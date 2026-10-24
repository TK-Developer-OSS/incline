// プロバイダのエラー文から「HTTP ステータス + 種類」を取り出して、画面に出す短い見出しにする。
// 拡張 (リトライの状況メッセージ) と webview (エラーの枠) の両方で使う。

export interface ProviderErrorInfo {
	status?: number
	/** プロバイダが返した状態名 (RESOURCE_EXHAUSTED / UNAVAILABLE など)。 */
	code?: string
	kind: "quota" | "server" | "other"
	label: string
}

export function describeProviderError(text: string | undefined | null): ProviderErrorInfo | undefined {
	if (typeof text !== "string" || !text) {
		return undefined
	}
	const head = text.match(/^\s*(\d{3})\b/)?.[1]
	const inBody = text.match(/"code"\s*:\s*(\d{3})/)?.[1]
	const bare = text.match(/\b(429|50[234])\b/)?.[1]
	const status = Number(head ?? inBody ?? bare) || undefined
	const code = text.match(/"status"\s*:\s*"([A-Z_]+)"/)?.[1] ?? text.match(/\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED)\b/)?.[1]
	const quota = status === 429 || /resource_exhausted|exceeded your current quota|quota exceeded|too many requests/i.test(text)
	const server = !quota && (status === 502 || status === 503 || status === 504 || /overloaded|high demand|unavailable|deadline.?exceeded/i.test(text))
	if (!quota && !server && !status) {
		return undefined
	}
	const kind = quota ? "quota" : server ? "server" : "other"
	const kindLabel = quota ? "枠切れ / レート制限" : server ? "サーバー過負荷 / タイムアウト" : "エラー"
	const parts = [status ? `HTTP ${status}` : undefined, kindLabel, code].filter(Boolean)
	return { status, code, kind, label: parts.join(" · ") }
}
