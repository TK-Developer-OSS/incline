import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

// jsdom は webview-ui の devDependency
const { JSDOM } = createRequire(path.join(__dirname, "../../webview-ui/package.json"))("jsdom")
const FILE = path.resolve(__dirname, "../../../alarm-pwa/fl-alarm-standalone.html")

describe("INCLINE Alarm standalone HTML (works from file:// on a phone)", () => {
	it("is one self-contained file: no modules, no external scripts, no service worker", async () => {
		const html = await fs.readFile(FILE, "utf8")
		expect(html).not.toContain('type="module"')
		expect(html).not.toMatch(/<script[^>]+src=/)
		expect(html).not.toContain("serviceWorker.register")
		expect(html).toContain("[FL-Alarm]")
		expect(html).toContain("pollOnce")
	})

	it("runs: Test button rings, Acknowledge posts ACK; Start listening polls ntfy and rings on [FL-Alarm] only once", async () => {
		const html = await fs.readFile(FILE, "utf8")
		const posted: { url: string; body?: string }[] = []
		const event = JSON.stringify({ id: "m1", time: 100, event: "message", message: "[FL-Alarm] INCLINE needs your decision: #86" })
		const dom = new JSDOM(html, {
			runScripts: "dangerously",
			url: "https://pwa.example/",
			pretendToBeVisual: true,
			beforeParse(w: any) {
				w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
					posted.push({ url, body: init?.body })
					return { text: async () => (init?.method === "POST" ? "" : event) }
				}
				w.EventSource = class {
					close() {}
				}
				w.AudioContext = class {
					currentTime = 0
					destination = {}
					resume() {}
					createGain() {
						return { gain: { value: 1 }, connect: () => ({ connect() {} }) }
					}
					createOscillator() {
						const o: any = { type: "", frequency: { setValueAtTime() {} }, connect: () => ({ connect() {} }), start() {}, stop() {}, disconnect() {} }
						return o
					}
				}
				w.navigator.vibrate = vi.fn()
			},
		})
		const doc = dom.window.document
		const alarm = doc.getElementById("alarm") as HTMLElement

		// 画面のテスト鳴動 → Acknowledge で ACK が topic に返る
		;(doc.getElementById("topic") as HTMLInputElement).value = "my-topic"
		;(doc.getElementById("test") as HTMLElement).click()
		expect(alarm.classList.contains("on")).toBe(true)
		expect(doc.getElementById("alarm-text")!.textContent).toContain("[FL-Alarm]")
		;(doc.getElementById("ack") as HTMLElement).click()
		expect(alarm.classList.contains("on")).toBe(false)
		expect(posted.some((p) => p.url === "https://ntfy.sh/my-topic" && p.body?.startsWith("ACK"))).toBe(true)

		// Start listening: ポーリングで [FL-Alarm] を見つけて鳴る。もう一度ポーリングしても同じ id では鳴らない
		;(doc.getElementById("connect") as HTMLElement).click()
		await new Promise((r) => setTimeout(r, 50))
		expect(posted.some((p) => p.url.startsWith("https://ntfy.sh/my-topic/json?poll=1&since="))).toBe(true)
		expect(alarm.classList.contains("on")).toBe(true)
		expect(doc.getElementById("alarm-text")!.textContent).toContain("#86")
		;(doc.getElementById("ack") as HTMLElement).click()
		;(doc.getElementById("connect") as HTMLElement).click()
		await new Promise((r) => setTimeout(r, 50))
		expect(alarm.classList.contains("on")).toBe(false) // 承認済みの同じメッセージでは、もう鳴らない
	})
})
