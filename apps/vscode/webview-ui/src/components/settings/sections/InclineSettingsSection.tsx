import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { memo } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

// レート制限 / 自動リトライの項目。空欄 = 既定 (placeholder の値)。JSON 1 つにして保存する。
const RATE_LIMIT_FIELDS: { key: string; label: string; placeholder: string; help: string }[] = [
	{ key: "maxRetries", label: "Max auto-retries", placeholder: "2", help: "Automatic retries after a rate-limit / quota error (consecutive failures without progress). 0 disables automatic retry." },
	{ key: "retryDelaySec", label: "Retry wait (sec)", placeholder: "60", help: "Wait before the first retry. It doubles with each consecutive failure (up to 20 min). A longer \"retry in Ns\" hint from the server wins." },
	{ key: "minSpacingSec", label: "Min spacing between requests (sec)", placeholder: "provider default (Gemini 15)", help: "Minimum gap between API requests, including the SDK's internal retries." },
	{ key: "rpm", label: "Requests per minute (RPM)", placeholder: "provider default (Gemini 5)", help: "Target ceiling for the throttle and the gauge. Keep it below your real plan limit." },
	{ key: "tpm", label: "Tokens per minute (TPM)", placeholder: "provider default (Gemini 150000)", help: "Target ceiling for tokens (input + output + cache) per minute." },
	{ key: "requestDelaySec", label: "Wait per request (sec)", placeholder: "5", help: "Fixed wait before every model request, always. 0 disables it. (The minimum spacing above only fills the gap since the previous request.)" },
	{ key: "toolDelaySec", label: "Wait before each action (sec)", placeholder: "10", help: "Fixed wait before every tool execution. 0 disables it." },
	{ key: "toolAfterDelaySec", label: "Wait after each action (sec)", placeholder: "5", help: "Fixed wait after every tool execution, before the result goes back to the model. 0 disables it." },
]

const parseRateLimit = (json: string | undefined): Record<string, number> => {
	try {
		const parsed = json ? JSON.parse(json) : {}
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

const InclineSettingsSection = () => {
	const { ntfyTopic, inclineDebugMode, inclineMcpEnabled, inclineRateLimit } = useExtensionState()
	const rateLimit = parseRateLimit(inclineRateLimit)
	const setRateLimit = (key: string, value: string) => {
		const next = { ...rateLimit }
		const n = Number.parseFloat(value)
		if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
			delete next[key]
		} else {
			next[key] = n
		}
		updateSetting("inclineRateLimitJson", JSON.stringify(next))
	}

	return (
		<div className="p-4 space-y-4">
			<Section>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label className="text-sm font-medium text-foreground">NTFY Topic</Label>
						<p className="text-xs text-muted-foreground">
							The topic/room key for NTFY notifications.
						</p>
						<Input
							value={ntfyTopic || ""}
							onChange={(e) => updateSetting("ntfyTopic", e.target.value)}
							placeholder=""
						/>
					</div>
				</div>
			</Section>

			{/* レート制限 / 自動リトライ (空欄 = 既定)。VS Code 設定 incline.rateLimit.* より優先する */}
			<Section>
				<div className="space-y-3" data-testid="incline-rate-limit">
					<Label className="text-sm font-medium text-foreground">Rate limit / auto-retry</Label>
					<p className="text-xs text-muted-foreground">
						Throttling and automatic retry after rate-limit / quota errors. Leave a field empty to use the default. Changes
						take effect immediately. These override the VS Code settings incline.rateLimit.*.
					</p>
					{RATE_LIMIT_FIELDS.map((f) => (
						<div className="space-y-1" key={f.key}>
							<Label className="text-xs text-foreground">{f.label}</Label>
							<Input
								type="number"
								min={0}
								value={rateLimit[f.key] ?? ""}
								placeholder={f.placeholder}
								onChange={(e) => setRateLimit(f.key, e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">{f.help}</p>
						</div>
					))}
				</div>
			</Section>

			{/* MCP サーバの有効 / 無効と、MCP からのセッション操作の許可 */}
			<Section>
				<div className="space-y-3">
					<VSCodeCheckbox
						checked={inclineMcpEnabled !== false}
						data-testid="incline-mcp-enabled"
						onChange={(e: any) => updateSetting("inclineMcpEnabled", e.target.checked === true)}>
						Enable MCP server
					</VSCodeCheckbox>
					<p className="text-xs text-muted-foreground">
						Lets an external agent (for example a supervising AI) use this window's INCLINE: read and write the task board and
						messages, read the status (model, rate limits), and drive the AI (send prompts, cancel, end the session; your
						Auto-approve settings still apply). The server listens on 127.0.0.1 only, with token authentication. The port is chosen automatically
						per window, and the connection info is available in this window's integrated terminals as the environment
						variables INCLINE_MCP_URL / INCLINE_MCP_TOKEN. Switching takes effect immediately, no restart needed.
					</p>
				</div>
			</Section>

			{/* デバッグモード: MCP の接続先を ~/.incline/run に公開し、別の VS Code / 外部のエージェントからも接続できるようにする */}
			<Section>
				<div className="space-y-2">
					<VSCodeCheckbox
						checked={inclineDebugMode === true}
						data-testid="incline-debug-mode"
						onChange={(e: any) => updateSetting("inclineDebugMode", e.target.checked === true)}>
						Debug mode
					</VSCodeCheckbox>
					<p className="text-xs text-muted-foreground">
						Off (standard): the MCP connection info exists only in this window's integrated terminals (environment
						variables), so it can be used from this VS Code only. On: the connection info (port and token) is also
						written to ~/.incline/run/mcp-&lt;port&gt;.json, so another VS Code or an external agent (a supervising
						AI) can connect. MCP stays limited to 127.0.0.1 with token authentication.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default memo(InclineSettingsSection)
