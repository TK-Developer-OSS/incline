// Incline: MCP がリクエストを受けているか (#71: 受けている間は INCLINE のアプリ枠を青にする)。
// extension host 内の共有フラグ。getStateToPostToWebview が webview へ渡す。

let active = false

export function isMcpActive(): boolean {
	return active
}

export function setMcpActive(value: boolean): void {
	active = value
}
