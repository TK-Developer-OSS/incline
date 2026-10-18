import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import { ACTIVITY_LINGER_MS, type InclineMcpHandle, removeStaleRegistryFiles, startInclineMcpServer } from "./incline-mcp-server"

const basePort = 41000 + Math.floor(Math.random() * 2000)

describe("INCLINE MCP server", () => {
	let dir: string
	let store: TaskMdStore
	let handle: InclineMcpHandle | undefined
	const blockers: net.Server[] = []

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-"))
		store = new TaskMdStore(path.join(dir, "task.md"))
	})
	afterEach(async () => {
		await handle?.close()
		handle = undefined
		await Promise.all(blockers.splice(0).map((b) => new Promise((r) => b.close(() => r(undefined)))))
		await fs.rm(dir, { recursive: true, force: true })
	})

	const start = (extra: Record<string, unknown> = {}) =>
		startInclineMcpServer({
			store,
			workspace: dir,
			basePort,
			runDir: path.join(dir, "run"),
			getRateStatus: () => ({ rpm: 1 }),
			...extra,
		})

	async function connect(h: InclineMcpHandle) {
		const client = new Client({ name: "test", version: "0.0.0" })
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
			}),
		)
		return client
	}

	it("lists tools and runs task tools against the real task.md", async () => {
		handle = await start()
		const client = await connect(handle)
		const names = (await client.listTools()).tools.map((t) => t.name).sort()
		expect(names).toEqual(["rate_status", "task_create", "task_list", "task_note", "task_update"])

		const created = await client.callTool({ name: "task_create", arguments: { title: "MCP から登録", category: "メモ", priority: "HIGH" } })
		expect(JSON.stringify(created)).toContain("登録しました")
		const tasks = await store.list()
		expect(tasks).toHaveLength(1)
		expect(tasks[0]).toMatchObject({ title: "MCP から登録", category: "メモ", priority: "HIGH", creator: "AI" })

		await client.callTool({ name: "task_update", arguments: { id: tasks[0].id, status: "対応中" } })
		await client.callTool({ name: "task_note", arguments: { id: tasks[0].id, text: "進捗メモ" } })
		const after = (await store.list())[0]
		expect(after.status).toBe("対応中")
		expect(after.history).toContain("AI: 進捗メモ")

		const listed = await client.callTool({ name: "task_list", arguments: { status: "対応中" } })
		expect(JSON.stringify(listed)).toContain("MCP から登録")
		const rate = await client.callTool({ name: "rate_status", arguments: {} })
		expect(JSON.stringify(rate)).toContain("rpm")
		await client.close()
	})

	it("rejects requests without the token and only listens on 127.0.0.1", async () => {
		handle = await start()
		const noAuth = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: "POST" })
		expect(noAuth.status).toBe(401)
		const wrong = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope" } })
		expect(wrong.status).toBe(401)
	})

	it("writes a registry file (0600) with port and token, and removes it on close", async () => {
		handle = await start()
		const info = JSON.parse(await fs.readFile(handle.registryFile, "utf8"))
		expect(info).toMatchObject({ port: handle.port, token: handle.token, workspace: dir, url: `http://127.0.0.1:${handle.port}/mcp` })
		expect((await fs.stat(handle.registryFile)).mode & 0o777).toBe(0o600)
		const file = handle.registryFile
		await handle.close()
		handle = undefined
		await expect(fs.access(file)).rejects.toThrow()
	})

	it("picks the next free port when the base port is taken (one port per window)", async () => {
		const blocker = net.createServer()
		await new Promise<void>((r) => blocker.listen(basePort, "127.0.0.1", () => r()))
		blockers.push(blocker)
		handle = await start()
		expect(handle.port).toBe(basePort + 1)

		const second = await start()
		expect(second.port).toBe(basePort + 2)
		await second.close()
	})
})

describe("INCLINE MCP server: 操作中の通知 (#71)", () => {
	it("reports activity while authenticated requests are handled and clears it after the linger time", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-act-"))
		const events: boolean[] = []
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: basePort + 50,
			runDir: path.join(dir, "run"),
			onActivity: (a) => events.push(a),
		})
		try {
			// 認証なしのリクエストは「操作」に数えない
			await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST" })
			expect(events).toEqual([])

			const r = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
				method: "POST",
				headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			})
			await r.text()
			expect(events[0]).toBe(true)
			await new Promise((resolve) => setTimeout(resolve, ACTIVITY_LINGER_MS + 500))
			expect(events).toEqual([true, false])
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: ネットワーク (#72) とデバッグモード (#73)", () => {
	it("listens on 127.0.0.1 only: not reachable through a non-loopback address", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-net-"))
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: basePort + 80,
			runDir: path.join(dir, "run"),
		})
		try {
			// loopback では繋がる
			const ok = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST" })
			expect(ok.status).toBe(401)
			// loopback 以外の自分の IPv4 アドレスでは繋がらない (127.0.0.1 にしか bind していない)
			const external = Object.values(os.networkInterfaces())
				.flat()
				.find((i) => i && i.family === "IPv4" && !i.internal)
			if (external) {
				const connected = await new Promise<boolean>((resolve) => {
					const sock = net.connect({ host: external.address, port: h.port, timeout: 1500 })
					sock.once("connect", () => {
						sock.destroy()
						resolve(true)
					})
					sock.once("error", () => resolve(false))
					sock.once("timeout", () => {
						sock.destroy()
						resolve(false)
					})
				})
				expect(connected).toBe(false)
			}
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("standard mode (discoverable: false) writes no registry file; debug mode can publish and unpublish it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-dbg-"))
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: basePort + 120,
			runDir: path.join(dir, "run"),
			discoverable: false,
		})
		try {
			await expect(fs.access(h.registryFile)).rejects.toThrow()
			await h.setDiscoverable(true)
			expect(JSON.parse(await fs.readFile(h.registryFile, "utf8"))).toMatchObject({ port: h.port, token: h.token })
			expect((await fs.stat(h.registryFile)).mode & 0o777).toBe(0o600)
			await h.setDiscoverable(false)
			await expect(fs.access(h.registryFile)).rejects.toThrow()
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: パネルがなくても (バックグラウンドで) タスク操作できる (#82)", () => {
	it("writes task.md without any panel and notifies the panel after create / update / note", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-bg-"))
		const store = new TaskMdStore(path.join(dir, "task.md"))
		let changed = 0
		const h = await startInclineMcpServer({ store, workspace: dir, basePort: basePort + 160, runDir: path.join(dir, "run"), onTasksChanged: () => changed++ })
		const client = new Client({ name: "test", version: "0.0.0" })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }),
			)
			await client.callTool({ name: "task_create", arguments: { title: "背景で登録" } })
			const id = (await store.list())[0].id
			await client.callTool({ name: "task_update", arguments: { id, status: "対応中" } })
			await client.callTool({ name: "task_note", arguments: { id, text: "背景で追記" } })
			expect(changed).toBe(3)
			const t = (await store.list())[0]
			expect(t).toMatchObject({ title: "背景で登録", status: "対応中" })
			expect(t.history).toContain("AI: 背景で追記")
		} finally {
			await client.close()
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: 登録ファイルの保護と自己修復 (#84)", () => {
	const mk = async (extra: Record<string, unknown> = {}) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-reg-"))
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: basePort + 200 + Math.floor(Math.random() * 90),
			runDir: path.join(dir, "run"),
			...extra,
		})
		return { dir, h }
	}

	it("on close, does not delete a registry file that now belongs to another process", async () => {
		const { dir, h } = await mk()
		try {
			// 別のプロセスが同名のファイルを書いた (別の pid / トークン)
			await fs.writeFile(h.registryFile, JSON.stringify({ port: h.port, token: "someone-else", pid: process.pid + 1 }))
			await h.close()
			expect(JSON.parse(await fs.readFile(h.registryFile, "utf8")).token).toBe("someone-else")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("on close, deletes its own registry file", async () => {
		const { dir, h } = await mk()
		try {
			await h.close()
			await expect(fs.access(h.registryFile)).rejects.toThrow()
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rewrites the registry file when it disappears (or is overwritten) while the server keeps running", async () => {
		const { dir, h } = await mk({ registryCheckMs: 100 })
		try {
			await fs.unlink(h.registryFile)
			await new Promise((r) => setTimeout(r, 400))
			expect(JSON.parse(await fs.readFile(h.registryFile, "utf8"))).toMatchObject({ port: h.port, token: h.token, pid: process.pid })

			await fs.writeFile(h.registryFile, JSON.stringify({ port: h.port, token: "stale", pid: 1 }))
			await new Promise((r) => setTimeout(r, 400))
			expect(JSON.parse(await fs.readFile(h.registryFile, "utf8")).token).toBe(h.token)
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("does not recreate the file in standard mode (discoverable: false)", async () => {
		const { dir, h } = await mk({ discoverable: false, registryCheckMs: 100 })
		try {
			await new Promise((r) => setTimeout(r, 400))
			await expect(fs.access(h.registryFile)).rejects.toThrow()
		} finally {
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: 古い登録ファイルの掃除", () => {
	it("removes registry files whose owner process is gone, keeps live ones and unrelated files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-stale-"))
		try {
			const dead = path.join(dir, "mcp-12340.json")
			const mine = path.join(dir, "mcp-12341.json")
			const alive = path.join(dir, "mcp-12342.json")
			const other = path.join(dir, "notes.json")
			await fs.writeFile(dead, JSON.stringify({ port: 12340, pid: 2 ** 22 + 4321, token: "x" }))
			await fs.writeFile(mine, JSON.stringify({ port: 12341, pid: process.pid, token: "y" }))
			await fs.writeFile(alive, JSON.stringify({ port: 12342, pid: process.ppid, token: "z" }))
			await fs.writeFile(other, JSON.stringify({ pid: 2 ** 22 + 4321 }))
			expect(await removeStaleRegistryFiles(dir)).toEqual(["mcp-12340.json"])
			expect((await fs.readdir(dir)).sort()).toEqual(["mcp-12341.json", "mcp-12342.json", "notes.json"])
			expect(await removeStaleRegistryFiles(path.join(dir, "nope"))).toEqual([])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: task_list の ⚠CONFIRM", () => {
	it("marks tasks with an open [CONFIRM] in task_list", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-cf-"))
		const store = new TaskMdStore(path.join(dir, "task.md"))
		const h = await startInclineMcpServer({ store, workspace: dir, basePort: basePort + 300, runDir: path.join(dir, "run") })
		const client = new Client({ name: "test", version: "0.0.0" })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }),
			)
			await client.callTool({ name: "task_create", arguments: { title: "判断が要る" } })
			await client.callTool({ name: "task_create", arguments: { title: "普通" } })
			const [a, b] = await store.list()
			await client.callTool({ name: "task_note", arguments: { id: a.id, text: "[CONFIRM] どちらにしますか" } })
			const list = (await client.callTool({ name: "task_list", arguments: {} })) as any
			const lines = (list.content[0].text as string).split("\n")
			expect(lines.find((l) => l.includes("判断が要る"))).toContain("⚠CONFIRM")
			expect(lines.find((l) => l.includes("普通"))).not.toContain("⚠CONFIRM")
			await client.callTool({ name: "task_note", arguments: { id: a.id, text: "[RESOLVED] A に決定" } })
			const after = (await client.callTool({ name: "task_list", arguments: {} })) as any
			expect(after.content[0].text).not.toContain("⚠CONFIRM")
			expect(b).toBeTruthy()
		} finally {
			await client.close()
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("INCLINE MCP server: model_info (#91)", () => {
	it("returns the provider / model name through the model_info tool", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-model-"))
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: basePort + 400,
			runDir: path.join(dir, "run"),
			getModelInfo: () => ({ mode: "act", provider: "gemini", modelId: "gemini-3.5-flash-lite" }),
		})
		const client = new Client({ name: "test", version: "0.0.0" })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }),
			)
			const r = (await client.callTool({ name: "model_info", arguments: {} })) as any
			expect(JSON.parse(r.content[0].text)).toMatchObject({ provider: "gemini", modelId: "gemini-3.5-flash-lite", mode: "act" })
		} finally {
			await client.close()
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
