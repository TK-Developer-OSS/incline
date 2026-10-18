import { afterEach, describe, expect, it } from "vitest"
import type { TurnPhase } from "@/shared/ExtensionMessage"
import { canWakeAgent, type ConfirmNotifierApi, confirmReplyPrompt, registerConfirmReplyNotifier } from "./confirm-reply-notifier"
import { emitConfirmReply } from "./task-events"

const flush = () => new Promise((r) => setTimeout(r, 20))

function fake(phase: TurnPhase, taskId: string | null = "t1") {
	const calls = { followups: [] as string[], messages: [] as [string, string, string][], noAgent: [] as number[] }
	const api: ConfirmNotifierApi = {
		taskId: () => taskId ?? undefined,
		phase: () => phase,
		followup: async (p) => void calls.followups.push(p),
		postMessage: async (to, title, text) => void calls.messages.push([to, title, text]),
		onNoAgent: (r) => void calls.noAgent.push(r.id),
	}
	return { api, calls }
}

describe("confirm reply notifier", () => {
	let off: (() => void) | undefined
	afterEach(() => off?.())

	it("posts a message to the AI and wakes an idle session", async () => {
		const { api, calls } = fake("awaiting_followup")
		off = registerConfirmReplyNotifier(api)
		emitConfirmReply({ id: 12, title: "DB の選定" })
		await flush()
		expect(calls.messages).toHaveLength(1)
		expect(calls.messages[0][0]).toBe("ai")
		expect(calls.followups).toHaveLength(1)
		expect(calls.followups[0]).toContain("[INCLINE NOTICE]")
		expect(calls.followups[0]).toContain("task #12")
		expect(calls.followups[0]).toContain("[RESOLVED]")
	})

	it("does not interrupt a running or approval-waiting session, but still leaves the message", async () => {
		for (const phase of ["streaming", "awaiting_approval"] as TurnPhase[]) {
			const { api, calls } = fake(phase)
			off = registerConfirmReplyNotifier(api)
			emitConfirmReply({ id: 1, title: "t" })
			await flush()
			expect(calls.followups).toEqual([])
			expect(calls.messages).toHaveLength(1)
			off()
		}
	})

	it("with no AI session, hands over to the human (onNoAgent) instead of waking anyone", async () => {
		const { api, calls } = fake("idle", null)
		off = registerConfirmReplyNotifier(api)
		emitConfirmReply({ id: 7, title: "t" })
		await flush()
		expect(calls.followups).toEqual([])
		expect(calls.noAgent).toEqual([7])
		expect(canWakeAgent(api)).toBe(false)
	})

	it("does not bother the human while an AI session exists (running or idle): the AI judges", async () => {
		for (const phase of ["streaming", "awaiting_followup"] as TurnPhase[]) {
			const { api, calls } = fake(phase)
			off = registerConfirmReplyNotifier(api)
			emitConfirmReply({ id: 1, title: "t" })
			await flush()
			expect(calls.noAgent).toEqual([])
			off()
		}
	})

	it("the notice tells the agent not to add [RESOLVED] if the reply is not an answer", () => {
		expect(confirmReplyPrompt({ id: 3, title: "x" })).toContain("do not add [RESOLVED]")
	})
})
