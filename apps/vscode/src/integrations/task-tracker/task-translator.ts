// Incline Tasks: リフレッシュ時に、タスクの件名と履歴を母国語に AI 翻訳して「表示だけ」差し込む。
// 原本の task.md は一切変えない。翻訳は原文のハッシュをキーにキャッシュし、新しい / 変わった行だけを AI に送る。
// 失敗しても止まらない (その行は原文のまま)。

import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { languageOptions } from "../../shared/Languages"
import type { Task } from "./task-md"

/** 1 回のリフレッシュで AI に送る上限 (レート制限・トークンの暴走防止)。 */
export const MAX_ITEMS_PER_REFRESH = 60
export const MAX_CHARS_PER_REQUEST = 6000
/** 1 行の上限。これを超える行は先頭だけ訳す。 */
const MAX_LINE_CHARS = 1500
const MAX_CACHE_ENTRIES = 5000

/** 言語キー (設定の "ja" や vscode.env.language) → AI に伝える言語名 ("Japanese")。英語 / 不明は翻訳不要 (undefined)。 */
export function targetLanguageName(key: string): string | undefined {
	const k = key.toLowerCase()
	if (!k || k === "en" || k.startsWith("en-")) {
		return undefined
	}
	const option =
		languageOptions.find((o) => o.key.toLowerCase() === k) ?? languageOptions.find((o) => o.key.toLowerCase() === k.split("-")[0])
	return option?.display.split(" - ")[0]
}

const HISTORY_PREFIX = /^(- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: )(.*)$/
const TMP_MARK = "data-tmp-::"

export function textHash(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

/** 日本語のように、母国語の文字がすでに十分含まれる行は訳さない (自分で書いた日本語を AI に送らない)。 */
export function isAlreadyTarget(text: string, language: string): boolean {
	const letters = [...text].filter((c) => /\p{L}/u.test(c))
	if (letters.length === 0) {
		return true // 記号・数字だけ
	}
	let native = 0
	for (const c of letters) {
		if (language === "Japanese" && /[぀-ヿ㐀-鿿]/u.test(c)) native++
		else if (language === "Korean" && /[가-힯]/u.test(c)) native++
		else if (language.endsWith("Chinese") && /[㐀-鿿]/u.test(c)) native++
		else if (language === "Russian" && /[Ѐ-ӿ]/u.test(c)) native++
	}
	return native / letters.length >= 0.3
}

export interface TranslatableItem {
	hash: string
	text: string
}

/** 件名と、履歴の各行の本文 (行頭の日時・名前は除く) を集める。未確定の追記 (data-tmp-::) と空行は除く。 */
export function collectItems(tasks: readonly Task[], language: string): TranslatableItem[] {
	const seen = new Set<string>()
	const items: TranslatableItem[] = []
	const add = (raw: string) => {
		const text = raw.trim().slice(0, MAX_LINE_CHARS)
		if (!text || text.includes(TMP_MARK) || isAlreadyTarget(text, language)) {
			return
		}
		const hash = textHash(text)
		if (!seen.has(hash)) {
			seen.add(hash)
			items.push({ hash, text })
		}
	}
	for (const t of tasks) {
		add(t.title)
		for (const line of String(t.history ?? "").split("\n")) {
			const m = line.match(HISTORY_PREFIX)
			add(m ? m[2] : line)
		}
	}
	return items
}

/** 表示用: 各タスクの件名と履歴の各行について、キャッシュにある訳を ハッシュ → 訳文 で返す。 */
export function pickKnown(items: readonly TranslatableItem[], cache: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const it of items) {
		if (cache[it.hash]) {
			out[it.hash] = cache[it.hash]
		}
	}
	return out
}

/** 訳していない項目を、上限内で小分けにする。 */
export function planBatches(missing: readonly TranslatableItem[]): TranslatableItem[][] {
	const batches: TranslatableItem[][] = []
	let current: TranslatableItem[] = []
	let chars = 0
	for (const it of missing.slice(0, MAX_ITEMS_PER_REFRESH)) {
		if (current.length > 0 && chars + it.text.length > MAX_CHARS_PER_REQUEST) {
			batches.push(current)
			current = []
			chars = 0
		}
		current.push(it)
		chars += it.text.length
	}
	if (current.length > 0) {
		batches.push(current)
	}
	return batches
}

export function buildTranslatePrompt(language: string, batch: readonly TranslatableItem[]): { system: string; user: string } {
	return {
		system:
			`You are a translation engine for a software task board. Translate EVERY string into ${language}. ` +
			`The input strings are mostly English: do not copy them, write them in ${language}. ` +
			"Keep as they are only: code, file paths, identifiers, URLs, task ids like #12, the marker itself in [CONFIRM] / [RESOLVED] / [CONFIRM:topic] (but translate the text after it), and markdown syntax. " +
			"Return a string unchanged only if it is already in the target language or has nothing to translate. " +
			`Example: input ["[CONFIRM:build] The build is ready. Please check #12."] -> output ["[CONFIRM:build] ビルドの準備ができました。#12 を確認してください。"] (this example is Japanese; use ${language}). ` +
			"Reply with ONLY a JSON array of strings, the same length and order as the input. No explanation, no code fence.",
		user: JSON.stringify(batch.map((b) => b.text)),
	}
}

/** AI の返答 (JSON 配列) を読む。長さが合わない / 壊れていたら undefined (その batch は訳さない)。 */
export function parseTranslateReply(reply: string, expected: number): string[] | undefined {
	const trimmed = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
	const start = trimmed.indexOf("[")
	const end = trimmed.lastIndexOf("]")
	if (start < 0 || end <= start) {
		return undefined
	}
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1))
		if (Array.isArray(parsed) && parsed.length === expected && parsed.every((v) => typeof v === "string")) {
			return parsed
		}
	} catch {
		// fall through
	}
	return undefined
}

/**
 * 翻訳に使う AI の設定。globalState の act プロバイダは古いまま残ることがある (宿題 #127: openrouter が残って "Unknown or disabled provider")
 * ので、providers.json の lastUsedProvider (= ユーザーが最後に実際に使ったもの) があればそれを優先する。
 * モデルは providers.json のそのプロバイダの設定。どちらも無ければ globalState のまま。
 */
export function pickTranslationConfig<T extends { actModeApiProvider?: string; actModeApiModelId?: string }>(
	config: T,
	lastUsed: { provider?: string; model?: string },
): T {
	if (!lastUsed.provider || lastUsed.provider === config.actModeApiProvider) {
		return config
	}
	return { ...config, actModeApiProvider: lastUsed.provider, actModeApiModelId: lastUsed.model ?? config.actModeApiModelId } as T
}

/** 長い文なのに原文と同じものが返ってきた = 訳されていない (安いモデルが英語をそのまま返すことがある)。短い文・記号だけは正当な「そのまま」。 */
export function looksUntranslated(original: string, out: string): boolean {
	const letters = [...original].filter((c) => /\p{L}/u.test(c)).length
	return letters >= 20 && out.trim() === original.trim()
}

export type CompleteFn = (system: string, user: string) => Promise<string>

/** 訳していない項目を翻訳してキャッシュに足す。足した件数を返す。1 batch の失敗は他に影響しない。 */
export async function translateMissing(
	items: readonly TranslatableItem[],
	cache: Record<string, string>,
	language: string,
	complete: CompleteFn,
	onError: (error: unknown) => void = () => {},
): Promise<number> {
	const missing = items.filter((it) => !cache[it.hash] || looksUntranslated(it.text, cache[it.hash]))
	let added = 0
	for (const batch of planBatches(missing)) {
		try {
			const { system, user } = buildTranslatePrompt(language, batch)
			const parsed = parseTranslateReply(await complete(system, user), batch.length)
			if (!parsed) {
				onError(new Error("the model's reply was not a JSON array of the expected length"))
				continue
			}
			batch.forEach((it, i) => {
				const out = parsed[i].trim()
				if (out) {
					cache[it.hash] = out
					added++
				}
			})
		} catch (error) {
			onError(error)
			break // 429 などのとき、残りを続けて投げない
		}
	}
	return added
}

/** language ごとの翻訳キャッシュ (globalStorage のファイル 1 つ)。 */
export class TranslationCache {
	private data: Record<string, Record<string, string>> | undefined

	constructor(private readonly file: string) {}

	async get(language: string): Promise<Record<string, string>> {
		if (!this.data) {
			try {
				const parsed = JSON.parse(await fs.readFile(this.file, "utf-8"))
				this.data = parsed && typeof parsed === "object" ? parsed : {}
			} catch {
				this.data = {}
			}
		}
		this.data![language] ??= {}
		return this.data![language]
	}

	async save(): Promise<void> {
		if (!this.data) {
			return
		}
		for (const lang of Object.keys(this.data)) {
			const keys = Object.keys(this.data[lang])
			for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES))) {
				delete this.data[lang][k] // 古い順に捨てる
			}
		}
		await fs.mkdir(path.dirname(this.file), { recursive: true })
		await fs.writeFile(this.file, JSON.stringify(this.data), "utf-8")
	}
}

/** 画面に送る、1 タスク分の訳 (原本は変えない)。historyTr は「空行を除いた履歴の行」と同じ並びで、訳が無い行は ""。 */
export interface TaskTranslation {
	titleTr: string
	historyTr: string[]
}

export function annotate(task: Task, cache: Record<string, string>, language: string): TaskTranslation {
	const lookup = (raw: string): string => {
		const text = raw.trim().slice(0, MAX_LINE_CHARS)
		if (!text || text.includes(TMP_MARK) || isAlreadyTarget(text, language)) {
			return ""
		}
		return cache[textHash(text)] ?? ""
	}
	const lines = String(task.history ?? "")
		.split("\n")
		.filter((l) => l.trim())
	return {
		titleTr: lookup(task.title),
		historyTr: lines.map((l) => {
			const m = l.match(HISTORY_PREFIX)
			return lookup(m ? m[2] : l)
		}),
	}
}
