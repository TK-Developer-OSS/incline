import * as fs from "node:fs"
import * as path from "node:path"
import { resolveDataDirFromEnv } from "@/shared/storage/storage-context"

// 操作ログ (人が読む用): API リクエスト / 各種ウェイト / ツール実行 / リトライ / ブレーカー / ウォッチドッグ。
// 1 行 1 事象。~/.incline/data/logs/activity.log (INCLINE_DATA_DIR があればその下)。
// 例: grep -E "API|BREAKER" ~/.incline/data/logs/activity.log | tail -50
// 429 の前後に何を何秒おきに送っていたかを後から追えるようにするのが目的 (長期ペナルティの調査用)。

export type ActivityKind = "API" | "WAIT" | "TOOL" | "RETRY" | "BREAKER" | "WATCHDOG"

const MAX_BYTES = 5 * 1024 * 1024
const p2 = (n: number, w = 2) => String(n).padStart(w, "0")

function stamp(d = new Date()): string {
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`
}

let logPath: string | undefined

/** 1 行を追記する。失敗しても本処理には影響させない。5MB を超えたら activity.log.1 に退避 (1 世代)。 */
export function logActivity(kind: ActivityKind, message: string): void {
	if (process.env.VITEST === "true") {
		return
	}
	try {
		if (!logPath) {
			logPath = path.join(resolveDataDirFromEnv(), "logs", "activity.log")
			fs.mkdirSync(path.dirname(logPath), { recursive: true })
		}
		try {
			if (fs.statSync(logPath).size > MAX_BYTES) {
				fs.renameSync(logPath, `${logPath}.1`)
			}
		} catch {}
		fs.appendFileSync(logPath, `${stamp()} [${kind.padEnd(8)}] pid=${process.pid} ${message.replace(/\s+/g, " ").slice(0, 400)}\n`)
	} catch {}
}
