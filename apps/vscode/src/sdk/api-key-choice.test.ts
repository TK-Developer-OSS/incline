import { describe, expect, it } from "vitest"
import { pickNewerApiKey } from "./api-key-choice"

describe("pickNewerApiKey (#107)", () => {
	it("uses the SDK store's key when it was written after secrets.json (a key changed in the settings UI)", () => {
		expect(pickNewerApiKey("old-key", "new-key", 2000, 1000)).toBe("new-key")
	})
	it("keeps the legacy key when secrets.json is newer", () => {
		expect(pickNewerApiKey("legacy-key", "sdk-key", 1000, 2000)).toBe("legacy-key")
	})
	it("falls back to whichever exists, trimming blanks", () => {
		expect(pickNewerApiKey(undefined, " sdk-key ", 0, 0)).toBe("sdk-key")
		expect(pickNewerApiKey("  legacy ", undefined, 0, 0)).toBe("legacy")
		expect(pickNewerApiKey("legacy", "   ", 5, 1)).toBe("legacy")
		expect(pickNewerApiKey(undefined, undefined, 0, 0)).toBeUndefined()
	})
})
