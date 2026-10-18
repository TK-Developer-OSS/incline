import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { classifyMessages, type NtfyComment, type NtfyMessage, projectKey } from "./protocol"

export const NTFY_POLL_INTERVAL_MS = 30_000
/** 起動直後に「直前のプロジェクト」を把握するために遡る範囲。この間のコメントは配信しない。 */
const WARMUP_WINDOW = "12h"

export interface NtfyWatcherOptions {
	getTopic: () => string | undefined
	/** このウィンドウのプロジェクト (フォルダ名またはパス)。 */
	getProject: () => string | undefined
	/** 自分のプロジェクト宛てのコメントを受け取る。 */
	onComment: (comment: NtfyComment) => Promise<void> | void
	pollIntervalMs?: number
}

/**
 * ntfy のトピックを定期ポーリングして、自分以外のコメントを拾う。
 * 拡張の起動を止めないよう、例外はすべて握りつぶしてログだけ残す。
 * 同じトピックを複数のウィンドウが見ても、各ウィンドウは自分のプロジェクト宛てだけを処理する。
 */
export class NtfyWatcher {
	private timer: ReturnType<typeof setInterval> | undefined
	private lastId: string | undefined
	private lastProject: string | undefined
	private warmedUp = false
	private polling = false
	private topicInUse: string | undefined

	constructor(private readonly options: NtfyWatcherOptions) {}

	start(): void {
		if (this.timer) {
			return
		}
		const interval = this.options.pollIntervalMs ?? NTFY_POLL_INTERVAL_MS
		this.timer = setInterval(() => void this.pollOnce(), interval)
		void this.pollOnce()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	async pollOnce(): Promise<void> {
		if (this.polling) {
			return
		}
		this.polling = true
		try {
			const topic = this.options.getTopic()?.trim()
			if (!topic) {
				return
			}
			if (topic !== this.topicInUse) {
				// トピックが変わったら最初からやり直す
				this.topicInUse = topic
				this.lastId = undefined
				this.lastProject = undefined
				this.warmedUp = false
			}
			const since = this.lastId ?? WARMUP_WINDOW
			const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`)
			if (!res.ok) {
				Logger.warn(`[NTFY] poll failed: HTTP ${res.status}`)
				return
			}
			const messages = parseNdjson(await res.text())
			if (messages.length === 0) {
				this.warmedUp = true
				return
			}
			const { comments, lastProject } = classifyMessages(messages, this.lastProject)
			this.lastProject = lastProject
			this.lastId = messages[messages.length - 1].id
			if (!this.warmedUp) {
				// 初回は文脈 (直前のプロジェクト) を把握するだけで、過去のコメントは配信しない
				this.warmedUp = true
				return
			}
			const mine = this.options.getProject()
			const mineKey = mine ? projectKey(mine) : undefined
			for (const comment of comments) {
				if (mineKey && comment.project === mineKey) {
					await this.options.onComment(comment)
				}
			}
		} catch (e) {
			Logger.error("[NTFY] poll error", e)
		} finally {
			this.polling = false
		}
	}
}

export function parseNdjson(text: string): NtfyMessage[] {
	const out: NtfyMessage[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			const obj = JSON.parse(trimmed) as NtfyMessage
			if (obj && typeof obj.id === "string") {
				out.push(obj)
			}
		} catch {
			// 壊れた行は無視
		}
	}
	return out
}
