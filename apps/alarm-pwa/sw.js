// Cache the app shell so the PWA opens offline (the alarm itself still needs the network to receive ntfy messages).
const CACHE = "incline-alarm-v2"
const SHELL = ["./", "index.html", "app.js", "alarm-core.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"]
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())))
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())))
self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url)
	if (url.origin !== location.origin) return // never cache ntfy traffic
	// Network first (so an updated app is picked up), the cache only when offline.
	e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); return res }).catch(() => caches.match(e.request)))
})
