/**
 * Incline (#107): which API key wins when the legacy store (secrets.json, via StateManager) and the SDK store (providers.json) both
 * have one. The legacy key used to win always, so a key changed in the settings UI (written to providers.json only) was ignored and
 * the old, possibly exhausted key kept being used. Now the SDK store's key wins when it was written after secrets.json.
 */
export function pickNewerApiKey(
	legacyKey: string | undefined,
	settingsKey: string | undefined,
	settingsUpdatedAtMs: number,
	secretsMtimeMs: number,
): string | undefined {
	const legacy = legacyKey?.trim() || undefined
	const settings = settingsKey?.trim() || undefined
	if (!settings) {
		return legacy
	}
	if (!legacy) {
		return settings
	}
	return settingsUpdatedAtMs > secretsMtimeMs ? settings : legacy
}
