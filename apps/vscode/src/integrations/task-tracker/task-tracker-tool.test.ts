import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTaskTrackerTool } from "./task-tracker-tool"

describe("task_tracker tool: update with a status change leaves a history line", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-tool-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})
	const run = async (tool: any, input: unknown): Promise<string> => {
		const r = await tool.execute(input, {} as any)
		return typeof r === "string" ? r : JSON.stringify(r)
	}
	it("keeps the report even when the model put it in remarks instead of a note", async () => {
		const tool = createTaskTrackerTool(dir) as any
		await run(tool, { action: "create", title: "t", assignee: "AI", status: "対応中" })
		await run(tool, { action: "update", id: 1, status: "報告", remarks: "README の最初の見出しは # INCLINE でした" })
		const text = await fs.readFile(path.join(dir, "task.md"), "utf-8")
		expect(text).toContain("ステータス: 対応中 → 報告。README の最初の見出しは # INCLINE でした")
	})
	it("does not add a history line when the status does not change", async () => {
		const tool = createTaskTrackerTool(dir) as any
		await run(tool, { action: "create", title: "t", assignee: "AI", status: "対応中" })
		await run(tool, { action: "update", id: 1, status: "対応中", remarks: "メモ" })
		const text = await fs.readFile(path.join(dir, "task.md"), "utf-8")
		expect(text).not.toContain("ステータス:")
	})
})
