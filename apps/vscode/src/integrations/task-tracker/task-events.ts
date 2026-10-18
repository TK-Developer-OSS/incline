// Incline: task.md がパネル以外 (MCP / AI ツール) から変更されたことをパネルに知らせる。
// ファイル監視でも拾えるが、監視の遅れ・取りこぼしに頼らず即時に更新するための直通経路 (#82)。
// vscode 非依存。

type Listener = () => void
const listeners = new Set<Listener>()

export function onTasksChangedExternally(listener: Listener): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function emitTasksChangedExternally(): void {
	for (const listener of listeners) {
		listener()
	}
}

// --- 判断待ち ([CONFIRM]) への返答かもしれない保存 (人間が『変更を保存』で [CONFIRM] の次の行を確定した) ---
export interface ConfirmReply {
	id: number
	title: string
}
type ReplyListener = (reply: ConfirmReply) => void
const replyListeners = new Set<ReplyListener>()

export function onConfirmReply(listener: ReplyListener): () => void {
	replyListeners.add(listener)
	return () => replyListeners.delete(listener)
}

export function emitConfirmReply(reply: ConfirmReply): void {
	for (const listener of replyListeners) {
		listener(reply)
	}
}

// --- PWA (INCLINE Alarm) で人間が Acknowledge した (ntfy に ACK が届いた) ---
const ackListeners = new Set<() => void>()

export function onAlarmAck(listener: () => void): () => void {
	ackListeners.add(listener)
	return () => ackListeners.delete(listener)
}

export function emitAlarmAck(): void {
	for (const listener of ackListeners) {
		listener()
	}
}
