// AI 向けツール `task_tracker`。Incline のバックログ (task.md) を読み書きする。
// createVscodeExtraTools 経由でセッションの extraTools に追加される。
// AI が書き込むときの登録者/更新者は常に "AI"。

import type { AgentTool } from "@cline/shared"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"
import { needsConfirmation, TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "./task-md"
import { TaskMdStore } from "./task-md-store"

const AUTHOR = "AI"

interface TaskTrackerToolInput {
	action?: "list" | "create" | "update" | "note"
	id?: number
	title?: string
	content?: string
	text?: string
	status?: TaskStatus
	category?: string
	priority?: TaskPriority
	assignee?: string
	remarks?: string
}

const INPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: ["list", "create", "update", "note"],
			description:
				"list=全タスク取得 / create=新規登録 / update=件名・状態・カテゴリ・担当・備考の変更 / note=履歴(掲示板)に1行追記",
		},
		id: { type: "number", description: "update / note の対象タスク ID" },
		title: { type: "string", description: "件名 (create 必須、update 任意)" },
		content: { type: "string", description: "create 時の初回履歴 (内容)。省略時は「登録。」" },
		text: { type: "string", description: "note で履歴に追記するコメント本文" },
		status: { type: "string", enum: [...TASK_STATUSES], description: "ステータス" },
		category: { type: "string", description: "カテゴリ (task.md の `## カテゴリ` にある値。例: バグ / タスク / 設計 / メモ)" },
		priority: { type: "string", enum: [...TASK_PRIORITIES], description: "優先度 (一覧は HIGH が上、省略時 MIDDLE)" },
		assignee: { type: "string", description: '担当者 (自分がやるなら "AI")' },
		remarks: { type: "string", description: "備考 (短いメモ。履歴ではない)。進捗や完了報告は action=note の text に書く" },
	},
	required: ["action"],
}

const DESCRIPTION = [
	"Incline のバックログ task.md を読み書きする。ユーザーから受けた作業や自分で見つけた ToDo を",
	"タスクとして登録・更新し、進捗を履歴に残すのに使う。",
	"使いどころ: 作業に着手したら該当タスクを status=対応中 & assignee=AI にする / 区切りごとに",
	"action=note で1行進捗を残す / 作業が終わったら action=note で完了報告 (何をしたか・どう確認したか・残り) を残し、",
	"status を 報告 にする (人間が確認待ちの印。完了 / 削除 にするのは人間。明示的に頼まれたときだけ例外) / 新しい課題に気付いたら action=create。",
	"人間が 差戻 にしたタスクは、最新の人間のメモ (理由) を読んでやり直し、着手で 対応中、終えたら再び 報告。人間の判断が要るときは action=note で本文を [CONFIRM] で始める (質問・選択肢・あなたの既定の選択を書く)。パネルのそのタスクが赤く点滅する。人間が [RESOLVED] で打ち消す。",
	"（削除は soft delete。行は残る。）",
].join(" ")

function formatTaskLine(t: {
	id: number
	title: string
	status: string
	priority: string
	assignee: string
	updated: string
	history?: string
}): string {
	// 有効な判断待ち ([CONFIRM] が [RESOLVED] で打ち消されていない) があれば、一覧でも分かるようにする
	const confirm = t.history !== undefined && needsConfirmation({ status: t.status, history: t.history }) ? " ⚠CONFIRM" : ""
	return `#${t.id} [${t.priority}] [${t.status}] ${t.title}${t.assignee ? ` (@${t.assignee})` : ""} — updated ${t.updated}${confirm}`
}

export function createTaskTrackerTool(cwd: string): AgentTool {
	const store = new TaskMdStore(path.join(cwd || process.cwd(), "task.md"))

	const execute = async (rawInput: unknown): Promise<string> => {
		const input = (rawInput ?? {}) as TaskTrackerToolInput
		try {
			switch (input.action) {
				case "list": {
					const tasks = await store.list()
					return tasks.length === 0 ? "タスクはまだありません。" : tasks.map(formatTaskLine).join("\n")
				}
				case "create": {
					if (!input.title?.trim()) {
						return "エラー: create には title が必要です。"
					}
					const task = await store.create(
						{
							title: input.title,
							content: input.content,
							status: input.status,
							category: input.category,
							priority: input.priority,
							assignee: input.assignee,
							remarks: input.remarks,
						},
						AUTHOR,
					)
					return `登録しました: ${formatTaskLine(task)}`
				}
				case "update": {
					if (typeof input.id !== "number") {
						return "エラー: update には id が必要です。"
					}
					const before = input.status !== undefined ? (await store.list()).find((t) => t.id === input.id) : undefined
					const task = await store.update(
						input.id,
						{
							title: input.title,
							status: input.status,
							category: input.category,
							priority: input.priority,
							assignee: input.assignee,
							remarks: input.remarks,
						},
						AUTHOR,
					)
					// 状態を変える update では、状態の変更と、渡された備考 / 本文を履歴にも 1 行残す。モデルが完了報告を
					// 履歴 (note) でなく備考 (remarks) に書いても、報告が消えないようにする (シナリオテストで発覚)。
					if (task && before && input.status !== undefined && before.status !== task.status) {
						const detail = (input.text ?? input.remarks ?? "").trim()
						await store.note(input.id, `ステータス: ${before.status} → ${task.status}${detail ? `。${detail}` : ""}`, AUTHOR)
					}
					return task ? `更新しました: ${formatTaskLine(task)}` : `エラー: #${input.id} が見つかりません。`
				}
				case "note": {
					if (typeof input.id !== "number" || !input.text?.trim()) {
						return "エラー: note には id と text が必要です。"
					}
					const task = await store.note(input.id, input.text, AUTHOR, {
						status: input.status,
						category: input.category,
						priority: input.priority,
						assignee: input.assignee,
						remarks: input.remarks,
					})
					return task ? `追記しました: ${formatTaskLine(task)}` : `エラー: #${input.id} が見つかりません。`
				}
				default:
					return `エラー: action は list|create|update|note のいずれか (受領: ${String(input.action)})`
			}
		} catch (error) {
			Logger.error("[TaskTracker] tool error:", error)
			return `エラー: ${error instanceof Error ? error.message : String(error)}`
		}
	}

	return {
		name: "task_tracker",
		description: DESCRIPTION,
		inputSchema: INPUT_SCHEMA,
		execute,
	}
}
