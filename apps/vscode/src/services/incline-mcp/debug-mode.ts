// Incline: デバッグモード (#73 / #74)。
//  標準モード: MCP の接続先 (ポート・トークン) はこのウィンドウの統合ターミナルの環境変数だけ。
//             登録ファイル (~/.incline/run/mcp-<port>.json) は作らないので、別の VS Code や外部の
//             プロセスは接続先を知る手段が無い (= 同一 VS Code からのみ)。
//  デバッグモード: 登録ファイルを作り、別の VS Code / 外部のエージェント (監督 AI) からも接続できる。
// 設定パネルのチェックボックス (updateSettings) が setMcpDebugMode を呼び、MCP の登録処理が購読する。

type Listener = (debug: boolean) => void

let debugMode = false
const listeners = new Set<Listener>()

export function isMcpDebugMode(): boolean {
	return debugMode
}

export function setMcpDebugMode(value: boolean): void {
	if (value === debugMode) {
		return
	}
	debugMode = value
	for (const listener of listeners) {
		listener(value)
	}
}

export function onMcpDebugModeChanged(listener: Listener): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
