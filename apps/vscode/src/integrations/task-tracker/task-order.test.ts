import { describe, expect, it } from "vitest"
import { forgetPosition, moveInOrder, reconcileOrder, sortByOrder } from "./task-order"
import type { Task } from "./task-md"

const t = (id: number, priority: Task["priority"], status = "未着手"): Task =>
	({ id, title: `t${id}`, priority, status, history: "", category: "", assignee: "", creator: "", created: "", updated: "", remarks: "" }) as unknown as Task

describe("task-order", () => {
	it("places new tasks once by priority and then keeps them", () => {
		const tasks = [t(1, "HIGH"), t(2, "LOW"), t(3, "MIDDLE")]
		const order = reconcileOrder(tasks, [])
		expect(order).toEqual([1, 3, 2])
		expect(reconcileOrder([...tasks, t(4, "HIGH")], order)).toEqual([1, 4, 3, 2])
	})
	it("drops ids that no longer exist", () => {
		expect(reconcileOrder([t(1, "HIGH")], [9, 1, 1])).toEqual([1])
	})
	it("moves before a target or to the end", () => {
		expect(moveInOrder([1, 2, 3], 3, 1)).toEqual([3, 1, 2])
		expect(moveInOrder([1, 2, 3], 1, null)).toEqual([2, 3, 1])
	})
	it("re-places by priority after forgetPosition", () => {
		const tasks = [t(1, "HIGH"), t(2, "HIGH"), t(3, "LOW")]
		const order = forgetPosition([1, 2, 3], 3)
		expect(reconcileOrder(tasks, order)).toEqual([1, 2, 3])
		const raised = [t(1, "HIGH"), t(2, "HIGH"), t(3, "HIGH")]
		expect(reconcileOrder(raised, forgetPosition([1, 2, 3], 1))).toEqual([2, 3, 1])
	})
	it("keeps closed tasks last whatever the manual order", () => {
		const tasks = [t(1, "HIGH", "完了"), t(2, "LOW")]
		expect(sortByOrder(tasks, [1, 2]).map((x) => x.id)).toEqual([2, 1])
	})
})
