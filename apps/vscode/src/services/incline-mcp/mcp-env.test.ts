import { describe, expect, it } from "vitest"
import { applyMcpProcessEnv, clearMcpProcessEnv, mcpEnvironment } from "./mcp-env"

describe("MCP connection environment variables", () => {
	it("builds URL / PORT / TOKEN for 127.0.0.1", () => {
		expect(mcpEnvironment({ port: 12345, token: "tok" })).toEqual({
			INCLINE_MCP_URL: "http://127.0.0.1:12345/mcp",
			INCLINE_MCP_PORT: "12345",
			INCLINE_MCP_TOKEN: "tok",
		})
	})

	it("sets them on the given env and clears them again (volatile)", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/bin" }
		applyMcpProcessEnv({ port: 12340, token: "a" }, env)
		expect(env.INCLINE_MCP_URL).toBe("http://127.0.0.1:12340/mcp")
		clearMcpProcessEnv("a", env)
		expect(env).toEqual({ PATH: "/bin" })
	})

	it("does not clear a newer connection that replaced it", () => {
		const env: NodeJS.ProcessEnv = {}
		applyMcpProcessEnv({ port: 12340, token: "old" }, env)
		applyMcpProcessEnv({ port: 12341, token: "new" }, env)
		clearMcpProcessEnv("old", env)
		expect(env.INCLINE_MCP_TOKEN).toBe("new")
	})
})

describe("scripts/incline-mcp (CLI for agents)", () => {
	it("connects through INCLINE_MCP_URL / INCLINE_MCP_TOKEN and also through a registry file by workspace", async () => {
		const { execFile } = await import("node:child_process")
		const fs = await import("node:fs/promises")
		const os = await import("node:os")
		const path = await import("node:path")
		const { TaskMdStore } = await import("@/integrations/task-tracker/task-md-store")
		const { startInclineMcpServer } = await import("./incline-mcp-server")

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-cli-"))
		const store = new TaskMdStore(path.join(dir, "task.md"))
		const h = await startInclineMcpServer({ store, workspace: dir, basePort: 47000 + Math.floor(Math.random() * 1500), runDir: path.join(dir, "run") })
		const cli = path.resolve(__dirname, "../../../../../scripts/incline-mcp")
		const run = (args: string[], env: Record<string, string>) =>
			new Promise<{ code: number; out: string }>((resolve) =>
				execFile("python3", [cli, ...args], { env: { PATH: process.env.PATH ?? "", HOME: dir, ...env } }, (err, stdout, stderr) =>
					resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }),
				),
			)
		try {
			// 1) 標準モード: 環境変数 (揮発)
			const env = { INCLINE_MCP_URL: `http://127.0.0.1:${h.port}/mcp`, INCLINE_MCP_TOKEN: h.token }
			expect((await run(["call", "task_create", '{"title":"from cli"}'], env)).out).toContain("from cli")
			const list = await run(["call", "task_list", "{}"], env)
			expect(list.code).toBe(0)
			expect(list.out).toContain("from cli")
			expect((await run(["tools"], env)).out).toContain("task_note")

			// 2) 環境変数なし → デバッグモードの登録ファイル (workspace 一致)
			const viaFile = await run(["--workspace", dir, "call", "task_list", "{}"], { INCLINE_DIR: dir })
			expect(viaFile.out).toContain("from cli")

			// 3) どちらも無い → 操作方法を案内するエラー (デバッグモードを要求しない文言になっている)
			const none = await run(["tools"], { INCLINE_DIR: path.join(dir, "empty") })
			expect(none.code).not.toBe(0)
			expect(none.out).toContain("Start a new Claude session")
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
