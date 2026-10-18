import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../services/Logger"
import { ClineSyncStorage } from "./ClineStorage"

export interface ClineFileStorageOptions {
	/**
	 * File permissions mode (e.g., 0o600 for owner read/write only).
	 * If not set, uses the system default.
	 */
	fileMode?: number
}

/**
 * Synchronous file-backed JSON storage.
 * Stores any JSON-serializable values with sync read and write.
 * Used for VSCode Memento compatibility and CLI environments.
 */
export class ClineFileStorage<T = any> extends ClineSyncStorage<T> {
	protected name: string
	private data: Record<string, T>
	private readonly fsPath: string
	private readonly fileMode?: number
	/** 最後にディスクと同期した時点のファイルの更新時刻 (ms)。これと今の更新時刻が違えば、他のウィンドウが書いたので、ファイルを正とする。 */
	private syncedMtimeMs = 0

	constructor(filePath: string, name = "ClineFileStorage", options?: ClineFileStorageOptions) {
		super()
		this.fsPath = filePath
		this.name = name
		this.fileMode = options?.fileMode
		this.data = this.readFromDisk()
		this.syncedMtimeMs = this.currentMtimeMs()
	}

	protected _get(key: string): T | undefined {
		this.refreshIfFileChanged()
		return this.data[key]
	}

	private currentMtimeMs(): number {
		try {
			return fs.statSync(this.fsPath).mtimeMs
		} catch {
			return 0
		}
	}

	/** 読み込み (または前回の書き込み) 以降にファイルが変わっていたら、ファイルの内容を正として読み直す。読み直したら true。 */
	public reloadIfChanged(): boolean {
		const mtime = this.currentMtimeMs()
		if (mtime !== 0 && mtime !== this.syncedMtimeMs) {
			const latest = this.readLatestFromDisk()
			if (latest) {
				this.data = latest
			}
			this.syncedMtimeMs = mtime
			return latest !== undefined
		}
		return false
	}

	private refreshIfFileChanged(): void {
		this.reloadIfChanged()
	}

	protected _set(key: string, value: T | undefined): void {
		// Use setBatch for consistency - all writes go through one path
		this.setBatch({ [key]: value })
	}

	protected _delete(key: string): void {
		this.setBatch({ [key]: undefined })
	}

	/**
	 * Set multiple keys in a single write operation.
	 * More efficient than calling set() for each key individually,
	 * since it only writes to disk once.
	 */
	public setBatch(entries: Record<string, T | undefined>): Thenable<void> {
		// Incline: 設計の前提 = ミリ秒単位の同時書き込み競合は想定しない (設定変更は人間の操作で、まれ)。
		// 同じファイルを複数のウィンドウ (= 別プロセス) が共有するため、読み直し→変更→書き込みを
		// ロックファイルで排他にし、書く直前にディスクの最新の内容を読み直して、このバッチで変えるキーだけを
		// 上書きする。(読めない / 壊れている / 無いときは従来どおりメモリの内容を基にする)
		const release = this.acquireLock()
		try {
			const latest = this.readLatestFromDisk()
			if (latest) {
				this.data = latest
				this.syncedMtimeMs = this.currentMtimeMs()
			}
			const changedKeys: string[] = []
			for (const [key, value] of Object.entries(entries)) {
				// 値が今のファイルと同じなら変更ではない (自分のメモリの古い値で、他のウィンドウの新しい値を上書きしない)。
				if (value !== undefined && JSON.stringify(this.data[key]) === JSON.stringify(value)) {
					continue
				}
				if (value === undefined) {
					if (key in this.data) {
						delete this.data[key]
						changedKeys.push(key)
					}
				} else {
					this.data[key] = value
					changedKeys.push(key)
				}
			}
			if (changedKeys.length > 0) {
				this.auditWrite(latest, changedKeys)
				this.writeToDisk()
				this.verifyWrite(entries, changedKeys)
				release()
				for (const key of changedKeys) {
					this.fireChange(key)
				}
			}
		} finally {
			release()
		}
		return Promise.resolve()
	}

	/** 書いた直後に読み直し、他のプロセスに上書きされていないか確かめる (されていたら一度だけ書き直す)。 */
	private verifyWrite(entries: Record<string, T | undefined>, changedKeys: string[]): void {
		const after = this.readLatestFromDisk()
		if (!after) {
			return
		}
		const lost = changedKeys.filter((key) => JSON.stringify(after[key]) !== JSON.stringify(entries[key]))
		if (lost.length === 0) {
			return
		}
		Logger.warn(`[${this.name}] write was overwritten by another process for: ${lost.join(", ")}; rewriting`)
		this.data = { ...after }
		for (const key of lost) {
			if (entries[key] === undefined) {
				delete this.data[key]
			} else {
				this.data[key] = entries[key] as T
			}
		}
		this.writeToDisk()
	}

	/** 同期のロックファイル (O_EXCL)。1 秒待っても取れなければ諦めて続行する (固まるよりまし)。古い (5 秒超) ロックは奪う。 */
	private acquireLock(): () => void {
		const lockPath = `${this.fsPath}.lock`
		const deadline = Date.now() + 1000
		let held = false
		while (!held) {
			try {
				fs.mkdirSync(path.dirname(lockPath), { recursive: true })
				fs.closeSync(fs.openSync(lockPath, "wx"))
				held = true
			} catch {
				try {
					if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
						fs.unlinkSync(lockPath)
						continue
					}
				} catch {}
				if (Date.now() > deadline) {
					break
				}
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
			}
		}
		let released = false
		return () => {
			if (held && !released) {
				released = true
				try {
					fs.unlinkSync(lockPath)
				} catch {}
			}
		}
	}

	protected _keys(): readonly string[] {
		return Object.keys(this.data)
	}

	/**
	 * Incline (#94): leave a trace of who wrote the shared settings file, so a "settings reverted after reinstall"
	 * report can be traced to a window/process. Key names only (plus the provider/model keys, which are not secret).
	 * Only for globalState; best effort, never throws.
	 */
	private auditWrite(latest: Record<string, T> | undefined, changedKeys: string[]): void {
		if (this.name !== "GlobalState") {
			return
		}
		try {
			const plain = ["planModeApiProvider", "actModeApiProvider", "planModeApiModelId", "actModeApiModelId", "inclineDebugMode"]
			const values: Record<string, unknown> = {}
			for (const key of changedKeys) {
				if (plain.includes(key)) {
					values[key] = this.data[key]
				}
			}
			const line = JSON.stringify({
				ts: new Date().toISOString(),
				pid: process.pid,
				ppid: process.ppid,
				diskReadable: latest !== undefined,
				changed: changedKeys,
				values,
				stack: (new Error().stack ?? "").split("\n").slice(2, 6).map((l) => l.trim()),
			})
			const logPath = path.join(path.dirname(this.fsPath), "logs", "state-writes.jsonl")
			fs.mkdirSync(path.dirname(logPath), { recursive: true })
			fs.appendFileSync(logPath, line + "\n")
		} catch {}
	}

	private readFromDisk(): Record<string, T> {
		try {
			if (fs.existsSync(this.fsPath)) {
				return JSON.parse(fs.readFileSync(this.fsPath, "utf-8"))
			}
		} catch (error) {
			Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
		}
		return {}
	}

	/** ディスク上の最新の内容。ファイルが無い / 壊れているときは undefined。 */
	private readLatestFromDisk(): Record<string, T> | undefined {
		try {
			if (!fs.existsSync(this.fsPath)) {
				return undefined
			}
			const parsed = JSON.parse(fs.readFileSync(this.fsPath, "utf-8"))
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, T>) : undefined
		} catch {
			return undefined
		}
	}

	private writeToDisk(): void {
		try {
			const dir = path.dirname(this.fsPath)
			fs.mkdirSync(dir, { recursive: true })
			atomicWriteFileSync(this.fsPath, JSON.stringify(this.data, null, 2), this.fileMode)
			this.syncedMtimeMs = this.currentMtimeMs()
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
		}
	}
}

/**
 * Synchronously, atomically write data to a file using temp file + rename pattern.
 * Prefer core/storage's async atomicWriteFile to this.
 */
function atomicWriteFileSync(filePath: string, data: string, mode?: fs.Mode | undefined): void {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.json`
	try {
		fs.writeFileSync(tmpPath, data, {
			flag: "wx",
			encoding: "utf-8",
			mode,
		})
		// Rename temp file to target (atomic in most cases)
		fs.renameSync(tmpPath, filePath)
	} catch (error) {
		// Clean up temp file if it exists
		try {
			fs.unlinkSync(tmpPath)
		} catch {}
		throw error
	}
}
