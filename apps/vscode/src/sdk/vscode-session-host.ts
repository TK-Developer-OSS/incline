// VscodeSessionHost — wraps ClineCore with VSCode-specific customizations
//
// Uses ClineCore.create() so the SDK owns session input normalization,
// lifecycle bootstrapping, and host selection while the VSCode extension
// still provides its custom McpHub-backed runtime builder.

import { logActivity } from "./activity-log"
import {
	ApiRateLimiter,
	isRateLimitErrorText,
	modelRequestRateLimiter,
	getRateLimitMaxRetries,
	RATE_LIMIT_RETRY_PROMPT,
	rateLimitRetryDelayMs,
	isDailyQuotaErrorText,
	isRateLimitBreakerOpen,
	markRateLimitGaveUp,
	recordRateLimitFailure,
	RATE_LIMIT_BREAKER_THRESHOLD,
	retryRunMadeProgress,
	sleep,
} from "./rate-limiter"
import { sendNtfyNotification } from "@/services/ntfy"
import { formatOutgoing } from "@/services/ntfy/protocol"
import {
	type ApplyPatchExecutor,
	type AskQuestionExecutor,
	ClineCore,
	type ClineCoreListHistoryOptions,
	type ClineCoreStartInput,
	type CompareCheckpointInput,
	type CompareCheckpointResult,
	type CoreSessionEvent,
	type EditorExecutor,
	type HookEventPayload,
	type ITelemetryService,
	type PendingPromptMutationResult,
	type PendingPromptsDeleteInput,
	type PendingPromptsListInput,
	type PendingPromptsUpdateInput,
	type PreparedRemoteConfigCoreIntegration,
	type RestoreInput,
	type RestoreResult,
	type SendSessionInput,
	type SessionAccumulatedUsage,
	type SessionCompactionState,
	type SessionHistoryRecord,
	type SessionPendingPrompt,
	type SessionRecord,
	type StartSessionInput,
	type StartSessionResult,
	type ToolExecutors,
	toClineCoreStartInput,
} from "@cline/core"
import { RUNTIME_CONFIG_EXTENSION_KINDS, type ToolApprovalRequest, type ToolApprovalResult, type ToolPolicy } from "@cline/shared"
import { StateManager } from "@/core/storage/StateManager"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { getDistinctId } from "@/services/logging/distinctId"
import type { McpHub } from "@/services/mcp/McpHub"
import { Logger } from "@/shared/services/Logger"
import { type VscodeGitTelemetry, VscodeGitTelemetryManager } from "./git-telemetry"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import type { SdkSessionHost } from "./session-host"
import { createVscodeExtraTools } from "./vscode-runtime-builder"
import { getEffectiveTerminalExecutionMode } from "./vscode-terminal-execution-mode"
import * as vscode from "vscode"

export interface VscodeSessionHostOptions {
	mcpHub: McpHub
	requestToolApproval?: (request: {
		agentId: string
		conversationId: string
		iteration: number
		toolCallId: string
		toolName: string
		input: unknown
		policy: { enabled: boolean; autoApprove: boolean }
	}) => Promise<{ approved: boolean; reason?: string }>
	/** Executor for the SDK's built-in ask_question tool (equivalent to classic ask_followup_question). */
	askQuestion?: AskQuestionExecutor
	/**
	 * Custom `editor` tool executor (diff-view edit pipeline). Fully replaces the SDK's
	 * default disk-writing executor.
	 */
	editorExecutor?: EditorExecutor
	/**
	 * Custom `apply_patch` tool executor (reverts the approval-time diff preview before
	 * delegating to the SDK's default patch application).
	 */
	applyPatchExecutor?: ApplyPatchExecutor
	/**
	 * Custom `read_files` executor (resolves relative paths against the workspace root
	 * instead of the extension host's process.cwd(), which is usually "/").
	 */
	readFileExecutor?: ToolExecutors["readFile"]
	/** Per-tool approval policies derived from the user's auto-approval settings. */
	toolPolicies?: Record<string, ToolPolicy>
	/** Shared SDK telemetry service owned by SdkController. */
	telemetry?: ITelemetryService
	/** Resolves once the applicable remote config is ready for a new SDK session. */
	beforeStartSession?: () => Promise<void>
	/** Returns the latest prepared remote-config integration, if remote config is active. */
	getRemoteConfigIntegration?: () => PreparedRemoteConfigCoreIntegration | undefined
	/**
	 * Lazy factory for the VscodeTerminalManager.
	 * When provided, the SDK's built-in `run_commands` is suppressed and replaced
	 * with a custom tool that supports foreground/background terminal execution.
	 */
	getTerminalManager?: () => VscodeTerminalManager
	/** Registry of in-flight foreground executions for "Proceed While Running". */
	foregroundCommands?: SdkForegroundCommandCoordinator
}

export class VscodeSessionHost implements SdkSessionHost {
	readonly runtimeAddress: string | undefined
	private readonly inner: ClineCore
	private readonly prepareStartSessionInput: (input: ClineCoreStartInput) => Promise<ClineCoreStartInput>
	private readonly gitTelemetry: VscodeGitTelemetryManager

	private readonly rateLimiter: ApiRateLimiter

	private constructor(
		inner: ClineCore,
		prepareStartSessionInput: (input: ClineCoreStartInput) => Promise<ClineCoreStartInput>,
		options: VscodeSessionHostOptions,
	) {
		this.inner = inner
		this.runtimeAddress = inner.runtimeAddress
		// エージェントループの各モデルリクエスト前 (beforeModel フック) と同じ
		// 待機時計を共有する。hooks-adapter.ts の beforeModel も同一インスタンスを使う。
		this.rateLimiter = modelRequestRateLimiter
		this.prepareStartSessionInput = prepareStartSessionInput
		this.gitTelemetry = new VscodeGitTelemetryManager(options.telemetry)
	}
	updateSessionModel?(sessionId: string, modelId: string): Promise<void> {
		return this.inner.updateSessionModel(sessionId, modelId)
	}

	static async create(options: VscodeSessionHostOptions): Promise<VscodeSessionHost> {
		// Build tool executor capabilities from options — only include keys that are provided.
		// When a terminal manager is available, suppress the SDK's built-in run_commands
		// tool by setting bash to undefined. Our custom run_commands (provided via
		// extraTools) replaces it with foreground/background terminal support.
		const toolExecutors: Partial<ToolExecutors> = {}
		if (options.askQuestion) {
			toolExecutors.askQuestion = options.askQuestion
		}
		if (options.editorExecutor) {
			toolExecutors.editor = options.editorExecutor
		}
		if (options.applyPatchExecutor) {
			toolExecutors.applyPatch = options.applyPatchExecutor
		}
		if (options.readFileExecutor) {
			toolExecutors.readFile = options.readFileExecutor
		}
		if (options.getTerminalManager) {
			// Setting bash to undefined suppresses the SDK's createShellTool():
			// createDefaultTools() checks `enableBash && executors.bash` — falsy
			// bash means no built-in run_commands tool is created.
			;(toolExecutors as Record<string, unknown>).bash = undefined
		}

		// Both start and checkpoint restore use the same input preparation.
		const prepareStartSessionInput = async (input: ClineCoreStartInput): Promise<ClineCoreStartInput> => {
			await options.beforeStartSession?.()
			// Read only after the readiness gate: it may have atomically replaced
			// the integration that must be captured by this session.
			const remoteConfigIntegration = options.getRemoteConfigIntegration?.()
			const inputWithRemoteConfig = remoteConfigIntegration
				? await remoteConfigIntegration.applyToStartSessionInput(input)
				: input
			const requestedTerminalExecutionMode = StateManager.get().getGlobalStateKey("vscodeTerminalExecutionMode")
			const extraTools = await createVscodeExtraTools(options.mcpHub, {
				cwd: inputWithRemoteConfig.config.cwd,
				getTerminalManager: options.getTerminalManager,
				vscodeTerminalExecutionMode: getEffectiveTerminalExecutionMode(requestedTerminalExecutionMode),
				foregroundCommands: options.foregroundCommands,
				taskTrackerToolEnabled: vscode.workspace.getConfiguration().get<boolean>("incline.taskTracker.aiToolEnabled", true),
			})
			const config: ClineCoreStartInput["config"] = {
				...inputWithRemoteConfig.config,
				telemetry: inputWithRemoteConfig.config.telemetry ?? options.telemetry,
				extraTools: [...(inputWithRemoteConfig.config.extraTools ?? []), ...extraTools],
			}
			return {
				...inputWithRemoteConfig,
				source: inputWithRemoteConfig.source ?? "vscode",
				// The extension runs file hooks through its own hooks adapter
				// (status chips, hooksEnabled setting, HookFactory discovery).
				// Exclude the SDK core's file-hook extension or every hook
				// would execute twice per event.
				localRuntime: {
					...(inputWithRemoteConfig.localRuntime ?? {}),
					hooks: config.hooks,
					configExtensions: (
						inputWithRemoteConfig.localRuntime?.configExtensions ?? RUNTIME_CONFIG_EXTENSION_KINDS
					).filter((kind) => kind !== "hooks"),
				},
				config,
			}
		}

		const inner = await ClineCore.create({
			backendMode: "local",
			capabilities: {
				requestToolApproval: options.requestToolApproval as
					| ((request: ToolApprovalRequest) => Promise<ToolApprovalResult>)
					| undefined,
				toolExecutors: Object.keys(toolExecutors).length > 0 ? toolExecutors : undefined,
			},
			toolPolicies: options.toolPolicies,
			telemetry: options.telemetry,
			distinctId: getDistinctId() || undefined,
		})

		Logger.log("[VscodeSessionHost] Initialized with ClineCore + VSCode extra tools")
		if (options.getTerminalManager) {
			Logger.log("[VscodeSessionHost] SDK run_commands suppressed; using custom foreground/background terminal tool")
		}
		return new VscodeSessionHost(inner, prepareStartSessionInput, options)
	}

	async start(input: StartSessionInput): Promise<StartSessionResult>
	async start(input: ClineCoreStartInput): Promise<StartSessionResult>
	async start(input: StartSessionInput | ClineCoreStartInput): Promise<StartSessionResult> {
		const prepared = await this.prepareStartSessionInput(toClineCoreStartInput(input))
		const observer = this.gitTelemetry.init(prepared)
		try {
			const result = await this.inner.start(prepared)
			this.gitTelemetry.start(result.sessionId, observer)
			return result
		} catch (error) {
			observer?.dispose()
			throw error
		}
	}

	async send(input: SendSessionInput) {
		// レート制限の強制ウェイトはここ (ユーザーメッセージ送信時=1ターン1回) ではなく、
		// エージェントループの各モデルリクエスト前に効かせる。hooks-adapter.ts の
		// beforeModel フックが sharedApiRateLimiter.wait() を呼ぶ。
		Logger.log(`[VscodeSessionHost] send() called: sessionId=${input.sessionId}, prompt=${input.prompt?.substring(0, 50)}`)
		try {
			let result = await this.inner.send(input)

			// Incline: プロバイダのレート制限 / クォータ超過 (429 / RESOURCE_EXHAUSTED /
			// "exceeded your current quota") でターンが失敗したら、一定時間 (既定60秒)
			// 待ってから自動でターンを再開する。元のユーザーメッセージはセッション履歴に
			// 残っているので再送せず、SDK の Retry ボタンと同じ再開プロンプトを送る。
			// UI 側 (リトライボタン非表示 + カウントダウン表示) は
			// sdk-session-event-coordinator.ts が同じ判定で担当する。
			//
			// `attempt` は「進捗なしの連続失敗回数」。再開ターンが1トークンでも
			// 出力/ツール実行して前進したら 0 に戻し、「少し進んでまた429」を
			// 繰り返しても打ち切られないようにする。
			let attempt = 0
			let totalRetries = 0
			while (
				result?.finishReason !== "completed" &&
				isRateLimitErrorText(result?.text) &&
				attempt < getRateLimitMaxRetries() &&
				!isRateLimitBreakerOpen()
			) {
				if (recordRateLimitFailure()) {
					Logger.error(`[VscodeSessionHost] Rate-limit circuit breaker opened; stopping auto-retry (session ${input.sessionId})`)
					await sendNtfyNotification(
						`Rate limit: ${RATE_LIMIT_BREAKER_THRESHOLD} failures in a row with no success — auto-retry and watchdog stopped for 1h. Check the API key / plan. ${String(result?.text).substring(0, 60)}`,
					)
					break
				}
				if (attempt > 0 && retryRunMadeProgress(result)) {
					Logger.log(
						`[VscodeSessionHost] Rate-limit retry made progress (outputTokens=${result?.usage?.outputTokens}, toolCalls=${result?.toolCalls?.length}); resetting retry count for session ${input.sessionId}`,
					)
					attempt = 0
				}
				attempt++
				if (attempt === 10) {
					await sendNtfyNotification(`Failed after 10 retries: ${result?.text?.substring(0, 60)}`)
				}
				totalRetries++
				const waitMs = rateLimitRetryDelayMs(result?.text, attempt)
				const logMsg = `[INCLINE] [${new Date().toISOString()}] Rate limit / quota error — auto-retry ${attempt}/${getRateLimitMaxRetries()} after ${waitMs}ms: ${String(result?.text).slice(0, 200)}`
				Logger.warn(logMsg)
				process.stderr.write(logMsg + "\n")
				logActivity("RETRY", `session ${input.sessionId} attempt ${attempt}/${getRateLimitMaxRetries()} in ${Math.round(waitMs / 1000)}s: ${String(result?.text).slice(0, 120)}`)

				await sleep(waitMs)

				Logger.log(
					`[VscodeSessionHost] Auto-retrying turn after rate limit (attempt ${attempt}/${getRateLimitMaxRetries()}, total ${totalRetries}) for session ${input.sessionId}`,
				)
				result = await this.inner.send({
					sessionId: input.sessionId,
					prompt: RATE_LIMIT_RETRY_PROMPT,
					...(input.mode ? { mode: input.mode } : {}),
				})
			}
			if (result?.finishReason !== "completed" && (isRateLimitErrorText(result?.text) || isDailyQuotaErrorText(result?.text))) {
				markRateLimitGaveUp(`${totalRetries} retr${totalRetries === 1 ? "y" : "ies"} then ${String(result?.text).slice(0, 80)}`)
			}
			if (result?.finishReason !== "completed" && isDailyQuotaErrorText(result?.text)) {
				// Incline (#121): 日次の枠切れは待っても戻らないので、自動リトライせずここで止めて人に知らせる。
				Logger.error(`[VscodeSessionHost] Daily quota exhausted; not retrying (session ${input.sessionId})`)
				await sendNtfyNotification(
					`Daily quota exhausted — auto-retry stopped. Wait for the reset or switch the API key/plan. ${String(result?.text).substring(0, 80)}`,
				)
			}
			if (totalRetries > 0 && isRateLimitErrorText(result?.text) && result?.finishReason !== "completed") {
				Logger.error(
					`[VscodeSessionHost] Rate limit auto-retry exhausted after ${attempt} consecutive attempt(s) (${totalRetries} total) for session ${input.sessionId}; surfacing error`,
				)
			}

			Logger.log(
				`[VscodeSessionHost] send() completed: text=${result?.text?.substring(0, 100)}, inputTokens=${result?.usage?.inputTokens}`,
			)
			if (result?.finishReason === "completed") {
				// biome-ignore lint/plugin: ワークスペース取得のため、意図的にVS CodeのネイティブAPIを使用
				const workspaceFolders = vscode.workspace.workspaceFolders
				let workspaceDir = ""

				if (workspaceFolders && workspaceFolders.length > 0) {
					// 「Open Folder」で開いている最初のプロジェクトフォルダの絶対パスを取得
					workspaceDir = workspaceFolders[0].uri.fsPath
				}

				await sendNtfyNotification(formatOutgoing(workspaceDir, result?.text ?? ""))
			}

			return result
		} catch (error) {
			Logger.error("[VscodeSessionHost] send() error:", error)
			throw error
		}
	}

	async getAccumulatedUsage(sessionId: string): Promise<SessionAccumulatedUsage | undefined> {
		return (await this.inner.getAccumulatedUsage(sessionId))?.usage
	}

	async abort(sessionId: string, reason?: unknown): Promise<void> {
		try {
			return await this.inner.abort(sessionId, reason)
		} catch (error) {
			// AbortError is expected when cancelling a running task —
			// AbortController.abort() fires synchronously and may cause
			// listeners to throw. Suppress it here so callers don't
			// need to handle it.
			if (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))) {
				Logger.debug(`[VscodeSessionHost] AbortError during abort (expected): ${sessionId}`)
				return
			}
			throw error
		}
	}

	async stop(sessionId: string): Promise<void> {
		this.gitTelemetry.stop(sessionId)
		return this.inner.stop(sessionId)
	}

	async dispose(reason?: string): Promise<void> {
		this.gitTelemetry.dispose()
		return this.inner.dispose(reason)
	}

	async get(sessionId: string): Promise<SessionRecord | undefined> {
		return this.inner.get(sessionId)
	}

	async list(limit?: number, options: Omit<ClineCoreListHistoryOptions, "limit"> = {}): Promise<SessionHistoryRecord[]> {
		return this.inner.list(limit, options)
	}

	async listHistory(options: ClineCoreListHistoryOptions = {}): Promise<SessionHistoryRecord[]> {
		return this.inner.listHistory(options)
	}

	async delete(sessionId: string): Promise<boolean> {
		return this.inner.delete(sessionId)
	}

	async readMessages(sessionId: string) {
		return this.inner.readMessages(sessionId)
	}

	async readLiveMessages(sessionId: string) {
		return this.inner.readLiveMessages(sessionId)
	}

	async updateSessionCompactionState(sessionId: string, state: SessionCompactionState): Promise<{ updated: boolean }> {
		return this.inner.updateSessionCompactionState(sessionId, state)
	}

	async restore(input: RestoreInput): Promise<RestoreResult> {
		// Apply the same preparation to checkpoint-restore replacement sessions.
		let observer: VscodeGitTelemetry | undefined
		if (input.start) {
			const start = await this.prepareStartSessionInput(toClineCoreStartInput(input.start))
			observer = this.gitTelemetry.init(start)
			input = { ...input, start }
		}
		try {
			const result = await this.inner.restore(input)
			if (result.startResult && result.sessionId) this.gitTelemetry.start(result.sessionId, observer)
			else observer?.dispose()
			return result
		} catch (error) {
			observer?.dispose()
			throw error
		}
	}

	async compareCheckpoint(input: CompareCheckpointInput): Promise<CompareCheckpointResult> {
		return this.inner.compareCheckpoint(input)
	}

	async update(
		sessionId: string,
		updates: {
			prompt?: string | null
			metadata?: Record<string, unknown> | null
			title?: string | null
		},
	): Promise<{ updated: boolean }> {
		return this.inner.update(sessionId, updates)
	}

	async handleHookEvent(payload: HookEventPayload): Promise<void> {
		await this.rateLimiter.wait("VscodeSessionHost.handleHookEvent")
		return this.inner.ingestHookEvent(payload)
	}

	pendingPrompts(action: "list", input: PendingPromptsListInput): Promise<SessionPendingPrompt[]>
	pendingPrompts(action: "update", input: PendingPromptsUpdateInput): Promise<PendingPromptMutationResult>
	pendingPrompts(action: "delete", input: PendingPromptsDeleteInput): Promise<PendingPromptMutationResult>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pendingPrompts(action: any, input: any): any {
		switch (action) {
			case "list":
				return this.inner.pendingPrompts.list(input)
			case "update":
				return this.inner.pendingPrompts.update(input)
			case "delete":
				return this.inner.pendingPrompts.delete(input)
			default:
				throw new Error(`Unsupported pending prompt action: ${String(action)}`)
		}
	}

	subscribe(listener: (event: CoreSessionEvent) => void): () => void {
		return this.inner.subscribe(listener)
	}
}
