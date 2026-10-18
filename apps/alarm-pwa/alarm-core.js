// INCLINE Alarm (PWA): pure logic (no DOM). Finds [FL-Alarm] messages in ntfy events and runs the ring / acknowledge / snooze state machine.

/** Parse one line of an ntfy SSE/JSON stream. Returns the event object or undefined. */
export function parseNtfyEvent(raw) {
	if (!raw) return undefined
	let text = String(raw).trim()
	if (text.startsWith("data:")) text = text.slice(5).trim()
	if (!text) return undefined
	try {
		const ev = JSON.parse(text)
		return ev && typeof ev === "object" ? ev : undefined
	} catch {
		return undefined
	}
}

/** The marker INCLINE puts in the text of a message that must wake the human. */
export const FL_ALARM_MARKER = "[FL-Alarm]"

/**
 * A message rings when its text or title contains [FL-Alarm] (case-insensitive). The priority does not matter.
 * Our own ACK replies never ring (even if they quote the marker).
 */
export function shouldRing(ev, marker = FL_ALARM_MARKER) {
	if (!ev || ev.event !== "message") return false
	const message = typeof ev.message === "string" ? ev.message.trim() : ""
	if (/^ACK\b/i.test(message)) return false
	const needle = marker.toLowerCase()
	return message.toLowerCase().includes(needle) || String(ev.title || "").toLowerCase().includes(needle)
}

/** URL for one poll of the topic (returns newline-delimited JSON events newer than `since`). */
export function pollUrl(server, topic, since) {
	return `${String(server).replace(/\/$/, "")}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since || "10m")}`
}

/** Remembers which message ids already rang, so polling + the live stream never ring the same message twice. */
export function createSeen(limit = 500) {
	const seen = new Set()
	return {
		/** true the first time an id is seen */
		first(id) {
			if (!id) return true
			if (seen.has(id)) return false
			seen.add(id)
			if (seen.size > limit) seen.delete(seen.values().next().value)
			return true
		},
	}
}

export const ACK_PREFIX = "ACK"

/** The text published back to the topic when the human acknowledges (INCLINE stops its reminders when it sees it). */
export function ackMessage(ev) {
	const title = ev && (ev.title || ev.message) ? String(ev.message || ev.title).slice(0, 80) : ""
	return title ? `${ACK_PREFIX}: ${title}` : ACK_PREFIX
}

/**
 * Alarm state machine. Callbacks: onRing(ev) starts the siren, onStop() silences it, onAck(ev) publishes the ACK.
 * - ring(ev): rings immediately (a new alarm replaces a snoozed one).
 * - snooze(minutes): silences now and rings the same alarm again after the delay unless acknowledged.
 * - acknowledge(): stops everything and calls onAck.
 */
export function createAlarm({ onRing, onStop, onAck, setTimer = setTimeout, clearTimer = clearTimeout }) {
	let current
	let ringing = false
	let timer

	const clear = () => {
		if (timer !== undefined) {
			clearTimer(timer)
			timer = undefined
		}
	}
	return {
		get ringing() {
			return ringing
		},
		get current() {
			return current
		},
		get snoozed() {
			return timer !== undefined
		},
		ring(ev) {
			clear()
			// A new ring (e.g. a reminder) while already ringing must silence the previous siren / vibration first,
			// otherwise the old oscillator and timers are orphaned and keep going after Acknowledge.
			if (ringing) onStop?.()
			current = ev
			ringing = true
			onRing?.(ev)
		},
		snooze(minutes = 5) {
			if (!current) return
			clear()
			if (ringing) {
				ringing = false
				onStop?.()
			}
			timer = setTimer(() => {
				timer = undefined
				if (current) {
					ringing = true
					onRing?.(current)
				}
			}, minutes * 60_000)
		},
		acknowledge() {
			if (!current) return
			clear()
			const ev = current
			current = undefined
			if (ringing) {
				ringing = false
				onStop?.()
			}
			onAck?.(ev)
		},
	}
}

/**
 * One poll: fetch the events newer than `since`, call onEvent for each, return the time of the newest event (or `since`).
 * fetchFn is injected (window.fetch in the app).
 */
export async function pollOnce(fetchFn, server, topic, since, onEvent) {
	const res = await fetchFn(pollUrl(server, topic, since), { cache: "no-store" })
	const text = await res.text()
	let latest = since
	for (const line of text.split("\n")) {
		const ev = parseNtfyEvent(line)
		if (!ev) continue
		if (ev.time) latest = String(ev.time)
		onEvent(ev)
	}
	return latest
}

/** The EventSource gave up for good (readyState CLOSED = 2): the browser will not reconnect by itself. */
export function shouldReconnect(readyState) {
	return readyState === 2
}

/**
 * The live stream is considered dead when nothing (not even ntfy's keepalive, about every 55 s) arrived for `limitMs`.
 * A page that was frozen in the background wakes up with an old `lastEventAt`, so it reconnects right away.
 */
export function isStreamStale(lastEventAt, now = Date.now(), limitMs = 180_000) {
	return !lastEventAt || now - lastEventAt > limitMs
}
