// Incline: MCP の接続先を、実行中のメモリ上の環境変数だけで渡す (#88)。
//  - ファイルには残さない (揮発)。ウィンドウ (拡張ホスト) ごとに独立で、MCP の停止 / 終了で消える。
//  - 拡張ホストの process.env に入れると、同じウィンドウの Claude Code が起動する claude プロセスと、その
//    Bash ツールまで引き継がれる (統合ターミナルの環境変数 = environmentVariableCollection は別プロセスの
//    Claude Code には届かないため、これが標準モードでの渡し方になる)。
//  - 設定した時点より前に起動済みのプロセスには届かない (起動後に開いたターミナル / 起動した Claude セッションから有効)。
// vscode 非依存。

export const MCP_ENV_KEYS = ["INCLINE_MCP_URL", "INCLINE_MCP_PORT", "INCLINE_MCP_TOKEN"] as const

export interface McpConnection {
	port: number
	token: string
}

export function mcpEnvironment(conn: McpConnection): Record<(typeof MCP_ENV_KEYS)[number], string> {
	return {
		INCLINE_MCP_URL: `http://127.0.0.1:${conn.port}/mcp`,
		INCLINE_MCP_PORT: String(conn.port),
		INCLINE_MCP_TOKEN: conn.token,
	}
}

/** 拡張ホスト (または渡された env) に接続先を設定する。 */
export function applyMcpProcessEnv(conn: McpConnection, env: NodeJS.ProcessEnv = process.env): void {
	Object.assign(env, mcpEnvironment(conn))
}

/** 設定した接続先を消す。トークンが違う (= 別の接続先に置き換わっている) ときは消さない。 */
export function clearMcpProcessEnv(token: string, env: NodeJS.ProcessEnv = process.env): void {
	if (env.INCLINE_MCP_TOKEN !== token) {
		return
	}
	for (const key of MCP_ENV_KEYS) {
		delete env[key]
	}
}
