import { describeProviderError } from "@/shared/provider-error"
import type { AgentEvent, CoreSessionEvent } from "@cline/core"
import { refreshClineRecommendedModels } from "@/core/controller/models/refreshClineRecommendedModels"
import type { StateManager } from "@/core/storage/StateManager"
import { CLINE_RECOMMENDED_MODELS_FALLBACK } from "@/shared/cline/recommended-models"
import type { ClineApiReqInfo, TurnPhase } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { isClineManagedProvider } from "@/shared/utils/cline"
import type { MessageTranslatorState, TranslationResult } from "./message-translator"
import { translateSessionEvent } from "./message-translator"
import { PROVIDER_FAILURE_ERROR_TYPE, PROVIDER_FAILURE_PHASE, type ProviderFailureTelemetry } from "./provider-failure-telemetry"
import { dynamicModelRateLimiter, formatRetryLimit, isRateLimitErrorText, rateLimitMaxRetriesFor, rateLimitRetryDelayMs } from "./rate-limiter"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkTaskHistory } from "./sdk-task-history"
import type { TaskProxy } from "./task-proxy"

function normalizeModelId(modelId: string): string {
	return modelId.trim().toLowerCase()
}

type AgentFailureTelemetry = Pick<ProviderFailureTelemetry, "sessionId" | "error" | "errorType"> | undefined

export interface SdkSessionEventCoordinatorOptions {
	messageTranslatorState: MessageTranslatorState
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	getTask: () => TaskProxy | undefined
	postStateToWebview: () => Promise<void>
	stateManager?: StateManager
	translateSessionEvent?: (event: CoreSessionEvent, state: MessageTranslatorState) => TranslationResult
	isClineFreeModel?: () => Promise<boolean>
	/**
	 * Set the authoritative UI turn phase. Called as the agent streams (streaming), on a
	 * completed turn (completed if attempt_completion was used, else awaiting_followup), and on
	 * error. Optional for tests.
	 */
	setTurnPhase?: (phase: TurnPhase, anchorTs?: number) => void
	/** Current authoritative UI turn phase, from the controller's TurnStateTracker. */
	getTurnPhase?: () => TurnPhase
	captureProviderApiError?: (event: ProviderFailureTelemetry) => void
	beginProviderFailureTelemetryTurn?: () => void
}

export class SdkSessionEventCoordinator {
	private readonly translateSessionEvent: (event: CoreSessionEvent, state: MessageTranslatorState) => TranslationResult

	// Incline: レート制限 / クォータ超過の自動リトライ状態。実際の待機と再送は
	// VscodeSessionHost.send() が行い、ここは UI 反映 (エラー相 → streaming に
	// 留める = Retry ボタンを出さない + カウントダウン表示) を担当する。
	//
	// 1回の失敗は `error` イベント (詳細メッセージ有り) と直後の `done`
	// (reason:"error"、text が空のことが多い) の2発で届く。`episodeActive` で
	// 「いまレート制限リトライ中」を持ち越し、`turnCounted` で同一ターンの
	// 二重カウントを防ぐ (`iteration_start` でリセット)。
	private rlEpisodeActive = false
	private rlRetryCount = 0
	private rlTurnCounted = false
	private retryStatusTs: number | undefined
	private retryStatusTicker: ReturnType<typeof setInterval> | undefined
	private retryDeadlineMs = 0
	private retrySessionId: string | undefined

	constructor(private readonly options: SdkSessionEventCoordinatorOptions) {
		this.translateSessionEvent = options.translateSessionEvent ?? translateSessionEvent
	}

	async handleSessionEvent(event: CoreSessionEvent): Promise<void> {
		this.logQueueEvents(event)

		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession || event.payload.sessionId !== activeSession.sessionId) {
			Logger.debug(
				`[SdkController] Ignoring stale SDK event for session ${event.payload.sessionId}; active=${activeSession?.sessionId ?? "none"}`,
			)
			return
		}

		if (event.type === "pending_prompts") {
			this.options.sessions.setQueuedPromptCount(event.payload.prompts.length)
			this.options.postStateToWebview().catch((err) => {
				Logger.error("[SdkController] Failed to post pending-prompt state update:", err)
			})
		}

		const result = this.translateSessionEvent(event, this.options.messageTranslatorState)
		const agentFailure = this.getAgentFailureTelemetry(event)
		if (agentFailure && !this.options.messageTranslatorState.isSuppressedToolApprovalDenial(agentFailure.error)) {
			this.options.captureProviderApiError?.({
				sessionId: agentFailure.sessionId,
				error: agentFailure.error,
				errorType: agentFailure.errorType,
				failurePhase: PROVIDER_FAILURE_PHASE.STREAMING,
			})
		}

		// Incline: このイベント (またはこのターンの直前の失敗) がレート制限 /
		// クォータ超過を示すか。`error` イベントの詳細メッセージと `done` の text
		// (空のこともある) と、翻訳済みメッセージ本文を広めに拾う。
		// 実際の失敗イベント (agentFailure 有り or errorSeen) のときだけエピソードを
		// 立てる — 通常メッセージ本文が "rate limit" 等を含んでも誤爆しないように。
		const failureText = this.collectFailureText(event, result, agentFailure)
		const isRealFailure = !!agentFailure || this.options.messageTranslatorState.wasErrorSeen()
		if (isRealFailure && failureText && isRateLimitErrorText(failureText)) {
			this.rlEpisodeActive = true
		}
		if (event.type === "agent_event") {
			const ae = event.payload.event as AgentEvent
			// 新しいモデルリクエストの開始 = このターンぶんのカウントはまだ、に戻す。
			if (ae.type === "iteration_start") {
				this.rlTurnCounted = false
			}
			// Incline: 動的 RPM/TPM スロットリング (beforeModel) の TPM 計算に
			// per-turn のトークン実績を供給する。
			if (ae.type === "usage") {
				dynamicModelRateLimiter.recordUsage(
					(ae.inputTokens ?? 0) +
						(ae.outputTokens ?? 0) +
						(ae.cacheReadTokens ?? 0) +
						(ae.cacheWriteTokens ?? 0),
				)
			}
			// モデルが実際に出力した / 反復が完走した = 前進。エピソード終了扱いにし、
			// 連続失敗カウントとカウントダウンをリセット (host 側 send() の
			// retryRunMadeProgress と歩調を合わせる)。
			const progressed =
				ae.type === "iteration_end" ||
				(ae.type === "content_end" && ae.contentType === "text" && !ae.error) ||
				(ae.type === "usage" && ae.outputTokens > 0)
			if (progressed && this.rlEpisodeActive) {
				Logger.log(`[SdkController] Rate-limit episode: progress (${ae.type}); resetting retry count from ${this.rlRetryCount}`)
				this.endRateLimitEpisode()
			}
			// done(reason != "error") = 成功 / 中断 / 上限など。エピソードを畳んで
			// 下の相判定に通常フローを取らせる (中断時に抑制ループへ落ちないように)。
			if (ae.type === "done" && ae.reason !== "error" && this.rlEpisodeActive) {
				Logger.log(`[SdkController] Rate-limit episode ended by done(reason=${ae.reason})`)
				this.endRateLimitEpisode()
			}
		}
		if (event.type === "pending_prompt_submitted") {
			this.options.beginProviderFailureTelemetryTurn?.()
			this.options.messageTranslatorState.clearTurnOutcome()
			this.options.sessions.setRunning(true)
			this.options.setTurnPhase?.(PROVIDER_FAILURE_PHASE.STREAMING)
		}
		const zeroCostPromise = this.zeroCostForFreeClineModel(result)
		if (zeroCostPromise) {
			await zeroCostPromise
		}

		if (!activeSession.isRunning && result.messages.length > 0) {
			result.messages = result.messages.filter(
				(m) => !(m.type === "ask" && (m.ask === "completion_result" || m.ask === "resume_completed_task")),
			)
		}

		if (result.messages.length > 0) {
			this.options.messages.appendAndEmit(result.messages, event)
		}

		if (activeSession) {
			if (result.sessionEnded || result.turnComplete) {
				// Authoritative UI phase at turn end. If the completion tool was used this turn
				// the phase is "completed" (green box + Start New Task); otherwise the agent
				// simply stopped and is waiting for the user ("awaiting_followup"). Error turns
				// are surfaced as the error phase. The webview reads this, not the array tail.
				//
				// EXCEPTION: a turn-complete from a turn that was cancelled (cancelTask set phase
				// "resumable" and aborted) is a straggler. Overwriting it here would clobber
				// "resumable" with "awaiting_followup"/"completed" and the footer would lose the
				// Resume Task button (showing the scroll-arrow default instead), so the cancel-set
				// phase is preserved. Check the phase itself, not just isRunning: when the SDK
				// drains a queued prompt at turn end, the PREVIOUS turn's send promise settles
				// after the new turn already started and its completion bookkeeping flips
				// isRunning back to false mid-turn (see fireAndForgetSend). Keying on isRunning
				// alone made the queued turn's real completion look like this straggler, leaving
				// the phase stuck on "streaming" (endless Thinking).
				const errorSeen = this.options.messageTranslatorState.wasErrorSeen()
				if (!activeSession.isRunning && this.options.getTurnPhase?.() === "resumable") {
					Logger.debug("[SdkController] turn-complete straggler after cancel; preserving resumable phase")
					this.endRateLimitEpisode()
					this.options.sessions.setRunning(false)
				} else if (this.rlEpisodeActive && this.rlRetryCount < rateLimitMaxRetriesFor(failureText)) {
					// Incline: レート制限 / クォータ超過。VscodeSessionHost.send() が
					// 待機して自動でターンを再開するので、「エラー」相 (Retry ボタン) には
					// せず streaming を維持し、カウントダウンを表示する。isRunning も
					// 立てたまま (send() の Promise 解決まで turn は継続中扱い)。
					// 1回の失敗 = error + done の2発なので、`turnCounted` で二重加算を防ぐ。
					if (!this.rlTurnCounted) {
						this.rlRetryCount++
						this.rlTurnCounted = true
						Logger.log(
							`[SdkController] Rate-limit auto-retry: keeping turn streaming (attempt ${this.rlRetryCount}/${formatRetryLimit(failureText)})`,
						)
					}
					this.beginRetryCountdown(failureText, activeSession.sessionId)
					this.options.setTurnPhase?.(PROVIDER_FAILURE_PHASE.STREAMING)
					this.options.sessions.setRunning(true)
				} else if (errorSeen) {
					if (this.rlEpisodeActive) {
						Logger.error(
							`[SdkController] Rate-limit auto-retry budget exhausted (${this.rlRetryCount}/${formatRetryLimit(failureText)}); surfacing error`,
						)
					}
					this.endRateLimitEpisode()
					// The turn surfaced a provider error (ask:"api_req_failed" was emitted) —
					// offer error recovery (Retry / Start New Task), not the followup state.
					this.options.setTurnPhase?.("error")
					this.options.sessions.setRunning(false)
				} else if (this.options.messageTranslatorState.wasAttemptCompletionSeen()) {
					this.endRateLimitEpisode()
					this.options.setTurnPhase?.("completed")
					this.options.sessions.setRunning(false)
				} else {
					this.endRateLimitEpisode()
					this.options.setTurnPhase?.("awaiting_followup")
					this.options.sessions.setRunning(false)
				}
			}

			if (result.usage && activeSession.startResult) {
				Promise.resolve(
					this.options.taskHistory.updateTaskUsage(
						this.options.getTask()?.taskId ?? this.options.sessions.getActiveSession()?.sessionId,
						result.usage,
					),
				).catch((error) => {
					Logger.error("[SdkController] Failed to persist task usage:", error)
				})
			}
		}

		// Post state when there are messages to ship OR when the turn ended. A clean turn end's
		// `done` event carries no transcript message, yet the authoritative phase just changed to
		// completed/awaiting_followup/error above; without posting here the webview would stay on
		// the prior phase (footer stuck on the streaming/scroll state). The webview reducer gates
		// turnState by seq, so an extra no-message post is safe.
		if (
			result.messages.length > 0 ||
			result.sessionEnded ||
			result.turnComplete ||
			event.type === "pending_prompt_submitted"
		) {
			this.options.postStateToWebview().catch((err) => {
				Logger.error("[SdkController] Failed to post state after event:", err)
			})
		}
	}

	// --- Incline: レート制限自動リトライのカウントダウン表示 ------------------
	// say:"info" のメッセージを ts 固定で使い回し、数秒おきに残り秒数を更新する
	// (webview 変更なしの簡易カウントダウン)。実際の待機/再送は
	// VscodeSessionHost.send() 側。

	/**
	 * この失敗イベント (と直前の失敗) のエラーテキストを広めに集める。
	 * `error` イベントは error.message / error.cause に、`done` は text に載るが
	 * 空のこともある。翻訳済みメッセージ本文 (api_req_failed の payload) も拾う。
	 */
	private collectFailureText(
		event: CoreSessionEvent,
		result: TranslationResult,
		agentFailure: AgentFailureTelemetry,
	): string {
		const parts: string[] = []
		if (agentFailure?.error != null) {
			parts.push(String(agentFailure.error))
		}
		if (event.type === "agent_event") {
			const ae = event.payload.event as AgentEvent
			if (ae.type === "error" && ae.error != null) {
				parts.push(String(ae.error))
				if (ae.error instanceof Error) {
					parts.push(ae.error.message)
					const cause = (ae.error as Error & { cause?: unknown }).cause
					if (cause != null) {
						parts.push(String(cause))
					}
				}
			}
			if (ae.type === "done" && typeof ae.text === "string") {
				parts.push(ae.text)
			}
		}
		for (const message of result.messages) {
			if (typeof message.text === "string") {
				parts.push(message.text)
			}
		}
		return parts.join(" \n ")
	}

	private retryErrorText = ""
	private statusAttemptNo = 0
	private lastStatusTs = 0
	private retryWaitSec = 0

	/** その回のメッセージを確定させる (カウントダウンを止め、何回目で何を受けてどれだけ待ったかを残す)。 */
	private finalizeRetryStatus(mark: string): void {
		if (this.retryStatusTs === undefined) {
			return
		}
		const label = describeProviderError(this.retryErrorText)?.label ?? "プロバイダのエラー"
		this.options.messages.emitHookMessage({
			ts: this.retryStatusTs,
			type: "say",
			say: "info",
			text: `${mark} ${this.statusAttemptNo}/${formatRetryLimit(this.retryErrorText)} 回目: ${label} → ${this.retryWaitSec} 秒待って再試行しました`,
			partial: false,
		})
	}

	private beginRetryCountdown(errorText: string, sessionId: string): void {
		this.retryErrorText = errorText
		this.retryDeadlineMs = Date.now() + rateLimitRetryDelayMs(errorText, this.rlRetryCount)
		this.retrySessionId = sessionId
		// 1 回の失敗ごとに別のメッセージにする (1 つを書き換え続けると、下にエラーが積まれて上に埋もれ、何回目か分からなくなる)。
		// 前の回のメッセージは「再試行しました」と確定させて残す。
		if (this.retryStatusTs !== undefined && this.statusAttemptNo !== this.rlRetryCount) {
			this.finalizeRetryStatus("🔁")
			this.retryStatusTs = undefined
		}
		if (this.retryStatusTs === undefined) {
			this.retryStatusTs = Math.max(Date.now(), this.lastStatusTs + 1)
			this.lastStatusTs = this.retryStatusTs
			this.statusAttemptNo = this.rlRetryCount
		}
		this.retryWaitSec = Math.max(1, Math.round((this.retryDeadlineMs - Date.now()) / 1000))
		this.emitRetryStatusMessage()
		if (this.retryStatusTicker) {
			clearInterval(this.retryStatusTicker)
		}
		this.retryStatusTicker = setInterval(() => this.emitRetryStatusMessage(), 5000)
	}

	private emitRetryStatusMessage(): void {
		if (this.retryStatusTs === undefined) {
			return
		}
		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession || activeSession.sessionId !== this.retrySessionId) {
			Logger.log(
				`[SdkController] Suppressing rate-limit retry status message for inactive session ${this.retrySessionId} (active: ${activeSession?.sessionId ?? "none"})`,
			)
			this.endRateLimitEpisode()
			return
		}
		const remainingSec = Math.max(0, Math.ceil((this.retryDeadlineMs - Date.now()) / 1000))
		const text =
			remainingSec > 0
				? `⏳ ${describeProviderError(this.retryErrorText)?.label ?? "プロバイダのエラー（レート制限 / クォータ超過 / 高負荷）"} を受信しました。約 ${remainingSec} 秒後に自動リトライします（${this.rlRetryCount}/${formatRetryLimit(this.retryErrorText)}）`
				: `🔄 自動リトライ中…（${this.rlRetryCount}/${formatRetryLimit(this.retryErrorText)}）`
		
		Logger.log(`[SdkController] Emitting retry status for session ${activeSession.sessionId}: ${text.substring(0, 50)}...`)
		
		this.options.messages.emitHookMessage({
			ts: this.retryStatusTs,
			type: "say",
			say: "info",
			text,
			partial: false,
		})
		if (remainingSec <= 0 && this.retryStatusTicker) {
			clearInterval(this.retryStatusTicker)
			this.retryStatusTicker = undefined
		}
	}

	/**
	 * レート制限リトライのエピソードを終了 (成功/前進/上限到達/別ターン)。状態を全リセット。
	 * 抑制中に持ち越していた失敗フラグ (errorSeen 等) も畳むので、前進後の
	 * `done`(completed) が誤って「エラー」相に落ちない。上限到達側は直後に
	 * setTurnPhase("error") を明示するので畳んでも影響しない。
	 */
	private endRateLimitEpisode(): void {
		if (this.retryStatusTs !== undefined && this.rlEpisodeActive) {
			this.finalizeRetryStatus("⏹")
		}
		if (this.retryStatusTicker) {
			clearInterval(this.retryStatusTicker)
			this.retryStatusTicker = undefined
		}
		this.retryStatusTs = undefined
		this.retryDeadlineMs = 0
		this.retrySessionId = undefined
		if (this.rlEpisodeActive) {
			this.options.messageTranslatorState.clearTurnOutcome()
		}
		this.rlEpisodeActive = false
		this.rlRetryCount = 0
		this.rlTurnCounted = false
	}

	private getAgentFailureTelemetry(event: CoreSessionEvent): AgentFailureTelemetry {
		if (event.type !== "agent_event") {
			return undefined
		}

		const agentEvent: AgentEvent = event.payload.event
		if (agentEvent.type === "error") {
			if (agentEvent.error == null) {
				return undefined
			}
			// Only terminal failures are provider failures. `recoverable: true`
			// error events are in-run notices — the MistakeTracker emits one for
			// EVERY recorded mistake (with the tool/mistake details as the
			// message, e.g. "2 tool call(s) failed: [shell] ...") and hook
			// failures surface the same way. Counting those here misclassified
			// tool noise as provider API errors and inflated the SDK bundle's
			// error rate ~9x vs legacy in the A/B rollout dashboards. Genuine
			// run failures (run-failed) always carry `recoverable: false`.
			if (agentEvent.recoverable !== false) {
				return undefined
			}
			return {
				sessionId: event.payload.sessionId,
				error: agentEvent.error,
				errorType: PROVIDER_FAILURE_ERROR_TYPE.SDK_AGENT_ERROR,
			}
		}
		if (agentEvent.type === "done" && agentEvent.reason === "error") {
			const errorMessage = agentEvent.text.trim() || "SDK agent finished with error"
			return {
				sessionId: event.payload.sessionId,
				error: errorMessage,
				errorType: PROVIDER_FAILURE_ERROR_TYPE.SDK_AGENT_DONE_ERROR,
			}
		}
		return undefined
	}

	private zeroCostForFreeClineModel(result: TranslationResult): Promise<void> | undefined {
		const hasUsageCost = typeof result.usage?.totalCost === "number" && result.usage.totalCost !== 0
		const hasMessageCost = result.messages.some((message) => {
			if (message.type !== "say" || message.say !== "api_req_started" || !message.text) {
				return false
			}
			try {
				const info = JSON.parse(message.text) as ClineApiReqInfo
				return typeof info.cost === "number" && info.cost !== 0
			} catch {
				return false
			}
		})

		if (!hasUsageCost && !hasMessageCost) {
			return undefined
		}

		return (async () => {
			if (!(await this.isCurrentClineModelFree())) {
				return
			}

			if (result.usage) {
				result.usage = { ...result.usage, totalCost: 0 }
			}

			result.messages = result.messages.map((message) => {
				if (message.type !== "say" || message.say !== "api_req_started" || !message.text) {
					return message
				}
				try {
					const info = JSON.parse(message.text) as ClineApiReqInfo
					if (typeof info.cost !== "number") {
						return message
					}
					return {
						...message,
						text: JSON.stringify({ ...info, cost: 0 } satisfies ClineApiReqInfo),
					}
				} catch {
					return message
				}
			})
		})()
	}

	private async isCurrentClineModelFree(): Promise<boolean> {
		if (this.options.isClineFreeModel) {
			return this.options.isClineFreeModel()
		}

		const stateManager = this.options.stateManager
		if (!stateManager) {
			return false
		}

		try {
			const apiConfig = stateManager.getApiConfiguration()
			const mode = stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
			const provider = mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
			// Free models are also selectable on ClinePass — they ride usage billing at $0
			if (!isClineManagedProvider(provider)) {
				return false
			}

			const modelId = this.getCurrentClineModelId()
			if (!modelId) {
				return false
			}

			const normalizedModelId = normalizeModelId(modelId)
			const models = await refreshClineRecommendedModels()
			const freeIds = models.free.map((model) => normalizeModelId(model.id)).filter(Boolean)
			const resolvedFreeIds =
				freeIds.length > 0 ? freeIds : CLINE_RECOMMENDED_MODELS_FALLBACK.free.map((model) => normalizeModelId(model.id))
			return resolvedFreeIds.includes(normalizedModelId)
		} catch (error) {
			Logger.error("[SdkController] Failed to check Cline free model list:", error)
			const modelId = this.getCurrentClineModelId()
			if (!modelId) {
				return false
			}
			const fallbackFreeIds = CLINE_RECOMMENDED_MODELS_FALLBACK.free.map((model) => normalizeModelId(model.id))
			return fallbackFreeIds.includes(normalizeModelId(modelId))
		}
	}

	private getCurrentClineModelId(): string | undefined {
		const stateManager = this.options.stateManager
		if (!stateManager) {
			return undefined
		}
		const apiConfig = stateManager.getApiConfiguration()
		const mode = stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
		const provider = mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
		if (provider === "cline-pass") {
			return mode === "plan" ? apiConfig.planModeClinePassModelId : apiConfig.actModeClinePassModelId
		}
		return mode === "plan" ? apiConfig.planModeClineModelId : apiConfig.actModeClineModelId
	}

	private logQueueEvents(event: CoreSessionEvent): void {
		if (event.type === "pending_prompts") {
			const count = event.payload.prompts.length
			Logger.log(
				`[SdkController] Pending prompts updated: ${count} prompt(s) in queue for session ${event.payload.sessionId}`,
			)
			return
		}

		if (event.type === "pending_prompt_submitted") {
			Logger.log(
				`[SdkController] Pending prompt submitted: "${event.payload.prompt.substring(0, 80)}" for session ${event.payload.sessionId}`,
			)
		}
	}
}
