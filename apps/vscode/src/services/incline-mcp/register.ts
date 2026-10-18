// Incline: MCP サーバを拡張に組み込む (extension.ts の activate から呼ぶ)。
//  - 有効 / 無効・セッション操作の許可・デバッグモードは INCLINE 設定タブのチェックボックスで切り替える (実行中でも即時に反映)。
//    ポートの探索開始番号だけ VS Code 設定 incline.mcp.basePort (既定 12340)。
//  - ポートは自動判定で、複数ウィンドウが同時に起動できる (各ウィンドウが別ポート)。
//  - 監督 AI など外部のエージェントが接続先を読めるよう、
//      1. このウィンドウの統合ターミナルに環境変数を注入:
//         INCLINE_MCP_URL / INCLINE_MCP_TOKEN / INCLINE_MCP_PORT
//      2. ~/.incline/run/mcp-<port>.json にも書く (別のターミナル/プロセスからは workspace で探す)
//    ※環境変数は起動後に開いたターミナルから有効 (既存のターミナルは開き直す)。

import * as path from "node:path"
import * as vscode from "vscode"
import { emitTasksChangedExternally } from "@/integrations/task-tracker/task-events"
import { findOpenConfirms } from "@/integrations/task-tracker/task-md"
import { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import { dynamicModelRateLimiter } from "@/sdk/rate-limiter"
import type { Controller } from "@/sdk/SdkController"
import { Logger } from "@/shared/services/Logger"
import { StateManager } from "@/core/storage/StateManager"
import { setMcpActive } from "./activity"
import { isMcpDebugMode, onMcpDebugModeChanged, setMcpDebugMode } from "./debug-mode"
import { applyMcpProcessEnv, clearMcpProcessEnv, mcpEnvironment } from "./mcp-env"
import { isMcpEnabled, onMcpFlagsChanged, setMcpEnabled } from "./mcp-flags"
import { defaultMessageFile, MessageStore } from "./message-store"
import { markMcpPrompt } from "./debug-prompts"
import { timelineCommentSource, timelineCommentText } from "./timeline-comment"
import { DEFAULT_MCP_BASE_PORT, type InclineMcpHandle, startInclineMcpServer } from "./incline-mcp-server"

export async function registerInclineMcp(context: vscode.ExtensionContext, controller?: Controller): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]
	if (!folder) {
		Logger.log("[InclineMcp] no workspace folder; skipping")
		return
	}
	const config = vscode.workspace.getConfiguration("incline.mcp")

	// 設定パネルのチェックボックスの値 (保存済みの状態) を読み込む。標準モード / MCP オン / セッション操作オフが既定。
	try {
		const state = StateManager.get()
		setMcpDebugMode(state.getGlobalSettingsKey("inclineDebugMode") === true)
		setMcpEnabled(state.getGlobalSettingsKey("inclineMcpEnabled") !== false)
	} catch {
		// StateManager が未初期化なら既定のまま
	}

	const env = context.environmentVariableCollection
	env.persistent = false
	env.description = "INCLINE の MCP サーバの接続先 (INCLINE_MCP_URL / INCLINE_MCP_TOKEN)"

	let handle: InclineMcpHandle | undefined
	// 起動・停止は直列に行う (チェックボックスを素早く切り替えても競合しない)
	let chain: Promise<void> = Promise.resolve()

	const taskStore = new TaskMdStore(path.join(folder.uri.fsPath, "task.md"))
	const start = async () => {
		handle = await startInclineMcpServer({
			discoverable: isMcpDebugMode(),
			onTasksChanged: emitTasksChangedExternally,
			// AI / 人間どうしのメッセージ (#62)。リポジトリの外 (~/.incline/data/messages) に保存する。
			messageStore: new MessageStore(defaultMessageFile(folder.uri.fsPath)),
			// 人間宛 (TK / me / human / all) は VS Code の通知で知らせる。ログと通知にはタイトルだけで本文は出さない。
			onMessagePosted: (m) => {
				Logger.log(`[InclineMcp] message #${m.id} ${m.from} -> ${m.to} (${m.text.length} chars)`)
				// INCLINE のタイムラインにも「コメント」として出す (表示だけ。モデルへの入力にはしない) (#92)
				try {
					controller?.insertTimelineComment(timelineCommentText(m), timelineCommentSource(m))
				} catch (error) {
					Logger.error("[InclineMcp] failed to show the message in the timeline:", error)
				}
				if (["tk", "me", "human", "all"].includes(m.to.trim().toLowerCase())) {
					void vscode.window.showInformationMessage(`INCLINE: ${m.from} → ${m.to}: ${m.title || "(件名なし)"}`)
				}
			},
			store: taskStore,
			workspace: folder.uri.fsPath,
			basePort: config.get<number>("basePort", DEFAULT_MCP_BASE_PORT),
			// セッション操作ツール (session_*)。MCP が有効なら使える (権限は分けない。有効 / 無効は設定タブの「Enable MCP server」1 つ)。
			sessionApi: controller
				? {
						isEnabled: () => isMcpEnabled(),
						modelInfo: () => controller.getModelInfo(),
						pendingConfirms: async () =>
							(await taskStore.list())
								.filter((t) => t.status !== "完了" && t.status !== "削除")
								.map((t) => ({ id: t.id, open: findOpenConfirms(t.history) }))
								.filter((x) => x.open.length > 0)
								.map((x) => ({ id: x.id, topics: x.open.map((c) => c.tag ?? "") })),
						phase: () => controller.getTurnPhase(),
						taskId: () => controller.task?.taskId,
						messages: () => controller.task?.messageStateHandler?.getClineMessages?.() ?? [],
						startTask: (prompt) => {
							markMcpPrompt(prompt)
							return controller.initTask(prompt)
						},
						followup: (prompt) => {
							markMcpPrompt(prompt)
							return controller.askResponse(prompt)
						},
						cancel: () => controller.cancelTask(),
						end: () => controller.clearTask(),
					}
				: undefined,
			// MCP の操作を受けている間は INCLINE のアプリ枠を青にする (#71)
			onActivity: (active) => {
				setMcpActive(active)
				void controller?.postStateToWebview()
			},
			getModelInfo: () => controller?.getModelInfo(),
			getRateStatus: () => ({ usage: dynamicModelRateLimiter.usageView(), limits: dynamicModelRateLimiter.getLimits() }),
		})
		// 接続先は環境変数だけで渡す (ファイルに残さない揮発式)。
		//  - 拡張ホストの process.env: 同じウィンドウの Claude Code が起動する claude プロセスと Bash ツールまで引き継がれる。
		//  - 統合ターミナル: environmentVariableCollection。
		// どちらも、設定したあとに起動したプロセス / 開いたターミナルから有効。
		applyMcpProcessEnv({ port: handle.port, token: handle.token })
		for (const [key, value] of Object.entries(mcpEnvironment({ port: handle.port, token: handle.token }))) {
			env.replace(key, value)
		}
		Logger.log(`[InclineMcp] listening on 127.0.0.1:${handle.port} (registry: ${handle.registryFile})`)
	}

	const stop = async () => {
		const h = handle
		handle = undefined
		if (h) {
			clearMcpProcessEnv(h.token)
		}
		setMcpActive(false)
		env.clear()
		await h?.close()
		if (h) {
			Logger.log("[InclineMcp] stopped")
		}
	}

	const sync = () => {
		chain = chain
			.then(async () => {
				if (isMcpEnabled() && !handle) {
					await start()
				} else if (!isMcpEnabled() && handle) {
					await stop()
				}
			})
			.catch((error) => Logger.error("[InclineMcp] failed to switch MCP server:", error))
		return chain
	}

	// チェックボックスの切替に追従する (再起動不要)
	context.subscriptions.push({ dispose: onMcpFlagsChanged(() => void sync()) })
	context.subscriptions.push({ dispose: onMcpDebugModeChanged((debug) => void handle?.setDiscoverable(debug)) })
	context.subscriptions.push({
		dispose: () => {
			chain = chain.then(stop)
		},
	})

	if (!isMcpEnabled()) {
		Logger.log("[InclineMcp] disabled in INCLINE settings")
	}
	await sync()
}
