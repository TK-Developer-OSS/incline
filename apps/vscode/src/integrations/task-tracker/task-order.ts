import { needsConfirmation, type Task, type TaskPriority } from "./task-md"

/**
 * Manual task order (#15). The order is a list of task ids kept in a side file next to task.md.
 * A task that is not in the list yet (new, or its priority just changed) is placed once by priority,
 * after that it stays where it is until the user drags it. Needs-decision tasks stay first and
 * closed (done / deleted) tasks stay last, whatever the manual order says.
 */

const PRIORITY_RANK: Record<TaskPriority, number> = { HIGH: 0, MIDDLE: 1, LOW: 2 }

/** Add the ids missing from `order` (by priority, once) and drop the ids that no longer exist. */
export function reconcileOrder(tasks: readonly Task[], order: readonly number[]): number[] {
	const byId = new Map(tasks.map((t) => [t.id, t]))
	const result = order.filter((id, i) => byId.has(id) && order.indexOf(id) === i)
	const missing = tasks.filter((t) => !result.includes(t.id)).sort((a, b) => a.id - b.id)
	for (const t of missing) {
		let at = result.findIndex((id) => PRIORITY_RANK[byId.get(id)!.priority] > PRIORITY_RANK[t.priority])
		if (at < 0) {
			at = result.length
		}
		result.splice(at, 0, t.id)
	}
	return result
}

/** The order the panel shows: needs-decision first, closed last, manual order inside each group. */
export function sortByOrder(tasks: readonly Task[], order: readonly number[]): Task[] {
	const pos = new Map(order.map((id, i) => [id, i]))
	const closed = (t: Task) => (t.status === "完了" || t.status === "削除" ? 1 : 0)
	const confirm = (t: Task) => (needsConfirmation(t) ? 0 : 1)
	return [...tasks].sort(
		(a, b) => closed(a) - closed(b) || confirm(a) - confirm(b) || (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || a.id - b.id,
	)
}

/** Move `id` just before `beforeId` (or to the end when `beforeId` is null / unknown). */
export function moveInOrder(order: readonly number[], id: number, beforeId: number | null): number[] {
	const rest = order.filter((x) => x !== id)
	const at = beforeId === null ? -1 : rest.indexOf(beforeId)
	rest.splice(at < 0 ? rest.length : at, 0, id)
	return rest
}

/** Forget the position of `id` so it is placed again by its (new) priority. */
export function forgetPosition(order: readonly number[], id: number): number[] {
	return order.filter((x) => x !== id)
}
