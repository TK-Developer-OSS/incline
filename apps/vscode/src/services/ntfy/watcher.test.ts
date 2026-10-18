import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/shared/net", () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { formatOutgoing } from "./protocol"
import { NtfyWatcher } from "./watcher"

const ndjson = (...msgs: Array<{ id: string; message: string; event?: string }>) =>
	msgs.map((m, i) => JSON.stringify({ time: i + 1, event: "message", ...m })).join("\n")

const respond = (body: string) => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => body })

describe("NtfyWatcher", () => {
	beforeEach(() => fetchMock.mockReset())

	it("learns context on the first poll, then delivers only comments for its own project", async () => {
		const received: string[] = []
		const watcher = new NtfyWatcher({
			getTopic: () => "topic",
			getProject: () => "/work/proj-a",
			onComment: (c) => {
				received.push(c.text)
			},
		})

		// 1回目: 過去ログ。直前のプロジェクト = proj-a を把握するだけで、配信しない
		respond(ndjson({ id: "1", message: formatOutgoing("/work/proj-a", "done") }, { id: "2", message: "old comment" }))
		await watcher.pollOnce()
		expect(received).toEqual([])

		// 2回目: 新着。since は最後の ID
		respond(
			ndjson(
				{ id: "3", message: "new comment for a" },
				{ id: "4", message: formatOutgoing("/work/proj-b", "done B") },
				{ id: "5", message: "comment for b" },
			),
		)
		await watcher.pollOnce()
		expect(fetchMock.mock.calls[1][0]).toContain("since=2")
		expect(received).toEqual(["new comment for a"])
	})

	it("does nothing without a topic", async () => {
		const watcher = new NtfyWatcher({ getTopic: () => undefined, getProject: () => "x", onComment: vi.fn() })
		await watcher.pollOnce()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("swallows network errors", async () => {
		fetchMock.mockRejectedValueOnce(new Error("offline"))
		const watcher = new NtfyWatcher({ getTopic: () => "t", getProject: () => "x", onComment: vi.fn() })
		await expect(watcher.pollOnce()).resolves.toBeUndefined()
	})
})
