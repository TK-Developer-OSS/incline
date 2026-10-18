// Incline: AI / 人間どうしのメッセージ置き場 (#62)。ntfy の公開トピックに頼っている報告・指示の経路を、
// ローカル + トークン認証の仕組みに置き換える。
//  - 追記専用の JSONL (1 行 1 レコード)。投稿は { type: "msg" }、既読は { type: "ack" } を追記するだけなので、
//    複数のウィンドウ / プロセスが同時に書いても行が壊れない (O_APPEND の 1 回の書き込みは原子的)。
//  - 保存先は ~/.incline/data/messages/<ワークスペースのハッシュ>.jsonl (リポジトリの外。公開しない)。
// vscode 非依存。

import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { withFileLock } from "./file-lock"

export const MAX_TITLE_CHARS = 200
export const MAX_TEXT_CHARS = 8000

export interface Message {
	id: number
	ts: string
	from: string
	to: string
	title: string
	text: string
	/** 既読にした人 (ack)。 */
	ackedBy: string[]
}

export interface PostInput {
	to: string
	title: string
	text: string
	from?: string
}

export interface ReadOptions {
	/** この id より新しいものだけ。 */
	sinceId?: number
	/** 宛先で絞る (大文字小文字は区別しない)。"all" 宛は常に含む。 */
	to?: string
	/** この人が ack していないものだけ。 */
	unackedBy?: string
	limit?: number
}

type Record_ =
	| { type: "msg"; id: number; ts: string; from: string; to: string; title: string; text: string }
	| { type: "ack"; id: number; by: string; ts: string }

export function defaultMessageFile(workspace: string, home: string = process.env.INCLINE_DIR?.trim() || path.join(os.homedir(), ".incline")): string {
	const key = createHash("sha1").update(workspace).digest("hex").slice(0, 12)
	return path.join(home, "data", "messages", `${key}.jsonl`)
}

const norm = (s: string) => s.trim().toLowerCase()

export class MessageStore {
	/** 同じプロセス内の投稿 / 既読を順番に処理する。ファイルをまたぐ排他は withFileLock が行う。 */
	private chain: Promise<unknown> = Promise.resolve()

	constructor(private readonly file: string) {}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(() => withFileLock(`${this.file}.lock`, fn))
		this.chain = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	get path(): string {
		return this.file
	}

	private async readRecords(): Promise<Record_[]> {
		let raw: string
		try {
			raw = await fs.readFile(this.file, "utf8")
		} catch {
			return []
		}
		const out: Record_[] = []
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue
			}
			try {
				out.push(JSON.parse(line) as Record_)
			} catch {
				// 壊れた行 (書き込み途中の強制終了など) は読み飛ばす
			}
		}
		return out
	}

	private async append(record: Record_): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true })
		await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
	}

	private async collect(): Promise<Message[]> {
		const byId = new Map<number, Message>()
		for (const r of await this.readRecords()) {
			if (r.type === "msg") {
				byId.set(r.id, { id: r.id, ts: r.ts, from: r.from, to: r.to, title: r.title, text: r.text, ackedBy: [] })
			} else if (r.type === "ack") {
				const m = byId.get(r.id)
				if (m && !m.ackedBy.some((b) => norm(b) === norm(r.by))) {
					m.ackedBy.push(r.by)
				}
			}
		}
		return [...byId.values()].sort((a, b) => a.id - b.id)
	}

	/** メッセージを投稿して、そのメッセージを返す。 */
	async post(input: PostInput): Promise<Message> {
		return this.serialize(() => this.postLocked(input))
	}

	private async postLocked(input: PostInput): Promise<Message> {
		const to = input.to.trim()
		if (!to) {
			throw new Error("to (宛先) が空です")
		}
		const text = input.text.slice(0, MAX_TEXT_CHARS)
		if (!text.trim()) {
			throw new Error("text (本文) が空です")
		}
		const existing = await this.collect()
		const id = (existing.length ? existing[existing.length - 1].id : 0) + 1
		const record: Record_ = {
			type: "msg",
			id,
			ts: new Date().toISOString(),
			from: (input.from ?? "AI").trim() || "AI",
			to,
			title: input.title.trim().slice(0, MAX_TITLE_CHARS),
			text,
		}
		await this.append(record)
		return { id, ts: record.ts, from: record.from, to: record.to, title: record.title, text: record.text, ackedBy: [] }
	}

	/** 条件に合うメッセージを id 昇順で返す。 */
	async read(opts: ReadOptions = {}): Promise<Message[]> {
		let list = await this.collect()
		if (opts.sinceId !== undefined) {
			const since = opts.sinceId
			list = list.filter((m) => m.id > since)
		}
		if (opts.to) {
			const to = norm(opts.to)
			list = list.filter((m) => norm(m.to) === to || norm(m.to) === "all")
		}
		if (opts.unackedBy) {
			const by = norm(opts.unackedBy)
			list = list.filter((m) => !m.ackedBy.some((b) => norm(b) === by))
		}
		return opts.limit ? list.slice(0, opts.limit) : list
	}

	/** 既読にする。メッセージが無ければ undefined。 */
	async ack(id: number, by: string): Promise<Message | undefined> {
		return this.serialize(() => this.ackLocked(id, by))
	}

	private async ackLocked(id: number, by: string): Promise<Message | undefined> {
		const target = (await this.collect()).find((m) => m.id === id)
		if (!target) {
			return undefined
		}
		await this.append({ type: "ack", id, by: by.trim() || "AI", ts: new Date().toISOString() })
		return (await this.collect()).find((m) => m.id === id)
	}
}
