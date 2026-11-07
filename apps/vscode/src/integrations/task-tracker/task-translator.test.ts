import { describe, expect, it } from "vitest"
import type { Task } from "./task-md"
import { pickTranslationConfig, targetLanguageName, annotate, collectItems, isAlreadyTarget, parseTranslateReply, looksUntranslated, planBatches, textHash, translateMissing } from "./task-translator"

const task = (over: Partial<Task>): Task => ({
	id: 1,
	title: "Add a setting",
	status: "対応中",
	category: "",
	priority: "MIDDLE",
	assignee: "",
	creator: "me",
	created: "2026-10-31 10:00",
	updater: "me",
	updated: "2026-10-31 10:00",
	remarks: "",
	history: "",
	...over,
})

describe("task-translator", () => {
	it("prefers the last used provider over a stale one in globalState", () => {
		const stale = { actModeApiProvider: "openrouter", actModeApiModelId: "x" }
		expect(pickTranslationConfig(stale, { provider: "gemini", model: "m" })).toEqual({ actModeApiProvider: "gemini", actModeApiModelId: "m" })
		expect(pickTranslationConfig(stale, {})).toBe(stale)
		expect(pickTranslationConfig(stale, { provider: "openrouter", model: "y" })).toBe(stale)
	})
	it("maps language keys to names; English and unknown need no translation", () => {
		expect(targetLanguageName("ja")).toBe("Japanese")
		expect(targetLanguageName("zh-cn")).toBe("Simplified Chinese")
		expect(targetLanguageName("pt-br")).toBe("Portuguese")
		expect(targetLanguageName("en")).toBeUndefined()
		expect(targetLanguageName("en-US")).toBeUndefined()
		expect(targetLanguageName("")).toBeUndefined()
	})
	it("skips lines already in the target language and unsaved drafts", () => {
		const t = task({
			title: "設定を追加",
			history: "- 2026-10-31 10:00 ai: Implemented X\n- 2026-10-31 10:01 me: 日本語のメモ\n- 2026-10-31 10:02 me: data-tmp-::draft",
		})
		expect(collectItems([t], "Japanese").map((i) => i.text)).toEqual(["Implemented X"])
	})
	it("detects native text", () => {
		expect(isAlreadyTarget("設定を追加 (test)", "Japanese")).toBe(true)
		expect(isAlreadyTarget("Add a setting", "Japanese")).toBe(false)
	})
	it("annotates from the cache, aligned with non-empty history lines", () => {
		const t = task({ history: "- 2026-10-31 10:00 ai: Implemented X\n\n- 2026-10-31 10:01 me: メモ" })
		const out = annotate(t, { [textHash("Add a setting")]: "設定を追加", [textHash("Implemented X")]: "X を実装" }, "Japanese")
		expect(out).toEqual({ titleTr: "設定を追加", historyTr: ["X を実装", ""] })
	})
	it("parses replies strictly", () => {
		expect(parseTranslateReply('```json\n["a","b"]\n```', 2)).toEqual(["a", "b"])
		expect(parseTranslateReply('["a"]', 2)).toBeUndefined()
		expect(parseTranslateReply("nope", 1)).toBeUndefined()
	})
	it("caps the work per refresh", () => {
		const items = Array.from({ length: 200 }, (_, i) => ({ hash: String(i), text: "x".repeat(100) }))
		const batches = planBatches(items)
		expect(batches.flat().length).toBe(60)
		expect(batches.every((b) => b.reduce((n, i) => n + i.text.length, 0) <= 6000)).toBe(true)
	})
	it("translates only missing items and stops after an error", async () => {
		const cache: Record<string, string> = { a: "A" }
		const items = [
			{ hash: "a", text: "one" },
			{ hash: "b", text: "two" },
		]
		let calls = 0
		const added = await translateMissing(items, cache, "Japanese", async (_s, u) => {
			calls++
			return JSON.stringify(JSON.parse(u).map((x: string) => `<${x}>`))
		})
		expect(added).toBe(1)
		expect(calls).toBe(1)
		expect(cache.b).toBe("<two>")
		const errors: unknown[] = []
		await translateMissing([{ hash: "c", text: "3" }], cache, "Japanese", async () => {
			throw new Error("429")
		}, (e) => errors.push(e))
		expect(errors).toHaveLength(1)
		expect(cache.c).toBeUndefined()
	})
	it("does not cache a long English line that came back unchanged, and retries it", async () => {
		const long = "The build is ready, please check the new settings panel."
		expect(looksUntranslated(long, long)).toBe(true)
		expect(looksUntranslated("OK", "OK")).toBe(false)
		expect(looksUntranslated(long, "ビルドの準備ができました。")).toBe(false)
		const cache: Record<string, string> = { x: long } // an earlier bad result
		const items = [{ hash: "x", text: long }]
		await translateMissing(items, cache, "Japanese", async () => JSON.stringify([long]))
		expect(cache.x).toBe(long) // still unchanged, not "translated"
		const added = await translateMissing(items, cache, "Japanese", async () => JSON.stringify(["ビルドの準備ができました。"]))
		expect(added).toBe(1)
		expect(cache.x).toBe("ビルドの準備ができました。")
	})
})
