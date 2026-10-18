import { describe, expect, it } from "vitest"
import { classifyMessages, formatOutgoing, isAckText, isOwnAlarmText, parseOutgoingProject, projectKey } from "./protocol"

const msg = (id: string, time: number, message: string, event = "message") => ({ id, time, event, message })

describe("ntfy protocol", () => {
	it("extracts the folder name from paths and names", () => {
		expect(projectKey("/home/user/Incline")).toBe("incline")
		expect(projectKey("C:\\work\\My App\\")).toBe("my app")
		expect(projectKey("incline")).toBe("incline")
	})

	it("round-trips the outgoing format", () => {
		expect(parseOutgoingProject(formatOutgoing("/home/user/proj-a", "done"))).toBe("proj-a")
		expect(parseOutgoingProject("hello")).toBeUndefined()
	})

	it("treats non-INCLINE messages as comments on the previous project", () => {
		const result = classifyMessages(
			[
				msg("1", 1, formatOutgoing("/w/a", "finished A")),
				msg("2", 2, "looks good"),
				msg("3", 3, formatOutgoing("/w/b", "finished B")),
				msg("4", 4, "please also add tests"),
			],
			undefined,
		)
		expect(result.comments.map((c) => [c.project, c.text])).toEqual([
			["a", "looks good"],
			["b", "please also add tests"],
		])
		expect(result.lastProject).toBe("b")
	})

	it("carries the last project across polls and ignores empty / non-message events", () => {
		const result = classifyMessages([msg("1", 1, ""), msg("2", 2, "x", "keepalive"), msg("3", 3, "reply")], "a")
		expect(result.comments).toEqual([{ id: "3", time: 3, project: "a", text: "reply" }])
	})

	it("reports project undefined when no INCLINE notification has been seen", () => {
		expect(classifyMessages([msg("1", 1, "hi")], undefined).comments[0].project).toBeUndefined()
	})
})

describe("isOwnAlarmText", () => {
	it("recognizes INCLINE's own [FL-Alarm] message and nothing else", () => {
		expect(isOwnAlarmText("[FL-Alarm] INCLINE needs your decision: #99 ...")).toBe(true)
		expect(isOwnAlarmText("  [FL-Alarm] x")).toBe(true)
		expect(isOwnAlarmText("ACK")).toBe(false)
		expect(isOwnAlarmText("please see [FL-Alarm] later")).toBe(false)
	})
})

describe("isAckText", () => {
	it("recognizes the PWA acknowledgement and nothing else", () => {
		expect(isAckText("ACK: [FL-Alarm] INCLINE needs your decision: #94")).toBe(true)
		expect(isAckText("  ack")).toBe(true)
		expect(isAckText("please ACK this")).toBe(false)
		expect(isAckText("ACKNOWLEDGED later")).toBe(false)
	})
})
