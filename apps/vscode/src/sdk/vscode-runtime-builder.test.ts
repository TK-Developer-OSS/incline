import sinon from "sinon"
import { describe, expect, it } from "vitest"
import { createVscodeExtraTools, McpHubToolProvider } from "./vscode-runtime-builder"

describe("McpHubToolProvider", () => {
	it("forwards the agent abort signal to McpHub", async () => {
		const callTool = sinon.stub().resolves({ content: [] })
		const provider = new McpHubToolProvider({ callTool } as never)
		const controller = new AbortController()

		await provider.callTool({
			serverName: "server",
			toolName: "slow-tool",
			context: {
				agentId: "agent",
				iteration: 1,
				signal: controller.signal,
			},
		})

		expect(callTool.calledOnce).toBe(true)
		expect(callTool.firstCall.args[4]).toBe(controller.signal)
	})
})

describe("createVscodeExtraTools task_tracker", () => {
	const hub = { getServers: () => [], callTool: async () => ({ content: [] }) } as never
	const names = async (taskTrackerToolEnabled?: boolean) =>
		(await createVscodeExtraTools(hub, { cwd: "/tmp", taskTrackerToolEnabled })).map((t) => t.name)

	it("includes task_tracker by default", async () => {
		expect(await names()).toContain("task_tracker")
	})

	it("omits task_tracker when disabled", async () => {
		expect(await names(false)).not.toContain("task_tracker")
	})
})
