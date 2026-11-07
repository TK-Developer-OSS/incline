// Incline タスクトラッカー登録エントリ。extension.ts の activate() から呼ぶ。
//  - "INCLINE Tasks" を、右のセカンダリ サイドバーのビュー (既定) とエディタ領域のタブ (incline.openTasksInEditor) の両方で出せる (#95)
//  - ワークスペース直下 task.md を TaskMdStore で管理
//  - task.md の外部編集をファイル監視で拾って Webview を更新
//
// AI ツール `task_tracker` の登録は createVscodeExtraTools 側 (セッション構築時)。

import * as path from "node:path"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { buildApiHandlerWithHostContext } from "@/sdk/sdk-api-handler"
import { Logger } from "@/shared/services/Logger"
import { TaskMdStore } from "./task-md-store"
import { onTasksChangedExternally } from "./task-events"
import { TaskTrackerEditor, TaskTrackerSideView } from "./task-tracker-editor"
import { readLastUsedProviderFromFile } from "@/core/storage/utils/state-helpers"
import { pickTranslationConfig, targetLanguageName, TranslationCache } from "./task-translator"
import { TASK_TRACKER_PANEL_TYPE, TASK_TRACKER_VIEW_ID, TaskTrackerViewProvider } from "./task-tracker-view"

export { TaskMdStore } from "./task-md-store"
export { createTaskTrackerTool } from "./task-tracker-tool"

/** 右のセカンダリ サイドバーの INCLINE Tasks を開く (既定の置き場)。 */
export const OPEN_TASKS_COMMAND = "incline.openTasks"
/** エディタ領域のタブとして開く。 */
export const OPEN_TASKS_IN_EDITOR_COMMAND = "incline.openTasksInEditor"

export function registerTaskTracker(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0]
	if (!folder) {
		// フォルダ未オープン時はスキップ (task.md の置き場が定まらない)。コマンドだけは、理由が分かるように登録しておく。
		Logger.log("[TaskTracker] no workspace folder; skipping registration")
		context.subscriptions.push(
			...[OPEN_TASKS_COMMAND, OPEN_TASKS_IN_EDITOR_COMMAND].map((command) =>
				vscode.commands.registerCommand(command, () =>
					vscode.window.showInformationMessage("INCLINE Tasks: open a folder first (task.md lives in the workspace root)."),
				),
			),
		)
		return
	}

	const store = new TaskMdStore(path.join(folder.uri.fsPath, "task.md"))
	// 起動時に task.md が無ければ、フォーマットの説明書き (前文) 付きで作る。すでにあるファイルには触らない。
	void store.ensureFile().catch((error) => Logger.warn("[TaskTracker] could not create task.md:", error))
	const provider = new TaskTrackerViewProvider(store, {
		cache: new TranslationCache(path.join(context.globalStorageUri.fsPath, "task-translations.json")),
		// 設定パネルの『Translate into』(空なら VS Code の表示言語) が英語以外で、チェックが ON のときだけ翻訳する。
		language: () =>
			StateManager.get().getGlobalSettingsKey("inclineTaskTranslate") === true
				? targetLanguageName(StateManager.get().getGlobalSettingsKey("inclineTaskTranslateTo") || vscode.env.language)
				: undefined,
		// 設定済みの AI (Act モードのモデル) で 1 回きりの翻訳を行う。コミットメッセージ生成と同じ呼び方。
		complete: async (system, user) => {
			const handler = await buildApiHandlerWithHostContext(pickTranslationConfig(StateManager.get().getApiConfiguration(), readLastUsedProviderFromFile()), "act", {
				disableReasoning: true,
			})
			let text = ""
			let streamError: string | undefined
			for await (const chunk of handler.createMessage(system, [{ role: "user" as const, content: user }])) {
				if (chunk.type === "text") {
					text += chunk.text
				} else if (chunk.type === "done" && chunk.success === false) {
					streamError = chunk.error
				}
			}
			if (!text && streamError) {
				throw new Error(streamError)
			}
			return text
		},
	})

	// エディタ領域のタブとして開く。再読み込み前に開いていたタブは、シリアライザで復元する。
	const editor = new TaskTrackerEditor(provider, vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon.png"))
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(TASK_TRACKER_PANEL_TYPE, editor),
		vscode.commands.registerCommand(OPEN_TASKS_IN_EDITOR_COMMAND, () => editor.open()),
		// 既定の置き場: 右のセカンダリ サイドバー (Chat / Claude Code と並ぶタブ)
		vscode.window.registerWebviewViewProvider(TASK_TRACKER_VIEW_ID, new TaskTrackerSideView(provider), {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand(OPEN_TASKS_COMMAND, () => vscode.commands.executeCommand(`${TASK_TRACKER_VIEW_ID}.focus`)),
	)

	// 起動時に、INCLINE Tasks が見えていなければ右のペインで開く (#89)。設定 incline.tasks.openOnStartup (既定 true)。
	// 再読み込みで復元される (すでに見えている) ときは何もしない。
	const openOnStartup = vscode.workspace.getConfiguration("incline.tasks").get<boolean>("openOnStartup", true)
	if (openOnStartup) {
		const timer = setTimeout(() => {
			if (!provider.hasVisibleView()) {
				void vscode.commands.executeCommand(`${TASK_TRACKER_VIEW_ID}.focus`)
			}
		}, 3000)
		context.subscriptions.push({ dispose: () => clearTimeout(timer) })
	}

	// task.md の外部編集 (エディタ手編集 / AI ツール書き込み) を拾って Webview を更新。
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "task.md"))
	const refresh = () => {
		void provider.postTasks()
	}
	watcher.onDidChange(refresh)
	watcher.onDidCreate(refresh)
	watcher.onDidDelete(refresh)
	// MCP / AI ツールからの変更は、パネルが閉じていても (バックグラウンドで) 受け付け、開いていれば即反映する (#82)
	context.subscriptions.push(watcher, provider, { dispose: onTasksChangedExternally(refresh) })

	Logger.log(`[TaskTracker] registered (task.md at ${store.path})`)
}
