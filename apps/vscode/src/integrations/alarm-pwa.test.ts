import * as fs from "node:fs/promises"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// @ts-expect-error: plain ES module in apps/alarm-pwa (no type declarations)
import { ackMessage, createAlarm, createSeen, FL_ALARM_MARKER, isStreamStale, parseNtfyEvent, pollOnce, pollUrl, shouldReconnect, shouldRing } from "../../../alarm-pwa/alarm-core.js"

const PWA = path.resolve(__dirname, "../../../alarm-pwa")

describe("INCLINE Alarm PWA: finding [FL-Alarm] in ntfy events", () => {
	it("parses SSE data lines and JSON lines, ignores junk", () => {
		expect(parseNtfyEvent('data: {"id":"a","event":"message","message":"hi"}')).toMatchObject({ id: "a" })
		expect(parseNtfyEvent('{"id":"b","event":"message"}')).toMatchObject({ id: "b" })
		expect(parseNtfyEvent("")).toBeUndefined()
		expect(parseNtfyEvent("not json")).toBeUndefined()
		expect(parseNtfyEvent("data: ")).toBeUndefined()
	})

	it("rings only for messages containing [FL-Alarm] in the text or title, regardless of priority", () => {
		expect(FL_ALARM_MARKER).toBe("[FL-Alarm]")
		expect(shouldRing({ event: "message", message: "[FL-Alarm] INCLINE needs your decision: #86" })).toBe(true)
		expect(shouldRing({ event: "message", message: "wake up", title: "[fl-alarm] case-insensitive", priority: 1 })).toBe(true)
		expect(shouldRing({ event: "message", message: "normal notification", priority: 5 })).toBe(false) // 優先度では鳴らさない
		expect(shouldRing({ event: "keepalive" })).toBe(false)
		expect(shouldRing({ event: "open" })).toBe(false)
		expect(shouldRing(undefined)).toBe(false)
	})

	it("never rings for its own ACK replies, even if they quote the marker", () => {
		expect(shouldRing({ event: "message", message: "ACK: [FL-Alarm] INCLINE needs your decision" })).toBe(false)
		expect(ackMessage({ message: "[FL-Alarm] INCLINE needs your decision: #86 FL-Alarm" })).toMatch(/^ACK: /)
		expect(ackMessage(undefined)).toBe("ACK")
	})

	it("builds the poll URL and dedupes message ids across the live stream and polling", () => {
		expect(pollUrl("https://ntfy.sh/", "my topic", "10m")).toBe("https://ntfy.sh/my%20topic/json?poll=1&since=10m")
		const seen = createSeen(2)
		expect(seen.first("a")).toBe(true)
		expect(seen.first("a")).toBe(false)
		expect(seen.first("b")).toBe(true)
		expect(seen.first("c")).toBe(true) // 上限を超えたら古い id から忘れる
		expect(seen.first("a")).toBe(true)
	})

	it("pollOnce feeds every event to the handler and returns the newest event time", async () => {
		const lines = [
			JSON.stringify({ id: "1", time: 100, event: "message", message: "hello" }),
			JSON.stringify({ id: "2", time: 160, event: "message", message: "[FL-Alarm] wake up" }),
			"",
		].join("\n")
		const fetchFn = vi.fn(async () => ({ text: async () => lines }))
		const rang: string[] = []
		const latest = await pollOnce(fetchFn, "https://ntfy.sh", "t", "10m", (ev: any) => shouldRing(ev) && rang.push(ev.id))
		expect(fetchFn).toHaveBeenCalledWith("https://ntfy.sh/t/json?poll=1&since=10m", { cache: "no-store" })
		expect(rang).toEqual(["2"])
		expect(latest).toBe("160")
		expect(await pollOnce(async () => ({ text: async () => "" }), "https://ntfy.sh", "t", "160", () => {})).toBe("160")
	})
})

describe("INCLINE Alarm PWA: ring / snooze / acknowledge", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	const make = () => {
		const log: string[] = []
		const alarm = createAlarm({
			onRing: (ev: any) => log.push(`ring:${ev.id}`),
			onStop: () => log.push("stop"),
			onAck: (ev: any) => log.push(`ack:${ev.id}`),
		})
		return { alarm, log }
	}

	it("rings until acknowledged, then publishes the ACK once", () => {
		const { alarm, log } = make()
		alarm.ring({ id: "1" })
		expect(alarm.ringing).toBe(true)
		alarm.acknowledge()
		expect(log).toEqual(["ring:1", "stop", "ack:1"])
		expect(alarm.ringing).toBe(false)
		alarm.acknowledge() // 二重に押しても ACK は 1 回
		expect(log).toHaveLength(3)
	})

	it("snooze silences now and rings the same alarm again after the delay unless acknowledged", () => {
		const { alarm, log } = make()
		alarm.ring({ id: "1" })
		alarm.snooze(5)
		expect(alarm.ringing).toBe(false)
		expect(alarm.snoozed).toBe(true)
		vi.advanceTimersByTime(4 * 60_000)
		expect(log).toEqual(["ring:1", "stop"])
		vi.advanceTimersByTime(60_000)
		expect(log).toEqual(["ring:1", "stop", "ring:1"]) // スヌーズ明けにまた鳴る
		alarm.snooze(5)
		alarm.acknowledge() // スヌーズ中に承認したら鳴り直さない
		vi.advanceTimersByTime(10 * 60_000)
		expect(log.filter((l) => l === "ring:1")).toHaveLength(2)
	})

	it("a new alarm replaces a snoozed one", () => {
		const { alarm, log } = make()
		alarm.ring({ id: "1" })
		alarm.snooze(5)
		alarm.ring({ id: "2" })
		vi.advanceTimersByTime(10 * 60_000)
		expect(log).toEqual(["ring:1", "stop", "ring:2"])
	})
})

describe("INCLINE Alarm PWA: installable files", () => {
	it("ships a valid manifest, service worker, icons and the page wiring", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(PWA, "manifest.webmanifest"), "utf8"))
		expect(manifest).toMatchObject({ name: "INCLINE Alarm", display: "standalone", start_url: "./index.html" })
		for (const icon of manifest.icons) {
			await fs.access(path.join(PWA, icon.src))
		}
		const html = await fs.readFile(path.join(PWA, "index.html"), "utf8")
		expect(html).toContain('rel="manifest"')
		expect(html).toContain('type="module" src="app.js"')
		expect(html).toContain("[FL-Alarm]")
		const sw = await fs.readFile(path.join(PWA, "sw.js"), "utf8")
		expect(sw).toContain("alarm-core.js")
		expect(sw).toContain("never cache ntfy traffic")
		const app = await fs.readFile(path.join(PWA, "app.js"), "utf8")
		for (const needle of ["EventSource", "pollOnce", "POLL_MS = 30_000", "wakeLock", "vibrate", "AudioContext", "ackMessage"]) {
			expect(app).toContain(needle)
		}
	})
})


describe("INCLINE Alarm PWA: stays alive for hours (#102)", () => {
	it("silences the previous siren before a second ring starts, so nothing is orphaned", () => {
		const calls: string[] = []
		const alarm = createAlarm({
			onRing: () => calls.push("ring"),
			onStop: () => calls.push("stop"),
			onAck: () => calls.push("ack"),
			setTimer: (() => 0) as any,
			clearTimer: (() => {}) as any,
		})
		alarm.ring({ id: "1" })
		alarm.ring({ id: "2" }) // a reminder while ringing
		expect(calls).toEqual(["ring", "stop", "ring"])
		alarm.acknowledge()
		expect(calls).toEqual(["ring", "stop", "ring", "stop", "ack"])
	})
	it("reconnects when the stream is closed or silent for too long", () => {
		expect(shouldReconnect(2)).toBe(true)
		expect(shouldReconnect(0)).toBe(false)
		expect(shouldReconnect(1)).toBe(false)
		expect(isStreamStale(0)).toBe(true)
		expect(isStreamStale(1_000_000, 1_060_000)).toBe(false) // 60 s: a keepalive is due
		expect(isStreamStale(1_000_000, 1_200_000)).toBe(true) // 200 s of silence
	})
	it("the page reconnects on resume and when opened again, and the service worker is network first", async () => {
		const app = await fs.readFile(path.join(PWA, "app.js"), "utf-8")
		for (const ev of ["visibilitychange", "online", "focus", "pageshow", "resume"]) expect(app).toContain(`"${ev}"`)
		expect(app).toContain('store.get("connected", "")')
		const sw = await fs.readFile(path.join(PWA, "sw.js"), "utf-8")
		expect(sw).toContain("incline-alarm-v2")
		expect(sw).toMatch(/fetch\(e\.request\)\.then/)
	})
})
