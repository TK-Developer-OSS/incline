import { describe, expect, it } from "vitest"
import { parseRetryRemainingSec, withRemainingSec } from "./RetryInfoRow"

describe("RetryInfoRow helpers", () => {
	const text = "⏳ プロバイダのエラーを検知しました。約 42 秒後に自動リトライします（3/100）"

	it("parses the remaining seconds", () => {
		expect(parseRetryRemainingSec(text)).toBe(42)
		expect(parseRetryRemainingSec("🔄 自動リトライ中…（3/100）")).toBeUndefined()
		expect(parseRetryRemainingSec(undefined)).toBeUndefined()
	})

	it("replaces the remaining seconds", () => {
		expect(withRemainingSec(text, 7)).toContain("約 7 秒後に自動リトライします（3/100）")
	})
})
