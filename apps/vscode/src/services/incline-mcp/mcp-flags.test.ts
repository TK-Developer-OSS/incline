import { describe, expect, it, vi } from "vitest"
import { isMcpEnabled, isMcpSessionControlAllowed, onMcpFlagsChanged, setMcpEnabled, setMcpSessionControlAllowed } from "./mcp-flags"

describe("MCP flags", () => {
	it("defaults: enabled on, session control off; notifies only on change", () => {
		expect(isMcpEnabled()).toBe(true)
		expect(isMcpSessionControlAllowed()).toBe(false)
		const listener = vi.fn()
		const off = onMcpFlagsChanged(listener)
		setMcpEnabled(true)
		setMcpSessionControlAllowed(false)
		expect(listener).not.toHaveBeenCalled()
		setMcpSessionControlAllowed(true)
		setMcpEnabled(false)
		expect(listener).toHaveBeenCalledTimes(2)
		expect(isMcpEnabled()).toBe(false)
		expect(isMcpSessionControlAllowed()).toBe(true)
		off()
		setMcpEnabled(true)
		setMcpSessionControlAllowed(false)
		expect(listener).toHaveBeenCalledTimes(2)
	})
})
