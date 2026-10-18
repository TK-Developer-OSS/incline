// Incline: 小さなファイルロック (排他作成 + 期限切れ / 持ち主の死亡で解除)。
// task.md のロック (task-md-store.ts) と同じ方式。メッセージの ID 採番のように、
// 「読んで → 決めて → 書く」を複数のプロセスで安全に行うために使う。vscode 非依存。

import * as fs from "node:fs/promises"
import * as path from "node:path"

const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 20

async function ownerIsDead(lockPath: string): Promise<boolean> {
	try {
		const info = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: number }
		if (typeof info.pid !== "number" || info.pid === process.pid) {
			return false
		}
		try {
			process.kill(info.pid, 0)
			return false
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH"
		}
	} catch {
		return false
	}
}

/** lockPath を排他作成して fn を実行し、終わったら解除する。 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true })
	const deadline = Date.now() + LOCK_WAIT_MS
	for (;;) {
		try {
			const fh = await fs.open(lockPath, "wx")
			try {
				await fh.writeFile(JSON.stringify({ owner: "incline", pid: process.pid, at: new Date().toISOString() }))
			} finally {
				await fh.close()
			}
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error
			}
			let stale = await ownerIsDead(lockPath)
			if (!stale) {
				try {
					stale = Date.now() - (await fs.stat(lockPath)).mtimeMs > LOCK_STALE_MS
				} catch {
					continue // 直前に解放された
				}
			}
			if (stale) {
				await fs.unlink(lockPath).catch(() => undefined)
				continue
			}
			if (Date.now() > deadline) {
				throw new Error("ロックを取得できませんでした (他のプロセスが書き込み中)")
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
		}
	}
	try {
		return await fn()
	} finally {
		await fs.unlink(lockPath).catch(() => undefined)
	}
}
