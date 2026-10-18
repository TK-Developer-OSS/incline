import { describe, expect, it } from "vitest"
import { TIMELINE_COMMENT_CHARS, timelineCommentSource, timelineCommentText } from "./timeline-comment"

describe("timeline comment for MCP messages (#92)", () => {
	it("shows sender -> recipient and 'title: text' on one line", () => {
		expect(timelineCommentSource({ from: "claude", to: "gemini" })).toBe("claude → gemini")
		expect(timelineCommentText({ title: "完了報告", text: "実装が終わりました\n詳細は task #12" })).toBe("完了報告: 実装が終わりました 詳細は task #12")
		expect(timelineCommentText({ title: "", text: "本文だけ" })).toBe("本文だけ")
	})
	it("truncates very long messages", () => {
		const t = timelineCommentText({ title: "", text: "あ".repeat(TIMELINE_COMMENT_CHARS + 50) })
		expect(t).toHaveLength(TIMELINE_COMMENT_CHARS + 1)
		expect(t.endsWith("…")).toBe(true)
	})
})
