import type { ClineMessage } from "@shared/ExtensionMessage"

export interface RateMetrics {
	/** 直近60秒のモデルリクエスト数 (概算)。 */
	rpm: number
	/** 直近60秒の処理トークン数 (in+out+cache、概算)。 */
	tpm: number
}

interface SeenRequest {
	/** このリクエストを初めて観測した実時刻 (Date.now())。 */
	at: number
	tokens: number
}

const WINDOW_MS = 60_000
const PRUNE_MS = 180_000

/**
 * RPM / TPM の直近60秒推定。
 *
 * `ClineMessage.ts` はメッセージ識別子 (単調カウンタ) であって時刻ではないため、
 * `api_req_started` メッセージを「初めて画面で観測した実時刻」でスタンプして数える。
 * タスクを開いた時点で既にある履歴ぶんは "過去" 扱いにしてカウントしない。
 */
export class RateTracker {
	private readonly seen = new Map<number, SeenRequest>()
	private readonly ignored = new Set<number>()
	private primed = false

	observe(messages: readonly ClineMessage[], now: number): void {
		for (const m of messages) {
			if (m.type !== "say" || m.say !== "api_req_started" || !m.text) {
				continue
			}
			if (!this.primed) {
				this.ignored.add(m.ts)
				continue
			}
			if (this.ignored.has(m.ts)) {
				continue
			}

			let tokens = 0
			try {
				const d = JSON.parse(m.text) as {
					tokensIn?: number
					tokensOut?: number
					cacheReads?: number
					cacheWrites?: number
				}
				tokens = (d.tokensIn ?? 0) + (d.tokensOut ?? 0) + (d.cacheReads ?? 0) + (d.cacheWrites ?? 0)
			} catch {
				// malformed api_req_started payload — count it as a request with 0 tokens
			}

			const prev = this.seen.get(m.ts)
			if (prev) {
				prev.tokens = tokens // usage イベントによる後埋め
			} else {
				this.seen.set(m.ts, { at: now, tokens })
			}
		}

		this.primed = true
		for (const [key, value] of this.seen) {
			if (now - value.at > PRUNE_MS) {
				this.seen.delete(key)
			}
		}
	}

	metrics(now: number): RateMetrics {
		const cutoff = now - WINDOW_MS
		let rpm = 0
		let tpm = 0
		for (const value of this.seen.values()) {
			if (value.at >= cutoff) {
				rpm += 1
				tpm += Math.max(0, value.tokens)
			}
		}
		return { rpm, tpm }
	}
}
