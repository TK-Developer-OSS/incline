// task.md のファイル入出力 + タスク操作 (read-modify-write)。vscode 非依存。
// Webview パネルと AI ツール `task_tracker` の両方がこれを使う。
// 同一ファイルへの書き込みは簡易キューで直列化する。

import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
	isFillerNote,
	isRedundantConfirmNote,
	appendHistoryLine,
	commitTmpNotes,
	DEFAULT_CATEGORIES,
	DEFAULT_PREAMBLE,
	dedupeNonEmpty,
	discardTmpNotes,
	formatTimestamp,
	hasTmpNotes,
	nextTaskId,
	type ParsedTaskMd,
	parseTaskMd,
	serializeTaskMd,
	sortByPriority,
	type Task,
	type TaskPriority,
	type TaskStatus,
} from "./task-md"

export interface CreateTaskInput {
	title: string
	/** 初回履歴 (内容)。省略時は「登録。」 */
	content?: string
	status?: TaskStatus
	category?: string
	priority?: TaskPriority
	assignee?: string
	remarks?: string
}

export interface UpdateTaskPatch {
	title?: string
	status?: TaskStatus
	category?: string
	priority?: TaskPriority
	assignee?: string
	remarks?: string
}

/** ロックファイルがこの時間 (ms) 更新されていなければ、持ち主が落ちたとみなして INCLINE が解除する (15分)。 */
export const LOCK_STALE_MS = 15 * 60 * 1000
/** ロック取得を待つ上限 (ms)。 */
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 50

export class TaskMdStore {
	private writeChain: Promise<unknown> = Promise.resolve()

	constructor(private readonly filePath: string) {}

	/**
	 * 他プロセス (別ウィンドウ / 協調する AI) と共有するロックファイル `task.md.lock`。
	 * 排他作成 (wx) で取得する。内容は JSON `{ owner, pid, at }`。
	 *  - 書き込み中: 書き込みの間だけ作って削除する (owner: "incline")。
	 *  - 編集中:   パネルで編集が始まったら作り、保存 / 破棄で削除する (owner: "incline-edit")。
	 *             編集中は mtime を更新し続け、LOCK_STALE_MS (15分) 更新が無ければ INCLINE が解除する。
	 * AI 向けの手順はシステムプロンプトに書いてある (task-tracker-prompt.ts)。
	 */
	get lockPath(): string {
		return `${this.filePath}.lock`
	}

	private editHeld = false

	private async readLockOwner(): Promise<{ owner?: string; pid?: number } | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.lockPath, "utf8"))
		} catch {
			return undefined
		}
	}

	/** ロックの持ち主 (pid) がもう動いていないか。pid の無いロック (AI など) は判定しない。 */
	private async isOwnerDead(): Promise<boolean> {
		const info = await this.readLockOwner()
		if (typeof info?.pid !== "number" || info.pid === process.pid) {
			return false
		}
		try {
			process.kill(info.pid, 0)
			return false
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH"
		}
	}

	/**
	 * 期限切れ (LOCK_STALE_MS 更新なし) か、持ち主のプロセスが既に無いロックを解除する。
	 * (ウィンドウの再読み込み / 強制終了で残ったロックを 15 分待たずに外すため)。解除したら true。
	 */
	private async breakStaleLock(): Promise<boolean> {
		if (await this.isOwnerDead()) {
			await fs.unlink(this.lockPath).catch(() => undefined)
			return true
		}
		try {
			const st = await fs.stat(this.lockPath)
			if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
				await fs.unlink(this.lockPath).catch(() => undefined)
				return true
			}
		} catch {
			return true // stat 直前に解放された
		}
		return false
	}

	/**
	 * 編集ロックを取る (パネルで編集が始まったとき)。すでに自分が持っていれば mtime を更新するだけ。
	 * 他の書き手が持っていれば false (呼び出し側が「他で編集中」と知らせる)。
	 */
	async holdEditLock(): Promise<boolean> {
		if (this.editHeld) {
			const now = new Date()
			await fs.utimes(this.lockPath, now, now).catch(() => undefined)
			return true
		}
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fh = await fs.open(this.lockPath, "wx")
				try {
					await fh.writeFile(JSON.stringify({ owner: "incline-edit", pid: process.pid, at: new Date().toISOString() }))
				} finally {
					await fh.close()
				}
				this.editHeld = true
				return true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error
				}
				if (await this.breakStaleLock()) {
					continue
				}
				return false
			}
		}
		return false
	}

	/** 編集ロックを解除する (保存 / 破棄で編集が終わったとき)。 */
	async releaseEditLock(): Promise<void> {
		if (!this.editHeld) {
			return
		}
		this.editHeld = false
		await fs.unlink(this.lockPath).catch(() => undefined)
	}

	private async acquireLock(): Promise<() => Promise<void>> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		const deadline = Date.now() + LOCK_WAIT_MS
		for (;;) {
			try {
				const fh = await fs.open(this.lockPath, "wx")
				try {
					await fh.writeFile(JSON.stringify({ owner: "incline", pid: process.pid, at: new Date().toISOString() }))
				} finally {
					await fh.close()
				}
				return async () => {
					await fs.unlink(this.lockPath).catch(() => undefined)
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error
				}
				// 自分 (このウィンドウのパネル) の編集ロックなら、そのまま書き込める
				if (this.editHeld) {
					const info = await this.readLockOwner()
					if (info?.owner === "incline-edit" && info.pid === process.pid) {
						return async () => undefined
					}
				}
				if (await this.breakStaleLock()) {
					continue
				}
				if (Date.now() > deadline) {
					throw new Error("task.md のロックを取得できませんでした (他のプロセスが書き込み中)")
				}
				await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
			}
		}
	}

	get path(): string {
		return this.filePath
	}

	private async readRaw(): Promise<string> {
		try {
			return await fs.readFile(this.filePath, "utf8")
		} catch {
			return ""
		}
	}

	async load(): Promise<ParsedTaskMd> {
		const raw = await this.readRaw()
		if (!raw.trim()) {
			return { preamble: DEFAULT_PREAMBLE, tasks: [], categories: [...DEFAULT_CATEGORIES] }
		}
		const parsed = parseTaskMd(raw)
		if (!parsed.preamble.trim()) {
			parsed.preamble = DEFAULT_PREAMBLE
		}
		return parsed
	}

	/** 優先度順 (HIGH が先) にソートして返す。ファイル上の順序は登録順のまま。 */
	async list(): Promise<Task[]> {
		return sortByPriority((await this.load()).tasks)
	}

	private async save(parsed: ParsedTaskMd): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		// 一時ファイルに書いてから置き換える (書き込み途中で止まっても task.md が壊れない)
		const tmp = `${this.filePath}.${process.pid}.tmp`
		await fs.writeFile(tmp, serializeTaskMd(parsed), "utf8")
		await fs.rename(tmp, this.filePath)
	}

	/** 書き込み操作を直列化し、ファイルロックを取って実行する。 */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const fn = async (): Promise<T> => {
			const release = await this.acquireLock()
			try {
				return await op()
			} finally {
				await release()
			}
		}
		const run = this.writeChain.then(fn, fn)
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	/** task.md がまだ無ければ前文だけで作成する。 */
	async ensureFile(): Promise<void> {
		if ((await this.readRaw()).trim()) {
			return
		}
		await this.enqueue(() => this.save({ preamble: DEFAULT_PREAMBLE, tasks: [], categories: [...DEFAULT_CATEGORIES] }))
	}

	async create(input: CreateTaskInput, author: string): Promise<Task> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const now = formatTimestamp()
			const task: Task = {
				id: nextTaskId(parsed.tasks),
				title: input.title.trim() || "(無題)",
				status: input.status ?? "未着手",
				// カテゴリ未指定なら「タスク」(があれば) を初期値にする (#79)。AI / MCP からの登録も同じ。
				category: (input.category ?? (parsed.categories.includes("タスク") ? "タスク" : "")).trim(),
				priority: input.priority ?? "MIDDLE",
				assignee: (input.assignee ?? "").trim(),
				creator: author,
				created: now,
				updater: author,
				updated: now,
				remarks: (input.remarks ?? "").trim(),
				history: appendHistoryLine("", author, input.content?.trim() || "登録。"),
			}
			parsed.tasks.push(task)
			await this.save(parsed)
			return task
		})
	}

	async update(id: number, patch: UpdateTaskPatch, author: string): Promise<Task | undefined> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const task = parsed.tasks.find((t) => t.id === id)
			if (!task) {
				return undefined
			}
			if (patch.title !== undefined) {
				task.title = patch.title.trim() || task.title
			}
			if (patch.status !== undefined) {
				task.status = patch.status
			}
			if (patch.category !== undefined) {
				task.category = patch.category.trim()
			}
			if (patch.priority !== undefined) {
				task.priority = patch.priority
			}
			if (patch.assignee !== undefined) {
				task.assignee = patch.assignee.trim()
			}
			if (patch.remarks !== undefined) {
				task.remarks = patch.remarks.trim()
			}
			task.updater = author
			task.updated = formatTimestamp()
			await this.save(parsed)
			return task
		})
	}

	/** 履歴に1行追記する。ステータスも同時に変えたい場合は patch を渡す。 */
	async note(
		id: number,
		text: string,
		author: string,
		patch?: UpdateTaskPatch,
		opts: { tmp?: boolean } = {},
	): Promise<Task | undefined> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const task = parsed.tasks.find((t) => t.id === id)
			if (!task) {
				return undefined
			}
			// すでに判断待ちのタスクへの『[CONFIRM 継続]』の連投は書かない (履歴が埋まる)。人間 (me) の追記は常に通す。
			if (!opts.tmp && author.trim().toLowerCase() !== "me" && (isRedundantConfirmNote(task.history, text) || isFillerNote(task.history, text, task.status))) {
				return task
			}
			task.history = appendHistoryLine(task.history, author, text, new Date(), opts)
			if (opts.tmp) {
				// 未確定の追記は履歴行だけ。項目の変更・更新日時は『変更を保存』まで動かさない。
				await this.save(parsed)
				return task
			}
			if (patch?.status !== undefined) {
				task.status = patch.status
			}
			if (patch?.category !== undefined) {
				task.category = patch.category.trim()
			}
			if (patch?.priority !== undefined) {
				task.priority = patch.priority
			}
			if (patch?.assignee !== undefined) {
				task.assignee = patch.assignee.trim()
			}
			if (patch?.remarks !== undefined) {
				task.remarks = patch.remarks.trim()
			}
			task.updater = author
			task.updated = formatTimestamp()
			await this.save(parsed)
			return task
		})
	}

	/** 未確定の追記 (data-tmp-::) を確定する。『変更を保存』で呼ぶ。 */
	async commitNotes(id: number, author: string): Promise<Task | undefined> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const task = parsed.tasks.find((t) => t.id === id)
			if (!task || !hasTmpNotes(task.history)) {
				return task
			}
			task.history = commitTmpNotes(task.history)
			task.updater = author
			task.updated = formatTimestamp()
			await this.save(parsed)
			return task
		})
	}

	/** 未確定の追記 (data-tmp-::) を破棄する。『破棄』で呼ぶ。 */
	async discardNotes(id: number): Promise<Task | undefined> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const task = parsed.tasks.find((t) => t.id === id)
			if (!task || !hasTmpNotes(task.history)) {
				return task
			}
			task.history = discardTmpNotes(task.history)
			await this.save(parsed)
			return task
		})
	}

	/**
	 * `## カテゴリ` 一覧を丸ごと入れ替える。
	 *  - `renames` (旧名 -> 新名) はまず各タスクの category に反映する。
	 *  - `list` から外れたカテゴリでも、まだタスクに紐づいていれば削除せず残す (#19: ひもづけ有りは削除不可)。
	 * @returns 確定した一覧と、使用中のため削除を拒否したカテゴリ名。
	 */
	async saveCategories(
		list: readonly string[],
		renames: Record<string, string>,
		author: string,
	): Promise<{ categories: string[]; blocked: string[] }> {
		return this.enqueue(async () => {
			const parsed = await this.load()
			const now = formatTimestamp()

			for (const task of parsed.tasks) {
				const to = renames[task.category]?.trim()
				if (to && to !== task.category) {
					task.category = to
					task.updater = author
					task.updated = now
				}
			}

			const desired = dedupeNonEmpty(list)
			const desiredSet = new Set(desired)
			const inUse = new Set(parsed.tasks.map((t) => t.category).filter(Boolean))
			const blocked: string[] = []
			for (const existing of parsed.categories) {
				if (!desiredSet.has(existing) && inUse.has(existing)) {
					blocked.push(existing)
					desiredSet.add(existing)
					desired.push(existing)
				}
			}

			parsed.categories = desired
			await this.save(parsed)
			return { categories: desired, blocked }
		})
	}
}
