import { describe, expect, it } from "vitest"
import { alarmMessage, createConfirmAlarm, DEFAULT_MAX_REPEATS, FL_ALARM_MARKER } from "./confirm-alarm"
import { parseTaskMd, type Task } from "./task-md"

const mk = (id: number, status: string, history: string): Task =>
	parseTaskMd(`## [#${id}] 件名${id}\n- status: ${status}\n- priority: MIDDLE\n\n### 履歴\n${history}`).tasks[0]
const REG = "- 2026-10-17 10:00 AI: 登録。"
const CONFIRM = "- 2026-10-17 10:01 AI: [CONFIRM] どうしますか"
const RESOLVED = "- 2026-10-17 10:30 TK: [RESOLVED] A で"

function setup() {
	let tasks: Task[] = []
	let clock = 0
	const sent: string[] = []
	const alarm = createConfirmAlarm({ listTasks: async () => tasks, notify: async (m) => void sent.push(m), now: () => clock }, 10, DEFAULT_MAX_REPEATS)
	return {
		sent,
		alarm,
		set: (t: Task[]) => (tasks = t),
		advance: (min: number) => (clock += min * 60_000),
	}
}

describe("confirm alarm (#86 PoC)", () => {
	it("does not ring for confirmations that were already open at startup", async () => {
		const s = setup()
		s.set([mk(1, "対応中", `${REG}\n${CONFIRM}`)])
		expect(await s.alarm.check()).toBe(0)
		expect(s.sent).toEqual([])
	})

	it("rings immediately for a new [CONFIRM], repeats every interval up to the limit, and stops at [RESOLVED]", async () => {
		const s = setup()
		await s.alarm.check() // 起動時の確認 (何も無い)
		s.set([mk(2, "対応中", `${REG}\n${CONFIRM}`)])
		expect(await s.alarm.check()).toBe(1)
		expect(s.sent[0]).toBe(alarmMessage(mk(2, "対応中", REG), 0))
		s.advance(5)
		expect(await s.alarm.check()).toBe(0) // まだ間隔が来ていない
		s.advance(6)
		expect(await s.alarm.check()).toBe(1)
		expect(s.sent[1]).toContain("(reminder 1)")
		for (let i = 0; i < 6; i++) {
			s.advance(11)
			await s.alarm.check()
		}
		expect(s.sent).toHaveLength(1 + DEFAULT_MAX_REPEATS) // 上限で止まる

		s.set([mk(2, "対応中", `${REG}\n${CONFIRM}\n${RESOLVED}`)])
		s.advance(30)
		expect(await s.alarm.check()).toBe(0) // 解決したら鳴らない
	})

	it("every alarm message carries the [FL-Alarm] marker the PWA looks for", () => {
		expect(alarmMessage(mk(5, "対応中", REG), 0).startsWith(FL_ALARM_MARKER)).toBe(true)
		expect(alarmMessage(mk(5, "対応中", REG), 2)).toContain("(reminder 2)")
	})

	it("stops the reminders when the human acknowledges on the PWA, but a new question rings again", async () => {
		const s = setup()
		await s.alarm.check()
		s.set([mk(6, "対応中", `${REG}\n${CONFIRM}`)])
		expect(await s.alarm.check()).toBe(1)
		s.alarm.acknowledge() // PWA から ACK
		for (let i = 0; i < 5; i++) {
			s.advance(11)
			expect(await s.alarm.check()).toBe(0) // リマインドは止まる
		}
		s.set([mk(6, "対応中", `${REG}\n${CONFIRM}\n- 2026-10-17 11:00 AI: [CONFIRM:next] 次の質問`)])
		expect(await s.alarm.check()).toBe(1) // 新しい質問には鳴る
	})

	it("treats a second question on the same task as new, and ignores done / deleted tasks", async () => {
		const s = setup()
		await s.alarm.check()
		s.set([mk(3, "完了", `${REG}\n${CONFIRM}`), mk(4, "対応中", `${REG}\n- 2026-10-17 10:01 AI: [CONFIRM:db] DB は`)])
		expect(await s.alarm.check()).toBe(1) // 完了のタスクは鳴らさない
		s.set([mk(4, "対応中", `${REG}\n- 2026-10-17 10:01 AI: [CONFIRM:db] DB は\n- 2026-10-17 10:05 AI: [CONFIRM:ui] UI は`)])
		expect(await s.alarm.check()).toBe(1) // 新しい質問 (ui) だけ
	})
})
