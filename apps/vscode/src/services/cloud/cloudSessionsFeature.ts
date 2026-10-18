/**
 * Incline (#33 / #107): the Cline cloud backend is disabled in INCLINE, so cloud sessions are never available and the
 * `CLINE_CLOUD_SESSIONS` override and the Settings toggle are ignored. Upstream's flag / override logic is intentionally removed
 * so a merge of upstream changes cannot switch the feature on by accident.
 */

/** Cloud sessions are not available in INCLINE. */
export function isCloudSessionsFeatureAvailable(): boolean {
	return false
}

/** Cloud sessions are never enabled in INCLINE. */
export function isCloudSessionsFeatureEnabled(): boolean {
	return false
}
