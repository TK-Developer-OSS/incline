// "Incline Tasks" の Webview ホスト (#95: 下部パネルから、右のセカンダリ サイドバー / エディタ領域のタブへ)。
// task.md を TaskMdStore 経由で読み書きし、ファイル監視 + 30秒ポーリングで追従する。
// 画面の置き場 (セカンダリ サイドバーのビュー / エディタ領域のタブ) は複数同時に持て、attach() で渡す。

import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { isPossibleConfirmReply, TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "./task-md"
import { emitConfirmReply } from "./task-events"
import { type CreateTaskInput, TaskMdStore, type UpdateTaskPatch } from "./task-md-store"
import { getTaskTrackerHtml } from "./task-tracker-webview-html"

/** エディタ領域のタブ (WebviewPanel) の viewType。 */
export const TASK_TRACKER_PANEL_TYPE = "incline.tasksEditor"
/** 右のセカンダリ サイドバーのビュー (WebviewView) の id。 */
export const TASK_TRACKER_VIEW_ID = "incline.tasksView"

/** attach() に渡す画面の置き場。WebviewPanel をそのまま渡せる最小の形 (テストでは偽物を渡す)。 */
export interface TaskWebviewTarget {
	readonly webview: vscode.Webview
	readonly visible: boolean
	onDidChangeVisibility(listener: () => void): vscode.Disposable
	onDidDispose(listener: () => void): vscode.Disposable
}

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { forgetPosition, moveInOrder, reconcileOrder, sortByOrder } from "./task-order"

const AUTHOR_SETTING = "incline.taskTracker.author"
/** 自動リロード間隔 (ms)。ファイル監視が UNC 共有等で発火しない場合の保険。 */
const AUTO_REFRESH_MS = 30_000

function makeNonce(): string {
	let s = ""
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	for (let i = 0; i < 32; i++) {
		s += chars.charAt(Math.floor(Math.random() * chars.length))
	}
	return s
}

export class TaskTrackerViewProvider {
	/** 開いている画面 (サイドバーのビューとエディタのタブを同時に開ける)。値は、その画面のリスナーの後始末。 */
	private readonly targets = new Map<TaskWebviewTarget, vscode.Disposable[]>()
	private autoRefreshTimer: ReturnType<typeof setInterval> | undefined

	constructor(private readonly store: TaskMdStore) {}

	/** Manual order (#15): a list of task ids in a side file next to task.md. */
	private get orderPath(): string {
		return path.join(path.dirname(this.store.path), ".task-order.json")
	}

	private async readOrder(): Promise<number[]> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.orderPath, "utf-8"))
			return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isInteger(n)) : []
		} catch {
			return []
		}
	}

	private async writeOrder(order: readonly number[]): Promise<void> {
		try {
			await fs.writeFile(this.orderPath, JSON.stringify(order), "utf-8")
		} catch (error) {
			Logger.error("[TaskTracker] failed to write the task order:", error)
		}
	}

	private get author(): string {
		const configured = vscode.workspace.getConfiguration().get<string>(AUTHOR_SETTING)?.trim()
		return configured || "me"
	}

	/** 画面 (サイドバーのビュー / エディタのタブ) を受け取って、HTML とメッセージ処理を結びつける。開き直し / 復元でも呼ばれる。 */
	attach(target: TaskWebviewTarget): void {
		if (this.targets.has(target)) {
			this.detach(target)
		}
		target.webview.options = { enableScripts: true, localResourceRoots: [] }
		target.webview.html = getTaskTrackerHtml(makeNonce())

		const listeners: vscode.Disposable[] = [
			target.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
			target.onDidChangeVisibility(() => {
				if (target.visible) {
					void this.postTasks()
				}
			}),
			target.onDidDispose(() => this.detach(target)),
		]
		this.targets.set(target, listeners)

		// ファイル監視が効かない環境 (UNC 共有など) の保険として一定間隔でも読み直す。
		if (!this.autoRefreshTimer) {
			this.autoRefreshTimer = setInterval(() => {
				if ([...this.targets.keys()].some((t) => t.visible)) {
					void this.postTasks()
				}
			}, AUTO_REFRESH_MS)
		}
	}

	/** 見えている画面 (サイドバーのビュー / エディタのタブ) があるか。 */
	hasVisibleView(): boolean {
		return [...this.targets.keys()].some((t) => t.visible)
	}

	/** 画面が閉じられた / 付け替えられた: リスナーを片付け、最後の画面なら編集ロックを解除してタイマーを止める。 */
	private detach(target: TaskWebviewTarget): void {
		for (const d of this.targets.get(target) ?? []) {
			d.dispose()
		}
		this.targets.delete(target)
		if (this.targets.size === 0) {
			void this.store.releaseEditLock()
			if (this.autoRefreshTimer) {
				clearInterval(this.autoRefreshTimer)
				this.autoRefreshTimer = undefined
			}
		}
	}

	/** ファイル監視 / ポーリング / Webview からの要求で呼ぶ: 最新タスクを送る。 */
	async postTasks(): Promise<void> {
		if (this.targets.size === 0) {
			Logger.log("[TaskTracker] postTasks: no open Tasks view")
			return
		}
		try {
			const { tasks, categories } = await this.store.load()
			Logger.log(`[TaskTracker] postTasks: sending ${tasks.length} tasks, ${categories.length} categories to ${this.targets.size} view(s)`)
			const saved = await this.readOrder()
			const order = reconcileOrder(tasks, saved)
			if (order.join(",") !== saved.join(",")) {
				await this.writeOrder(order)
			}
			const message = {
				type: "tasks",
				tasks: sortByOrder(tasks, order),
				categories,
				author: this.author,
				filePath: this.store.path,
			}
			await Promise.all([...this.targets.keys()].map((t) => t.webview.postMessage(message)))
		} catch (error) {
			Logger.error("[TaskTracker] postTasks failed:", error)
		}
	}

	private async handleMessage(msg: unknown): Promise<void> {
		if (!msg || typeof msg !== "object") {
			return
		}
		const m = msg as Record<string, unknown>
		try {
			switch (m.type) {
				case "ready":
				case "refresh":
					await this.postTasks()
					return
				case "categories": {
					const list: string[] = Array.isArray(m.list) ? m.list.map((v) => String(v)) : []
					const renames: Record<string, string> =
						m.renames && typeof m.renames === "object" ? (m.renames as Record<string, string>) : {}
					const { blocked } = await this.store.saveCategories(list, renames, this.author)
					await this.postTasks()
					if (blocked.length) {
						void vscode.window.showWarningMessage(
							`INCLINE Tasks: cannot delete categories that are still in use: ${blocked.join(", ")}`,
						)
					}
					return
				}
				case "openFile": {
					await this.store.ensureFile()
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.store.path))
					await vscode.window.showTextDocument(doc, { preview: false })
					return
				}
				case "create":
					await this.store.create(toCreateInput(m), this.author)
					await this.postTasks()
					return
				case "update": {
					// 『変更を保存』: 未確定の追記 (data-tmp-::) も一緒に確定する。有効な [CONFIRM] があるタスクで
					// 確定したら、返答が来たかもしれないので AI に知らせる (confirm-reply-notifier)。
					const before = m.commitNotes === true ? (await this.store.list()).find((t) => t.id === Number(m.id)) : undefined
					const patch = toPatch(m.patch)
					if (patch.priority !== undefined) {
						const prev = (await this.store.list()).find((t) => t.id === Number(m.id))
						if (prev && prev.priority !== patch.priority) {
							await this.writeOrder(forgetPosition(await this.readOrder(), Number(m.id)))
						}
					}
					await this.store.update(Number(m.id), patch, this.author)
					if (m.commitNotes === true) {
						await this.store.commitNotes(Number(m.id), this.author)
						if (before && isPossibleConfirmReply(before)) {
							emitConfirmReply({ id: before.id, title: before.title })
						}
					}
					await this.postTasks()
					return
				}
				case "reorder": {
					const beforeId = m.beforeId === null || m.beforeId === undefined ? null : Number(m.beforeId)
					await this.writeOrder(moveInOrder(await this.readOrder(), Number(m.id), beforeId))
					await this.postTasks()
					return
				}
				case "note":
					// tmp: 『変更を保存』まで未確定の印 (data-tmp-::) 付きで追記する
					await this.store.note(Number(m.id), String(m.text ?? ""), this.author, undefined, { tmp: m.tmp === true })
					await this.postTasks()
					return
				case "warn":
					// webview では alert() が使えないため、画面内のお知らせとは別にホストの通知でも知らせる
					void vscode.window.showWarningMessage(`INCLINE Tasks: ${String(m.text ?? "")}`)
					return
				case "editing":
					// パネルで編集が始まった / 続いている → ロックファイルを作る・更新する。終わったら解除する。
					if (m.editing === true) {
						if (!(await this.store.holdEditLock())) {
							void vscode.window.showWarningMessage(
								"task.md is being edited by another process (another window / an AI). If saving fails, wait a moment and try again.",
							)
						}
					} else {
						await this.store.releaseEditLock()
					}
					return
				case "discardNotes":
					await this.store.discardNotes(Number(m.id))
					await this.postTasks()
					return
				default:
					Logger.warn(`[TaskTracker] unknown webview message: ${String(m.type)}`)
			}
		} catch (error) {
			Logger.error("[TaskTracker] handleMessage failed:", error)
			void vscode.window.showErrorMessage(
				`INCLINE Tasks: operation failed (${error instanceof Error ? error.message : String(error)})`,
			)
		}
	}

	dispose(): void {
		for (const target of [...this.targets.keys()]) {
			this.detach(target)
		}
	}
}

function pickStatus(v: unknown): TaskStatus | undefined {
	return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : undefined
}

function pickPriority(v: unknown): TaskPriority | undefined {
	return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v) ? (v as TaskPriority) : undefined
}

function toCreateInput(m: Record<string, unknown>): CreateTaskInput {
	return {
		title: String(m.title ?? ""),
		content: m.content ? String(m.content) : undefined,
		priority: pickPriority(m.priority),
		category: typeof m.category === "string" ? m.category : undefined,
	}
}

function toPatch(raw: unknown): UpdateTaskPatch {
	if (!raw || typeof raw !== "object") {
		return {}
	}
	const p = raw as Record<string, unknown>
	const patch: UpdateTaskPatch = {}
	if (typeof p.title === "string") {
		patch.title = p.title
	}
	const status = pickStatus(p.status)
	if (status) {
		patch.status = status
	}
	if (typeof p.category === "string") {
		patch.category = p.category
	}
	const priority = pickPriority(p.priority)
	if (priority) {
		patch.priority = priority
	}
	if (typeof p.assignee === "string") {
		patch.assignee = p.assignee
	}
	if (typeof p.remarks === "string") {
		patch.remarks = p.remarks
	}
	return patch
}
