import * as fs from "node:fs"
import * as path from "node:path"
import { ApiProvider } from "@shared/api"
import type { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import {
	applyTransform,
	GlobalStateAndSettingKeys,
	GlobalStateAndSettings,
	getDefaultValue,
	isAsyncProperty,
	isComputedProperty,
	LocalState,
	LocalStateKeys,
	SecretKeys,
	Secrets,
} from "@shared/storage/state-keys"
import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { Logger } from "@/shared/services/Logger"
import { ClineMemento } from "@/shared/storage"
import { resolveDataDirFromEnv } from "@shared/storage/storage-context"
import { StateManager } from "../StateManager"

// ─── File-backed storage readers (used by StateManager) ────────────────────

/**
 * Read secrets from a ClineFileStorage instance.
 */
export function readSecretsFromStorage(store: ClineFileStorage<string>): Secrets {
	return SecretKeys.reduce((acc, key) => {
		acc[key] = store.get(key)
		return acc
	}, {} as Secrets)
}

/**
 * Read workspace state from a ClineFileStorage instance.
 */
export function readWorkspaceStateFromStorage(store: ClineFileStorage): LocalState {
	return LocalStateKeys.reduce((acc, key) => {
		acc[key] = store.get(key) || {}
		return acc
	}, {} as LocalState)
}

/**
 * Read global state from a ClineFileStorage instance.
 */
export async function readGlobalStateFromStorage(store: ClineMemento): Promise<GlobalStateAndSettings> {
	try {
		// Batch read all state values in a single optimized pass
		const stateValues = new Map<string, any>()
		for (const key of GlobalStateAndSettingKeys) {
			const value = store.get(key as string)
			stateValues.set(key, value)
		}

		const result = {} as any

		for (const key of GlobalStateAndSettingKeys) {
			const stateKey = key as keyof GlobalStateAndSettings
			let value = stateValues.get(stateKey)

			if (isAsyncProperty(stateKey)) {
				continue
			}
			if (isComputedProperty(stateKey)) {
				continue
			}
			if (value === undefined) {
				const defaultValue = getDefaultValue(stateKey)
				if (defaultValue !== undefined) {
					value = defaultValue
				}
			}
			if (value !== undefined) {
				value = applyTransform(stateKey, value)
			}
			result[stateKey] = value
		}

		await handleComputedProperties(result, stateValues)

		return result as GlobalStateAndSettings
	} catch (error) {
		Logger.error("[StateHelpers] Failed to read global state from storage:", error)
		throw error
	}
}

// ─── Legacy readers (for VSCode migration — reads from ExtensionContext) ────

/**
 * Handle properties that require computed logic
 */
/**
 * Incline (#110 / #90): the provider used when globalState.json has none. It used to be a hard-coded "openrouter", so a missing
 * key (a new data dir, a partial write, another window) silently switched the user to OpenRouter. Prefer the provider the user
 * used last (providers.json lastUsedProvider) and its model; fall back to "openrouter" only when that is unknown.
 */
export function readLastUsedProviderFromFile(dataDir: string = resolveDataDirFromEnv()): { provider?: ApiProvider; model?: string } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "settings", "providers.json"), "utf-8"))
		const id = typeof raw?.lastUsedProvider === "string" ? raw.lastUsedProvider.trim() : ""
		if (!id) {
			return {}
		}
		const model = raw?.providers?.[id]?.settings?.model
		return { provider: toLegacyApiProvider(id), model: typeof model === "string" && model ? model : undefined }
	} catch {
		return {}
	}
}

async function handleComputedProperties(result: any, stateValues: Map<string, any>): Promise<void> {
	// 1. API Provider logic - set defaults based on existing values
	const lastUsed = readLastUsedProviderFromFile()
	const defaultApiProvider: ApiProvider = lastUsed.provider ?? "openrouter"
	result.planModeApiProvider = result.planModeApiProvider || defaultApiProvider
	result.actModeApiProvider = result.actModeApiProvider || defaultApiProvider
	if (lastUsed.model) {
		// Only fill the model when the provider was also missing, so a provider chosen explicitly keeps its own model setting.
		if (!stateValues.get("planModeApiProvider") && !result.planModeApiModelId) {
			result.planModeApiModelId = lastUsed.model
		}
		if (!stateValues.get("actModeApiProvider") && !result.actModeApiModelId) {
			result.actModeApiModelId = lastUsed.model
		}
	}

	// 2. Plan/Act separate models setting with special logic
	const planActSeparateModelsSettingRaw = stateValues.get("planActSeparateModelsSetting")
	if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
		result.planActSeparateModelsSetting = planActSeparateModelsSettingRaw
	} else {
		// Default to false when not explicitly set
		result.planActSeparateModelsSetting = false
	}
}

export async function resetWorkspaceState() {
	const stateManager = StateManager.get()
	LocalStateKeys.map((key) => stateManager.setWorkspaceState(key, {}))
	await stateManager.reInitialize()
}

export async function resetGlobalState() {
	// TODO: Reset all workspace states?
	const stateManager = StateManager.get()
	GlobalStateAndSettingKeys.map((key) => stateManager.setGlobalState(key, undefined))
	SecretKeys.map((key) => stateManager.setSecret(key, undefined))
	await stateManager.reInitialize()
}
