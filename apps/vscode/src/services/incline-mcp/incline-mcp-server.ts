// Incline: INCLINE 自身が持つ MCP サーバ (外部のエージェントが INCLINE のバックログ等を使うための窓口)。
//  - 127.0.0.1 限定の Streamable HTTP。ウィンドウごとに別ポート (基準ポートから空きを探索)。
//  - 起動ごとのランダムなトークンで認証 (Authorization: Bearer)。
//  - ポートとトークンは ~/.incline/run/mcp-<port>.json に書き、外部から見つけられるようにする。
//  - リクエストごとに McpServer + Transport を作るステートレス方式。
// vscode 非依存 (テスト可能)。

import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { needsConfirmation, TASK_PRIORITIES, TASK_STATUSES } from "@/integrations/task-tracker/task-md"
import type { TaskMdStore } from "@/integrations/task-tracker/task-md-store"
import { MAX_TEXT_CHARS, type Message, type MessageStore } from "./message-store"
import { registerSessionTools, type SessionControlApi } from "./session-tools"

export const DEFAULT_MCP_BASE_PORT = 12340
/** 基準ポートから探索する範囲 (ウィンドウ数の上限)。 */
const PORT_SCAN_RANGE = 100
const AUTHOR = "AI"
/** 最後のリクエストが終わってから、操作中の表示を消すまでの余韻 (ms)。 */
export const ACTIVITY_LINGER_MS = 2000

export interface InclineMcpOptions {
	store: TaskMdStore
	workspace: string
	basePort?: number
	/** モデル名の参照 (model_info)。無ければ登録しない。 */
	getModelInfo?: () => unknown
	/** 状態参照ツール用 (レートメーター等)。無ければ登録しない。 */
	getRateStatus?: () => unknown
	/** セッション操作ツール (session_*) 用。無ければ登録しない。 */
	sessionApi?: SessionControlApi
	/** メッセージ (post_message / read_messages / ack_message)。無ければ登録しない。 */
	messageStore?: MessageStore
	/** メッセージが投稿されたときに呼ぶ (人間宛の通知など)。本文はログに出さないこと。 */
	onMessagePosted?: (message: Message) => void
	/** タスクを書き換えたあとに呼ぶ (パネルへの即時反映用)。 */
	onTasksChanged?: () => void
	/** MCP がリクエストを受けている間 true になる (最後のリクエストから ACTIVITY_LINGER_MS 後に false)。 */
	onActivity?: (active: boolean) => void
	/** レジストリファイルの置き場。既定は ~/.incline/run。 */
	runDir?: string
	/** false なら登録ファイルを作らない (接続先は呼び出し側が環境変数などで渡す)。既定 true。 */
	discoverable?: boolean
	/** 登録ファイルが消えていないか確認して書き直す間隔 (ms)。既定 5000。0 で無効 (テスト用)。 */
	registryCheckMs?: number
	/** 固定トークン (テスト用)。既定はランダム。 */
	token?: string
}

export interface InclineMcpHandle {
	port: number
	token: string
	registryFile: string
	/** 登録ファイルを作る (true) / 消す (false)。デバッグモードの切替で使う。 */
	setDiscoverable(discoverable: boolean): Promise<void>
	close(): Promise<void>
}

function defaultRunDir(): string {
	return path.join(process.env.INCLINE_DIR?.trim() || path.join(os.homedir(), ".incline"), "run")
}

function text_(value: string) {
	return text(value)
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] }
}

function formatTask(t: { id: number; title: string; status: string; priority: string; category: string; assignee: string; updated: string; history?: string }) {
	// 有効な判断待ち ([CONFIRM] が [RESOLVED] で打ち消されていない) があれば分かるようにする
	const confirm = t.history !== undefined && needsConfirmation({ status: t.status, history: t.history }) ? " ⚠CONFIRM" : ""
	return `#${t.id} [${t.priority}] [${t.status}]${t.category ? ` <${t.category}>` : ""} ${t.title}${t.assignee ? ` (@${t.assignee})` : ""} — updated ${t.updated}${confirm}`
}

function buildServer(opts: InclineMcpOptions): McpServer {
	const server = new McpServer({ name: "incline", version: "1.0.0" })
	const { store } = opts

	server.registerTool(
		"task_list",
		{
			description: "List the tasks in the INCLINE backlog (task.md), ordered by priority.",
			inputSchema: { status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional() },
		},
		async ({ status }) => {
			const tasks = (await store.list()).filter((t) => !status || t.status === status)
			return text(tasks.length ? tasks.map(formatTask).join("\n") : "該当するタスクはありません。")
		},
	)

	server.registerTool(
		"task_create",
		{
			description: "Create a task in the backlog.",
			inputSchema: {
				title: z.string().min(1),
				content: z.string().optional(),
				category: z.string().optional(),
				priority: z.enum(TASK_PRIORITIES as unknown as [string, ...string[]]).optional(),
			},
		},
		async ({ title, content, category, priority }) => {
			const t = await store.create(
				{ title, content, category, priority: priority as (typeof TASK_PRIORITIES)[number] | undefined },
				AUTHOR,
			)
			opts.onTasksChanged?.()
			return text(`登録しました: ${formatTask(t)}`)
		},
	)

	server.registerTool(
		"task_update",
		{
			description: "Update a task (status, priority, category, assignee, remarks). Note: set a task to 完了 / 削除 only when the human asked you to.",
			inputSchema: {
				id: z.number().int(),
				status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
				priority: z.enum(TASK_PRIORITIES as unknown as [string, ...string[]]).optional(),
				category: z.string().optional(),
				assignee: z.string().optional(),
				remarks: z.string().optional(),
			},
		},
		async ({ id, ...patch }) => {
			const t = await store.update(
				id,
				patch as Parameters<TaskMdStore["update"]>[1],
				AUTHOR,
			)
			opts.onTasksChanged?.()
			return t ? text(`更新しました: ${formatTask(t)}`) : text(`エラー: #${id} は存在しません。`)
		},
	)

	server.registerTool(
		"task_note",
		{
			description: "Append one line to a task's history (append only; existing lines are never changed). Use it to report progress and your final report. When you need a human decision, start the text with [CONFIRM] (question, options, your default choice): the task blinks red in the panel until a line starting with [RESOLVED] cancels it.",
			inputSchema: { id: z.number().int(), text: z.string().min(1) },
		},
		async ({ id, text: body }) => {
			const t = await store.note(id, body, AUTHOR)
			opts.onTasksChanged?.()
			return t ? text(`追記しました: #${id}`) : text(`エラー: #${id} は存在しません。`)
		},
	)

	if (opts.getModelInfo) {
		server.registerTool(
			"model_info",
			{ description: "Return the AI provider and model this INCLINE window is using (mode, provider, current model id, and the plan / act mode models)." },
			async () => text(JSON.stringify(opts.getModelInfo?.() ?? {}, null, 2)),
		)
	}
	if (opts.getRateStatus) {
		server.registerTool(
			"rate_status",
			{ description: "Return the current RPM / TPM / RPD usage and limits." },
			async () => text(JSON.stringify(opts.getRateStatus?.() ?? {}, null, 2)),
		)
	}
	if (opts.sessionApi) {
		registerSessionTools(server, opts.sessionApi)
	}
	if (opts.messageStore) {
		registerMessageTools(server, opts.messageStore, opts.onMessagePosted)
	}
	return server
}

function registerMessageTools(server: McpServer, store: MessageStore, onPosted?: (m: Message) => void): void {
	const fmt = (m: Message) => ({ id: m.id, ts: m.ts, from: m.from, to: m.to, title: m.title, text: m.text, ackedBy: m.ackedBy })

	server.registerTool(
		"post_message",
		{
			description: `Post a message (completion report, question, instruction) to a human or another AI. "to" is a name (e.g. "TK", "claude", "gemini"), or "all" for everyone. The text is limited to ${MAX_TEXT_CHARS} characters.`,
			inputSchema: { to: z.string().min(1), title: z.string().optional(), text: z.string().min(1), from: z.string().optional() },
		},
		async ({ to, title, text, from }) => {
			try {
				const m = await store.post({ to, title: title ?? "", text, from })
				onPosted?.(m)
				return text_(`投稿しました: #${m.id} → ${m.to}`)
			} catch (error) {
				return { isError: true, content: [{ type: "text" as const, text: `エラー: ${error instanceof Error ? error.message : String(error)}` }] }
			}
		},
	)

	server.registerTool(
		"read_messages",
		{
			description:
				"Read messages in ascending id order. Filter with since (only messages newer than this id), to (recipient; messages addressed to \"all\" are included), unacked_by (only messages this person has not acknowledged yet) and limit.",
			inputSchema: {
				since: z.number().int().min(0).optional(),
				to: z.string().optional(),
				unacked_by: z.string().optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
		},
		async ({ since, to, unacked_by, limit }) => {
			const list = await store.read({ sinceId: since, to, unackedBy: unacked_by, limit })
			return text_(JSON.stringify({ messages: list.map(fmt) }, null, 2))
		},
	)

	server.registerTool(
		"ack_message",
		{
			description: "Acknowledge a message (by is the name of the person acknowledging it).",
			inputSchema: { id: z.number().int(), by: z.string().min(1) },
		},
		async ({ id, by }) => {
			const m = await store.ack(id, by)
			return m ? text_(`既読にしました: #${m.id} (既読: ${m.ackedBy.join(", ")})`) : { isError: true, content: [{ type: "text" as const, text: `エラー: #${id} は存在しません。` }] }
		},
	)
}

/**
 * 持ち主のプロセス (pid) がもう無い登録ファイルを消す。ウィンドウの再読み込みや強制終了で残った古いファイルが、
 * 無効なトークンのまま見つかって 401 になるのを防ぐ。自分のプロセスのファイルと、生きているプロセスのものは触らない。
 */
export async function removeStaleRegistryFiles(runDir: string): Promise<string[]> {
	const removed: string[] = []
	let names: string[]
	try {
		names = await fs.readdir(runDir)
	} catch {
		return removed
	}
	for (const name of names) {
		if (!/^mcp-\d+\.json$/.test(name)) {
			continue
		}
		const file = path.join(runDir, name)
		try {
			const info = JSON.parse(await fs.readFile(file, "utf8")) as { pid?: number }
			if (typeof info.pid !== "number" || info.pid === process.pid) {
				continue
			}
			try {
				process.kill(info.pid, 0)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					await fs.unlink(file)
					removed.push(name)
				}
			}
		} catch {
			// 壊れたファイル / 読めないファイルは触らない
		}
	}
	return removed
}

async function listen(server: http.Server, basePort: number): Promise<number> {
	for (let i = 0; i < PORT_SCAN_RANGE; i++) {
		const port = basePort + i
		const ok = await new Promise<boolean>((resolve) => {
			const onError = () => resolve(false)
			server.once("error", onError)
			server.listen(port, "127.0.0.1", () => {
				server.off("error", onError)
				resolve(true)
			})
		})
		if (ok) {
			return port
		}
	}
	throw new Error(`MCP サーバ用の空きポートが見つかりません (${basePort}〜${basePort + PORT_SCAN_RANGE - 1})`)
}

export async function startInclineMcpServer(opts: InclineMcpOptions): Promise<InclineMcpHandle> {
	const token = opts.token ?? randomBytes(24).toString("hex")

	// 認証済みリクエストの処理中は「操作を受けている」とみなし、終わって少し経ってから解除する。
	let inFlight = 0
	let lingerTimer: ReturnType<typeof setTimeout> | undefined
	const markActive = () => {
		inFlight++
		if (lingerTimer) {
			clearTimeout(lingerTimer)
			lingerTimer = undefined
		}
		if (inFlight === 1) {
			opts.onActivity?.(true)
		}
	}
	const markIdle = () => {
		inFlight = Math.max(0, inFlight - 1)
		if (inFlight === 0 && !lingerTimer) {
			lingerTimer = setTimeout(() => {
				lingerTimer = undefined
				opts.onActivity?.(false)
			}, ACTIVITY_LINGER_MS)
		}
	}

	const httpServer = http.createServer(async (req, res) => {
		try {
			if (req.headers.authorization !== `Bearer ${token}`) {
				res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized")
				return
			}
			if (req.url?.split("?")[0] !== "/mcp") {
				res.writeHead(404).end()
				return
			}
			markActive()
			res.on("close", markIdle)
			const mcp = buildServer(opts)
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
			res.on("close", () => {
				void transport.close()
				void mcp.close()
			})
			await mcp.connect(transport)
			await transport.handleRequest(req, res)
		} catch (error) {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain" }).end(String(error instanceof Error ? error.message : error))
			}
		}
	})

	const port = await listen(httpServer, opts.basePort ?? DEFAULT_MCP_BASE_PORT)

	// 外部のエージェントが見つけられるよう、ポートとトークンを書く (本人だけが読めるように 0600)。
	const runDir = opts.runDir ?? defaultRunDir()
	await removeStaleRegistryFiles(runDir)
	const registryFile = path.join(runDir, `mcp-${port}.json`)
	const registryBody = JSON.stringify(
		{
			port,
			url: `http://127.0.0.1:${port}/mcp`,
			token,
			workspace: opts.workspace,
			pid: process.pid,
			startedAt: new Date().toISOString(),
		},
		null,
		2,
	)
	// 登録ファイルは「自分のもの」のときだけ消す (#84): 別のプロセス (同じポートを後から使ったウィンドウなど) が
	// 同名のファイルを書いていたら、その人のものなので触らない。
	const ownsRegistry = async (): Promise<boolean> => {
		try {
			const info = JSON.parse(await fs.readFile(registryFile, "utf8")) as { pid?: number; token?: string }
			return info.pid === process.pid && info.token === token
		} catch {
			return false
		}
	}
	let discoverableNow = false
	const writeRegistry = async () => {
		await fs.mkdir(runDir, { recursive: true })
		await fs.writeFile(registryFile, registryBody, { mode: 0o600 })
	}
	const setDiscoverable = async (discoverable: boolean) => {
		discoverableNow = discoverable
		if (discoverable) {
			await writeRegistry()
		} else if (await ownsRegistry()) {
			await fs.unlink(registryFile).catch(() => undefined)
		}
	}
	await setDiscoverable(opts.discoverable !== false)

	// 公開中なのに登録ファイルが無い / 別の内容になっていたら書き直す (外部の掃除や別プロセスの終了処理で消えた場合の自己修復)。
	const checkMs = opts.registryCheckMs ?? 5000
	const registryTimer =
		checkMs > 0
			? setInterval(() => {
					if (discoverableNow) {
						void ownsRegistry().then((owns) => (owns ? undefined : writeRegistry())).catch(() => undefined)
					}
				}, checkMs)
			: undefined
	registryTimer?.unref?.()

	return {
		port,
		token,
		registryFile,
		setDiscoverable,
		close: async () => {
			if (lingerTimer) {
				clearTimeout(lingerTimer)
				lingerTimer = undefined
			}
			if (registryTimer) {
				clearInterval(registryTimer)
			}
			discoverableNow = false
			await new Promise<void>((resolve) => httpServer.close(() => resolve()))
			if (await ownsRegistry()) {
				await fs.unlink(registryFile).catch(() => undefined)
			}
		},
	}
}
