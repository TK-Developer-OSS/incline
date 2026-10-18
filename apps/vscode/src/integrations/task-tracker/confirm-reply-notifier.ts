// Incline: 人間が『変更を保存』で [CONFIRM] の次の行を確定したら、返答が来たかもしれないことを AI に知らせる。
//  1. メッセージ (post_message) に「AI 宛」で残す (read_messages で読める。ログには本文を出さない)。
//  2. このウィンドウに AI のセッションがあり、いま実行中でなければ、そのセッションへ追加メッセージを送って起こす。
//     (実行中のときは割り込まない。AI は task_list の ⚠CONFIRM と履歴で気付ける)
//  3. このウィンドウに AI のセッションが無ければ、人間に「解決にする」を出す (onNoAgent)。AI がいないと誰も判定しないため。
// vscode / SdkController 非依存 (ConfirmNotifierApi 経由なのでテスト可能)。

import type { TurnPhase } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { type ConfirmReply, onConfirmReply } from "./task-events"

export interface ConfirmNotifierApi {
	/** このウィンドウの現在のセッション (無ければ undefined)。 */
	taskId(): string | undefined
	phase(): TurnPhase
	/** セッションへ追加メッセージ (通常の入力と同じ扱い) を送る。 */
	followup(prompt: string): Promise<void>
	/** AI 宛のメッセージとして残す (無ければ省略)。 */
	postMessage?(to: string, title: string, text: string): Promise<void>
	/**
	 * 判定してくれる AI のセッションが無いとき (このウィンドウに実行中でも待機中でもセッションが無い) に呼ばれる。
	 * 人間に「解決にする」を出すなど、AI なしで決着をつける手段を用意するためのフック。
	 */
	onNoAgent?(reply: ConfirmReply): void
}

export function confirmReplyPrompt(reply: ConfirmReply): string {
	return [
		`[INCLINE NOTICE] The human saved a new line on task #${reply.id} "${reply.title}" after your [CONFIRM] line. It may be the answer to your question.`,
		`Read the task history now (task_list, then the lines after your [CONFIRM]) and act on the answer.`,
		`If the question is answered, add a note starting with [RESOLVED] that states the decision; if the reply does not answer it, keep waiting (do not add [RESOLVED]).`,
	].join(" ")
}

/** AI を起こしてよい状態か: セッションがあり、実行中 (streaming) でも承認待ちでもない。 */
export function canWakeAgent(api: Pick<ConfirmNotifierApi, "taskId" | "phase">): boolean {
	if (!api.taskId()) {
		return false
	}
	const phase = api.phase()
	return phase !== "streaming" && phase !== "awaiting_approval"
}

export function registerConfirmReplyNotifier(api: ConfirmNotifierApi): () => void {
	return onConfirmReply((reply) => {
		void (async () => {
			try {
				await api.postMessage?.("ai", `Reply saved on task #${reply.id}`, confirmReplyPrompt(reply))
			} catch (error) {
				Logger.error("[ConfirmReply] failed to post the notice message:", error)
			}
			if (!api.taskId()) {
				// 判定する AI のセッションが無い: 誰も [RESOLVED] を書かないので、人間が決着をつけられるようにする
				api.onNoAgent?.(reply)
			} else if (canWakeAgent(api)) {
				try {
					Logger.log(`[ConfirmReply] waking the agent for task #${reply.id}`)
					await api.followup(confirmReplyPrompt(reply))
				} catch (error) {
					Logger.error("[ConfirmReply] failed to send the notice to the agent:", error)
				}
			}
		})()
	})
}
