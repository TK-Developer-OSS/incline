import * as vscode from "vscode"
import { applyRateLimitSettings } from "./rate-limiter"

const SECTION = "incline.rateLimit"

/** VS Code 設定 (incline.rateLimit.*) をスロットリング / 自動リトライに反映する。 */
export function applyRateLimitConfigFromVscode(): void {
	const c = vscode.workspace.getConfiguration(SECTION)
	// 明示的に設定された値だけを渡す (未設定なら package.json の default ではなく
	// プロバイダ別の目安を使わせるため)。
	const explicit = (key: string): number | undefined => {
		const i = c.inspect<number>(key)
		return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
	}
	applyRateLimitSettings({
		rpm: explicit("rpm"),
		tpm: explicit("tpm"),
		rpd: explicit("rpd"),
		minSpacingSec: explicit("minSpacingSec"),
		retryDelaySec: explicit("retryDelaySec"),
		maxRetries: explicit("maxRetries"),
		toolDelaySec: explicit("toolDelaySec"),
	})
}

/** 起動時に一度反映し、設定変更を監視する。変更後は onChanged で webview の再描画などを行う。 */
export function registerRateLimitConfig(context: vscode.ExtensionContext, onChanged: () => void): void {
	applyRateLimitConfigFromVscode()
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SECTION)) {
				applyRateLimitConfigFromVscode()
				onChanged()
			}
		}),
	)
}
