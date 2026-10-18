// Incline: 判断待ち ([CONFIRM]) を、スマホへ最優先の通知で知らせ、解決されるまで間隔を空けて繰り返す (#86 PoC)。
//  - 新しく有効になった [CONFIRM] ごとに、すぐ 1 回 (urgent)。
//  - まだ解決されていなければ repeatMinutes ごとに繰り返す (スヌーズ代わり)。最大 maxRepeats 回で止める。
//  - [RESOLVED] で解決された / 完了・削除になったら止める。
// vscode 非依存 (AlarmApi 経由なのでテスト可能)。

import { findOpenConfirms, type Task } from "./task-md"

/** PWA (apps/alarm-pwa) がアラームを鳴らす目印。メッセージの本文にこれが入っていると、PWA が爆音で鳴る。 */
export const FL_ALARM_MARKER = "[FL-Alarm]"

export interface AlarmApi {
	listTasks(): Promise<Task[]>
	notify(message: string): Promise<void>
	now?(): number
}

export const DEFAULT_REPEAT_MINUTES = 10
export const DEFAULT_MAX_REPEATS = 3

const OPEN = (t: Task) => t.status !== "完了" && t.status !== "削除"

/** 有効な判断待ちの識別子 (タスク id + 行番号 + tag)。 */
export function openConfirmKeys(task: Task): string[] {
	return OPEN(task) ? findOpenConfirms(task.history).map((c) => `${task.id}:${c.line}:${c.tag ?? ""}`) : []
}

export function alarmMessage(task: Task, repeat: number): string {
	return `${FL_ALARM_MARKER} ${repeat > 0 ? `(reminder ${repeat}) ` : ""}INCLINE needs your decision: #${task.id} ${task.title}`
}

export function createConfirmAlarm(api: AlarmApi, repeatMinutes = DEFAULT_REPEAT_MINUTES, maxRepeats = DEFAULT_MAX_REPEATS) {
	const now = api.now ?? Date.now
	/** key -> { 最後に通知した時刻, 通知済みの回数 } */
	const state = new Map<string, { at: number; sent: number }>()
	let seeded = false

	/** PWA で人間が Acknowledge した: いま開いている判断待ちのリマインドを止める (新しい判断待ちには、また通知する)。 */
	function acknowledge(): void {
		for (const [key, v] of state) {
			state.set(key, { at: v.at, sent: maxRepeats + 1 })
		}
	}

	/** タスクの変更のたび / 一定間隔で呼ぶ。通知した件数を返す。 */
	async function check(): Promise<number> {
		const tasks = await api.listTasks()
		const live = new Set<string>()
		let sent = 0
		for (const task of tasks) {
			for (const key of openConfirmKeys(task)) {
				live.add(key)
				const known = state.get(key)
				if (!known) {
					// 起動直後の最初の確認では、すでに開いている判断待ちを「通知済み」として記録だけする (起動のたびに鳴らさない)
					state.set(key, { at: now(), sent: seeded ? 1 : maxRepeats + 1 })
					if (seeded) {
						await api.notify(alarmMessage(task, 0))
						sent++
					}
				} else if (known.sent <= maxRepeats && now() - known.at >= repeatMinutes * 60_000) {
					await api.notify(alarmMessage(task, known.sent))
					state.set(key, { at: now(), sent: known.sent + 1 })
					sent++
				}
			}
		}
		for (const key of [...state.keys()]) {
			if (!live.has(key)) {
				state.delete(key) // 解決された
			}
		}
		seeded = true
		return sent
	}

	return { check, acknowledge }
}
