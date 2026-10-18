import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { readLastUsedProviderFromFile } from "./state-helpers"

describe("readLastUsedProviderFromFile (#110)", () => {
	const mk = (content?: unknown) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lastused-"))
		if (content !== undefined) {
			fs.mkdirSync(path.join(dir, "settings"), { recursive: true })
			fs.writeFileSync(path.join(dir, "settings", "providers.json"), JSON.stringify(content))
		}
		return dir
	}
	it("returns the last used provider and its model", () => {
		const dir = mk({ lastUsedProvider: "gemini", providers: { gemini: { settings: { model: "gemini-3.5-flash-lite" } } } })
		expect(readLastUsedProviderFromFile(dir)).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite" })
	})
	it("returns nothing when the file is missing or has no last used provider", () => {
		expect(readLastUsedProviderFromFile(mk())).toEqual({})
		expect(readLastUsedProviderFromFile(mk({ providers: {} }))).toEqual({})
	})
})
