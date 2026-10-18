import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import { startInclineMcpServer } from "./incline-mcp-server"
import { defaultMessageFile, MAX_TEXT_CHARS, MessageStore } from "./message-store"

describe("MessageStore", () => {
	let dir: string
	let file: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-msg-"))
		file = path.join(dir, "data", "messages", "x.jsonl")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("posts with increasing ids and reads in order; defaults sender to AI", async () => {
		const store = new MessageStore(file)
		const a = await store.post({ to: "TK", title: "完了報告", text: "終わりました" })
		const b = await store.post({ to: "claude", title: "質問", text: "どちらにしますか", from: "gemini" })
		expect([a.id, b.id]).toEqual([1, 2])
		expect(a.from).toBe("AI")
		expect((await store.read()).map((m) => [m.id, m.from, m.to])).toEqual([
			[1, "AI", "TK"],
			[2, "gemini", "claude"],
		])
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
	})

	it("filters by since / to (all included) / unacked / limit", async () => {
		const store = new MessageStore(file)
		await store.post({ to: "TK", title: "a", text: "1" })
		await store.post({ to: "claude", title: "b", text: "2" })
		await store.post({ to: "ALL", title: "c", text: "3" })
		expect((await store.read({ sinceId: 1 })).map((m) => m.id)).toEqual([2, 3])
		expect((await store.read({ to: "Claude" })).map((m) => m.id)).toEqual([2, 3]) // 大文字小文字を区別しない + all 宛
		expect((await store.read({ limit: 2 })).map((m) => m.id)).toEqual([1, 2])
		await store.ack(2, "claude")
		expect((await store.read({ to: "claude", unackedBy: "claude" })).map((m) => m.id)).toEqual([3])
	})

	it("ack is recorded once per person and unknown ids are rejected", async () => {
		const store = new MessageStore(file)
		const m = await store.post({ to: "TK", title: "t", text: "x" })
		await store.ack(m.id, "TK")
		const again = await store.ack(m.id, "tk")
		expect(again?.ackedBy).toEqual(["TK"])
		expect(await store.ack(99, "TK")).toBeUndefined()
	})

	it("limits the body, rejects empty fields, and skips a corrupted line", async () => {
		const store = new MessageStore(file)
		const long = await store.post({ to: "TK", title: "t", text: "あ".repeat(MAX_TEXT_CHARS + 500) })
		expect(long.text).toHaveLength(MAX_TEXT_CHARS)
		await expect(store.post({ to: " ", title: "", text: "x" })).rejects.toThrow()
		await expect(store.post({ to: "TK", title: "", text: "   " })).rejects.toThrow()
		await fs.appendFile(file, "{ これは壊れた行\n")
		const next = await store.post({ to: "TK", title: "t", text: "after" })
		expect(next.id).toBe(2)
		expect((await store.read()).map((m) => m.id)).toEqual([1, 2])
	})

	it("does not lose messages when several stores (= windows / processes) post concurrently", async () => {
		const stores = [new MessageStore(file), new MessageStore(file), new MessageStore(file)]
		const posted = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 3].post({ to: "all", title: `t${i}`, text: `m${i}` })))
		const all = await new MessageStore(file).read()
		expect(all).toHaveLength(30)
		expect(new Set(posted.map((m) => m.title)).size).toBe(30)
	})

	it("keeps the file outside the repo, keyed by workspace", () => {
		const a = defaultMessageFile("/work/a", "/home/u/.incline")
		const b = defaultMessageFile("/work/b", "/home/u/.incline")
		expect(a).not.toBe(b)
		expect(a.startsWith("/home/u/.incline/data/messages/")).toBe(true)
	})
})

describe("INCLINE MCP message tools", () => {
	it("post_message / read_messages / ack_message work through MCP and notify the host", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-msg-mcp-"))
		const posted: number[] = []
		const h = await startInclineMcpServer({
			store: new TaskMdStore(path.join(dir, "task.md")),
			workspace: dir,
			basePort: 46000 + Math.floor(Math.random() * 1500),
			runDir: path.join(dir, "run"),
			messageStore: new MessageStore(path.join(dir, "m.jsonl")),
			onMessagePosted: (m) => posted.push(m.id),
		})
		const client = new Client({ name: "test", version: "0.0.0" })
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }),
			)
			const names = (await client.listTools()).tools.map((t) => t.name)
			expect(names).toEqual(expect.arrayContaining(["post_message", "read_messages", "ack_message"]))

			const res = (await client.callTool({ name: "post_message", arguments: { to: "claude", title: "完了報告", text: "実装が終わりました", from: "gemini" } })) as any
			expect(res.content[0].text).toContain("#1")
			expect(posted).toEqual([1])

			const read = (await client.callTool({ name: "read_messages", arguments: { to: "claude", unacked_by: "claude" } })) as any
			const list = JSON.parse(read.content[0].text).messages
			expect(list).toHaveLength(1)
			expect(list[0]).toMatchObject({ id: 1, from: "gemini", to: "claude", title: "完了報告", text: "実装が終わりました" })

			await client.callTool({ name: "ack_message", arguments: { id: 1, by: "claude" } })
			const after = (await client.callTool({ name: "read_messages", arguments: { to: "claude", unacked_by: "claude" } })) as any
			expect(JSON.parse(after.content[0].text).messages).toHaveLength(0)

			const bad = (await client.callTool({ name: "ack_message", arguments: { id: 99, by: "claude" } })) as any
			expect(bad.isError).toBe(true)
		} finally {
			await client.close()
			await h.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
