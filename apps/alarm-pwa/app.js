// INCLINE Alarm (PWA): subscribes to an ntfy topic and rings loudly (siren + vibration + flashing screen) until acknowledged.
import { ackMessage, createAlarm, createSeen, isStreamStale, parseNtfyEvent, pollOnce, shouldReconnect, shouldRing } from "./alarm-core.js"

const $ = (id) => document.getElementById(id)
const store = {
	get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } },
	set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
}
const params = new URLSearchParams(location.search)
$("topic").value = params.get("topic") || store.get("topic", "")
$("server").value = params.get("server") || store.get("server", "https://ntfy.sh")

let audio, siren, vibrateTimer, wakeLock, source, pollTimer
const seen = createSeen()
const POLL_MS = 30_000

function startSiren() {
	try {
		audio = audio || new (window.AudioContext || window.webkitAudioContext)()
		audio.resume?.()
		const osc = audio.createOscillator()
		const gain = audio.createGain()
		osc.type = "square"
		gain.gain.value = 1
		osc.connect(gain).connect(audio.destination)
		osc.start()
		let hi = false
		const sweep = setInterval(() => { hi = !hi; osc.frequency.setValueAtTime(hi ? 1320 : 880, audio.currentTime) }, 450)
		siren = () => { clearInterval(sweep); try { osc.stop() } catch {} ; osc.disconnect() }
	} catch {}
}

const alarm = createAlarm({
	onRing(ev) {
		$("alarm-text").textContent = ev?.message || ev?.title || "Decision needed"
		$("alarm").classList.add("on")
		startSiren()
		navigator.vibrate?.([600, 200, 600])
		vibrateTimer = setInterval(() => navigator.vibrate?.([600, 200, 600]), 1600)
		if ("Notification" in window && Notification.permission === "granted") {
			try { new Notification(ev?.title || "INCLINE needs you", { body: ev?.message || "", requireInteraction: true }) } catch {}
		}
	},
	onStop() {
		$("alarm").classList.remove("on")
		siren?.(); siren = undefined
		clearInterval(vibrateTimer)
		navigator.vibrate?.(0)
	},
	onAck(ev) {
		const topic = $("topic").value.trim(), server = $("server").value.trim().replace(/\/$/, "")
		if (topic) fetch(`${server}/${encodeURIComponent(topic)}`, { method: "POST", body: ackMessage(ev) }).catch(() => {})
	},
})

$("ack").addEventListener("click", () => alarm.acknowledge())
$("snooze").addEventListener("click", () => alarm.snooze(5))
$("test").addEventListener("click", () => { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); alarm.ring({ event: "message", title: "Test", message: "[FL-Alarm] Test alarm (tap Acknowledge)" }) })

async function keepAwake() {
	try { wakeLock = await navigator.wakeLock?.request("screen") } catch {}
}

// A message with [FL-Alarm] rings once (per message id), whether it arrives on the live stream or on a poll.
function handle(ev) {
	if (ev?.time) store.set("lastTime", String(ev.time))
	if (shouldRing(ev) && seen.first(ev.id)) alarm.ring(ev)
}

// Periodic check: pull everything newer than the last message we saw (or the last 10 minutes on the first run).
async function poll(server, topic) {
	try {
		const latest = await pollOnce((u, o) => fetch(u, o), server, topic, store.get("lastTime", "10m"), handle)
		store.set("lastTime", String(latest))
		$("status").textContent = `Listening on ${server}/${topic} (checked ${new Date().toLocaleTimeString()})`
	} catch {
		$("status").textContent = "Check failed, will retry…"
	}
}

let lastStreamAt = 0
let connection // { server, topic } of the current connection

// 1) live stream (instant)  2) periodic poll every 30 s (reliable even if the stream silently stalls)
function openStream() {
	if (!connection) return
	const { server, topic } = connection
	source?.close()
	lastStreamAt = Date.now()
	source = new EventSource(`${server}/${encodeURIComponent(topic)}/sse`)
	source.onopen = () => { lastStreamAt = Date.now(); $("status").textContent = `Listening on ${server}/${topic}` }
	source.onerror = () => { $("status").textContent = "Stream lost; polling every 30 s…" }
	source.onmessage = (e) => { lastStreamAt = Date.now(); handle(parseNtfyEvent(e.data)) } // keepalives count too
}

// After hours in the background the page may have been frozen: its timers stopped and its stream may be dead.
// Reconnect when the stream is closed or silent for too long, and catch up with a poll straight away.
function resync(force) {
	if (!connection) return
	if (force || shouldReconnect(source?.readyState) || isStreamStale(lastStreamAt)) openStream()
	poll(connection.server, connection.topic)
	if (document.visibilityState === "visible") keepAwake()
}

function connect() {
	const topic = $("topic").value.trim(), server = $("server").value.trim().replace(/\/$/, "")
	if (!topic) { $("status").textContent = "Enter the topic first."; return }
	store.set("topic", topic); store.set("server", server); store.set("connected", "1")
	audio = audio || new (window.AudioContext || window.webkitAudioContext)() // unlock audio with this tap
	if ("Notification" in window && Notification.permission === "default") Notification.requestPermission()
	keepAwake()
	connection = { server, topic }
	openStream()
	clearInterval(pollTimer)
	poll(server, topic)
	pollTimer = setInterval(() => resync(false), POLL_MS)
}
$("connect").addEventListener("click", connect)
for (const type of ["visibilitychange", "online", "focus", "pageshow", "resume"]) {
	;(type === "visibilitychange" ? document : window).addEventListener(type, () => {
		if (type !== "visibilitychange" || document.visibilityState === "visible") resync(type === "online" || type === "pageshow" || type === "resume")
	})
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {})
// Reconnect by itself when the app is opened again (the OS may have killed it in the background): remembered after the first Connect.
if ($("topic").value && (params.get("autostart") === "1" || store.get("connected", "") === "1")) connect()
