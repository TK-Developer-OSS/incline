import { describe, expect, it } from "vitest"
import { formatElapsed, formatMessageTime, isRealTimestamp, messageTime, speakerBadge, speakerColor, speakerLabel } from "./ChatRow"

describe("chat row timestamp (#100)", () => {
	it("treats 0 and small placeholder values as not real", () => {
		expect(isRealTimestamp(0)).toBe(false)
		expect(isRealTimestamp(1)).toBe(false)
		expect(isRealTimestamp(undefined)).toBe(false)
		expect(isRealTimestamp(1792287693797)).toBe(true)
	})
	it("formats elapsed time", () => {
		expect(formatElapsed(5_000)).toBe("+5s")
		expect(formatElapsed(185_000)).toBe("+3m 05s")
		expect(formatElapsed(3_900_000)).toBe("+1h 05m")
	})
	it("formats a local date time", () => {
		expect(formatMessageTime(new Date(2026, 9, 18, 8, 5, 9).getTime())).toBe("2026-10-18 08:05:09")
	})

	it("uses the host-stamped createdAt (ts is only an identity counter), falling back to a real epoch ts", () => {
		expect(messageTime({ ts: 7, createdAt: 1792287693797 })).toBe(1792287693797) // completion_result with a counter ts
		expect(messageTime({ ts: 1792287693797 })).toBe(1792287693797)
		expect(messageTime({ ts: 7 })).toBeUndefined()
	})

	it("labels who said it", () => {
		expect(speakerLabel({ type: "say", say: "user_feedback", text: "hi" })).toBe("You")
		expect(speakerLabel({ type: "say", say: "text", text: "💬 [claude → TK] #92 実演: x" })).toBe("Comment") // old messages that still carry the prefix
		expect(speakerLabel({ type: "say", say: "text", text: "#92 実演: x", commentSource: "claude → TK" })).toBe("claude → TK")
		expect(speakerColor("claude → TK", true)).toBe("#ffb74d")
		expect(speakerLabel({ type: "say", say: "text", text: "調べます" })).toBe("AI")
		expect(speakerLabel({ type: "say", say: "completion_result", text: "READY" })).toBe("AI")
		expect(speakerLabel({ type: "say", say: "error", text: "x" })).toBe("INCLINE")
	})

	it("gives each speaker a bright color", () => {
		expect(speakerColor("You")).toBe("#4fc3f7")
		expect(speakerColor("AI")).toBe("#81c784")
		expect(speakerColor("Comment")).toBe("#ffb74d")
		expect(speakerColor("INCLINE")).toBe("#ba68c8")
		expect(speakerColor("unknown")).toBe("#bdbdbd")
	})

	it("renders the badge as a bubble icon, a half-width space, then [speaker]", () => {
		expect(speakerBadge("AI")).toBe("💬 [AI]")
		expect(speakerBadge("You")).toBe("💬 [You]")
	})

	it("labels input that was sent through MCP as DEBUG, in red", () => {
		const prompts = ["2+3="]
		expect(speakerLabel({ type: "say", say: "user_feedback", text: "  2+3= " }, prompts)).toBe("DEBUG")
		expect(speakerLabel({ type: "say", say: "user_feedback", text: "hello" }, prompts)).toBe("You")
		expect(speakerLabel({ type: "say", say: "user_feedback", text: "2+3=" }, [])).toBe("You")
		expect(speakerColor("DEBUG")).toBe("#ff5252")
		expect(speakerBadge("DEBUG")).toBe("💬 [DEBUG]")
	})
})
