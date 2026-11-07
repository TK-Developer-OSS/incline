// task.md パーサ / シリアライザ (pure, vscode 非依存)。
//
// task.md は Incline の簡易バックログ。下部パネル "Incline Tasks" の Webview と
// AI ツール `task_tracker` の両方がこのモジュール経由で読み書きする。
//
// 往復安全性 (parse -> serialize -> parse が安定):
//  - 冒頭ブロック (最初の `## [#N] ` 見出しより前) は verbatim 保持
//  - `### 履歴` 以降は不透明文字列として保持、追記のみ・整形しない
//  - メタ行 (`- key: value`) だけを正規化して再生成する

export type TaskStatus = "未着手" | "対応中" | "報告" | "差戻" | "保留" | "完了" | "削除"

export const TASK_STATUSES: readonly TaskStatus[] = ["未着手", "対応中", "報告", "差戻", "保留", "完了", "削除"] as const

/** `## カテゴリ` セクションが無い / 空のときに使う既定のカテゴリ一覧。 */
export const DEFAULT_CATEGORIES: readonly string[] = ["バグ", "タスク", "設計", "メモ"]

export type TaskPriority = "HIGH" | "MIDDLE" | "LOW"

export const TASK_PRIORITIES: readonly TaskPriority[] = ["HIGH", "MIDDLE", "LOW"] as const

const PRIORITY_RANK: Record<TaskPriority, number> = { HIGH: 0, MIDDLE: 1, LOW: 2 }

export interface Task {
	id: number
	/** 件名 */
	title: string
	status: TaskStatus
	/** カテゴリ */
	category: string
	/** 優先度 (一覧は HIGH が上) */
	priority: TaskPriority
	/** 担当者 */
	assignee: string
	/** 登録者 */
	creator: string
	/** 登録日時 "YYYY-MM-DD HH:MM" */
	created: string
	/** 更新者 */
	updater: string
	/** 更新日時 "YYYY-MM-DD HH:MM" */
	updated: string
	/** 備考 */
	remarks: string
	/** 内容 (掲示板履歴)。`### 履歴` 見出し直後の生テキスト。追記のみ。 */
	history: string
}

export interface ParsedTaskMd {
	/** 最初のセクション見出し (`## [#N]` / `## カテゴリ`) より前の全文 (verbatim)。 */
	preamble: string
	tasks: Task[]
	/** `## カテゴリ` セクションの項目。無ければ DEFAULT_CATEGORIES。 */
	categories: readonly string[]
}

/**
 * task.md が無い / 冒頭ブロックが空のときに書き込む既定の前文。AI (Claude Code など) が最初に読む取扱説明書なので英語で書く。
 * 注意: 前文は最初の `## [#N]` / `## カテゴリ` で終わる。ここに例を書くときは、その形の行が行頭に来ないよう字下げすること。
 */
export const DEFAULT_PREAMBLE = `# INCLINE Tasks (task.md)

This file is a backlog shared by the human (INCLINE Tasks panel), the AI agents, and other VS Code windows.
It is plain Markdown. A strict parser reads it, so follow the format below exactly.

## READ THIS FIRST (for AI agents)
- Prefer the tools over editing this file by hand: the \`task_tracker\` tool, or the INCLINE MCP tools
  (\`task_list\`, \`task_create\`, \`task_update\`, \`task_note\`). They take the lock, assign IDs, stamp times and keep the format valid.
- If you must edit the file directly: create \`task.md.lock\` first and delete it right after your last edit (if the lock is
  younger than 15 minutes, someone else is editing: wait). Re-read the file just before editing and change only what you need.
- Never rewrite the whole file from an older copy. Never delete or reorder existing tasks or history lines.

## Format
- One task = one section that starts with \`## [#<ID>] <title>\`. The ID is a number: the highest existing ID + 1.
  Only headings of this exact form are tasks; any other heading (including every heading in this introduction) is ignored.
- Right under the heading, metadata lines, one per line, as \`- <key>: <value>\` (indent and order do not matter):
  - \`status\`: 未着手 (not started) | 対応中 (in progress) | 報告 (reported: the work is done, waiting for the human to check) |
    差戻 (sent back by the human for rework) | 保留 (on hold / blocked) | 完了 (done) | 削除 (soft-deleted). Keep these exact words.
  - \`category\`: one of the names listed in the "## カテゴリ" section below (optional).
  - \`priority\`: HIGH | MIDDLE | LOW (default MIDDLE).
  - \`assignee\`: who works on it (TK / AI / empty). \`creator\` / \`created\`: who and when (YYYY-MM-DD HH:MM). \`updater\` / \`updated\`: update them on every change.
  - \`備考\`: optional free remark.
- Then a \`### 履歴\` (history) heading. Under it, one line per note: \`- <YYYY-MM-DD HH:MM> <name>: <text>\`.
  History is **append-only**: add lines at the end, never edit, reformat or delete existing lines.
  A line whose text starts with \`data-tmp-::\` is the human's unsaved draft: do not touch it.

Example (indented here only so that it is not parsed as a task):

    ## [#12] Fix the login redirect
    - status: 対応中
    - category: バグ
    - priority: HIGH
    - assignee: AI
    - creator: TK
    - created: 2026-10-31 09:00
    - updater: AI
    - updated: 2026-10-31 09:30
    - 備考: reported on the staging site

    ### 履歴
    - 2026-10-31 09:00 TK: The redirect loops after login. Please fix.
    - 2026-10-31 09:30 AI: Started. The cause looks like the session cookie path.

## Workflow rules
- Start a task: set status 対応中 and assignee AI. Add a short history line at each milestone.
- Finish: add a final report to the history (what you did, how you verified it, what is left) and set status 報告.
  Only the human sets 完了 or 削除 (unless the human explicitly asked you to for that task). Use 保留 if you are blocked.
- 差戻 means the human sent it back: read the newest human note, redo the work, set 対応中, then report again.
- Need a human decision? Add a history line whose text STARTS with \`[CONFIRM]\` (question, options, your default). The card blinks and
  the human's phone is alerted. A later line starting with \`[RESOLVED]\` cancels it (\`[CONFIRM:topic]\` / \`[RESOLVED:topic]\` for several at once).
  A report is not a question: never start a report with [CONFIRM].
- Do not report as done anything that is untested or unverified: say exactly what is unverified.

---
`

const HEADING_RE = /^##\s+\[#(\d+)\]\s?(.*)$/
const META_RE = /^\s*-\s*([^:：]+?)\s*[:：]\s*(.*)$/
const HISTORY_HEADING_RE = /^###\s+履歴\s*$/
/** カテゴリ定義セクションの見出し。前文とは別扱いにする (往復安定のため)。 */
const CATEGORY_HEADING_RE = /^##\s+カテゴリ\s*$/
/** カテゴリ項目行 (`- <名前>`)。`---` などは弾くため空白必須。 */
const CATEGORY_ITEM_RE = /^\s*-\s+(\S.*?)\s*$/
/** 前文の終端 = 最初の `## [#N]` か `## カテゴリ`。 */
const SECTION_START_RE = /^##\s+(?:\[#\d+\]|カテゴリ\s*$)/

export function normalizeStatus(value: string | undefined): TaskStatus {
	const v = (value ?? "").trim()
	return (TASK_STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : "未着手"
}

export function normalizePriority(value: string | undefined): TaskPriority {
	const v = (value ?? "").trim().toUpperCase()
	if (v === "MID" || v === "MED" || v === "NORMAL") {
		return "MIDDLE"
	}
	return (TASK_PRIORITIES as readonly string[]).includes(v) ? (v as TaskPriority) : "MIDDLE"
}

/**
 * 並び順: 有効な判断待ち ([CONFIRM]) があるタスクが最優先 (優先度に関係なく先頭)、次に優先度 (HIGH→LOW)、
 * 同順位は id 昇順。完了 / 削除は未完了 (LOW 含む) の下にまとめる。元配列は変更しない。
 */
export function sortByPriority(tasks: readonly Task[]): Task[] {
	const closed = (t: Task) => (t.status === "完了" || t.status === "削除" ? 1 : 0)
	const confirm = (t: Task) => (needsConfirmation(t) ? 0 : 1)
	return [...tasks].sort(
		(a, b) => closed(a) - closed(b) || confirm(a) - confirm(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id,
	)
}

/** `YYYY-MM-DD HH:MM` (ローカル時刻)。 */
export function formatTimestamp(date: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0")
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

/** 次に採番すべき ID (既存最大 +1、無ければ 1)。 */
export function nextTaskId(tasks: readonly Task[]): number {
	return tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1
}

function parseTaskBlock(id: number, title: string, blockLines: string[]): Task {
	const histIdx = blockLines.findIndex((l) => HISTORY_HEADING_RE.test(l.trim()))
	const metaLines = histIdx === -1 ? blockLines : blockLines.slice(0, histIdx)
	const historyLines = histIdx === -1 ? [] : blockLines.slice(histIdx + 1)

	const meta: Record<string, string> = {}
	for (const line of metaLines) {
		const m = line.match(META_RE)
		if (m) {
			meta[m[1].trim()] = m[2].trim()
		}
	}
	const get = (...keys: string[]): string => {
		for (const k of keys) {
			if (meta[k] !== undefined) {
				return meta[k]
			}
		}
		return ""
	}

	return {
		id,
		title: title.trim(),
		status: normalizeStatus(get("status", "ステータス")),
		category: get("category", "カテゴリ"),
		priority: normalizePriority(get("priority", "優先度")),
		assignee: get("assignee", "担当者"),
		creator: get("creator", "登録者"),
		created: get("created", "登録日時"),
		updater: get("updater", "更新者"),
		updated: get("updated", "更新日時"),
		remarks: get("備考", "remarks", "備考欄"),
		history: historyLines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, ""),
	}
}

export function parseTaskMd(text: string): ParsedTaskMd {
	const lines = text.split(/\r?\n/)
	const firstIdx = lines.findIndex((l) => SECTION_START_RE.test(l))
	if (firstIdx === -1) {
		return { preamble: text.replace(/\s+$/, ""), tasks: [], categories: [...DEFAULT_CATEGORIES] }
	}

	const preamble = lines.slice(0, firstIdx).join("\n").replace(/\s+$/, "")
	const tasks: Task[] = []
	let categories: string[] | undefined

	let i = firstIdx
	while (i < lines.length) {
		// `## カテゴリ` セクション: 次のセクション見出しまでの `- <名前>` を拾う。
		if (CATEGORY_HEADING_RE.test(lines[i])) {
			const collected: string[] = []
			let j = i + 1
			while (j < lines.length && !SECTION_START_RE.test(lines[j]) && !HEADING_RE.test(lines[j])) {
				const item = lines[j].match(CATEGORY_ITEM_RE)
				if (item) {
					collected.push(item[1].trim())
				}
				j++
			}
			categories = dedupeNonEmpty(collected)
			i = j
			continue
		}

		const m = lines[i].match(HEADING_RE)
		if (!m) {
			i++
			continue
		}
		const id = Number(m[1])
		const title = m[2]
		let j = i + 1
		const block: string[] = []
		while (j < lines.length && !HEADING_RE.test(lines[j])) {
			block.push(lines[j])
			j++
		}
		tasks.push(parseTaskBlock(id, title, block))
		i = j
	}

	return { preamble, tasks, categories: categories?.length ? categories : [...DEFAULT_CATEGORIES] }
}

/** 空要素を除き、順序を保って重複を落とす。 */
export function dedupeNonEmpty(values: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const v of values) {
		const t = v.trim()
		if (t && !seen.has(t)) {
			seen.add(t)
			out.push(t)
		}
	}
	return out
}

export function serializeTask(task: Task): string {
	const out: string[] = []
	out.push(`## [#${task.id}] ${task.title}`.trimEnd())
	out.push(`- status: ${task.status}`)
	if (task.category.trim()) {
		out.push(`- category: ${task.category}`)
	}
	out.push(`- priority: ${task.priority}`)
	out.push(`- assignee: ${task.assignee}`)
	out.push(`- creator: ${task.creator}`)
	out.push(`- created: ${task.created}`)
	out.push(`- updater: ${task.updater}`)
	out.push(`- updated: ${task.updated}`)
	if (task.remarks.trim()) {
		out.push(`- 備考: ${task.remarks}`)
	}
	out.push("")
	out.push("### 履歴")
	if (task.history.trim()) {
		out.push(task.history.replace(/\s+$/, ""))
	}
	return out.join("\n")
}

export function serializeTaskMd(parsed: ParsedTaskMd): string {
	const preamble = (parsed.preamble.trim() ? parsed.preamble : DEFAULT_PREAMBLE).replace(/\s+$/, "")
	const parts = [preamble]

	// カテゴリ定義セクション。前文とは独立に毎回再生成する (parseTaskMd が前文から分離して読む)。
	const categories = dedupeNonEmpty(parsed.categories?.length ? parsed.categories : DEFAULT_CATEGORIES)
	parts.push("", "## カテゴリ", ...categories.map((c) => `- ${c}`))

	for (const task of parsed.tasks) {
		parts.push("")
		parts.push(serializeTask(task))
	}
	return `${parts.join("\n").replace(/\s+$/, "")}\n`
}

/**
 * 一時 (未確定) の追記行を示す印。「追記」ボタンで書いた行は、『変更を保存』で確定するまで
 * この印付きでファイルに残る (リロード・別ウィンドウでも失われない)。
 * 確定で印を外し、『破棄』で行ごと消す。AI / 人間が直接読んでも未確定と分かる。
 */
export const TMP_NOTE_MARK = "data-tmp-::"
const TMP_NOTE_LINE = /^(- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: )data-tmp-::/m

/** 履歴に未確定の追記行があるか。 */
export function hasTmpNotes(history: string): boolean {
	return TMP_NOTE_LINE.test(history)
}

/** 未確定の追記行の印を外して確定する。 */
export function commitTmpNotes(history: string): string {
	return history.replace(/^(- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: )data-tmp-::/gm, "$1")
}

/** 未確定の追記行を削除する。 */
export function discardTmpNotes(history: string): string {
	return history
		.split("\n")
		.filter((line) => !/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: data-tmp-::/.test(line))
		.join("\n")
		.replace(/\s+$/, "")
}

/**
 * 判断待ち (#CONFIRM): 履歴の行の本文が `[CONFIRM]` で始まる行が「判断待ち」で、後の `[RESOLVED]` で始まる行が打ち消す。
 *  - `[CONFIRM:tag]` / `[RESOLVED:tag]` のように tag を付けると、同じ tag のものどうしで対応する。
 *  - tag の無い `[RESOLVED]` は、その時点で有効な判断待ちをすべて打ち消す。
 *  - 本文の途中に書かれた `[CONFIRM]` (説明文など) は発火しない。未確定の追記 (data-tmp-::) の行も数えない。
 * 行番号は、空行を除いた履歴の行の通し番号 (0 始まり)。webview の判定 (task-tracker-webview-html.ts) と同じ規則。
 */
const CONFIRM_LINE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: \[(CONFIRM|RESOLVED)(?::([^\]\s]+))?\]/

export interface OpenConfirm {
	/** 空行を除いた履歴の行の通し番号。 */
	line: number
	tag?: string
}

export function findOpenConfirms(history: string): OpenConfirm[] {
	let open: OpenConfirm[] = []
	history
		.split("\n")
		.filter((l) => l.trim())
		.forEach((l, line) => {
			const m = l.match(CONFIRM_LINE)
			if (!m) {
				return
			}
			const tag = m[2]
			if (m[1] === "CONFIRM") {
				open.push({ line, ...(tag ? { tag } : {}) })
			} else {
				open = tag ? open.filter((c) => c.tag !== tag) : []
			}
		})
	return open
}

/**
 * 『[CONFIRM 継続]』のような、すでに判断待ちのタスクへの重ね書きを弾く (#111)。
 * - すでに有効な [CONFIRM] があるタスクに、見出しに 継続 / continued / reminder / still を含む [CONFIRM...] を足そうとした
 * - 同じトピックの [CONFIRM:topic] がすでに有効
 * のとき true (= 追記しない)。新しいトピックの [CONFIRM:別トピック] は通す。
 */
export function isRedundantConfirmNote(history: string, text: string): boolean {
	const t = text.trim()
	if (!/^\[CONFIRM/i.test(t)) {
		return false
	}
	const open = findOpenConfirms(history)
	if (open.length === 0) {
		return false
	}
	const head = t.match(/^\[[^\]]*\]/)?.[0] ?? ""
	if (/継続|continu|reminder|still|再/i.test(head)) {
		return true
	}
	const topic = head.match(/^\[CONFIRM:([^\]]+)\]$/i)?.[1]
	return topic !== undefined && open.some((c) => c.tag === topic)
}

/** 履歴の行から「日時 名前: 」の接頭辞を除いた本文。 */
const historyBody = (line: string) => line.replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\s:]+: /, "")
/** 数字と空白をならして、番号だけが違う定型文 (「継続確認1」「継続確認2」…) を同じとみなす。 */
const normalizeFiller = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80)

/**
 * 中身のない定型の進捗メモ (「継続確認N: …を継続中」「[WATCHDOG] …」) を弾く (#99)。ウォッチドッグの通知に従って、
 * Gemini が毎回同じ文を書き足して履歴が埋まる、保留 / 完了のカードにも書かれる、への対策。
 * - 見出しが [WATCHDOG] / 継続確認 の定型で、タスクが 対応中 / 差戻 でない (保留 / 未着手 / 報告 / 完了 / 削除) → 弾く
 * - 直近 5 行のどれかと、数字をならした本文が同じ → 弾く (進捗が無い繰り返し)
 */
export function isFillerNote(history: string, text: string, status: string): boolean {
	const t = text.trim()
	const looksFiller = /^\[WATCHDOG\]|継続確認|^\[?継続中\]?/.test(t)
	if (looksFiller && status !== "対応中" && status !== "差戻") {
		return true
	}
	const recent = history.split("\n").filter((l) => l.trim()).slice(-5).map((l) => normalizeFiller(historyBody(l)))
	return recent.includes(normalizeFiller(t))
}

/** 完了 / 削除でないタスクに、有効な判断待ちがあるか。 */
export function needsConfirmation(task: { status: string; history: string }): boolean {
	return task.status !== "完了" && task.status !== "削除" && findOpenConfirms(task.history).length > 0
}

/**
 * 『変更を保存』で未確定の追記が確定したとき、それが有効な判断待ち ([CONFIRM]) への返答かもしれないか。
 * 保存前に有効な [CONFIRM] があり (未確定の行は数えない)、未確定の追記が1行以上確定した場合に true。
 * 確定した行は履歴の末尾 = [CONFIRM] の行の次以降になる。
 */
export function isPossibleConfirmReply(before: { status: string; history: string }): boolean {
	return hasTmpNotes(before.history) && needsConfirmation({ status: before.status, history: discardTmpNotes(before.history) })
}

/** 履歴に1行追記する (`- <日時> <名前>: <本文>`)。tmp なら未確定の印を付ける。 */
export function appendHistoryLine(
	history: string,
	author: string,
	text: string,
	at: Date = new Date(),
	opts: { tmp?: boolean } = {},
): string {
	const line = `- ${formatTimestamp(at)} ${author}: ${opts.tmp ? TMP_NOTE_MARK : ""}${text.replace(/\s+/g, " ").trim()}`
	const base = history.replace(/\s+$/, "")
	return base ? `${base}\n${line}` : line
}
