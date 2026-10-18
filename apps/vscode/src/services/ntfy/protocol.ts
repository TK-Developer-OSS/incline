// ntfy 通知の書式と、受信メッセージの分類 (vscode 非依存の純粋ロジック)。
//
// 送信 (INCLINE -> ntfy):  "INCLINE: <フォルダ>" + 空行 + 本文
// 受信 (ntfy -> INCLINE):  上の書式でないメッセージ = 自分以外のコメント。
//   コメントは「直前に通知を送ったプロジェクト」に対するものとみなす。
//   プロジェクトの識別は、通知に入れているフォルダ名 (パスなら末尾のフォルダ名) で行う。

export const NTFY_OUTGOING_PREFIX = "INCLINE:"

export interface NtfyMessage {
	id: string
	/** UNIX 秒 */
	time: number
	event?: string
	message?: string
}

export interface NtfyComment {
	id: string
	time: number
	/** 直前のプロジェクト (フォルダ名)。直前の通知が無ければ undefined */
	project: string | undefined
	text: string
}

/** パスまたはフォルダ名から、プロジェクトの識別子 (末尾のフォルダ名) を取り出す。 */
export function projectKey(pathOrName: string): string {
	const trimmed = pathOrName.trim().replace(/[\\/]+$/, "")
	const parts = trimmed.split(/[\\/]/)
	return (parts[parts.length - 1] ?? "").toLowerCase()
}

export function formatOutgoing(workspaceDir: string, text: string): string {
	return `${NTFY_OUTGOING_PREFIX} ${workspaceDir}\n\n${text}`
}

/** INCLINE が送った通知ならそのプロジェクトのキーを返す。そうでなければ undefined。 */
export function parseOutgoingProject(message: string): string | undefined {
	if (!message.startsWith(NTFY_OUTGOING_PREFIX)) {
		return undefined
	}
	const firstLine = message.slice(NTFY_OUTGOING_PREFIX.length).split(/\r?\n/, 1)[0] ?? ""
	return projectKey(firstLine)
}

/**
 * 時刻順に並んだ ntfy メッセージを分類する。
 * - event が "message" でないもの (open / keepalive 等) と、本文が空のものは無視
 * - INCLINE の送信メッセージは「直前のプロジェクト」を更新するだけ
 * - それ以外はコメントとして返す (project は更新済みの直前のプロジェクト)
 */
export function classifyMessages(
	messages: NtfyMessage[],
	lastProject: string | undefined,
): { comments: NtfyComment[]; lastProject: string | undefined } {
	const comments: NtfyComment[] = []
	let current = lastProject
	for (const m of messages) {
		if ((m.event ?? "message") !== "message") {
			continue
		}
		const body = (m.message ?? "").trim()
		if (!body) {
			continue
		}
		const outgoing = parseOutgoingProject(body)
		if (outgoing !== undefined) {
			current = outgoing
			continue
		}
		comments.push({ id: m.id, time: m.time, project: current, text: body })
	}
	return { comments, lastProject: current }
}

/** INCLINE 自身が送った判断待ちのアラーム ("[FL-Alarm] ...")。同じトピックの購読側にも戻ってくるので、コメントとして取り込まない。 */
export function isOwnAlarmText(text: string): boolean {
	return text.trim().startsWith("[FL-Alarm]")
}

/** PWA (INCLINE Alarm) の Acknowledge: "ACK" で始まる返信。判断待ちのリマインドを止める合図で、依頼ではない。 */
export function isAckText(text: string): boolean {
	return /^ACK\b/i.test(text.trim())
}
