import type {
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	extractTextToolCalls,
	findHoldIndex,
	textToolCallsMiddleware,
} from "./text-tool-calls";

const TOOL_NAMES = new Set(["editor", "read_files", "run_commands"]);

const usage: LanguageModelV4Usage = {
	inputTokens: {
		total: 10,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

function params(
	overrides: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
	return {
		prompt: [],
		tools: [...TOOL_NAMES].map((name) => ({
			type: "function" as const,
			name,
			inputSchema: { type: "object" as const },
		})),
		...overrides,
	} as LanguageModelV4CallOptions;
}

/** Stream a reply split into the given text chunks, as Ollama would. */
function textReply(
	chunks: string[],
	extra: LanguageModelV4StreamPart[] = [],
): LanguageModelV4StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t0" },
		...chunks.map(
			(delta): LanguageModelV4StreamPart => ({
				type: "text-delta",
				id: "t0",
				delta,
			}),
		),
		{ type: "text-end", id: "t0" },
		...extra,
		{
			type: "finish",
			usage,
			finishReason: { unified: "stop", raw: "stop" },
		},
	];
}

async function run(
	parts: LanguageModelV4StreamPart[],
	callParams: LanguageModelV4CallOptions = params(),
): Promise<LanguageModelV4StreamPart[]> {
	const doStream = async (): Promise<LanguageModelV4StreamResult> => ({
		stream: new ReadableStream<LanguageModelV4StreamPart>({
			start(controller) {
				for (const part of parts) {
					controller.enqueue(part);
				}
				controller.close();
			},
		}),
	});
	const wrapStream = textToolCallsMiddleware.wrapStream;
	if (!wrapStream) {
		throw new Error("middleware has no wrapStream");
	}
	const result = await wrapStream({
		doStream,
		doGenerate: async () => {
			throw new Error("unused");
		},
		params: callParams,
		model: {} as never,
	});
	const out: LanguageModelV4StreamPart[] = [];
	const reader = result.stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			return out;
		}
		out.push(value);
	}
}

function textOf(parts: LanguageModelV4StreamPart[]): string {
	return parts
		.map((part) => (part.type === "text-delta" ? part.delta : ""))
		.join("");
}

function toolCallsOf(parts: LanguageModelV4StreamPart[]) {
	return parts.flatMap((part) =>
		part.type === "tool-call"
			? [{ toolName: part.toolName, input: JSON.parse(part.input) }]
			: [],
	);
}

function finishReasonOf(parts: LanguageModelV4StreamPart[]) {
	const finish = parts.find((part) => part.type === "finish");
	return finish?.type === "finish" ? finish.finishReason.unified : undefined;
}

describe("extractTextToolCalls", () => {
	it("recovers a bare JSON call", () => {
		const result = extractTextToolCalls(
			'{"name": "editor", "arguments": {"path": "/w/hello.ts", "new_text": "console.log(1);"}}',
			TOOL_NAMES,
		);
		expect(result.calls).toEqual([
			{
				toolName: "editor",
				input: { path: "/w/hello.ts", new_text: "console.log(1);" },
			},
		]);
		expect(result.text).toBe("");
	});

	it("recovers the **Tool Calls:** fenced array and keeps the plan", () => {
		const text = [
			"**Plan:**",
			"1. 新しい TypeScript ファイル `hello.ts` を作成する。",
			"",
			"**Tool Calls:**",
			"```json",
			"[",
			"  {",
			'    "name": "editor",',
			'    "arguments": {',
			'      "path": "\\\\\\\\example-host\\\\tk\\\\test\\\\hello.ts",',
			'      "new_text": "console.log(\'Hello, World!\');"',
			"    }",
			"  }",
			"]",
			"```",
		].join("\n");
		const result = extractTextToolCalls(text, TOOL_NAMES);
		expect(result.calls).toEqual([
			{
				toolName: "editor",
				input: {
					path: "\\\\example-host\\tk\\test\\hello.ts",
					new_text: "console.log('Hello, World!');",
				},
			},
		]);
		expect(result.text).toBe(
			"**Plan:**\n1. 新しい TypeScript ファイル `hello.ts` を作成する。",
		);
	});

	it("recovers <tool_call> blocks, ### headings and several calls", () => {
		const text = [
			"<tool_call>",
			'{"name": "read_files", "arguments": {"files": [{"path": "/a.ts"}]}}',
			"</tool_call>",
			'### Tool calls: {"name": "run_commands", "arguments": {"commands": ["ls"]}}',
		].join("\n");
		const result = extractTextToolCalls(text, TOOL_NAMES);
		expect(result.calls.map((call) => call.toolName)).toEqual([
			"read_files",
			"run_commands",
		]);
		expect(result.text).toBe("");
	});

	it("accepts OpenAI, alias and flattened shapes", () => {
		const text = [
			'{"type": "function", "function": {"name": "run_commands", "arguments": "{\\"commands\\": [\\"pwd\\"]}"}}',
			'{"tool": "editor", "parameters": {"path": "/x", "new_text": "y"}}',
			'{"name": "read_files", "files": [{"path": "/b"}]}',
			'{"tool_calls": [{"name": "run_commands", "args": {"commands": ["id"]},}]}',
		].join("\n");
		expect(extractTextToolCalls(text, TOOL_NAMES).calls).toEqual([
			{ toolName: "run_commands", input: { commands: ["pwd"] } },
			{ toolName: "editor", input: { path: "/x", new_text: "y" } },
			{ toolName: "read_files", input: { files: [{ path: "/b" }] } },
			{ toolName: "run_commands", input: { commands: ["id"] } },
		]);
	});

	it("leaves JSON that does not name an advertised tool alone", () => {
		const text = [
			"package.json の例です:",
			"```json",
			'{"name": "my-app", "version": "1.0.0", "scripts": {"build": "tsc"}}',
			"```",
			'{"name": "delete_everything", "arguments": {}}',
		].join("\n");
		expect(extractTextToolCalls(text, TOOL_NAMES)).toEqual({
			calls: [],
			text,
		});
	});

	it("does not treat braces inside JSON strings as structure", () => {
		const result = extractTextToolCalls(
			'{"name": "editor", "arguments": {"path": "/a.ts", "new_text": "if (x) { a[0] = \\"}\\"; }"}}',
			TOOL_NAMES,
		);
		expect(result.calls[0]?.input).toEqual({
			path: "/a.ts",
			new_text: 'if (x) { a[0] = "}"; }',
		});
	});
});

describe("findHoldIndex", () => {
	it("holds from the first marker or a trailing partial marker", () => {
		expect(findHoldIndex("plain text")).toBe(10);
		expect(findHoldIndex('ok {"name"')).toBe(3);
		expect(findHoldIndex("see ``")).toBe(4);
		expect(findHoldIndex("x <tool")).toBe(2);
	});
});

describe("textToolCallsMiddleware", () => {
	it("turns a text-only reply into a tool call and a tool-calls finish", async () => {
		const out = await run(
			textReply([
				"ファイルを作成します。\n",
				'{"name": "editor", ',
				'"arguments": {"path": "/w/a.ts", "new_text": "x"}}',
			]),
		);
		expect(textOf(out)).toBe("ファイルを作成します。\n");
		expect(toolCallsOf(out)).toEqual([
			{ toolName: "editor", input: { path: "/w/a.ts", new_text: "x" } },
		]);
		expect(finishReasonOf(out)).toBe("tool-calls");
		// Text is closed before the call is emitted.
		const types = out.map((part) => part.type);
		expect(types.indexOf("text-end")).toBeLessThan(types.indexOf("tool-call"));
	});

	it("streams prose before the call live", async () => {
		const out = await run(
			textReply([
				"Hello ",
				"world",
				"\n```json\n",
				'{"name": "run_commands", "arguments": {"commands": ["ls"]}}\n```',
			]),
		);
		const firstDeltas = out.filter((part) => part.type === "text-delta");
		expect(firstDeltas[0]).toMatchObject({ delta: "Hello " });
		expect(textOf(out)).toBe("Hello world\n");
		expect(toolCallsOf(out)).toHaveLength(1);
	});

	it("handles markers split across chunks", async () => {
		const out = await run(
			textReply([
				"<tool",
				'_call>\n{"name": "read_files", "arguments": {"files": [{"path": "/a"}]}}\n</tool_',
				"call>",
			]),
		);
		expect(textOf(out)).toBe("");
		expect(out.some((part) => part.type === "text-start")).toBe(false);
		expect(toolCallsOf(out)).toEqual([
			{ toolName: "read_files", input: { files: [{ path: "/a" }] } },
		]);
	});

	it("releases held text unchanged when it holds no call", async () => {
		const reply = "配列は [1, 2, 3] で、設定は `{a: 1}` です。";
		const out = await run(textReply([reply.slice(0, 8), reply.slice(8)]));
		expect(textOf(out)).toBe(reply);
		expect(toolCallsOf(out)).toEqual([]);
		expect(finishReasonOf(out)).toBe("stop");
	});

	it("does not convert when the model made a native tool call", async () => {
		const reply =
			'{"name": "editor", "arguments": {"path": "/a", "new_text": "b"}}';
		const out = await run(
			textReply(
				[reply],
				[
					{
						type: "tool-call",
						toolCallId: "native",
						toolName: "run_commands",
						input: '{"commands":["ls"]}',
					},
				],
			),
		);
		expect(textOf(out)).toBe(reply);
		expect(toolCallsOf(out)).toEqual([
			{ toolName: "run_commands", input: { commands: ["ls"] } },
		]);
	});

	it("passes streams through untouched when no tools are advertised", async () => {
		const parts = textReply([
			'{"name": "editor", "arguments": {"path": "/a", "new_text": "b"}}',
		]);
		expect(await run(parts, params({ tools: [] }))).toEqual(parts);
		expect(await run(parts, params({ toolChoice: { type: "none" } }))).toEqual(
			parts,
		);
	});
});
