import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnPhase } from "@/shared/ExtensionMessage"
import { decideWatchdog, MAX_NUDGES, type PendingWork, startWatchdog, type WatchdogApi, watchdogPrompt } from "./watchdog"

const work = (aiInProgress: number, waitingForHuman = 0): PendingWork => ({ aiInProgress, waitingForHuman })
const base = { busy: false, idleMs: 6 * 60_000, intervalMs: 5 * 60_000, work: work(2), nudgesSoFar: 0 }

describe("decideWatchdog", () => {
	it("nudges only when idle long enough with AI work left, and not while busy / waiting for a human / over the limit", () => {
		expect(decideWatchdog(base)).toBe("nudge")
		expect(decideWatchdog({ ...base, busy: true })).toBe("busy")
		expect(decideWatchdog({ ...base, work: work(0) })).toBe("no-work")
		expect(decideWatchdog({ ...base, work: work(2, 2) })).toBe("waiting-for-human") // 全部が人間の判断待ち = 正当な待機
		expect(decideWatchdog({ ...base, work: work(2, 1) })).toBe("nudge") // 1 つでも動けるものが残っていれば通知
		expect(decideWatchdog({ ...base, idleMs: 60_000 })).toBe("not-idle-long-enough")
		expect(decideWatchdog({ ...base, nudgesSoFar: MAX_NUDGES })).toBe("limit-reached")
	})
	it("the nudge tells the agent to write [CONFIRM] if it waits for a human, else to continue", () => {
		const p = watchdogPrompt(5, work(2))
		expect(p).toContain("[INCLINE WATCHDOG]")
		expect(p).toContain("[CONFIRM]")
		expect(p).toContain("continue")
	})
})

describe("watchdogPrompt: no repeated [CONFIRM] notes (#111)", () => {
	it("names the tasks to act on and forbids adding notes to tasks that already wait for the human", () => {
		const p = watchdogPrompt(10, { aiInProgress: 3, waitingForHuman: 2, actionableIds: [7] })
		expect(p).toContain("#7")
		expect(p).toContain("Do NOT add notes to a task that already has an open [CONFIRM]")
		expect(p).toContain("2 such task(s)")
		expect(p).toContain("do not reply to this message again")
	})
})

describe("startWatchdog", () => {
	let clock = 0
	let phase: TurnPhase = "awaiting_followup"
	let stop: (() => void) | undefined
	const calls = { followups: [] as string[], messages: [] as [string, string][] }
	const api = (w: PendingWork, taskId: string | null = "t1"): WatchdogApi => ({
		phase: () => phase,
		taskId: () => taskId ?? undefined,
		pendingWork: async () => w,
		followup: async (p) => void calls.followups.push(p),
		postMessage: async (to, title) => void calls.messages.push([to, title]),
		now: () => clock,
	})

	beforeEach(() => {
		vi.useFakeTimers()
		clock = 0
		phase = "awaiting_followup"
		calls.followups = []
		calls.messages = []
	})
	afterEach(() => {
		stop?.()
		vi.useRealTimers()
	})
	// 1 分ずつ時計とタイマーを進める (各 tick が、その時点の時刻を見るように)
	const advance = async (ms: number) => {
		for (let t = 0; t < ms; t += 60_000) {
			clock += 60_000
			await vi.advanceTimersByTimeAsync(60_000)
		}
	}

	it("nudges the agent and the manager once per interval while idle, up to the limit, and resets when the agent becomes active", async () => {
		stop = startWatchdog(api(work(1)), 5, 60_000)
		await advance(4 * 60_000)
		expect(calls.followups).toHaveLength(0) // まだ 5 分たっていない
		await advance(2 * 60_000)
		expect(calls.followups).toHaveLength(1)
		expect(calls.messages[0][0]).toBe("manager")
		await advance(60_000)
		expect(calls.followups).toHaveLength(1) // 同じ間隔内では 1 回だけ
		await advance(5 * 60_000)
		expect(calls.followups).toHaveLength(2)

		await advance(60 * 60_000) // 上限で止まる
		expect(calls.followups).toHaveLength(MAX_NUDGES)

		phase = "streaming" // 動き出したら、次の停止でまた通知できる
		await advance(60_000)
		phase = "completed"
		await advance(6 * 60_000)
		expect(calls.followups.length).toBeGreaterThan(MAX_NUDGES)
	})

	it("does nothing when no AI task is in progress, or when it is only waiting for a human", async () => {
		stop = startWatchdog(api(work(0)), 5, 60_000)
		await advance(20 * 60_000)
		expect(calls.followups).toHaveLength(0)
		stop()
		stop = startWatchdog(api(work(2, 2)), 5, 60_000)
		await advance(20 * 60_000)
		expect(calls.followups).toHaveLength(0)
		expect(calls.messages).toHaveLength(0)
	})

	it("with no agent session it only messages the manager (nothing to wake)", async () => {
		stop = startWatchdog(api(work(1), null), 5, 60_000)
		await advance(6 * 60_000)
		expect(calls.followups).toHaveLength(0)
		expect(calls.messages).toHaveLength(1)
	})
})

describe("startWatchdog: activity between samples", () => {
	it("resets the nudge limit when the latest message is newer than the last busy sample", async () => {
		vi.useFakeTimers()
		let clock = 1_000_000
		let activity: number | undefined
		const postMessage = vi.fn(async () => {})
		const api = {
			phase: () => "completed" as const,
			taskId: () => undefined,
			pendingWork: async () => ({ aiInProgress: 1, waitingForHuman: 0 }),
			followup: async () => {},
			postMessage,
			now: () => clock,
			lastActivityAt: () => activity,
		}
		const stop = startWatchdog(api as any, 1, 30_000)
		for (let i = 0; i < 24; i++) {
			clock += 30_000
			await vi.advanceTimersByTimeAsync(30_000)
		}
		const before = postMessage.mock.calls.length
		expect(before).toBe(MAX_NUDGES) // the limit is reached and it stays quiet
		activity = clock // a short turn happened between two samples
		for (let i = 0; i < 6; i++) {
			clock += 30_000
			await vi.advanceTimersByTimeAsync(30_000)
		}
		expect(postMessage.mock.calls.length).toBeGreaterThan(before) // activity reset the limit, so it nudges again
		stop()
		vi.useRealTimers()
	})
})
