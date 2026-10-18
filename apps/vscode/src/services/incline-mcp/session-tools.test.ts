import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import type { ClineMessage, TurnPhase } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { type InclineMcpHandle, startInclineMcpServer } from "./incline-mcp-server"
import { buildSessionStatusFull, classifySessionError, latestApiFailure, type SessionControlApi, sessionActivity } from "./session-tools"

const basePort = 45000 + Math.floor(Math.random() * 2000)

class FakeSession implements SessionControlApi {
	enabled = true
	currentPhase: TurnPhase = "idle"
	id: string | undefined
	msgs: ClineMessage[] = []
	started: string[] = []
	followups: string[] = []
	cancelled = 0
	ended = 0
	isEnabled() {
		return this.enabled
	}
	phase() {
		return this.currentPhase
	}
	taskId() {
		return this.id
	}
	messages() {
		return this.msgs
	}
	async startTask(prompt: string) {
		this.started.push(prompt)
		this.id = "task-1"
		this.currentPhase = "streaming"
		return this.id
	}
	async followup(prompt: string) {
		this.followups.push(prompt)
		this.currentPhase = "streaming"
	}
	async cancel() {
		this.cancelled++
		this.currentPhase = "resumable"
	}
	async end() {
		this.ended++
		this.id = undefined
		this.currentPhase = "idle"
	}
}

describe("INCLINE MCP session tools", () => {
	let dir: string
	let handle: InclineMcpHandle
	let client: Client
	let fake: FakeSession

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-mcp-sess-"))
		fake = new FakeSession()
		handle = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort,
			runDir: path.join(dir, "run"),
			sessionApi: fake,
		})
		client = new Client({ name: "test", version: "0.0.0" })
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
			}),
		)
	})
	afterEach(async () => {
		await client.close()
		await handle.close()
		await fs.rm(dir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
		const text = r.content[0].text
		let json: any
		try {
			json = JSON.parse(text)
		} catch {
			json = undefined
		}
		return { isError: r.isError === true, text, json }
	}

	it("registers the session tools next to the task tools", async () => {
		const names = (await client.listTools()).tools.map((t) => t.name)
		for (const n of ["session_send", "session_status", "session_messages", "session_cancel", "session_end", "session_wait"]) {
			expect(names).toContain(n)
		}
	})

	it("is disabled unless the setting is on", async () => {
		fake.enabled = false
		for (const [name, args] of [["session_send", { prompt: "x" }], ["session_status", {}], ["session_cancel", {}], ["session_end", {}], ["session_wait", {}]] as const) {
			const r = await call(name, args as Record<string, unknown>)
			expect(r.isError).toBe(true)
			expect(r.text).toContain("Enable MCP server")
		}
		expect(fake.started).toEqual([])
	})

	it("session_send(new_task) starts a session and returns its id; refuses while one is running", async () => {
		const first = await call("session_send", { prompt: "新しい作業をして" })
		expect(first.json).toMatchObject({ id: "task-1", started: true })
		expect(fake.started).toEqual(["新しい作業をして"])

		const second = await call("session_send", { prompt: "もう1つ" })
		expect(second.isError).toBe(true)
		expect(second.text).toContain("実行中のセッションがあります")
		expect(fake.started).toHaveLength(1)
	})

	it("session_send(new_task=false) sends a follow-up (e.g. an answer to a question) to the current session", async () => {
		const none = await call("session_send", { prompt: "返事", new_task: false })
		expect(none.isError).toBe(true)

		await call("session_send", { prompt: "開始" })
		fake.currentPhase = "awaiting_followup"
		const r = await call("session_send", { prompt: "はい、続けてください", new_task: false })
		expect(r.json).toMatchObject({ id: "task-1", sent: true })
		expect(fake.followups).toEqual(["はい、続けてください"])
	})

	it("session_status maps phases, sums tokens and shortens the last message", async () => {
		fake.id = "task-1"
		fake.msgs = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1000, tokensOut: 200 }) } as ClineMessage,
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 3000, tokensOut: 100 }) } as ClineMessage,
			{ ts: 3, type: "say", say: "text", text: `${"あ".repeat(300)}` } as ClineMessage,
		]
		const expectations: [TurnPhase, string][] = [
			["streaming", "running"],
			["awaiting_approval", "waiting_approval"],
			["awaiting_followup", "waiting_question"],
			["completed", "completed"],
			["error", "error"],
			["resumable", "cancelled"],
			["idle", "idle"],
		]
		for (const [phase, status] of expectations) {
			fake.currentPhase = phase
			const r = await call("session_status")
			expect(r.json.status).toBe(status)
		}
		const r = await call("session_status", { id: "task-1" })
		expect(r.json.tokens).toMatchObject({ in: 4000, out: 300 })
		expect(r.json.lastMessage.text).toHaveLength(200)
	})

	it("returns a completion report in (almost) full, and the last N messages in order (#75)", async () => {
		fake.id = "task-1"
		fake.currentPhase = "completed"
		const report = `完了報告: ${"結果 ".repeat(600)}`
		fake.msgs = [
			{ ts: 1, type: "say", say: "text", text: "途中経過A" } as ClineMessage,
			{ ts: 2, type: "say", say: "api_req_started", text: "{}" } as ClineMessage,
			{ ts: 3, type: "say", say: "text", text: "途中経過B" } as ClineMessage,
			{ ts: 4, type: "say", say: "completion_result", text: report } as ClineMessage,
		]
		const status = await call("session_status")
		expect(status.json.lastMessage.kind).toBe("completion_result")
		expect(status.json.lastMessage.text.length).toBeGreaterThan(1500) // 200 字では切れない
		expect(status.json.lastMessage.text.length).toBeLessThanOrEqual(4000)

		const list = await call("session_messages", { count: 3 })
		expect(list.json.messages.map((m: any) => m.text.slice(0, 5))).toEqual(["途中経過A", "途中経過B", "完了報告:"])
		expect(list.json.messages).toHaveLength(3) // api_req_started は含まない
		const one = await call("session_messages", { count: 1 })
		expect(one.json.messages).toHaveLength(1)
		expect(one.json.messages[0].kind).toBe("completion_result")
	})

	it("session_status reports retrying while the auto-retry notice is the latest message", async () => {
		fake.id = "task-1"
		fake.currentPhase = "streaming"
		fake.msgs = [{ ts: 1, type: "say", say: "info", text: "⏳ ... 約 40 秒後に自動リトライします（1/100）" } as ClineMessage]
		expect((await call("session_status")).json.status).toBe("retrying")
	})

	it("only operates on this window's current session", async () => {
		fake.id = "task-1"
		const r = await call("session_cancel", { id: "other-window-task" })
		expect(r.isError).toBe(true)
		expect(r.text).toContain("別ウィンドウ")
		expect(fake.cancelled).toBe(0)
	})

	it("session_cancel and session_end call through", async () => {
		fake.id = "task-1"
		fake.currentPhase = "streaming"
		expect((await call("session_cancel")).json.status).toBe("cancelled")
		expect(fake.cancelled).toBe(1)
		expect((await call("session_end")).json.status).toBe("idle")
		expect(fake.ended).toBe(1)
	})

	it("session_wait returns once the session settles, or times out", async () => {
		fake.id = "task-1"
		fake.currentPhase = "streaming"
		setTimeout(() => {
			fake.currentPhase = "completed"
		}, 700)
		const done = await call("session_wait", { timeout_sec: 10 })
		expect(done.json).toMatchObject({ status: "completed", timedOut: false })

		fake.currentPhase = "streaming"
		const timeout = await call("session_wait", { timeout_sec: 1 })
		expect(timeout.json).toMatchObject({ status: "running", timedOut: true })
	})

	it("never writes the prompt text to the log (only its length)", async () => {
		const logged: string[] = []
		vi.spyOn(Logger, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})
		await call("session_send", { prompt: "秘密のトークン sk-SECRET-123 を含む指示" })
		expect(logged.join("\n")).toContain("session_send")
		expect(logged.join("\n")).not.toContain("sk-SECRET-123")
	})
})


describe("sessionActivity (#112)", () => {
	it("derives times, tool-call count and the latest request input size from the messages", () => {
		const r = sessionActivity(
			[
				{ ts: 1,createdAt: 1792000001000, type: "say", say: "text", text: "hi" },
				{ ts: 2,createdAt: 1792000002000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1200, cacheReads: 300 }) },
				{ ts: 3,createdAt: 1792000003000, type: "say", say: "command", text: "ls" },
				{ ts: 4,createdAt: 1792000004000, type: "say", say: "tool", text: "{}" },
				{ ts: 5,createdAt: 1792000005000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 2500 }) },
			],
			1792000011000,
		)
		expect(r).toEqual({ startedAt: 1792000001000, lastActivityAt: 1792000005000, elapsedSec: 10, toolCalls: 2, contextTokens: 2500 })
	})
	it("returns nulls for an empty session", () => {
		expect(sessionActivity([], 1)).toEqual({ startedAt: null, lastActivityAt: null, elapsedSec: null, toolCalls: 0, contextTokens: null })
	})
})


describe("classifySessionError (#112)", () => {
	it("classifies api_req_failed texts", () => {
		expect(classifySessionError("This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 3911.").kind).toBe("insufficient_credits")
		expect(classifySessionError("429 Too Many Requests: quota exceeded")).toMatchObject({ kind: "rate_limit", httpStatus: 429 })
		expect(classifySessionError("504 Gateway Timeout")).toMatchObject({ kind: "timeout", httpStatus: 504 })
		expect(classifySessionError("401 Unauthorized: invalid API key")).toMatchObject({ kind: "auth", httpStatus: 401 })
		expect(classifySessionError("503 Service Unavailable")).toMatchObject({ kind: "server_error", httpStatus: 503 })
		expect(classifySessionError("something odd")).toMatchObject({ kind: "other", httpStatus: null })
	})
})


describe("buildSessionStatusFull: pendingConfirm (#112)", () => {
	const base = { isEnabled: () => true, phase: () => "idle" as const, taskId: () => undefined, messages: () => [], startTask: async () => undefined, followup: async () => {}, cancel: async () => {}, end: async () => {} }
	it("adds the cards with an unresolved [CONFIRM]", async () => {
		const s = await buildSessionStatusFull({ ...base, pendingConfirms: async () => [{ id: 7, topics: ["t1"] }] })
		expect(s.pendingConfirm).toEqual([{ id: 7, topics: ["t1"] }])
	})
	it("is null when the lookup is not available or fails", async () => {
		expect((await buildSessionStatusFull(base)).pendingConfirm).toBeNull()
		expect((await buildSessionStatusFull({ ...base, pendingConfirms: async () => Promise.reject(new Error("x")) })).pendingConfirm).toBeNull()
	})
})


describe("latestApiFailure (#112)", () => {
	const fail = { type: "ask", ask: "api_req_failed", text: "429 Too Many Requests: quota exceeded" } as any
	const retry = { type: "say", say: "info", text: "🔄 自動リトライ中…（1/1）" } as any
	it("finds the failure even when the last message is the retry notice", () => {
		expect(latestApiFailure([fail, retry])).toMatchObject({ kind: "rate_limit", httpStatus: 429 })
	})
	it("is null when a normal reply came after the failure, or when there is none", () => {
		expect(latestApiFailure([fail, { type: "say", say: "completion_result", text: "OK" } as any])).toBeNull()
		expect(latestApiFailure([retry])).toBeNull()
	})
})

describe("classifySessionError: Google quota text (#112)", () => {
	it("treats Gemini's 'exceeded your current quota ... billing details' as a rate limit, not missing credits", () => {
		expect(classifySessionError("You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.").kind).toBe("rate_limit")
	})
})

describe("sessionActivity: identity counters are not times (#112 / #100)", () => {
	it("ignores small ts counters and uses createdAt", () => {
		const r = sessionActivity(
			[
				{ ts: 1, createdAt: 1792000000000, type: "say", say: "text" },
				{ ts: 2, createdAt: 1792000005000, type: "say", say: "completion_result" },
			],
			1792000010000,
		)
		expect(r).toMatchObject({ startedAt: 1792000000000, lastActivityAt: 1792000005000, elapsedSec: 10 })
	})
	it("is null when no message has a real time (no huge elapsedSec)", () => {
		expect(sessionActivity([{ ts: 1, type: "say", say: "text" }], 1792000010000)).toMatchObject({ startedAt: null, elapsedSec: null })
	})
})
