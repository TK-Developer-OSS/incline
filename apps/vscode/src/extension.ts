// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import assert from "node:assert"
import { disableCurrentDirectoryExecutableSearch } from "@cline/shared"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMarketplaceButtonClickedEvent } from "./core/controller/ui/subscribeToMarketplaceButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import { sendWorktreesButtonClickedEvent } from "./core/controller/ui/subscribeToWorktreesButtonClicked"
import { WebviewProvider } from "./core/webview"
import { createClineAPI } from "./exports"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import path from "node:path"
import type { ExtensionContext } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { setClineDir } from "@cline/shared/storage"
import { createStorageContext, resolveInclineDirFromEnv } from "@/shared/storage/storage-context"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { initialize, tearDown } from "./common"
import { addToCline } from "./core/controller/commands/addToCline"
import { explainWithCline } from "./core/controller/commands/explainWithCline"
import { fixWithCline } from "./core/controller/commands/fixWithCline"
import { improveWithCline } from "./core/controller/commands/improveWithCline"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendShowWebviewEvent } from "./core/controller/ui/subscribeToShowWebview"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { registerTaskTracker } from "./integrations/task-tracker"
import { registerConfirmReplyNotifier } from "./integrations/task-tracker/confirm-reply-notifier"
import { needsConfirmation } from "./integrations/task-tracker/task-md"
import { createConfirmAlarm } from "./integrations/task-tracker/confirm-alarm"
import { onAlarmAck, onTasksChangedExternally } from "./integrations/task-tracker/task-events"
import { isRateLimitHalted } from "./sdk/rate-limiter"
import { startWatchdog } from "./integrations/task-tracker/watchdog"
import { emitTasksChangedExternally } from "./integrations/task-tracker/task-events"
import { sendNtfyNotification, sendNtfyTestAlarm } from "./services/ntfy"
import { TaskMdStore } from "./integrations/task-tracker/task-md-store"
import { staleWriterHooks } from "./shared/storage/ClineFileStorage"
import { registerRateLimitConfig } from "./sdk/rate-limit-config"
import { defaultMessageFile, MessageStore } from "./services/incline-mcp/message-store"
import { registerInclineMcp } from "./services/incline-mcp/register"
import { registerNtfyWatcher } from "./services/ntfy/register"
import { migrateOpenAiCompatibleBaseUrlToV1 } from "./core/storage/openai-base-url-migration"
import {
	cleanupMcpMarketplaceCatalogFromGlobalState,
	cleanupOldApiKey,
	migrateCustomInstructionsToGlobalRules,
	migrateTaskHistoryToFile,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { workspaceResolver } from "./core/workspace"
import { findMatchingNotebookCell, getContextForCommand, showWebview } from "./hosts/vscode/commandUtils"
import { abortCommitGeneration, generateCommitMsg } from "./hosts/vscode/commit-message-generator"
import { registerClineOutputChannel } from "./hosts/vscode/hostbridge/env/debugLog"
import {
	disposeVscodeCommentReviewController,
	getVscodeCommentReviewController,
} from "./hosts/vscode/review/VscodeCommentReviewController"
import { DIFF_VIEW_URI_SCHEME, diffContentProvider } from "./hosts/vscode/VscodeDiffContentProvider"
import { EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider, VscodeEditPreview } from "./hosts/vscode/VscodeEditPreview"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { exportVSCodeStorageToSharedFiles } from "./hosts/vscode/vscode-to-file-migration"
import { ExtensionRegistryInfo } from "./registry"
import { AuthService, LogoutReason } from "./sdk/auth-service"
import { telemetryService } from "./services/telemetry"
import type { RolloutBundleActivation } from "./services/telemetry/rollout-metadata"
import { LG_TASK_URI_PATH, SharedUriHandler, TASK_URI_PATH } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/host/window"
import { fileExistsAtPath } from "./utils/fs"

export async function reportRolloutActivation(input: RolloutBundleActivation): Promise<void> {
	await telemetryService.captureRolloutBundleActivated(input)
}

// This method is called when the VS Code extension is activated.
// NOTE: This is VS Code specific - services that should be registered
// for all-platform should be registered in common.ts.
export async function activate(context: vscode.ExtensionContext) {
	const activationStartTime = performance.now()

	// 0. Pin the SDK's home directory to ~/.incline (not ~/.cline) so sessions,
	// task history and settings are never shared with the upstream Cline.
	// Must run before anything touches the SDK or reads CLINE_DIR.
	const inclineDir = resolveInclineDirFromEnv()
	process.env.CLINE_DIR = inclineDir
	setClineDir(inclineDir)
	// Before anything spawns with the workspace as cwd (rg, git, hooks, MCP).
	disableCurrentDirectoryExecutableSearch()

	// 1. Set up HostProvider for VSCode
	// IMPORTANT: This must be done before any service can be registered
	setupHostProvider(context)

	// 2. Clean up legacy data patterns within VSCode's native storage.
	// Moves workspace→global keys, task history→file, custom instructions→rules, etc.
	// Must run BEFORE the file export so we copy clean state.
	await cleanupLegacyVSCodeStorage(context)

	// 3. One-time export of VSCode's native storage to shared file-backed stores.
	// After this, all platforms (VSCode, CLI, JetBrains) read from ~/.cline/data/.
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	const storageContext = createStorageContext({ workspacePath })
	await exportVSCodeStorageToSharedFiles(context, storageContext)
	migrateOpenAiCompatibleBaseUrlToV1(storageContext)

	// 4. Register services and perform common initialization
	// IMPORTANT: Must be done after host provider is setup and migrations are complete
	const webview = (await initialize(storageContext)) as VscodeWebviewProvider

	// 5. Register services and commands specific to VS Code
	// Initialize hook discovery cache for performance optimization
	HookDiscoveryCache.getInstance().initialize(
		// biome-ignore lint/suspicious/noExplicitAny: Adapt VSCode ExtensionContext to generic interface
		context as any,
		(dir: string) => {
			try {
				const pattern = new vscode.RelativePattern(dir, "*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)
				// Ensure watcher is disposed when extension is deactivated
				context.subscriptions.push(watcher)
				// Adapt VSCode FileSystemWatcher to generic interface
				return {
					onDidCreate: (listener: () => void) => watcher.onDidCreate(listener),
					onDidChange: (listener: () => void) => watcher.onDidChange(listener),
					onDidDelete: (listener: () => void) => watcher.onDidDelete(listener),
					dispose: () => watcher.dispose(),
				}
			} catch {
				return null
			}
		},
		(callback: () => void) => {
			// Adapt VSCode Disposable to generic interface
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(callback)
			context.subscriptions.push(disposable)
			return disposable
		},
	)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeWebviewProvider.SIDEBAR_ID, webview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// NOTE: Commands must be added to the internal registry before registering them with VSCode
	const { commands } = ExtensionRegistryInfo

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.PlusButton, async () => {
			const sidebarInstance = WebviewProvider.getInstance()
			telemetryService.captureNewTaskClicked("activity_bar_plus", !!sidebarInstance.controller.task)
			await sidebarInstance.controller.clearTask()
			await sidebarInstance.controller.postStateToWebview()
			await sendChatButtonClickedEvent()
		}),
	)
	context.subscriptions.push(vscode.commands.registerCommand(commands.McpButton, () => sendMcpButtonClickedEvent()))
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.MarketplaceButton, () => sendMarketplaceButtonClickedEvent()),
	)
	context.subscriptions.push(vscode.commands.registerCommand(commands.SettingsButton, () => sendSettingsButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.HistoryButton, () => sendHistoryButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.AccountButton, () => sendAccountButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.WorktreesButton, () => sendWorktreesButtonClickedEvent()))

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	// Edit previews use a separate, mutable provider (content set programmatically and
	// re-rendered via onDidChange) so the diff's right side can play the simulated
	// streaming animation. See VscodeEditPreview.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider),
	)

	const handleUri = async (uri: vscode.Uri) => {
		const url = decodeURIComponent(uri.toString())
		const uriPath = getUriPath(url)
		const isTaskUri = uriPath === TASK_URI_PATH || uriPath === LG_TASK_URI_PATH

		if (isTaskUri) {
			await openClineSidebarForTaskUri()
		}

		let success = await SharedUriHandler.handleUri(url)

		// Task deeplinks can race with first-time sidebar initialization.
		if (!success && isTaskUri) {
			await openClineSidebarForTaskUri()
			success = await SharedUriHandler.handleUri(url)
		}

		if (!success) {
			Logger.warn("Extension URI handler: Failed to process URI:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Debug-harness affordance: VSCode only delivers real vscode:// URIs to the
	// registered handler above, which the harness can't synthesize. When running
	// under browser-capture (debug harness) mode, expose the same handler on
	// globalThis so the harness can deliver simulated OAuth callbacks via
	// `ext.evaluate`. Gated on CLINE_CAPTURE_BROWSER so it never ships in prod.
	if (process.env.CLINE_CAPTURE_BROWSER === "1" || process.env.CLINE_CAPTURE_BROWSER === "true") {
		;(globalThis as Record<string, unknown>).__clineHandleUri = (url: string) => SharedUriHandler.handleUri(url)
	}

	// Register size testing commands in development mode
	if (IS_DEV) {
		vscode.commands.executeCommand("setContext", "cline.isDevMode", IS_DEV)
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(webview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("[Cline Dev] Dev mode activated & dev commands registered")
			})
			.catch((error) => {
				Logger.log(`[Cline Dev] Failed to register dev commands: ${error}`)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.TerminalOutput, async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				const terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}
				// Ensure the sidebar view is visible but preserve editor focus
				await showWebview(true)

				await sendAddToInputEvent(`Terminal output:\n\`\`\`\n${terminalContents}\n\`\`\``)

				Logger.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				Logger.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					_document: vscode.TextDocument,
					_range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					// NOTE: These commands must NOT carry `arguments`. Commands with arguments are
					// routed through VS Code's CommandsConverter cache, whose entries are disposed
					// when the code action list is disposed - executing the action then fails with
					// "Actual command not found, wanted to execute ...". The handlers recover the
					// range (selection, expanded around the cursor when empty) and intersecting
					// diagnostics themselves via getContextForCommand.
					const actions: vscode.CodeAction[] = []

					// Add to Cline (Always available)
					const addAction = new vscode.CodeAction("Add to Cline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: commands.AddToChat,
						title: "Add to Cline",
					}
					actions.push(addAction)

					// Explain with Cline (Always available)
					const explainAction = new vscode.CodeAction("Explain with Cline", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: commands.ExplainCode,
						title: "Explain with Cline",
					}
					actions.push(explainAction)

					// Improve with Cline (Always available)
					const improveAction = new vscode.CodeAction("Improve with Cline", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: commands.ImproveCode,
						title: "Improve with Cline",
					}
					actions.push(improveAction)

					// Fix with Cline (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Cline", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: commands.FixWithCline,
							title: "Fix with Cline",
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handlers
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AddToChat, async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await addToCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FixWithCline, async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await fixWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ExplainCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await explainWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ImproveCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await improveWithCline(context.controller, context.commandContext)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FocusChatInput, async (preserveEditorFocus = false) => {
			const webview = WebviewProvider.getInstance() as VscodeWebviewProvider

			// Show the webview
			const webviewView = webview.getWebview()
			if (webviewView) {
				if (preserveEditorFocus) {
					// Only make webview visible without forcing focus
					webviewView.show(false)
				} else {
					// Show and force focus (default behavior for explicit focus actions)
					webviewView.show(true)
				}
			}

			// Send show webview event with preserveEditorFocus flag
			sendShowWebviewEvent(preserveEditorFocus)
			telemetryService.captureButtonClick("command_focusChatInput", webview.controller?.task?.ulid)
		}),
	)

	// Register Jupyter Notebook command handlers
	const NOTEBOOK_EDIT_INSTRUCTIONS = `Special considerations for using replace_in_file on *.ipynb files:
* Jupyter notebook files are JSON format with specific structure for source code cells
* Source code in cells is stored as JSON string arrays ending with explicit \\n characters and commas
* Always match the exact JSON format including quotes, commas, and escaped newlines.`

	// Helper to get notebook context for Jupyter commands
	async function getNotebookCommandContext(range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) {
		const activeNotebook = vscode.window.activeNotebookEditor
		if (!activeNotebook) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active Jupyter notebook found. Please open a .ipynb file first.",
			})
			return null
		}

		const ctx = await getContextForCommand(range, diagnostics)
		if (!ctx) {
			return null
		}

		const filePath = ctx.commandContext.filePath || ""
		let cellJson: string | null = null
		if (activeNotebook.notebook.cellCount > 0) {
			const cellIndex = activeNotebook.notebook.cellAt(activeNotebook.selection.start).index
			cellJson = await findMatchingNotebookCell(filePath, cellIndex)
		}

		return { ...ctx, cellJson }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterGenerateCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Generate Notebook Cell",
					"Enter your prompt for generating notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
Insert a new Jupyter notebook cell above or below the current cell based on user prompt.
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await addToCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterExplainCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = ctx.cellJson
					? `\n\nCurrent Notebook Cell Context (JSON, sanitized of image data):\n\`\`\`json\n${ctx.cellJson}\n\`\`\``
					: undefined

				await explainWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterImproveCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Improve Notebook Cell",
					"Enter your prompt for improving the current notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await improveWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.Walkthrough, async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#InclineWalkthrough`)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.GenerateCommit, async (scm) => {
			generateCommitMsg(webview.controller, scm)
		}),
		vscode.commands.registerCommand(commands.AbortCommit, () => {
			abortCommitGeneration()
		}),
	)

	// Listen for secrets changes (cross-window login/logout sync).
	// NOTE: Credentials now live in providers.json (single source of truth).
	// This listener catches legacy secrets.json writes from older windows and
	// triggers a re-read from providers.json via restoreRefreshTokenAndRetrieveAuthInfo().
	const unsubSecrets = storageContext.secrets.onDidChange((event) => {
		if (event.key === "cline:clineAccountId") {
			const secretValue = storageContext.secrets.get<string>(event.key)
			const activeWebview = WebviewProvider.getVisibleInstance()
			const controller = activeWebview?.controller

			const authService = AuthService.getInstance(controller)
			if (secretValue) {
				// Secret was added or updated - restore auth info (login from another window)
				authService?.restoreRefreshTokenAndRetrieveAuthInfo()
			} else {
				// Secret was removed - handle logout for all windows
				authService?.handleDeauth(LogoutReason.CROSS_WINDOW_SYNC)
			}
		}
	})
	context.subscriptions.push({ dispose: unsubSecrets })

	// Incline: 下部パネルの簡易タスクトラッカー (task.md ベース)
	try {
		registerTaskTracker(context)
	} catch (error) {
		Logger.error("[Cline] Failed to register Incline task tracker:", error)
	}

	// Incline: ntfy の返信 (自分以外のコメント) の取り込み。失敗しても拡張の起動は止めない。
	try {
		registerNtfyWatcher(context, webview.controller)
	} catch (error) {
		Logger.error("[Cline] Failed to register ntfy watcher:", error)
	}

	// Incline: 人間が [CONFIRM] の次の行を『変更を保存』で確定したら、返答が来たかもしれないことを AI に知らせる。
	try {
		const folder = vscode.workspace.workspaceFolders?.[0]
		const store = folder ? new MessageStore(defaultMessageFile(folder.uri.fsPath)) : undefined
		const controller = webview.controller
		context.subscriptions.push({
			dispose: registerConfirmReplyNotifier({
				taskId: () => controller.task?.taskId,
				phase: () => controller.getTurnPhase(),
				followup: (prompt) => controller.askResponse(prompt),
				postMessage: store ? async (to, title, text) => void (await store.post({ to, title, text, from: "INCLINE" })) : undefined,
				// 判定する AI のセッションが無いとき: 「解決にする」を出して、1 クリックで [RESOLVED] を書けるようにする
				onNoAgent: (reply) => {
					if (!folder) {
						return
					}
					void vscode.window
						.showInformationMessage(
							`INCLINE Tasks: reply saved on #${reply.id} "${reply.title}", but no AI session is running to judge it.`,
							"Mark resolved",
							"Keep waiting",
						)
						.then(async (choice) => {
							if (choice === "Mark resolved") {
								const author = vscode.workspace.getConfiguration().get<string>("incline.taskTracker.author")?.trim() || "me"
								await new TaskMdStore(path.join(folder.uri.fsPath, "task.md")).note(
									reply.id,
									"[RESOLVED] Marked as resolved by the human (no AI session was running to judge the reply).",
									author,
								)
								emitTasksChangedExternally()
							}
						})
				},
			}),
		})
	} catch (error) {
		Logger.error("[Cline] Failed to register confirm-reply notifier:", error)
	}

	// Incline: テスト用のアラームを送るコマンド (#86 PoC): スマホの ntfy アプリで最優先通知として鳴るかを確かめる。
	context.subscriptions.push(
		vscode.commands.registerCommand("incline.sendTestAlarm", async () => {
			const result = await sendNtfyTestAlarm()
			if (result === "no-topic") {
				void vscode.window.showWarningMessage("INCLINE: set the NTFY Topic in the INCLINE settings tab first, then run this command again.")
			} else {
				void vscode.window.showInformationMessage("INCLINE: test alarm sent (urgent priority). Check your phone's ntfy app.")
			}
		}),
	)

	// Incline: 判断待ち ([CONFIRM]) を ntfy の最優先通知で知らせ、解決されるまで 10 分おきに最大 3 回繰り返す (#86 PoC)。
	try {
		const folder = vscode.workspace.workspaceFolders?.[0]
		if (folder) {
			const store = new TaskMdStore(path.join(folder.uri.fsPath, "task.md"))
			const alarm = createConfirmAlarm({
				listTasks: () => store.list(),
				notify: (message) => sendNtfyNotification(message, { urgent: true, title: "INCLINE needs your decision" }),
			})
			const run = () => void alarm.check().catch((error) => Logger.error("[ConfirmAlarm] check failed:", error))
			run()
			const timer = setInterval(run, 60_000)
			context.subscriptions.push({ dispose: () => clearInterval(timer) }, { dispose: onTasksChangedExternally(run) }, { dispose: onAlarmAck(() => alarm.acknowledge()) })
		}
	} catch (error) {
		Logger.error("[Cline] Failed to start the confirm alarm:", error)
	}

	// Incline: ウォッチドッグ (#99): AI が黙って止まっていたら、AI とマネージャー AI に動くよう通知する。
	try {
		const folder = vscode.workspace.workspaceFolders?.[0]
		const wd = vscode.workspace.getConfiguration("incline.watchdog")
		if (folder && wd.get<boolean>("enabled", true)) {
			const tasks = new TaskMdStore(path.join(folder.uri.fsPath, "task.md"))
			const messages = new MessageStore(defaultMessageFile(folder.uri.fsPath))
			const controller = webview.controller
			const stop = startWatchdog(
				{
					phase: () => controller.getTurnPhase(),
					taskId: () => controller.task?.taskId,
					lastActivityAt: () => controller.task?.messageStateHandler.getClineMessages().at(-1)?.ts,
					pendingWork: async () => {
						const mine = (await tasks.list()).filter((t) => t.status === "対応中" && t.assignee.trim().toLowerCase() === "ai")
						const waiting = mine.filter((t) => needsConfirmation(t))
						return { aiInProgress: mine.length, waitingForHuman: waiting.length, actionableIds: mine.filter((t) => !needsConfirmation(t)).map((t) => t.id) }
					},
					rateLimitHalted: () => isRateLimitHalted(),
					followup: (prompt) => controller.askResponse(prompt),
					postMessage: async (to, title, text) => void (await messages.post({ to, title, text, from: "INCLINE" })),
				},
				wd.get<number>("intervalMinutes", 5),
			)
			context.subscriptions.push({ dispose: stop })
		}
	} catch (error) {
		Logger.error("[Cline] Failed to start the watchdog:", error)
	}

	// Incline: INCLINE 自身の MCP サーバ (ウィンドウごとに別ポート、統合ターミナルへ接続先を環境変数で渡す)。
	try {
		await registerInclineMcp(context, webview.controller)
	} catch (error) {
		Logger.error("[Cline] Failed to start Incline MCP server:", error)
	}

	// Incline (#127): このウィンドウが、新しいビルドの設定を古いメモリで書き戻しそうになったら、書かずに知らせる。
	staleWriterHooks.onStale = () => {
		void vscode.window
			.showWarningMessage(
				"INCLINE: this window runs an older build than the one that last saved the settings. Saving was paused to avoid overwriting them. Reload the window.",
				"Reload Window",
			)
			.then((choice) => {
				if (choice === "Reload Window") {
					void vscode.commands.executeCommand("workbench.action.reloadWindow")
				}
			})
	}

	// Incline: レートリミッター / 自動リトライの設定 (incline.rateLimit.*) を反映する。
	try {
		registerRateLimitConfig(context, () => void webview.controller.postStateToWebview())
	} catch (error) {
		Logger.error("[Cline] Failed to register rate limit config:", error)
	}

	Logger.log(`[Cline] extension activated in ${performance.now() - activationStartTime} ms`)

	return createClineAPI(webview.controller)
}

async function showJupyterPromptInput(title: string, placeholder: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.title = title
		quickPick.placeholder = placeholder
		quickPick.ignoreFocusOut = true

		// Allow free text input
		quickPick.canSelectMany = false

		let userInput = ""

		quickPick.onDidChangeValue((value) => {
			userInput = value
			// Update items to show the current input
			if (value) {
				quickPick.items = [
					{
						label: "$(check) Use this prompt",
						detail: value,
						alwaysShow: true,
					},
				]
			} else {
				quickPick.items = []
			}
		})

		quickPick.onDidAccept(() => {
			if (userInput) {
				resolve(userInput)
				quickPick.hide()
			}
		})

		quickPick.onDidHide(() => {
			if (!userInput) {
				resolve(undefined)
			}
			quickPick.dispose()
		})

		quickPick.show()
	})
}

function setupHostProvider(context: ExtensionContext) {
	const outputChannel = registerClineOutputChannel(context)
	outputChannel.appendLine("[Cline] Setting up VS Code host...")

	const createWebview = () => new VscodeWebviewProvider(context)
	const createEditPreview = () => new VscodeEditPreview()
	const createCommentReview = () => getVscodeCommentReviewController()

	const getCallbackUrl = async (path: string, _preferredPort?: number) => {
		const scheme = vscode.env.uriScheme || "vscode"
		const callbackUri = vscode.Uri.parse(`${scheme}://${context.extension.id}${path}`)

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			// In VS Code Web (Codespaces, code serve-web), vscode:// URIs redirect to the
			// desktop app instead of staying in the browser. Use asExternalUri to convert
			// to a web-reachable HTTPS URL that routes back to the extension's URI handler.
			const externalUri = await vscode.env.asExternalUri(callbackUri)
			return externalUri.toString(true)
		}

		// In regular desktop VS Code, use the vscode:// URI protocol handler directly.
		return callbackUri.toString(true)
	}
	HostProvider.initialize(
		createWebview,
		createEditPreview,
		createCommentReview,
		vscodeHostBridgeClient,
		() => {}, // No-op logger, logging is handled via HostProvider.env.debugLog
		getCallbackUrl,
		getBinaryLocation,
		context.extensionUri.fsPath,
		context.globalStorageUri.fsPath,
	)
}

function getUriPath(url: string): string | undefined {
	try {
		return new URL(url).pathname
	} catch {
		return undefined
	}
}

async function openClineSidebarForTaskUri(): Promise<void> {
	const sidebarWaitTimeoutMs = 3000
	const sidebarWaitIntervalMs = 50

	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)

	const startedAt = Date.now()
	while (Date.now() - startedAt < sidebarWaitTimeoutMs) {
		if (WebviewProvider.getVisibleInstance()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, sidebarWaitIntervalMs))
	}

	Logger.warn("Task URI handling timed out waiting for Cline sidebar visibility")
}

async function getBinaryLocation(name: string): Promise<string> {
	// The only binary currently supported is the rg binary from the VSCode installation.
	if (!name.startsWith("rg")) {
		throw new Error(`Binary '${name}' is not supported`)
	}

	const checkPath = async (pkgFolder: string) => {
		const fullPathResult = workspaceResolver.resolveWorkspacePath(
			vscode.env.appRoot,
			path.join(pkgFolder, name),
			"Services.ripgrep.getBinPath",
		)
		const fullPath = typeof fullPathResult === "string" ? fullPathResult : fullPathResult.absolutePath
		return (await fileExistsAtPath(fullPath)) ? fullPath : undefined
	}

	// VS Code 1.122.0 (microsoft/vscode#317978 et al.) migrated from @vscode/ripgrep
	// to @vscode/ripgrep-universal, which ships per-platform/arch subdirectories.
	// Probe the new layout first; fall back to the legacy paths for ≤1.121.x.
	const platformArch = `${process.platform}-${process.arch}`
	const binPath =
		(await checkPath(`node_modules/@vscode/ripgrep-universal/bin/${platformArch}/`)) ||
		(await checkPath(`node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${platformArch}/`)) ||
		(await checkPath("node_modules/@vscode/ripgrep/bin/")) ||
		(await checkPath("node_modules/vscode-ripgrep/bin")) ||
		(await checkPath("node_modules.asar.unpacked/vscode-ripgrep/bin/")) ||
		(await checkPath("node_modules.asar.unpacked/@vscode/ripgrep/bin/"))
	if (!binPath) {
		throw new Error("Could not find ripgrep binary")
	}
	return binPath
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose Non-VSCode-specific services
	try {
		await tearDown()
	} finally {
		// VSCode-specific services
		disposeVscodeCommentReviewController()
	}
}

// TODO: Find a solution for automatically removing DEV related content from production builds.
//  This type of code is fine in production to keep. We just will want to remove it from production builds
//  to bring down built asset sizes.
//
// This is a workaround to reload the extension when the source code changes
// since vscode doesn't support hot reload for extensions
const IS_DEV = process.env.IS_DEV === "true"
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// Set up development mode file watcher
if (IS_DEV) {
	assert(DEV_WORKSPACE_FOLDER, "DEV_WORKSPACE_FOLDER must be set in development")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		Logger.info(`${scheme} ${path} changed. Reloading VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}

// VSCode-specific storage migrations
async function cleanupLegacyVSCodeStorage(context: ExtensionContext): Promise<void> {
	try {
		await cleanupOldApiKey(context)
		// Migrate is not done if the new storage does not have the lastShownAnnouncementId flag
		const hasMigrated = context.globalState.get("lastShownAnnouncementId")
		if (hasMigrated !== undefined) {
			return
		}

		Logger.info("[VS Code Storage Migrations] Starting")

		// Migrate custom instructions to global Cline rules (one-time cleanup)
		await migrateCustomInstructionsToGlobalRules(context)

		// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
		await migrateWelcomeViewCompleted(context)

		// Migrate workspace storage values back to global storage (reverting previous migration)
		await migrateWorkspaceToGlobalStorage(context)

		// Ensure taskHistory.json exists and migrate legacy state (runs once)
		await migrateTaskHistoryToFile(context)

		// Clean up MCP marketplace catalog from global state (moved to disk cache)
		await cleanupMcpMarketplaceCatalogFromGlobalState(context)

		// lastShownAnnouncementId will be set when announcement is shown
		// after activation so we don't need to set it here.

		Logger.info("[VS Code Storage Migrations] Completed")
	} catch (error) {
		Logger.warn(`[VS Code Storage Migrations] Failed${error instanceof Error ? `: ${error.message}` : ""}`)
	}
}
