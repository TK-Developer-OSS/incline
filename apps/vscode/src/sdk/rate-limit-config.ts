import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { applyRateLimitSettings, type RateLimitSettings } from "./rate-limiter"

const SECTION = "incline.rateLimit"

/** 設定パネルの値 (JSON)。空欄 / 不正な項目は未指定として扱う。 */
function readPanelRateLimit(): RateLimitSettings {
	try {
		const raw = StateManager.get().getGlobalSettingsKey("inclineRateLimit")
		const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
		const num = (k: string): number | undefined => {
			const v = parsed[k]
			return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
		}
		return {
			rpm: num("rpm"),
			tpm: num("tpm"),
			rpd: num("rpd"),
			minSpacingSec: num("minSpacingSec"),
			retryDelaySec: num("retryDelaySec"),
			maxRetries: num("maxRetries"),
			toolDelaySec: num("toolDelaySec"),
			requestDelaySec: num("requestDelaySec"),
			toolAfterDelaySec: num("toolAfterDelaySec"),
		}
	} catch {
		return {}
	}
}

/** VS Code 設定 (incline.rateLimit.*) をスロットリング / 自動リトライに反映する。 */
export function applyRateLimitConfigFromVscode(): void {
	const c = vscode.workspace.getConfiguration(SECTION)
	// 明示的に設定された値だけを渡す (未設定なら package.json の default ではなく
	// プロバイダ別の目安を使わせるため)。
	const explicit = (key: string): number | undefined => {
		const i = c.inspect<number>(key)
		return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
	}
	// 優先順位: 設定パネル (INCLINE の設定画面) > VS Code 設定 (incline.rateLimit.*) > プロバイダ別 / 汎用の既定。
	const panel = readPanelRateLimit()
	applyRateLimitSettings({
		rpm: panel.rpm ?? explicit("rpm"),
		tpm: panel.tpm ?? explicit("tpm"),
		rpd: panel.rpd ?? explicit("rpd"),
		minSpacingSec: panel.minSpacingSec ?? explicit("minSpacingSec"),
		retryDelaySec: panel.retryDelaySec ?? explicit("retryDelaySec"),
		maxRetries: panel.maxRetries ?? explicit("maxRetries"),
		toolDelaySec: panel.toolDelaySec ?? explicit("toolDelaySec"),
		requestDelaySec: panel.requestDelaySec ?? explicit("requestDelaySec"),
		toolAfterDelaySec: panel.toolAfterDelaySec ?? explicit("toolAfterDelaySec"),
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
