// Incline: MCP の有効 / 無効とセッション操作の許可 (INCLINE 設定タブのチェックボックスで切り替える)。
// 設定パネル (updateSettings) が set*、MCP の登録処理 (register.ts) が購読する。実行中でも即時に反映される。
// vscode 非依存。

type Listener = () => void

let enabled = true
let sessionControl = false
const listeners = new Set<Listener>()

const notify = () => {
	for (const listener of listeners) {
		listener()
	}
}

export function isMcpEnabled(): boolean {
	return enabled
}

export function isMcpSessionControlAllowed(): boolean {
	return sessionControl
}

export function setMcpEnabled(value: boolean): void {
	if (value !== enabled) {
		enabled = value
		notify()
	}
}

export function setMcpSessionControlAllowed(value: boolean): void {
	if (value !== sessionControl) {
		sessionControl = value
		notify()
	}
}

export function onMcpFlagsChanged(listener: Listener): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
