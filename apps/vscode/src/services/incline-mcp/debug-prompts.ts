// Incline: MCP (session_send) から送ったプロンプトの文面を覚えておく。チャットは、同じ文面のユーザー入力を『[DEBUG]』と表示して、
// TK 自身の入力 (You) と区別する。ユーザー入力のメッセージは複数の経路で作られるので、メッセージ側に印を付けず、文面の一致で判定する。
// extension host 内の共有リスト。getStateToPostToWebview が webview へ渡す。vscode 非依存。

const MAX_PROMPTS = 30
const prompts: string[] = []

export const normalizePrompt = (text: string): string => text.replace(/\s+/g, " ").trim()

export function markMcpPrompt(text: string): void {
	const t = normalizePrompt(text)
	if (!t) {
		return
	}
	const i = prompts.indexOf(t)
	if (i >= 0) {
		prompts.splice(i, 1)
	}
	prompts.push(t)
	while (prompts.length > MAX_PROMPTS) {
		prompts.shift()
	}
}

export function listMcpPrompts(): string[] {
	return [...prompts]
}
