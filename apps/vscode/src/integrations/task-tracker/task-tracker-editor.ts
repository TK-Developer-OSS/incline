// Incline: INCLINE Tasks をエディタ領域のタブ (WebviewPanel) として開く / 右のセカンダリ サイドバーのビューとして置く (#95)。
//  - 新しく開くときは「いま操作しているペイン」に入れる。Claude のチャットなどが開いているペインから開けば、
//    そのペインのタブになる (ドラッグで好きな位置へ動かせる。位置は再読み込みのあとも復元される)。
//  - すでに開いていれば、その場所のまま前面に出す (二重に開かない)。
//  - 再読み込み / 再起動で閉じたタブは、シリアライザで復元する。

import * as vscode from "vscode"
import { TASK_TRACKER_PANEL_TYPE, type TaskTrackerViewProvider, type TaskWebviewTarget } from "./task-tracker-view"

export function panelAsTarget(panel: vscode.WebviewPanel): TaskWebviewTarget {
	return {
		webview: panel.webview,
		get visible() {
			return panel.visible
		},
		onDidChangeVisibility: (listener) => panel.onDidChangeViewState(() => listener()),
		onDidDispose: (listener) => panel.onDidDispose(listener),
	}
}

/** 右のセカンダリ サイドバーのビュー (WebviewView) を、画面の置き場として渡す形にする。 */
export function viewAsTarget(view: vscode.WebviewView): TaskWebviewTarget {
	return {
		webview: view.webview,
		get visible() {
			return view.visible
		},
		onDidChangeVisibility: (listener) => view.onDidChangeVisibility(() => listener()),
		onDidDispose: (listener) => view.onDidDispose(listener),
	}
}

/** セカンダリ サイドバー (右端の Chat / Claude Code と並ぶタブ) のビューの提供元。 */
export class TaskTrackerSideView implements vscode.WebviewViewProvider {
	constructor(private readonly provider: TaskTrackerViewProvider) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.provider.attach(viewAsTarget(view))
	}
}

export class TaskTrackerEditor implements vscode.WebviewPanelSerializer {
	private panel: vscode.WebviewPanel | undefined

	constructor(
		private readonly provider: TaskTrackerViewProvider,
		private readonly iconUri?: vscode.Uri,
	) {}

	get isOpen(): boolean {
		return this.panel !== undefined
	}

	open(): void {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn, false)
			return
		}
		const panel = vscode.window.createWebviewPanel(
			TASK_TRACKER_PANEL_TYPE,
			"INCLINE Tasks",
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
		)
		this.adopt(panel)
	}

	/** VS Code が、再読み込み前に開いていたタブを渡してくる。 */
	async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
		this.adopt(panel)
	}

	private adopt(panel: vscode.WebviewPanel): void {
		this.panel = panel
		if (this.iconUri) {
			panel.iconPath = this.iconUri
		}
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined
			}
		})
		this.provider.attach(panelAsTarget(panel))
	}
}
