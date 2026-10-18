import { describe, expect, it, vi } from "vitest"
import { isMcpDebugMode, onMcpDebugModeChanged, setMcpDebugMode } from "./debug-mode"

describe("MCP debug mode flag", () => {
	it("defaults to standard mode, notifies only on change, and can unsubscribe", () => {
		expect(isMcpDebugMode()).toBe(false)
		const listener = vi.fn()
		const off = onMcpDebugModeChanged(listener)
		setMcpDebugMode(false)
		expect(listener).not.toHaveBeenCalled()
		setMcpDebugMode(true)
		expect(isMcpDebugMode()).toBe(true)
		expect(listener).toHaveBeenLastCalledWith(true)
		setMcpDebugMode(true)
		expect(listener).toHaveBeenCalledTimes(1)
		off()
		setMcpDebugMode(false)
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
