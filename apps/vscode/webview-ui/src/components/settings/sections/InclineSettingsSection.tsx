import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { memo } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

const InclineSettingsSection = () => {
	const { ntfyTopic, inclineDebugMode, inclineMcpEnabled } = useExtensionState()

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
