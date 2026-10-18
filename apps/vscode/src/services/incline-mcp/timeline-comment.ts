// Incline: MCP で投稿されたメッセージを、INCLINE のタイムラインに「コメント」(💬 [送り元] 本文) として出す (#92)。
// 表示だけで、モデルへの入力にはしない (controller.insertTimelineComment)。vscode 非依存。

import type { Message } from "./message-store"

/** タイムラインに出す 1 行の長さの上限。 */
export const TIMELINE_COMMENT_CHARS = 600

export function timelineCommentSource(m: Pick<Message, "from" | "to">): string {
	return `${m.from} → ${m.to}`
}

export function timelineCommentText(m: Pick<Message, "title" | "text">): string {
	const body = `${m.title ? `${m.title}: ` : ""}${m.text}`.replace(/\s+/g, " ").trim()
	return body.length > TIMELINE_COMMENT_CHARS ? `${body.slice(0, TIMELINE_COMMENT_CHARS)}…` : body
}
