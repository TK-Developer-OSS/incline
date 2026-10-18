import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import RateMeters, { computeLiveUsage } from "./RateMeters"

describe("computeLiveUsage", () => {
	const at = 1_000_000
	const usage = {
		at,
		reqs: [at - 50_000, at - 30_000, at - 5_000],
		tokens: [
			{ at: at - 50_000, tokens: 1000 },
			{ at: at - 5_000, tokens: 400 },
		],
	}

	it("counts only samples inside the last 60 seconds", () => {
		expect(computeLiveUsage(usage, at)).toEqual({ rpm: 3, tpm: 1400 })
		// 20秒後: 最初のリクエスト (50秒前 → 70秒前) が窓から抜ける
		expect(computeLiveUsage(usage, at + 20_000)).toEqual({ rpm: 2, tpm: 400 })
		// 56秒後: 30秒前のも抜け、残りは1件
		expect(computeLiveUsage(usage, at + 56_000)).toEqual({ rpm: 0, tpm: 0 })
	})
})

describe("RateMeters (smooth decay)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(2_000_000)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("recomputes every second so old requests leave the window without a new state push", () => {
		const at = Date.now()
		render(<RateMeters rpd={3} usage={{ at, reqs: [at - 58_000, at - 1_000], tokens: [{ at: at - 58_000, tokens: 5000 }] }} />)
		// 初期: RPM 2 / TPM 5.0k (形式は formatLargeNumber)
		expect(screen.getByText("2")).toBeTruthy()
		act(() => {
			vi.advanceTimersByTime(3_000)
		})
		// 3秒後: 58秒前のリクエストは61秒前になり窓から抜ける → RPM 1
		expect(screen.getByText("1")).toBeTruthy()
	})
})
