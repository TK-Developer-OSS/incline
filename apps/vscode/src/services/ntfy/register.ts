import * as path from "node:path"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import type { Controller } from "@/sdk/SdkController"
import { Logger } from "@/shared/services/Logger"
import { emitAlarmAck } from "@/integrations/task-tracker/task-events"
import { isAckText, isOwnAlarmText, type NtfyComment } from "./protocol"
import { NtfyWatcher } from "./watcher"

const COMMENT_AUTHOR = "ntfy"

/**
 * ntfy の返信 (INCLINE 以外のメッセージ) を、このウィンドウのプロジェクト宛てなら
 *  1. チャットのタイムラインに挿入し、
 *  2. task.md の「対応中」タスクの履歴にコメントとして追記する。
 * StateManager の初期化後 (activate の終盤) に呼ぶこと。
 */
export function registerNtfyWatcher(context: vscode.ExtensionContext, controller: Controller): void {
	const folder = vscode.workspace.workspaceFolders?.[0]
	if (!folder) {
		return
	}
	const store = new TaskMdStore(path.join(folder.uri.fsPath, "task.md"))

	const watcher = new NtfyWatcher({
		getTopic: () => StateManager.get().getGlobalSettingsKey("ntfyTopic"),
		getProject: () => folder.uri.fsPath,
		onComment: async (comment) => {
			await deliverComment(controller, store, comment)
		},
	})
	watcher.start()
	context.subscriptions.push({ dispose: () => watcher.stop() })
}

async function deliverComment(controller: Controller, store: TaskMdStore, comment: NtfyComment): Promise<void> {
	// INCLINE 自身が送ったアラーム ([FL-Alarm] ...) は同じトピックに載るので、購読側にも戻ってくる。
	// これをコメントとして取り込むと、タイムラインと「対応中」の全カードの履歴に自分のアラーム文が書き込まれる。
	if (isOwnAlarmText(comment.text)) {
		return
	}
	// PWA (INCLINE Alarm) の Acknowledge: "ACK" で始まる返信は、判断待ちのリマインドを止める合図
	const isAck = isAckText(comment.text)
	if (isAck) {
		emitAlarmAck()
	}
	try {
		controller.insertTimelineComment(comment.text, COMMENT_AUTHOR)
	} catch (error) {
		Logger.error("[NTFY] failed to insert comment into timeline", error)
	}
	// ACK は確認応答であって依頼ではない。タイムラインには出すが、カードの履歴には書かない
	// (書くと、対応中のすべてのカードに ACK の行が増える)。
	if (isAck) {
		return
	}
	try {
		const tasks = await store.list()
		for (const task of tasks.filter((t) => t.status === "対応中")) {
			await store.note(task.id, comment.text, COMMENT_AUTHOR)
		}
	} catch (error) {
		Logger.error("[NTFY] failed to append comment to task.md", error)
	}
}
