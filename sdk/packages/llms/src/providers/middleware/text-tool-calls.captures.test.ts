// Replays real model replies captured by `scripts/ollama-tool-probe.py`
// through the text tool-call parser. Each capture records whether the prompt
// called for a tool; replies Ollama already returned as native `tool_calls`
// are skipped because the middleware leaves those alone. Nothing runs until
// the probe has saved captures.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTextToolCalls } from "./text-tool-calls";

interface Capture {
	model: string;
	case: string;
	expect_tool_call: boolean;
	tool_names: string[];
	content: string;
	native_tool_calls: unknown[];
}

const CAPTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
	"ollama-captures",
);

const captures = existsSync(CAPTURE_DIR)
	? readdirSync(CAPTURE_DIR)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => ({
				file,
				capture: JSON.parse(
					readFileSync(join(CAPTURE_DIR, file), "utf8"),
				) as Capture,
			}))
			.filter(({ capture }) => capture.native_tool_calls.length === 0)
	: [];

describe.skipIf(captures.length === 0)("captured Ollama replies", () => {
	it.each(captures)("$file", ({ capture }) => {
		const { calls } = extractTextToolCalls(
			capture.content,
			new Set(capture.tool_names),
		);
		// A reply that never names a tool is the model declining to act, not
		// something a parser can recover; only replies that do must parse.
		const namesATool = capture.tool_names.some((name) =>
			capture.content.includes(`"${name}"`),
		);
		if (capture.expect_tool_call) {
			if (namesATool) {
				expect(calls.length).toBeGreaterThan(0);
			}
		} else {
			expect(calls).toEqual([]);
		}
	});
});
