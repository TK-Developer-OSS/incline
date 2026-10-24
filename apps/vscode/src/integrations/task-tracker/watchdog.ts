// Incline: ウォッチドッグ (#99)。AI が質問や報告のあとに黙って止まるのを防ぐ。
//  一定時間 (既定 5 分) AI が動いていないのに、AI 担当で対応中のタスクが残っているとき、
//   1. INCLINE のエージェントに「無駄に待っているなら動け / 待つ理由はタスクの履歴に書け」と追加メッセージを送る
//   2. マネージャー AI (外部の Claude など) 宛に post_message で知らせる
//  を行う。人間の判断待ち ([CONFIRM]) だけが残っている間は正当な待機なので何もしない。
//  同じ停止中に送る回数には上限があり (MAX_NUDGES)、AI が再び動いたらリセットされる。
// vscode / SdkController 非依存 (WatchdogApi 経由なのでテスト可能)。

import type { TurnPhase } from "@/shared/ExtensionMessage"
import { logActivity } from "@/sdk/activity-log"
import { Logger } from "@/shared/services/Logger"

export const MAX_NUDGES = 6

export interface PendingWork {
	/** AI 担当 (assignee: AI) で対応中のタスクの数。 */
	aiInProgress: number
	/** そのうち、有効な [CONFIRM] で人間の判断を待っているもの。 */
	waitingForHuman: number
	/** 人間待ちではない (= AI が動くべき) タスクの ID。通知文に載せる。 */
	actionableIds?: number[]
}

export interface WatchdogApi {
	phase(): TurnPhase
	taskId(): string | undefined
	pendingWork(): Promise<PendingWork>
	followup(prompt: string): Promise<void>
	postMessage?(to: string, title: string, text: string): Promise<void>
	now?(): number
	/** 現在のセッションの最新メッセージの時刻 (ms)。サンプルの合間に短く動いただけでも「動いた」と分かるように使う。 */
	lastActivityAt?(): number | undefined
	/** レート制限のブレーカーが開いている間は催促しない (枠切れのキーを叩き続けないため)。 */
	rateLimitHalted?(): boolean
}

export type WatchdogDecision = "wrong-phase" | "busy" | "no-work" | "waiting-for-human" | "not-idle-long-enough" | "limit-reached" | "nudge"

/**
 * 催促してよい状態。意図は「Gemini が自問自答 / 質問 / 完了宣言なしの『終わりました』で止まったときに再開を促す」ことで、
 * 見張り番ではない。API エラー (error)、ユーザーの中断 (resumable)、完了済み (completed) では送らない
 * (エラー中の催促は新しいリクエストを起こして、枠切れのキーを叩き直すだけになる)。
 */
const NUDGE_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>(["awaiting_followup", "idle"])

export function decideWatchdog(input: {
	phase?: TurnPhase
	busy: boolean
	idleMs: number
	intervalMs: number
	work: PendingWork
	nudgesSoFar: number
}): WatchdogDecision {
	if (input.busy) {
		return "busy"
	}
	if (input.phase !== undefined && !NUDGE_PHASES.has(input.phase)) {
		return "wrong-phase"
	}
	if (input.work.aiInProgress === 0) {
		return "no-work"
	}
	if (input.work.waitingForHuman >= input.work.aiInProgress) {
		return "waiting-for-human"
	}
	if (input.idleMs < input.intervalMs) {
		return "not-idle-long-enough"
	}
	if (input.nudgesSoFar >= MAX_NUDGES) {
		return "limit-reached"
	}
	return "nudge"
}

export function watchdogPrompt(minutes: number, work: PendingWork): string {
	const waiting = work.waitingForHuman
	const actionable = work.actionableIds && work.actionableIds.length > 0 ? ` Tasks you can act on: ${work.actionableIds.map((id) => `#${id}`).join(", ")}.` : ""
	return [
		`[INCLINE WATCHDOG] You have been idle for about ${minutes} minute(s) while ${work.aiInProgress} task(s) assigned to AI are still in progress.${actionable}`,
		`If you are not waiting for anything, continue with the next step on those tasks now. Write a history note ONLY when there is real new progress or a result; never write "still working" / "continuing" notes (they are discarded and only fill the history). Do not touch tasks that are on hold (保留 / defer) or not in the list above. Never write that you verified, tested or finished something unless you actually did it in this session; do not change a task to 報告 without a real result.`,
		`If you need a human decision on a task, write ONE history note starting with [CONFIRM] there (question, options, your default), then stop.`,
		`Do NOT add notes to a task that already has an open [CONFIRM]${waiting > 0 ? ` (${waiting} such task(s) now)` : ""}: it is waiting for the human, and repeating "[CONFIRM continued]" notes only fills the history.`,
		`If your work is finished, say so once with a completion report and stop; do not reply to this message again.`,
	].join(" ")
}

const isBusy = (phase: TurnPhase) => phase === "streaming" || phase === "awaiting_approval"

/** 一定間隔で見張りを開始する。戻り値で止める。 */
export function startWatchdog(api: WatchdogApi, intervalMinutes: number, sampleMs = 30_000): () => void {
	const intervalMs = Math.max(1, intervalMinutes) * 60_000
	const now = api.now ?? Date.now
	let lastBusyAt = now()
	let lastNudgeAt = 0
	let nudges = 0
	let running = false

	const tick = async () => {
		if (running) {
			return
		}
		running = true
		try {
			if (api.rateLimitHalted?.()) {
				return
			}
			// セッションが無い (「+」で新規画面にした / 閉じた) なら、再開する対象が無いので催促しない。
			if (!api.taskId()) {
				return
			}
			const busy = isBusy(api.phase())
			if (busy) {
				lastBusyAt = now()
				nudges = 0 // 再び動いたので、次の停止ではまた通知できる
				return
			}
			// サンプル (30 秒おき) の合間に短く動いて止まった場合も、最新メッセージの時刻で「動いた」と判定する。
			// 自分が送った通知 (lastNudgeAt) の直後 10 秒以内のメッセージは、通知そのものなので数えない。
			const activity = api.lastActivityAt?.()
			if (activity !== undefined && activity > lastBusyAt && activity > lastNudgeAt + 10_000) {
				lastBusyAt = activity
				nudges = 0
			}
			const t = now()
			const idleMs = t - Math.max(lastBusyAt, lastNudgeAt) // 前回の通知からも数えて、間隔ごとに 1 回
			const work = await api.pendingWork()
			const decision = decideWatchdog({ phase: api.phase(), busy, idleMs, intervalMs, work, nudgesSoFar: nudges })
			if (decision !== "nudge") {
				return
			}
			nudges++
			lastNudgeAt = t
			const minutes = Math.round((t - lastBusyAt) / 60_000)
			logActivity("WATCHDOG", `nudge #${nudges}: idle ${minutes} min, ${work.aiInProgress} AI task(s) in progress`)
			Logger.log(`[Watchdog] nudging (idle ${minutes} min, ${work.aiInProgress} AI task(s) in progress, nudge #${nudges})`)
			await api.postMessage?.("manager", "Watchdog: the INCLINE agent has been idle", watchdogPrompt(minutes, work))
			if (api.taskId() && !isBusy(api.phase())) {
				await api.followup(watchdogPrompt(minutes, work))
			}
		} catch (error) {
			Logger.error("[Watchdog] tick failed:", error)
		} finally {
			running = false
		}
	}

	const timer = setInterval(() => void tick(), sampleMs)
	timer.unref?.()
	return () => clearInterval(timer)
}
