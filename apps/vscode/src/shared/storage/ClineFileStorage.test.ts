import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ClineFileStorage } from "./ClineFileStorage"

describe("ClineFileStorage: 複数ウィンドウ (別プロセス) での共有", () => {
	let dir: string
	let file: string
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "incline-fs-"))
		file = path.join(dir, "globalState.json")
		fs.writeFileSync(file, JSON.stringify({ a: 1, inclineDebugMode: false }))
	})
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("does not roll back another window's change when this window saves a different key", () => {
		const windowA = new ClineFileStorage(file) // 起動時に { inclineDebugMode: false } を読む
		const windowB = new ClineFileStorage(file)

		windowA.set("inclineDebugMode", true) // A で設定を変えた
		windowB.set("lastUsed", "gemini") // B (古いメモリ) が別のキーを保存

		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
		expect(onDisk.inclineDebugMode).toBe(true) // 巻き戻らない
		expect(onDisk.lastUsed).toBe("gemini")
		expect(onDisk.a).toBe(1)
		// B のメモリも最新に追いつく
		expect(windowB.get("inclineDebugMode")).toBe(true)
	})

	it("the key a window changes itself always wins, and deletes are kept", () => {
		const windowA = new ClineFileStorage(file)
		const windowB = new ClineFileStorage(file)
		windowA.set("inclineDebugMode", true)
		windowB.set("inclineDebugMode", false) // B が自分で変えたキーは B の値
		expect(JSON.parse(fs.readFileSync(file, "utf8")).inclineDebugMode).toBe(false)

		windowA.delete("a")
		windowB.set("b", 2)
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
		expect("a" in onDisk).toBe(false) // A が消したキーは B の保存で復活しない
		expect(onDisk.b).toBe(2)
	})

	it("falls back to the in-memory data when the file is missing or corrupted", () => {
		const w = new ClineFileStorage(file)
		fs.writeFileSync(file, "{ 壊れた")
		w.set("c", 3)
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ a: 1, c: 3 })
		fs.rmSync(file)
		w.set("d", 4)
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ a: 1, c: 3, d: 4 })
	})
})

describe("ClineFileStorage: concurrent writers (lock + verify)", () => {
	it("keeps keys written by another instance of the same file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-lock-"))
		const file = path.join(dir, "g.json")
		const a = new ClineFileStorage(file, "A")
		const b = new ClineFileStorage(file, "B")
		a.setBatch({ x: 1 })
		b.setBatch({ y: 2 })
		a.setBatch({ z: 3 })
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ x: 1, y: 2, z: 3 })
		expect(fs.existsSync(`${file}.lock`)).toBe(false)
	})

	it("takes over a stale lock", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-stale-"))
		const file = path.join(dir, "g.json")
		fs.writeFileSync(`${file}.lock`, "")
		const old = new Date(Date.now() - 60_000)
		fs.utimesSync(`${file}.lock`, old, old)
		new ClineFileStorage(file, "A").setBatch({ x: 1 })
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ x: 1 })
	})
})

describe("ClineFileStorage: file is the truth when it changed since load", () => {
	it("reads the other window's newer value instead of its own stale memory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-mtime-"))
		const file = path.join(dir, "g.json")
		fs.writeFileSync(file, JSON.stringify({ provider: "openrouter" }))
		const a = new ClineFileStorage<any>(file, "A")
		const b = new ClineFileStorage<any>(file, "B")
		b.setBatch({ provider: "gemini" })
		const future = new Date(Date.now() + 5000)
		fs.utimesSync(file, future, future) // make the change visible to the mtime comparison
		expect(a.get("provider")).toBe("gemini")
	})

	it("does not write a value that equals the current file (stale memory cannot overwrite it)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-noop-"))
		const file = path.join(dir, "g.json")
		fs.writeFileSync(file, JSON.stringify({ provider: "gemini", other: 1 }))
		const a = new ClineFileStorage<any>(file, "A")
		fs.writeFileSync(file, JSON.stringify({ provider: "gemini", other: 2 })) // another window changed "other"
		a.setBatch({ provider: "gemini" }) // a no-op for the file
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ provider: "gemini", other: 2 })
	})
})

describe("ClineFileStorage.reloadIfChanged", () => {
	it("returns true only when the file changed since load", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-reload-"))
		const file = path.join(dir, "g.json")
		fs.writeFileSync(file, JSON.stringify({ a: 1 }))
		const s = new ClineFileStorage<any>(file, "A")
		expect(s.reloadIfChanged()).toBe(false)
		fs.writeFileSync(file, JSON.stringify({ a: 2 }))
		const future = new Date(Date.now() + 5000)
		fs.utimesSync(file, future, future)
		expect(s.reloadIfChanged()).toBe(true)
		expect(s.get("a")).toBe(2)
		expect(s.reloadIfChanged()).toBe(false)
	})
})
