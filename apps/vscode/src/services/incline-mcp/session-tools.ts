// Incline: MCP のセッション操作ツール (監督 AI が、このウィンドウの INCLINE エージェントを動かすための窓口)。
//   session_send   新しいセッションを開始 (new_task=true) / 実行中・質問待ちのセッションへメッセージを送る (false)
//   session_messages 最後の N 件のメッセージ (完了報告の全文を含む)
//   session_status 状態 (running / completed / waiting_question / ...) と使用量・最後のメッセージ要約
//   session_cancel 実行中のターンを中止
//   session_end    セッションを終了 (チャットを空の状態に戻す)
//   session_wait   完了 / 質問待ち / 承認待ち / エラーなどになるまで待って status を返す
// 安全面:
//   - MCP サーバが有効なときに使える (権限は分けない)。
//   - 認証は MCP サーバ全体のトークン (401) と同じ。操作できるのは自分のウィンドウのセッションだけ。
//   - 送った prompt は通常の入力と同じ扱い (Auto-approve などの既存設定は変えない)。
//   - ログには prompt の全文を出さない (文字数のみ)。
// vscode / SdkController 非依存 (SessionControlApi 経由なのでテスト可能)。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ClineMessage, TurnPhase } from "@/shared/ExtensionMessage"
import { getApiMetrics } from "@/shared/getApiMetrics"
import { Logger } from "@/shared/services/Logger"

export interface SessionControlApi {
	/** 設定 incline.mcp.sessionControl が有効か。 */
	isEnabled(): boolean
	phase(): TurnPhase
	taskId(): string | undefined
	messages(): ClineMessage[]
	/** 新しいセッションを開始し、セッション id を返す。 */
	startTask(prompt: string): Promise<string | undefined>
	/** 現在のセッションへメッセージを送る (質問への返答・続きの指示)。 */
	followup(prompt: string): Promise<void>
	cancel(): Promise<void>
	end(): Promise<void>
	/** 使用中のプロバイダとモデル (session_status に同梱する。無ければ省略)。 */
	modelInfo?(): { provider?: string; modelId?: string } | undefined
	/** 人間の判断待ち ([CONFIRM]) が未解決のカード (id とトピック)。session_status に pendingConfirm として同梱する。 */
	pendingConfirms?(): Promise<{ id: number; topics: string[] }[]>
}

export type SessionStatusName =
	| "idle"
	| "running"
	| "retrying"
	| "waiting_approval"
	| "waiting_question"
	| "completed"
	| "error"
	| "cancelled"

/** この状態になったら session_wait は返る (人 / 監督 AI の対応待ちか、終わり)。 */
const SETTLED: ReadonlySet<SessionStatusName> = new Set(["idle", "waiting_approval", "waiting_question", "completed", "error", "cancelled"])

const SUMMARY_CHARS = 200
/** 完了報告 (completion_result) は全文に近い長さで返す。 */
const COMPLETION_CHARS = 4000
/** session_messages の 1 件あたりの上限。 */
const MESSAGE_CHARS = 1000

function lastText(messages: ClineMessage[]): ClineMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if ((m.type === "say" || m.type === "ask") && m.text && m.say !== "api_req_started") {
			return m
		}
	}
	return undefined
}

/** メッセージだけから出せる、監督側の判断材料 (#112): 開始 / 最終活動の時刻、経過秒、ツール呼び出し回数、直近リクエストの入力トークン (= 文脈の大きさ)。 */
export function sessionActivity(
	messages: readonly { ts?: number; createdAt?: number; type?: string; say?: string; ask?: string; text?: string }[],
	now = Date.now(),
) {
	// ts は識別用のカウンタで時刻ではない (#100)。ホストが付けた実時刻 createdAt を使い、無ければ実時刻らしい ts (2001 年以降の epoch ms) だけを使う。
	const timeOf = (m: { ts?: number; createdAt?: number }) =>
		typeof m.createdAt === "number" && m.createdAt > 1e12 ? m.createdAt : typeof m.ts === "number" && m.ts > 1e12 ? m.ts : undefined
	const stamped = messages.map((m) => timeOf(m)).filter((t): t is number => t !== undefined)
	const startedAt = stamped.length > 0 ? stamped[0] : null
	const lastActivityAt = stamped.length > 0 ? stamped[stamped.length - 1] : null
	let toolCalls = 0
	let contextTokens: number | null = null
	for (const m of messages) {
		if (m.type === "say" && (m.say === "tool" || m.say === "command" || m.say === "use_mcp_server" || m.say === "browser_action_launch")) {
			toolCalls++
		}
		if (m.say === "api_req_started" && m.text) {
			try {
				const info = JSON.parse(m.text) as { tokensIn?: number; cacheReads?: number }
				if (typeof info.tokensIn === "number") {
					contextTokens = info.tokensIn + (info.cacheReads ?? 0)
				}
			} catch {
				// ignore a malformed request record
			}
		}
	}
	return {
		startedAt,
		lastActivityAt,
		elapsedSec: startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 1000)),
		toolCalls,
		contextTokens,
	}
}

export type SessionErrorKind = "insufficient_credits" | "rate_limit" | "timeout" | "auth" | "server_error" | "other"

/** api_req_failed の文面を機械的に分類する (#112)。HTTP ステータスが文面にあれば取り出す。 */
export function classifySessionError(text: string): { kind: SessionErrorKind; httpStatus: number | null; message: string } {
	const message = text.replace(/\s+/g, " ").trim().slice(0, 500)
	const m = message.match(/\b([45]\d{2})\b/)
	const httpStatus = m ? Number(m[1]) : null
	let kind: SessionErrorKind = "other"
	if (/more credits|insufficient (funds|credits?|balance)|can only afford|payment required/i.test(message) || httpStatus === 402) {
		kind = "insufficient_credits"
	} else if (/rate.?limit|too many requests|quota|resource.?exhausted/i.test(message) || httpStatus === 429) {
		kind = "rate_limit"
	} else if (/timed? ?out|timeout|deadline/i.test(message) || httpStatus === 504 || httpStatus === 408) {
		kind = "timeout"
	} else if (/unauthori[sz]ed|invalid api key|forbidden|permission/i.test(message) || httpStatus === 401 || httpStatus === 403) {
		kind = "auth"
	} else if (httpStatus !== null && httpStatus >= 500) {
		kind = "server_error"
	}
	return { kind, httpStatus, message }
}

/** lastMessage.kind が取りうる値 (仕様。#112 の (7))。ClineSay / ClineAsk の名前そのもの。 */
export const SESSION_MESSAGE_KINDS = [
	"text",
	"user_feedback",
	"completion_result",
	"command",
	"command_output",
	"tool",
	"use_mcp_server",
	"api_req_failed",
	"error",
	"followup",
	"info",
] as const

/**
 * status が error のとき、直近の api_req_failed を分類して返す。最後のメッセージは自動リトライの表示 (info) などのことがあるので、
 * 最後の 1 件ではなく、後ろから探す。ただし、その後に正常な返答 (completion_result / 新しいユーザー入力) があれば古い失敗とみなして null。
 */
export function latestApiFailure(messages: readonly ClineMessage[]) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.ask === "api_req_failed" || m.say === ("api_req_failed" as never)) {
			return classifySessionError(m.text ?? "")
		}
		if (m.say === "completion_result" || m.say === "user_feedback") {
			return null
		}
	}
	return null
}

/** buildSessionStatus に、未解決の [CONFIRM] を持つカードの一覧を足す (#112 の (6))。取れなければ null。 */
export async function buildSessionStatusFull(api: SessionControlApi) {
	let pendingConfirm: { id: number; topics: string[] }[] | null = null
	try {
		pendingConfirm = (await api.pendingConfirms?.()) ?? null
	} catch {
		pendingConfirm = null
	}
	return { ...buildSessionStatus(api), pendingConfirm }
}

export function buildSessionStatus(api: SessionControlApi) {
	const messages = api.messages()
	const last = lastText(messages)
	let status: SessionStatusName
	switch (api.phase()) {
		case "streaming":
			// 自動リトライ待機中は「実行中」ではなく retrying として示す
			status = last?.say === "info" && last.text?.includes("自動リトライ") ? "retrying" : "running"
			break
		case "awaiting_approval":
			status = "waiting_approval"
			break
		case "awaiting_followup":
			status = "waiting_question"
			break
		case "completed":
			status = "completed"
			break
		case "error":
			status = "error"
			break
		case "resumable":
			status = "cancelled"
			break
		default:
			status = "idle"
	}
	const metrics = getApiMetrics(messages)
	const activity = sessionActivity(messages)
	return {
		id: api.taskId() ?? null,
		status,
		...activity,
		model: api.modelInfo?.() ?? null,
		error: status === "error" ? latestApiFailure(api.messages()) : null,
		tokens: { in: metrics.totalTokensIn, out: metrics.totalTokensOut, cacheReads: metrics.totalCacheReads ?? 0, cacheWrites: metrics.totalCacheWrites ?? 0 },
		// 完了報告 (completion_result) は監督側がそのまま読めるよう長めに返し、それ以外は先頭 200 字の要約 (#75)
		lastMessage: last
			? {
					kind: last.say ?? last.ask ?? last.type,
					text: (last.text ?? "")
						.replace(/\s+/g, " ")
						.slice(0, last.say === "completion_result" ? COMPLETION_CHARS : SUMMARY_CHARS),
				}
			: null,
	}
}

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: `エラー: ${message}` }] })

export function registerSessionTools(server: McpServer, api: SessionControlApi): void {
	const guard = (): string | undefined =>
		api.isEnabled() ? undefined : "Session control is disabled. Turn on \"Enable MCP server\" in the INCLINE settings tab."
	/** id 指定があるなら、このウィンドウの現在のセッションと一致している必要がある。 */
	const checkId = (id?: string): string | undefined => {
		const current = api.taskId()
		if (id && id !== current) {
			return `セッション ${id} はこのウィンドウの現在のセッションではありません (現在: ${current ?? "なし"})。別ウィンドウのセッションは操作できません。`
		}
		return undefined
	}

	server.registerTool(
		"session_send",
		{
			description:
				"Send a message to INCLINE in this window. new_task=true (default) creates a new session, starts it with the prompt and returns the session id (refused while a session is running). new_task=false adds a message to the current session (also use it to answer a question the agent is waiting on).",
			inputSchema: { prompt: z.string().min(1), new_task: z.boolean().optional() },
		},
		async ({ prompt, new_task }) => {
			const denied = guard()
			if (denied) {
				return fail(denied)
			}
			const newTask = new_task !== false
			try {
				if (newTask) {
					const phase = api.phase()
					if (phase === "streaming" || phase === "awaiting_approval") {
						return fail("実行中のセッションがあります。session_cancel で止めるか、new_task=false で追加メッセージを送ってください。")
					}
					Logger.log(`[InclineMcp] session_send new_task (prompt ${prompt.length} chars)`)
					const id = await api.startTask(prompt)
					return asText({ id: id ?? api.taskId() ?? null, started: true })
				}
				if (!api.taskId()) {
					return fail("メッセージを送るセッションがありません。new_task=true で新しく開始してください。")
				}
				Logger.log(`[InclineMcp] session_send followup (prompt ${prompt.length} chars)`)
				await api.followup(prompt)
				return asText({ id: api.taskId() ?? null, sent: true })
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error))
			}
		},
	)

	server.registerTool(
		"session_status",
		{
			description: "Return the session status (running / retrying / waiting_approval / waiting_question / completed / error / cancelled / idle), token usage and a summary of the last message (first 200 characters; completion reports up to 4000).",
			inputSchema: { id: z.string().optional() },
		},
		async ({ id }) => {
			const denied = guard() ?? checkId(id)
			return denied ? fail(denied) : asText(await buildSessionStatusFull(api))
		},
	)

	server.registerTool(
		"session_messages",
		{
			description: "Return the last N messages of the current session in chronological order (kind and text, up to 1000 characters each; completion reports up to 4000). Use it to read how a run ended.",
			inputSchema: { id: z.string().optional(), count: z.number().int().min(1).max(50).optional() },
		},
		async ({ id, count }) => {
			const denied = guard() ?? checkId(id)
			if (denied) {
				return fail(denied)
			}
			const shown = api
				.messages()
				.filter((m) => (m.type === "say" || m.type === "ask") && m.text && m.say !== "api_req_started")
				.slice(-(count ?? 10))
				.map((m) => ({
					ts: m.ts,
					kind: m.say ?? m.ask ?? m.type,
					text: `${m.commentSource ? `💬 [${m.commentSource}] ` : ""}${m.text ?? ""}`.slice(0, m.say === "completion_result" ? COMPLETION_CHARS : MESSAGE_CHARS),
				}))
			return asText({ id: api.taskId() ?? null, messages: shown })
		},
	)

	server.registerTool(
		"session_cancel",
		{ description: "Cancel the running turn (same as the Cancel button). The session stays and can be resumed.", inputSchema: { id: z.string().optional() } },
		async ({ id }) => {
			const denied = guard() ?? checkId(id)
			if (denied) {
				return fail(denied)
			}
			Logger.log("[InclineMcp] session_cancel")
			await api.cancel()
			return asText(buildSessionStatus(api))
		},
	)

	server.registerTool(
		"session_end",
		{ description: "End the session (returns the chat to an empty state). The history is kept.", inputSchema: { id: z.string().optional() } },
		async ({ id }) => {
			const denied = guard() ?? checkId(id)
			if (denied) {
				return fail(denied)
			}
			Logger.log("[InclineMcp] session_end")
			await api.end()
			return asText(buildSessionStatus(api))
		},
	)

	server.registerTool(
		"session_wait",
		{
			description:
				"Wait up to timeout_sec seconds (default 60, max 600) until the session is completed, waiting for a question or approval, errored, cancelled or idle, then return the status at that point. Returns timedOut: true if it timed out.",
			inputSchema: { id: z.string().optional(), timeout_sec: z.number().int().min(1).max(600).optional() },
		},
		async ({ id, timeout_sec }) => {
			const denied = guard() ?? checkId(id)
			if (denied) {
				return fail(denied)
			}
			const deadline = Date.now() + (timeout_sec ?? 60) * 1000
			for (;;) {
				const status = await buildSessionStatusFull(api)
				if (SETTLED.has(status.status)) {
					return asText({ ...status, timedOut: false })
				}
				if (Date.now() >= deadline) {
					return asText({ ...status, timedOut: true })
				}
				await new Promise((resolve) => setTimeout(resolve, 500))
			}
		},
	)
}
