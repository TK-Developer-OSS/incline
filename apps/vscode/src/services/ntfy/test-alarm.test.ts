import { beforeEach, describe, expect, it, vi } from "vitest"

const state = { topic: undefined as string | undefined }
const fetchMock = vi.fn(async () => ({ ok: true }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => ({ getGlobalSettingsKey: () => state.topic }) } }))
vi.mock("@/shared/net", () => ({ fetch: (...a: unknown[]) => fetchMock(...(a as [])) }))

import { sendNtfyNotification, sendNtfyTestAlarm } from "../ntfy"

describe("ntfy urgent notifications (#86 PoC)", () => {
	beforeEach(() => {
		fetchMock.mockClear()
		state.topic = undefined
	})

	it("sends nothing and says so when no topic is set", async () => {
		expect(await sendNtfyTestAlarm()).toBe("no-topic")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("sends the test alarm with ntfy priority 5 (urgent) to the configured topic", async () => {
		state.topic = "my-topic"
		expect(await sendNtfyTestAlarm()).toBe("sent")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }]
		expect(url).toBe("https://ntfy.sh/my-topic")
		expect(init.method).toBe("POST")
		expect(init.headers).toMatchObject({ Priority: "5", Tags: "rotating_light", Title: "INCLINE test alarm" })
		// PWA が鳴らす目印
		expect((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body).toContain("[FL-Alarm]")
	})

	it("keeps normal notifications at default priority, and only puts ASCII titles in headers", async () => {
		state.topic = "t"
		await sendNtfyNotification("done")
		const [, normal] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }]
		expect(normal.headers).toBeUndefined()
		await sendNtfyNotification("判断が必要", { urgent: true, title: "日本語のタイトル" })
		const [, urgent] = fetchMock.mock.calls[1] as unknown as [string, { headers: Record<string, string> }]
		expect(urgent.headers.Priority).toBe("5")
		expect(urgent.headers.Title).toBeUndefined() // HTTP ヘッダは ASCII のみ
	})
})
