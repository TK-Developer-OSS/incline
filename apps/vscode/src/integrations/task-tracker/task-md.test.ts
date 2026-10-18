import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
	findOpenConfirms,
	hasTmpNotes,
	isPossibleConfirmReply,
	needsConfirmation,
	nextTaskId,
	normalizePriority,
	normalizeStatus,
	parseTaskMd,
	serializeTaskMd,
	sortByPriority,
	TMP_NOTE_MARK,
} from "./task-md"
import { LOCK_STALE_MS, TaskMdStore } from "./task-md-store"
import { TASK_TRACKER_PROMPT_SECTION } from "./task-tracker-prompt"

const SAMPLE = `# Incline タスクトラッカー (task.md)

前文はそのまま保持される。
## これは前文の見出し（タスクではない）

---

## [#1] 最初のタスク
- status: 対応中
- assignee: AI
- creator: TK
- created: 2026-09-03 10:00
- updater: AI
- updated: 2026-09-03 15:30
- 備考: メモ

### 履歴
- 2026-09-03 10:00 TK: 登録。
- 2026-09-03 15:30 AI: 修正した。

## [#3] 3番目のタスク
- ステータス: 完了
- 担当者: TK

### 履歴
- 2026-09-03 11:00 TK: これで完了。
`

describe("parseTaskMd", () => {
	it("splits tasks on `## [#N] ` headings and keeps the preamble verbatim", () => {
		const parsed = parseTaskMd(SAMPLE)
		expect(parsed.preamble).toContain("前文はそのまま保持される。")
		expect(parsed.preamble).toContain("## これは前文の見出し（タスクではない）")
		expect(parsed.tasks).toHaveLength(2)
		expect(parsed.tasks.map((t) => t.id)).toEqual([1, 3])
	})

	it("parses meta lines (english + japanese keys)", () => {
		const [t1, t3] = parseTaskMd(SAMPLE).tasks
		expect(t1).toMatchObject({
			title: "最初のタスク",
			status: "対応中",
			assignee: "AI",
			creator: "TK",
			created: "2026-09-03 10:00",
			updater: "AI",
			updated: "2026-09-03 15:30",
			remarks: "メモ",
		})
		expect(t1.history).toBe("- 2026-09-03 10:00 TK: 登録。\n- 2026-09-03 15:30 AI: 修正した。")
		expect(t3).toMatchObject({ status: "完了", assignee: "TK" })
	})

	it("returns whole text as preamble when there are no task headings", () => {
		const parsed = parseTaskMd("# just notes\n\nno tasks here\n")
		expect(parsed.tasks).toEqual([])
		expect(parsed.preamble).toBe("# just notes\n\nno tasks here")
	})

	it("defaults unknown / missing status to 未着手", () => {
		expect(normalizeStatus("bogus")).toBe("未着手")
		expect(normalizeStatus(undefined)).toBe("未着手")
		expect(normalizeStatus("保留")).toBe("保留")
	})

	it("defaults missing / unknown priority to MIDDLE (case-insensitive, aliases)", () => {
		expect(parseTaskMd(SAMPLE).tasks[0].priority).toBe("MIDDLE")
		expect(normalizePriority("high")).toBe("HIGH")
		expect(normalizePriority("mid")).toBe("MIDDLE")
		expect(normalizePriority("bogus")).toBe("MIDDLE")
		expect(normalizePriority(undefined)).toBe("MIDDLE")
	})

	it("parses an explicit priority line", () => {
		const parsed = parseTaskMd("## [#5] p\n- priority: LOW\n\n### 履歴\n- x")
		expect(parsed.tasks[0].priority).toBe("LOW")
	})
})

describe("sortByPriority", () => {
	it("orders HIGH -> MIDDLE -> LOW, then by id, without mutating input", () => {
		const src = parseTaskMd(
			[
				"## [#1] a\n- priority: LOW\n\n### 履歴\n- x",
				"## [#2] b\n- priority: HIGH\n\n### 履歴\n- x",
				"## [#3] c\n- priority: MIDDLE\n\n### 履歴\n- x",
				"## [#4] d\n- priority: HIGH\n\n### 履歴\n- x",
			].join("\n\n"),
		).tasks
		const sorted = sortByPriority(src)
		expect(sorted.map((t) => t.id)).toEqual([2, 4, 3, 1])
		expect(src.map((t) => t.id)).toEqual([1, 2, 3, 4])
	})

	it("puts 完了/削除 below all open tasks, even LOW", () => {
		const src = parseTaskMd(
			[
				"## [#1] a\n- status: 完了\n- priority: HIGH\n\n### 履歴\n- x",
				"## [#2] b\n- status: 未着手\n- priority: LOW\n\n### 履歴\n- x",
				"## [#3] c\n- status: 削除\n- priority: HIGH\n\n### 履歴\n- x",
				"## [#4] d\n- status: 対応中\n- priority: MIDDLE\n\n### 履歴\n- x",
			].join("\n\n"),
		).tasks
		expect(sortByPriority(src).map((t) => t.id)).toEqual([4, 2, 1, 3])
	})
})

describe("serializeTaskMd / round-trip", () => {
	it("parse -> serialize -> parse is stable", () => {
		const once = parseTaskMd(SAMPLE)
		const text = serializeTaskMd(once)
		const twice = parseTaskMd(text)
		expect(twice.tasks).toEqual(once.tasks)
		expect(parseTaskMd(serializeTaskMd(twice)).tasks).toEqual(twice.tasks)
	})

	it("preserves the history block verbatim across a round-trip", () => {
		const text = serializeTaskMd(parseTaskMd(SAMPLE))
		expect(text).toContain("- 2026-09-03 10:00 TK: 登録。\n- 2026-09-03 15:30 AI: 修正した。")
	})

	it("omits the 備考 line when remarks is empty", () => {
		const parsed = parseTaskMd(SAMPLE)
		parsed.tasks[0].remarks = ""
		expect(serializeTaskMd(parsed)).not.toContain("- 備考:")
	})

	it("injects DEFAULT_PREAMBLE when preamble is blank", () => {
		expect(serializeTaskMd({ preamble: "", tasks: [], categories: DEFAULT_CATEGORIES })).toContain("# Incline タスクトラッカー")
	})
})

describe("categories (#19)", () => {
	it("defaults to バグ/タスク/設計/メモ when there is no ## カテゴリ section", () => {
		expect(parseTaskMd(SAMPLE).categories).toEqual(["バグ", "タスク", "設計", "メモ"])
		expect(parseTaskMd("# notes only\n").categories).toEqual(["バグ", "タスク", "設計", "メモ"])
	})

	it("round-trips a custom list + per-task category, without leaking into the preamble", () => {
		const p = parseTaskMd(SAMPLE)
		p.categories = ["不具合", "改善"]
		p.tasks[0].category = "不具合"
		const text = serializeTaskMd(p)
		const again = parseTaskMd(text)
		expect(again.categories).toEqual(["不具合", "改善"])
		expect(again.tasks[0].category).toBe("不具合")
		expect(again.tasks[1].category).toBe("")
		expect(again.preamble).not.toContain("## カテゴリ")
		expect(again.preamble).toContain("## これは前文の見出し（タスクではない）")
		// second pass is byte-stable
		expect(serializeTaskMd(again)).toBe(text)
	})

	it("omits the `- category:` line for tasks without a category", () => {
		const text = serializeTaskMd(parseTaskMd(SAMPLE))
		expect(text).not.toContain("- category:")
	})

	it("dedupeNonEmpty trims, drops blanks, keeps first-seen order", () => {
		expect(dedupeNonEmpty([" a ", "b", "a", "", "  ", "b", "c"])).toEqual(["a", "b", "c"])
	})
})

describe("helpers", () => {
	it("formatTimestamp -> YYYY-MM-DD HH:MM", () => {
		expect(formatTimestamp(new Date(2026, 8, 3, 7, 5))).toBe("2026-09-03 07:05")
	})

	it("nextTaskId = max + 1", () => {
		expect(nextTaskId([])).toBe(1)
		expect(nextTaskId(parseTaskMd(SAMPLE).tasks)).toBe(4)
	})

	it("appendHistoryLine appends a single collapsed line", () => {
		const h = appendHistoryLine("- x", "AI", "multi\n  line   text", new Date(2026, 8, 3, 9, 0))
		expect(h).toBe("- x\n- 2026-09-03 09:00 AI: multi line text")
	})
})

describe("TaskMdStore", () => {
	let dir: string
	let store: TaskMdStore

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-task-md-"))
		store = new TaskMdStore(path.join(dir, "task.md"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("ensureFile writes the preamble-only file", async () => {
		await store.ensureFile()
		const raw = await fs.readFile(store.path, "utf8")
		expect(raw).toContain(DEFAULT_PREAMBLE.trim().split("\n")[0])
		expect((await store.list())).toEqual([])
	})

	it("create assigns sequential ids and an initial history line", async () => {
		const a = await store.create({ title: "A" }, "TK")
		const b = await store.create({ title: "B", content: "詳細", status: "対応中", assignee: "AI" }, "TK")
		expect(a.id).toBe(1)
		expect(b.id).toBe(2)
		expect(a.priority).toBe("MIDDLE")
		expect(b.status).toBe("対応中")
		expect(b.history).toMatch(/^- .* TK: 詳細$/)
		expect(a.history).toMatch(/TK: 登録。$/)
	})

	it("list() returns tasks sorted by priority (HIGH first)", async () => {
		await store.create({ title: "low", priority: "LOW" }, "TK")
		await store.create({ title: "high", priority: "HIGH" }, "TK")
		await store.create({ title: "mid" }, "TK")
		expect((await store.list()).map((t) => t.title)).toEqual(["high", "mid", "low"])
	})

	it("update patches fields (incl. priority) and bumps updater/updated", async () => {
		const a = await store.create({ title: "A" }, "TK")
		const updated = await store.update(a.id, { status: "完了", priority: "HIGH", remarks: "done" }, "AI")
		expect(updated?.status).toBe("完了")
		expect(updated?.priority).toBe("HIGH")
		expect(updated?.remarks).toBe("done")
		expect(updated?.updater).toBe("AI")
		expect(updated?.creator).toBe("TK")
		expect(await store.update(999, { status: "完了" }, "AI")).toBeUndefined()
	})

	it("note appends history and can change status atomically", async () => {
		const a = await store.create({ title: "A" }, "TK")
		await store.note(a.id, "着手します", "AI", { status: "対応中" })
		const [t] = await store.list()
		expect(t.status).toBe("対応中")
		expect(t.history.split("\n")).toHaveLength(2)
		expect(t.history).toMatch(/AI: 着手します$/)
	})

	it("serializes existing content on round-trip through the store", async () => {
		await fs.writeFile(store.path, SAMPLE, "utf8")
		await store.update(1, { status: "保留" }, "AI")
		const reparsed = await store.list()
		expect(reparsed.map((t) => t.id)).toEqual([1, 3])
		expect(reparsed[0].status).toBe("保留")
		expect(reparsed[1].status).toBe("完了")
		// preamble (incl. the non-task `## ` heading) survives
		expect(await fs.readFile(store.path, "utf8")).toContain("## これは前文の見出し（タスクではない）")
	})

	it("saveCategories replaces the list and renames cascade to tasks", async () => {
		await fs.writeFile(store.path, SAMPLE, "utf8")
		await store.update(1, { category: "バグ" }, "AI")
		const res = await store.saveCategories(["不具合", "タスク", "設計", "メモ"], { バグ: "不具合" }, "TK")
		expect(res.blocked).toEqual([])
		expect(res.categories).toEqual(["不具合", "タスク", "設計", "メモ"])
		const [t1] = await store.list()
		expect(t1.category).toBe("不具合")
		expect(t1.updater).toBe("TK")
	})

	it("saveCategories refuses to delete a category still used by a task", async () => {
		await fs.writeFile(store.path, SAMPLE, "utf8")
		await store.update(1, { category: "バグ" }, "AI")
		const res = await store.saveCategories(["タスク"], {}, "TK")
		expect(res.blocked).toEqual(["バグ"])
		expect(res.categories).toEqual(expect.arrayContaining(["タスク", "バグ"]))
		expect((await store.load()).categories).toEqual(expect.arrayContaining(["バグ"]))
	})

	it("serializes concurrent writes without losing updates", async () => {
		await Promise.all([
			store.create({ title: "A" }, "TK"),
			store.create({ title: "B" }, "TK"),
			store.create({ title: "C" }, "TK"),
		])
		const tasks = await store.list()
		expect(tasks.map((t) => t.title).sort()).toEqual(["A", "B", "C"])
		expect(new Set(tasks.map((t) => t.id)).size).toBe(3)
	})
})

describe("未確定の追記 (data-tmp-::)", () => {
	const at = new Date(2026, 9, 16, 20, 0)

	it("marks a tmp line, then commits (marker removed) or discards (line removed)", () => {
		let h = appendHistoryLine("", "me", "確定済みの行", at)
		h = appendHistoryLine(h, "me", "下書きの行", at, { tmp: true })
		expect(h).toContain(`me: ${TMP_NOTE_MARK}下書きの行`)
		expect(hasTmpNotes(h)).toBe(true)

		const committed = commitTmpNotes(h)
		expect(hasTmpNotes(committed)).toBe(false)
		expect(committed).toContain("me: 下書きの行")
		expect(committed).not.toContain(TMP_NOTE_MARK)

		const discarded = discardTmpNotes(h)
		expect(discarded).toBe("- 2026-10-16 20:00 me: 確定済みの行")
		expect(hasTmpNotes(discarded)).toBe(false)
	})

	it("does not treat a colon earlier in the text as the marker position", () => {
		const h = "- 2026-10-16 21:00 AI: 注意: data-tmp-:: は印の名前"
		expect(hasTmpNotes(h)).toBe(false)
		expect(commitTmpNotes(h)).toBe(h)
		expect(discardTmpNotes(h)).toBe(h)
	})

	it("does not treat the marker in the middle of normal text as a tmp line", () => {
		const h = appendHistoryLine("", "me", `本文に ${TMP_NOTE_MARK} を含む通常行`, at)
		expect(hasTmpNotes(h)).toBe(false)
		expect(discardTmpNotes(h)).toBe(h)
	})
})

describe("TaskMdStore: 既定カテゴリ (#79)", () => {
	it("defaults an unspecified category to 'タスク' (when it exists); an explicit empty category stays empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-task-md-cat-"))
		try {
			const store = new TaskMdStore(path.join(dir, "task.md"))
			const a = await store.create({ title: "指定なし" }, "me")
			const b = await store.create({ title: "空を明示", category: "" }, "me")
			const c = await store.create({ title: "バグ", category: "バグ" }, "me")
			expect(a.category).toBe("タスク")
			expect(b.category).toBe("")
			expect(c.category).toBe("バグ")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("TaskMdStore: 未確定の追記", () => {
	let dir: string
	let store: TaskMdStore

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-task-md-tmp-"))
		store = new TaskMdStore(path.join(dir, "task.md"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("writes a tmp note immediately without touching updated/updater, and survives a reload", async () => {
		const t = await store.create({ title: "a" }, "me")
		const before = (await store.list())[0]
		await store.note(t.id, "下書き", "me", undefined, { tmp: true })
		const raw = await fs.readFile(path.join(dir, "task.md"), "utf8")
		expect(raw).toContain(`me: ${TMP_NOTE_MARK}下書き`)
		// 別インスタンス (= リロード / 別ウィンドウ) からも見える
		const again = (await new TaskMdStore(path.join(dir, "task.md")).list())[0]
		expect(hasTmpNotes(again.history)).toBe(true)
		expect(again.updated).toBe(before.updated)
		expect(again.updater).toBe(before.updater)
	})

	it("commitNotes confirms tmp notes; discardNotes removes them", async () => {
		const t = await store.create({ title: "a" }, "me")
		await store.note(t.id, "確定したい", "me", undefined, { tmp: true })
		const c = await store.commitNotes(t.id, "TK")
		expect(hasTmpNotes(c!.history)).toBe(false)
		expect(c!.history).toContain("me: 確定したい")
		expect(c!.updater).toBe("TK")

		await store.note(t.id, "捨てたい", "me", undefined, { tmp: true })
		const d = await store.discardNotes(t.id)
		expect(d!.history).not.toContain("捨てたい")
		expect(d!.history).toContain("me: 確定したい")
	})
})

describe("TaskMdStore: ロックファイルと原子的書き込み", () => {
	let dir: string
	let file: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-task-md-lock-"))
		file = path.join(dir, "task.md")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("does not lose updates when several store instances (= windows) write concurrently", async () => {
		const stores = [new TaskMdStore(file), new TaskMdStore(file), new TaskMdStore(file)]
		await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 3].create({ title: `t${i}` }, "me")))
		const tasks = await new TaskMdStore(file).list()
		expect(tasks).toHaveLength(30)
		expect(new Set(tasks.map((t) => t.id)).size).toBe(30)
	})

	it("removes the lock file after each write and leaves no temp file", async () => {
		const store = new TaskMdStore(file)
		await store.create({ title: "a" }, "me")
		const names = await fs.readdir(dir)
		expect(names).toEqual(["task.md"])
	})

	it("waits for a fresh lock held by someone else, then proceeds once it is released", async () => {
		const store = new TaskMdStore(file)
		await fs.writeFile(`${file}.lock`, JSON.stringify({ owner: "ai" }))
		let done = false
		const p = store.create({ title: "wait" }, "me").then(() => {
			done = true
		})
		await new Promise((r) => setTimeout(r, 200))
		expect(done).toBe(false)
		await fs.unlink(`${file}.lock`)
		await p
		expect(done).toBe(true)
	})

	it("takes over a stale lock", async () => {
		const store = new TaskMdStore(file)
		const lock = `${file}.lock`
		await fs.writeFile(lock, JSON.stringify({ owner: "dead" }))
		const old = new Date(Date.now() - LOCK_STALE_MS - 5_000)
		await fs.utimes(lock, old, old)
		await store.create({ title: "after stale" }, "me")
		expect((await store.list()).map((t) => t.title)).toEqual(["after stale"])
	})
})

describe("TaskMdStore: 編集ロック (パネルの編集中)", () => {
	let dir: string
	let file: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-task-md-edit-"))
		file = path.join(dir, "task.md")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("creates task.md.lock when editing starts and removes it when editing ends", async () => {
		const store = new TaskMdStore(file)
		expect(await store.holdEditLock()).toBe(true)
		const info = JSON.parse(await fs.readFile(`${file}.lock`, "utf8"))
		expect(info).toMatchObject({ owner: "incline-edit", pid: process.pid })
		await store.releaseEditLock()
		await expect(fs.access(`${file}.lock`)).rejects.toThrow()
	})

	it("lets the editing window save (writes) while its own edit lock is held, and keeps the lock", async () => {
		const store = new TaskMdStore(file)
		await store.holdEditLock()
		await store.create({ title: "while editing" }, "me")
		expect((await store.list()).map((t) => t.title)).toEqual(["while editing"])
		await expect(fs.access(`${file}.lock`)).resolves.toBeUndefined()
		await store.releaseEditLock()
	})

	it("refuses to hold the edit lock while someone else holds a fresh lock", async () => {
		await fs.writeFile(`${file}.lock`, JSON.stringify({ owner: "ai" }))
		expect(await new TaskMdStore(file).holdEditLock()).toBe(false)
	})

	it("INCLINE releases a lock that has not been refreshed for 15 minutes", async () => {
		const lock = `${file}.lock`
		await fs.writeFile(lock, JSON.stringify({ owner: "ai" }))
		const old = new Date(Date.now() - 15 * 60 * 1000 - 5_000)
		await fs.utimes(lock, old, old)
		const store = new TaskMdStore(file)
		expect(await store.holdEditLock()).toBe(true)
		await store.releaseEditLock()
	})

	it("breaks a lock whose owner process is gone right away (e.g. window reload), without waiting 15 minutes", async () => {
		await fs.writeFile(`${file}.lock`, JSON.stringify({ owner: "incline-edit", pid: 2 ** 22 + 12345 }))
		const store = new TaskMdStore(file)
		await store.create({ title: "after reload" }, "me")
		expect((await store.list()).map((t) => t.title)).toEqual(["after reload"])
	})

	it("keeps waiting for a lock whose owner process is alive", async () => {
		await fs.writeFile(`${file}.lock`, JSON.stringify({ owner: "incline-edit", pid: process.ppid }))
		expect(await new TaskMdStore(file).holdEditLock()).toBe(false)
	})

	it("refreshes the lock mtime while editing continues", async () => {
		const store = new TaskMdStore(file)
		await store.holdEditLock()
		const old = new Date(Date.now() - 10 * 60 * 1000)
		await fs.utimes(`${file}.lock`, old, old)
		await store.holdEditLock()
		const st = await fs.stat(`${file}.lock`)
		expect(Date.now() - st.mtimeMs).toBeLessThan(5_000)
		await store.releaseEditLock()
	})
})

describe("system prompt section", () => {
	it("tells the AI the lock protocol and the tmp-note rule", () => {
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("task.md.lock")
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("15 minutes")
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("data-tmp-::")
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("task_tracker")
		// #81: 作業したらタスクを更新するが、勝手に完了にはしない
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("Never set a task to 完了 or 削除 yourself")
		expect(TASK_TRACKER_PROMPT_SECTION).toContain("final report note")
	})
})

describe("判断待ちのタスクは一覧の最優先 (#97)", () => {
	const mk = (id: number, priority: string, status: string, history = "") =>
		`## [#${id}] t${id}\n- status: ${status}\n- priority: ${priority}\n\n### 履歴\n${history || "- 2026-10-17 10:00 AI: 登録。"}`
	const CONFIRM = "- 2026-10-17 10:01 AI: [CONFIRM] どうしますか"

	it("puts tasks with an open [CONFIRM] first, even above HIGH; resolved / closed ones sort normally", () => {
		const tasks = parseTaskMd(
			[
				mk(1, "HIGH", "対応中"),
				mk(2, "LOW", "未着手", `- 2026-10-17 10:00 AI: 登録。\n${CONFIRM}`), // 判断待ち (LOW)
				mk(3, "MIDDLE", "対応中", `${CONFIRM}\n- 2026-10-17 10:02 TK: [RESOLVED] A で`), // 解決済み
				mk(4, "MIDDLE", "未着手", CONFIRM), // 判断待ち (MIDDLE)
				mk(5, "HIGH", "完了", CONFIRM), // 完了は判断待ちでも末尾側
			].join("\n\n"),
		).tasks
		expect(sortByPriority(tasks).map((t) => t.id)).toEqual([4, 2, 1, 3, 5])
	})
})

describe("判断待ち ([CONFIRM] / [RESOLVED])", () => {
	const L = (hhmm: string, who: string, body: string) => `- 2026-10-17 ${hhmm} ${who}: ${body}`
	const h = (...lines: string[]) => lines.join("\n")

	it("fires on a line whose text starts with [CONFIRM] and is cancelled by a later [RESOLVED]", () => {
		const open = h(L("10:00", "AI", "[CONFIRM] A と B のどちらにしますか。既定は A"))
		expect(findOpenConfirms(open)).toEqual([{ line: 0 }])
		const resolved = h(open, L("10:05", "TK", "A で"), L("10:06", "AI", "[RESOLVED] A に決定"))
		expect(findOpenConfirms(resolved)).toEqual([])
	})

	it("does not fire when [CONFIRM] only appears inside a sentence", () => {
		expect(findOpenConfirms(h(L("10:00", "AI", "説明: [CONFIRM] で始めると点滅する")))).toEqual([])
		expect(findOpenConfirms(h(L("10:00", "AI", "注意: [CONFIRM] は文頭だけ")))).toEqual([])
	})

	it("counts lines among non-blank lines, supports tags, and an untagged [RESOLVED] cancels all", () => {
		const hist = h(L("10:00", "AI", "登録。"), "", L("10:01", "AI", "[CONFIRM:db] DB はどれ"), L("10:02", "AI", "[CONFIRM:ui] UI はどれ"))
		expect(findOpenConfirms(hist)).toEqual([
			{ line: 1, tag: "db" },
			{ line: 2, tag: "ui" },
		])
		expect(findOpenConfirms(h(hist, L("10:03", "TK", "[RESOLVED:db] SQLite"))).map((c) => c.tag)).toEqual(["ui"])
		expect(findOpenConfirms(h(hist, L("10:03", "TK", "[RESOLVED] 全部決定")))).toEqual([])
	})

	it("ignores unsaved (data-tmp-::) lines and closed tasks", () => {
		const hist = h(L("10:00", "AI", "[CONFIRM] どうする"), L("10:01", "TK", "data-tmp-::[RESOLVED] 下書き"))
		expect(findOpenConfirms(hist)).toEqual([{ line: 0 }]) // 未確定の [RESOLVED] はまだ効かない
		expect(needsConfirmation({ status: "対応中", history: hist })).toBe(true)
		expect(needsConfirmation({ status: "完了", history: hist })).toBe(false)
		expect(needsConfirmation({ status: "削除", history: hist })).toBe(false)
	})

	it("isPossibleConfirmReply: only when unsaved lines are about to be committed under an open [CONFIRM]", () => {
		const base = L("10:00", "AI", "[CONFIRM] どうする")
		expect(isPossibleConfirmReply({ status: "対応中", history: h(base, L("10:01", "TK", "data-tmp-::A で")) })).toBe(true)
		expect(isPossibleConfirmReply({ status: "対応中", history: base })).toBe(false) // 確定する行が無い
		expect(isPossibleConfirmReply({ status: "対応中", history: h(L("10:00", "AI", "進捗"), L("10:01", "TK", "data-tmp-::メモ")) })).toBe(false) // 判断待ちが無い
		expect(isPossibleConfirmReply({ status: "完了", history: h(base, L("10:01", "TK", "data-tmp-::A で")) })).toBe(false)
	})

	it("the system prompt teaches the rule", () => {
		for (const needle of ["[CONFIRM]", "[RESOLVED]", "STARTS with", "[INCLINE NOTICE]", "⚠CONFIRM", "do not add [RESOLVED]"]) {
			expect(TASK_TRACKER_PROMPT_SECTION).toContain(needle)
		}
	})
})

describe("isRedundantConfirmNote (#111)", () => {
	const waiting = "- 2026-10-18 10:00 AI: [CONFIRM:q1] どちらにしますか"
	it("blocks continuation notes and the same topic while a CONFIRM is open", () => {
		expect(isRedundantConfirmNote(waiting, "[CONFIRM 継続] まだ待っています")).toBe(true)
		expect(isRedundantConfirmNote(waiting, "[CONFIRM:q1] もう一度")).toBe(true)
	})
	it("lets a new topic and non-CONFIRM notes through", () => {
		expect(isRedundantConfirmNote(waiting, "[CONFIRM:q2] 別の質問")).toBe(false)
		expect(isRedundantConfirmNote(waiting, "進捗: 調査中")).toBe(false)
	})
	it("does not block when nothing is open", () => {
		expect(isRedundantConfirmNote("- 2026-10-18 10:00 AI: 登録。", "[CONFIRM 継続] x")).toBe(false)
		expect(isRedundantConfirmNote(`${waiting}\n- 2026-10-18 10:05 me: [RESOLVED:q1] 了解`, "[CONFIRM:q1] 再度")).toBe(false)
	})
})

describe("isFillerNote (#99)", () => {
	const h = "- 2026-10-18 12:06 AI: 継続確認1: dd 再起動問題の確認を継続中"
	it("drops a repeated filler (only the number differs)", () => {
		expect(isFillerNote(h, "継続確認2: dd 再起動問題の確認を継続中", "対応中")).toBe(true)
	})
	it("drops watchdog-style filler on cards that are not in progress", () => {
		expect(isFillerNote("", "継続確認1: 継続中", "保留")).toBe(true)
		expect(isFillerNote("", "[WATCHDOG] 継続確認", "報告")).toBe(true)
	})
	it("keeps real progress notes", () => {
		expect(isFillerNote(h, "原因を特定: Makefile の依存が欠けていた", "対応中")).toBe(false)
		expect(isFillerNote("", "継続確認1: 初回", "対応中")).toBe(false)
	})
})
