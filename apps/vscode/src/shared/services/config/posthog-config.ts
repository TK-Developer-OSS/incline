import { BUILD_CONSTANTS } from "../../constants"

export interface PostHogClientConfig {
	/**
	 * The main API key for PostHog telemetry service.
	 */
	apiKey?: string | undefined
	/**
	 * The API key for PostHog used only for error tracking service.
	 */
	errorTrackingApiKey?: string | undefined
	enableErrorAutocapture?: boolean
	host: string
	uiHost: string
}

/**
 * Helper type for a valid PostHog client configuration.
 * Must contains api keys for both telemetry and error tracking.
 */
export interface PostHogClientValidConfig extends PostHogClientConfig {
	apiKey: string
	errorTrackingApiKey: string
}

/**
 * NOTE: Ensure that dev environment is not used in production.
 * process.env.CI will always be true in the CI environment, during both testing and publishing step,
 * so it is not a reliable indicator of the environment.
 */
const useDevEnv = process.env.IS_DEV === "true" || process.env.CLINE_ENVIRONMENT === "local"

/**
 * PostHog configuration for Production Environment.
 * NOTE: The production environment variables will be injected at build time in CI/CD pipeline.
 * IMPORTANT: The secrets must be added to the GitHub Secrets and matched with the environment variables names
 * defined in the .github/workflows/ext-vscode-publish-stable.yml workflow.
 * NOTE: The development environment variables should be retrieved from 1password shared vault.
 */
// INCLINE: 本家 Cline のテレメトリ基盤 (data.cline.bot) へは送らない。
// キーを常に未設定にして PostHog のテレメトリ / エラー収集 / feature flags を無効化する。
// 自前の送信先を用意したら apiKey / errorTrackingApiKey / host を差し替えて戻す。
export const posthogConfig: PostHogClientConfig = {
	// apiKey: BUILD_CONSTANTS.TELEMETRY_SERVICE_API_KEY,
	// errorTrackingApiKey: BUILD_CONSTANTS.ERROR_SERVICE_API_KEY,
	apiKey: undefined,
	errorTrackingApiKey: undefined,
	host: "https://disabled.example.com",
	uiHost: useDevEnv ? "https://us.i.posthog.com" : "https://us.posthog.com",
	enableErrorAutocapture: BUILD_CONSTANTS.ENABLE_ERROR_AUTOCAPTURE === "true",
}

const isTestEnv = process.env.E2E_TEST === "true" || process.env.IS_TEST === "true"

export function isPostHogConfigValid(config: PostHogClientConfig): config is PostHogClientValidConfig {
	// Allow invalid config in test environment to enable mocking and stubbing
	if (isTestEnv) {
		return false
	}
	return (
		typeof config.apiKey === "string" &&
		typeof config.errorTrackingApiKey === "string" &&
		typeof config.host === "string" &&
		typeof config.uiHost === "string"
	)
}
