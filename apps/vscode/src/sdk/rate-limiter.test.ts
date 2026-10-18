import { describe, expect, it } from "vitest"
import {
	RATE_LIMIT_MAX_WAIT_MS,
	RATE_LIMIT_RPM,
	RATE_LIMIT_TPM,
	RATE_LIMIT_WINDOW_MS,
} from "@/shared/rate-limits"
import {
	applyRateLimitSettings,
	dynamicModelRateLimiter,
	estimateTokensFromText,
	getRateLimitMaxRetries,
	getRateLimitRetryDelayMs,
	isRateLimitErrorText,
	parseRetryAfterMs,
	SlidingWindowModelRateLimiter,
	setActiveRateLimitProvider,
	toolExecutionRateLimiter,
} from "./rate-limiter"

const T0 = 1_000_000_000_000

describe("SlidingWindowModelRateLimiter", () => {
	it("no wait while under both limits", () => {
		const rl = new SlidingWindowModelRateLimiter()
		for (let i = 0; i < 3; i++) {
			rl.noteRequest(T0 + i * 1000)
		}
		rl.recordUsage(1000, T0)
		expect(rl.computeWaitMs(T0 + 5000).waitMs).toBe(0)
	})

	it("RPM: waits until the oldest in-window request ages out", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 3, tpm: 1_000_000 })
		rl.noteRequest(T0)
		rl.noteRequest(T0 + 10_000)
		rl.noteRequest(T0 + 20_000)
		// now = T0+25s: 3 requests in the 60s window, at limit -> wait until T0 + 60s
		const { waitMs, reasons } = rl.computeWaitMs(T0 + 25_000)
		expect(waitMs).toBe(RATE_LIMIT_WINDOW_MS - 25_000)
		expect(reasons.join()).toContain("RPM 3/3")
	})

	it("RPM: no wait once old requests have aged past the window", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 2 })
		rl.noteRequest(T0)
		rl.noteRequest(T0 + 1000)
		// now is 61s later: both are outside the window -> pruned -> no wait
		expect(rl.computeWaitMs(T0 + 61_000).waitMs).toBe(0)
	})

	it("TPM: waits until enough token samples age out to drop below the limit", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ tpm: 100, rpm: 1000 })
		rl.recordUsage(60, T0)
		rl.recordUsage(60, T0 + 30_000)
		// now = T0+40s, sum=120 >= 100. The next request is predicted to be about as big as the last one (60, #121),
		// so the window must drop to below 40: both samples have to age out, the last one at T0+30s+60s = T0+90s -> wait 50s.
		const { waitMs, reasons } = rl.computeWaitMs(T0 + 40_000)
		expect(waitMs).toBe(50_000)
		expect(reasons.join()).toContain("TPM 120/100")
	})

	it("takes the max of the RPM and TPM waits", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 1, tpm: 50 })
		rl.noteRequest(T0 + 5000) // RPM: free at T0+65s
		rl.recordUsage(100, T0) // TPM: over, free at T0+60s
		expect(rl.computeWaitMs(T0 + 10_000).waitMs).toBe(55_000) // max(55s, 50s)
	})

	it("caps the wait at RATE_LIMIT_MAX_WAIT_MS", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 1000, tpm: 1_000_000, minSpacingMs: 200_000 })
		rl.noteRequest(T0)
		// min-spacing alone would ask for ~200s -> clamped to the max
		expect(rl.computeWaitMs(T0 + 100).waitMs).toBe(RATE_LIMIT_MAX_WAIT_MS)
	})

	it("min-spacing enforces a floor between requests", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 1000, tpm: 1_000_000, minSpacingMs: 5000 })
		rl.noteRequest(T0)
		expect(rl.computeWaitMs(T0 + 1000).waitMs).toBe(4000)
		expect(rl.computeWaitMs(T0 + 6000).waitMs).toBe(0)
	})

	it("snapshot reports current window usage and configured limits", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.noteRequest(T0)
		rl.noteRequest(T0 + 1000)
		rl.recordUsage(1234, T0)
		const s = rl.snapshot(T0 + 2000)
		expect(s).toEqual({ rpmUsed: 2, tpmUsed: 1234, rpmLimit: RATE_LIMIT_RPM, tpmLimit: RATE_LIMIT_TPM })
	})

	it("acquire records a request without sleeping under test env", async () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ rpm: 100, tpm: 1_000_000 })
		const start = Date.now()
		await rl.acquire("test")
		expect(Date.now() - start).toBeLessThan(500)
		expect(rl.snapshot().rpmUsed).toBe(1)
	})
})

describe("retryable error detection (existing helpers)", () => {
	it("matches quota / rate-limit / overload phrasings", () => {
		expect(isRateLimitErrorText("You exceeded your current quota")).toBe(true)
		expect(isRateLimitErrorText("RESOURCE_EXHAUSTED")).toBe(true)
		expect(isRateLimitErrorText("This model is currently experiencing high demand")).toBe(true)
		expect(isRateLimitErrorText("The model is overloaded. Please try again later.")).toBe(true)
		expect(isRateLimitErrorText("503 Service Unavailable")).toBe(true)
		expect(isRateLimitErrorText("ok, all good")).toBe(false)
		expect(isRateLimitErrorText(undefined)).toBe(false)
	})

	it("parseRetryAfterMs pulls the server hint", () => {
		expect(parseRetryAfterMs("Please retry in 27.9518s.")).toBe(27952)
		expect(parseRetryAfterMs("no hint here")).toBeUndefined()
	})
})

describe("applyRateLimitSettings", () => {
	it("overrides limits / retry settings and falls back to defaults on invalid values", () => {
		applyRateLimitSettings({ rpm: 30, tpm: 500_000, retryDelaySec: 5, maxRetries: 3, toolDelaySec: 0 })
		expect(dynamicModelRateLimiter.getLimits()).toEqual({ rpm: 30, tpm: 500_000 })
		expect(getRateLimitRetryDelayMs()).toBe(5000)
		expect(getRateLimitMaxRetries()).toBe(3)
		expect(toolExecutionRateLimiter.getMinDelay()).toBe(0)

		applyRateLimitSettings({ rpm: -1, tpm: Number.NaN, retryDelaySec: -5, maxRetries: undefined })
		expect(dynamicModelRateLimiter.getLimits()).toEqual({ rpm: RATE_LIMIT_RPM, tpm: RATE_LIMIT_TPM })
		expect(getRateLimitRetryDelayMs()).toBe(60_000)
		expect(getRateLimitMaxRetries()).toBe(100)
		expect(toolExecutionRateLimiter.getMinDelay()).toBe(10_000)
	})
})

describe("provider default limits", () => {
	it("uses provider defaults unless the user set them explicitly", () => {
		applyRateLimitSettings({})
		setActiveRateLimitProvider("gemini")
		expect(dynamicModelRateLimiter.getLimits()).toEqual({ rpm: 10, tpm: 250_000 })

		setActiveRateLimitProvider("ollama")
		expect(dynamicModelRateLimiter.getLimits().rpm).toBeGreaterThanOrEqual(1000)

		// 明示設定が最優先
		applyRateLimitSettings({ rpm: 7 })
		expect(dynamicModelRateLimiter.getLimits().rpm).toBe(7)

		// 未掲載プロバイダ / 未設定は汎用既定
		applyRateLimitSettings({})
		setActiveRateLimitProvider("anthropic")
		expect(dynamicModelRateLimiter.getLimits()).toEqual({ rpm: RATE_LIMIT_RPM, tpm: RATE_LIMIT_TPM })
		setActiveRateLimitProvider(undefined)
	})
})

describe("usage view (RPM / TPM / RPD)", () => {
	it("counts per session and resets the view when the session changes (throttle state untouched)", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.setViewSession("s1")
		rl.noteRequest(T0)
		rl.noteRequest(T0 + 1_000)
		rl.recordUsage(1500, T0 + 1_000)
		expect(rl.usageView(T0 + 2_000)).toEqual({ rpm: 2, tpm: 1500, rpd: 2 })

		// 60秒を過ぎると RPM/TPM は減り、RPD (24時間) は残る
		expect(rl.usageView(T0 + 70_000)).toEqual({ rpm: 0, tpm: 0, rpd: 2 })

		// セッション切替で表示はリセット。スロットリング側のリクエスト履歴は残る
		rl.setViewSession("s2")
		expect(rl.usageView(T0 + 70_000)).toEqual({ rpm: 0, tpm: 0, rpd: 0 })
		expect(rl.snapshot(T0 + 2_000).rpmUsed).toBe(2)

		// 24時間より古いものは RPD から落ちる
		rl.noteRequest(T0)
		expect(rl.usageView(T0 + 25 * 60 * 60 * 1000).rpd).toBe(0)
	})

	it("exposes an optional RPD limit", () => {
		applyRateLimitSettings({ rpd: 250 })
		expect(dynamicModelRateLimiter.getLimits().rpd).toBe(250)
		applyRateLimitSettings({})
		expect(dynamicModelRateLimiter.getLimits().rpd).toBeUndefined()
	})
})

describe("usageSnapshot (#77)", () => {
	it("returns the last-60s samples so the webview can recompute smoothly", () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.setViewSession("s1")
		rl.noteRequest(T0 - 50_000)
		rl.noteRequest(T0 - 10_000)
		rl.recordUsage(700, T0 - 10_000)
		const snap = rl.usageSnapshot(T0)
		expect(snap).toMatchObject({ rpm: 2, tpm: 700, rpd: 2, at: T0 })
		expect(snap.reqs).toEqual([T0 - 50_000, T0 - 10_000])
		expect(snap.tokens).toEqual([{ at: T0 - 10_000, tokens: 700 }])
		// 60秒より古いものはサンプルから外れる (RPD には残る)
		const later = rl.usageSnapshot(T0 + 55_000)
		expect(later.reqs).toEqual([])
		expect(later.rpd).toBe(2)
	})
})


describe("predictive TPM and pending tool-result reservation (#121)", () => {
	const T0 = 1_000_000
	const mk = () => {
		const rl = new SlidingWindowModelRateLimiter()
		rl.updateLimits({ tpm: 100, rpm: 1000, minSpacingMs: 0 })
		return rl
	}
	it("waits when the last request size would push the next request over the limit, even though the window is still under it", () => {
		const rl = mk()
		rl.recordUsage(60, T0) // sum 60 < 100, but the next request will be about 60 again => 120
		const { waitMs, reasons } = rl.computeWaitMs(T0 + 1000)
		expect(waitMs).toBeGreaterThan(0)
		expect(reasons.join()).toContain("next")
	})
	it("does not wait when the sum and the predicted next request fit", () => {
		const rl = mk()
		rl.recordUsage(30, T0) // 30 + about 30 = 60 < 100
		expect(rl.computeWaitMs(T0 + 1000).waitMs).toBe(0)
	})
	it("counts a reserved tool result before its usage has been recorded", () => {
		const rl = mk()
		rl.recordUsage(30, T0)
		expect(rl.computeWaitMs(T0 + 1000).waitMs).toBe(0)
		rl.reservePending(50) // a big tool result: next request ~ 30 + 50 = 80, 30 + 80 > 100
		expect(rl.computeWaitMs(T0 + 1000).waitMs).toBeGreaterThan(0)
	})
	it("drops the reservation when the real usage arrives", () => {
		const rl = mk()
		rl.recordUsage(10, T0)
		rl.reservePending(500)
		rl.recordUsage(10, T0 + 5000) // actual usage replaces the estimate
		expect(rl.computeWaitMs(T0 + 6000).waitMs).toBe(0)
	})
	it("estimates tokens: ASCII about 4 chars per token, other characters 1 each", () => {
		expect(estimateTokensFromText("abcd".repeat(100))).toBe(100)
		expect(estimateTokensFromText("あ".repeat(50))).toBe(50)
	})
})
