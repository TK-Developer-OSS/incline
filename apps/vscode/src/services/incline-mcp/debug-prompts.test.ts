import { describe, expect, it } from "vitest"
import { listMcpPrompts, markMcpPrompt, normalizePrompt } from "./debug-prompts"

describe("debug prompts (MCP-sent input shown as [DEBUG])", () => {
	it("remembers normalized prompts, newest last, without duplicates, bounded", () => {
		markMcpPrompt("  2+3=  ")
		markMcpPrompt("a\n  b")
		markMcpPrompt("2+3=")
		expect(listMcpPrompts().slice(-2)).toEqual(["a b", "2+3="])
		for (let i = 0; i < 50; i++) markMcpPrompt(`p${i}`)
		expect(listMcpPrompts().length).toBeLessThanOrEqual(30)
		expect(normalizePrompt(" x \n y ")).toBe("x y")
	})
})
