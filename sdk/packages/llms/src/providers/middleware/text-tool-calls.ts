// LanguageModelV4 middleware that recovers tool calls a model wrote as plain
// reply text instead of emitting them through the provider's native tool-call
// channel.
//
// Background: small local models served by Ollama (qwen2.5-coder:7b is the
// motivating case) often ignore the chat template's `<tool_call>` wrapper and
// write the call as a JSON object in the reply text — bare, inside a ```json
// fence, or under a "Tool Calls:" heading. Ollama only parses calls that
// follow the template exactly, so these arrive as ordinary text: the agent
// sees a text-only turn, nothing runs, and the task stalls.
//
// Stream mechanics: only requests that advertise function tools are touched.
// Each text part streams through live until something that could begin a
// tool call appears (`<tool_call`, a code fence, `{` or `[`); from there the
// rest of that text part is held back. When the stream finishes, held text is
// scanned for JSON values that name one of the advertised tools. Each match is
// removed from the text and re-emitted as a real `tool-call` part, and the
// finish reason becomes `tool-calls`. Held text without matches is released
// unchanged, and nothing is converted when the model produced native tool
// calls, so well-behaved models see no difference beyond the hold-back delay.

import type {
	LanguageModelV4CallOptions,
	LanguageModelV4Middleware,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { nanoid } from "nanoid";

export interface TextToolCall {
	toolName: string;
	input: unknown;
}

export interface ExtractedTextToolCalls {
	calls: TextToolCall[];
	/** The text with every recovered call (and its wrapper) removed. */
	text: string;
}

const NAME_KEYS = ["name", "tool", "tool_name", "toolName"] as const;
const ARGUMENT_KEYS = [
	"arguments",
	"parameters",
	"args",
	"input",
	"params",
] as const;
/** Keys that describe a call rather than carry its arguments. */
const CALL_META_KEYS = new Set<string>([...NAME_KEYS, "type", "id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Small models commonly leave a trailing comma before `}` or `]`.
		try {
			return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return undefined;
		}
	}
}

function toCall(
	name: unknown,
	args: unknown,
	toolNames: ReadonlySet<string>,
): TextToolCall | undefined {
	if (typeof name !== "string" || !toolNames.has(name)) {
		return undefined;
	}
	// OpenAI-style calls carry arguments as a JSON-encoded string.
	const input =
		typeof args === "string" ? (parseJsonLenient(args) ?? args) : args;
	return { toolName: name, input: input ?? {} };
}

/**
 * Interpret a parsed JSON value as zero or more tool calls. Accepts the
 * shapes models actually write: `{name, arguments}` (and the `tool` /
 * `parameters` / `args` / `input` spellings), OpenAI's
 * `{function: {name, arguments}}`, `{tool_calls: [...]}`, arrays of any of
 * these, and `{name, ...arguments}` with the arguments flattened alongside the
 * name.
 */
function callsFromJson(
	value: unknown,
	toolNames: ReadonlySet<string>,
): TextToolCall[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => callsFromJson(item, toolNames));
	}
	if (!isRecord(value)) {
		return [];
	}
	if (Array.isArray(value.tool_calls)) {
		return callsFromJson(value.tool_calls, toolNames);
	}
	if (isRecord(value.function)) {
		const call = toCall(
			value.function.name,
			value.function.arguments,
			toolNames,
		);
		return call ? [call] : [];
	}
	const nameKey = NAME_KEYS.find((key) => typeof value[key] === "string");
	if (!nameKey) {
		return [];
	}
	const argsKey = ARGUMENT_KEYS.find((key) => key in value);
	let args: unknown;
	if (argsKey) {
		args = value[argsKey];
	} else {
		args = Object.fromEntries(
			Object.entries(value).filter(([key]) => !CALL_META_KEYS.has(key)),
		);
	}
	const call = toCall(value[nameKey], args, toolNames);
	return call ? [call] : [];
}

/**
 * Index just past the JSON object/array that opens at `start`, found by
 * bracket matching that skips string contents; `undefined` when it never
 * closes.
 */
function findJsonEnd(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") {
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return undefined;
}

const WRAPPER_BEFORE = /(?:<tool_call>|```[\w-]*)\s*$/;
const WRAPPER_AFTER = /^\s*(?:<\/tool_call>|```)/;

/** Widen a span over the `<tool_call>` tags or code fence around it. */
function widenOverWrappers(
	text: string,
	start: number,
	end: number,
): [number, number] {
	for (let pass = 0; pass < 2; pass++) {
		const before = WRAPPER_BEFORE.exec(text.slice(0, start));
		const after = WRAPPER_AFTER.exec(text.slice(end));
		if (before && after) {
			start -= before[0].length;
			end += after[0].length;
		} else {
			if (before?.[0].startsWith("<tool_call>")) {
				start -= before[0].length;
			}
			if (after?.[0].trimStart().startsWith("</tool_call>")) {
				end += after[0].length;
			}
			break;
		}
	}
	return [start, end];
}

/** A heading line left behind once the calls under it are removed. */
const ORPHAN_HEADING =
	/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*tool[ _]?calls?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*:?[ \t]*$/gim;

/**
 * Find tool calls written as JSON in `text`. Only values naming one of
 * `toolNames` count, which keeps ordinary JSON in an answer (config files,
 * API examples) from being mistaken for a call.
 */
export function extractTextToolCalls(
	text: string,
	toolNames: ReadonlySet<string>,
): ExtractedTextToolCalls {
	const calls: TextToolCall[] = [];
	const spans: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch !== "{" && ch !== "[") {
			i++;
			continue;
		}
		const end = findJsonEnd(text, i);
		const value =
			end === undefined ? undefined : parseJsonLenient(text.slice(i, end));
		if (end === undefined || value === undefined) {
			i++;
			continue;
		}
		const found = callsFromJson(value, toolNames);
		if (found.length > 0) {
			calls.push(...found);
			spans.push(widenOverWrappers(text, i, end));
		}
		// Skip the whole value: nested objects are arguments, not calls.
		i = end;
	}
	if (calls.length === 0) {
		return { calls, text };
	}
	let remaining = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		remaining += text.slice(cursor, Math.max(cursor, start));
		cursor = Math.max(cursor, end);
	}
	remaining += text.slice(cursor);
	remaining = remaining
		.replace(ORPHAN_HEADING, "")
		.replace(/<\/?tool_call>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { calls, text: remaining };
}

const HOLD_MARKERS = ["<tool_call", "```", "{", "["];

/**
 * Where held-back text should start: the first marker that could begin a
 * tool call, or a trailing partial marker (e.g. a lone "`" or "<tool") that
 * the next delta might complete. Returns `text.length` when nothing needs
 * holding.
 */
export function findHoldIndex(text: string): number {
	let hold = text.length;
	for (const marker of HOLD_MARKERS) {
		const index = text.indexOf(marker);
		if (index !== -1 && index < hold) {
			hold = index;
		}
	}
	if (hold < text.length) {
		return hold;
	}
	for (const marker of HOLD_MARKERS) {
		for (let len = Math.min(marker.length - 1, text.length); len > 0; len--) {
			if (text.endsWith(marker.slice(0, len))) {
				hold = Math.min(hold, text.length - len);
				break;
			}
		}
	}
	return hold;
}

function advertisedToolNames(params: LanguageModelV4CallOptions): Set<string> {
	const names = new Set<string>();
	if (params.toolChoice?.type === "none") {
		return names;
	}
	for (const tool of params.tools ?? []) {
		if (tool.type === "function") {
			names.add(tool.name);
		}
	}
	return names;
}

interface TextState {
	/** The upstream `text-start`, forwarded lazily with the first output. */
	start: Extract<LanguageModelV4StreamPart, { type: "text-start" }>;
	started: boolean;
	full: string;
	/** How much of `full` has been forwarded. */
	emitted: number;
	/** Once set, the rest of the part is held until the stream finishes. */
	holding: boolean;
	end?: Extract<LanguageModelV4StreamPart, { type: "text-end" }>;
}

type FinishPart = Extract<LanguageModelV4StreamPart, { type: "finish" }>;

export const textToolCallsMiddleware: LanguageModelV4Middleware = {
	specificationVersion: "v4",
	wrapStream: async ({ doStream, params }) => {
		const result = await doStream();
		const toolNames = advertisedToolNames(params);
		if (toolNames.size === 0) {
			return result;
		}

		const texts = new Map<string, TextState>();
		let sawNativeToolCall = false;
		let finalized = false;

		const emitText = (
			controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
			state: TextState,
			delta: string,
		) => {
			if (delta.length === 0) {
				return;
			}
			if (!state.started) {
				controller.enqueue(state.start);
				state.started = true;
			}
			controller.enqueue({ type: "text-delta", id: state.start.id, delta });
		};

		const finalize = (
			controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
			finish?: FinishPart,
		) => {
			finalized = true;
			const recovered: TextToolCall[] = [];
			for (const state of texts.values()) {
				let held = state.full.slice(state.emitted);
				if (state.holding && !sawNativeToolCall) {
					const extracted = extractTextToolCalls(held, toolNames);
					if (extracted.calls.length > 0) {
						recovered.push(...extracted.calls);
						const kept = state.full.slice(0, state.emitted);
						held = extracted.text;
						// Keep a paragraph break between released prose and
						// whatever survived the extraction.
						if (held && kept && !/\s$/.test(kept)) {
							held = `\n\n${held}`;
						}
					}
				}
				emitText(controller, state, held);
				if (state.started) {
					controller.enqueue(
						state.end ?? { type: "text-end", id: state.start.id },
					);
				}
			}
			for (const call of recovered) {
				controller.enqueue({
					type: "tool-call",
					toolCallId: `call_${nanoid()}`,
					toolName: call.toolName,
					input: JSON.stringify(call.input),
				});
			}
			if (finish) {
				controller.enqueue(
					recovered.length > 0
						? {
								...finish,
								finishReason: {
									unified: "tool-calls",
									raw: finish.finishReason.raw,
								},
							}
						: finish,
				);
			}
		};

		const stream = result.stream.pipeThrough(
			new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
				{
					transform(part, controller) {
						switch (part.type) {
							case "text-start": {
								texts.set(part.id, {
									start: part,
									started: false,
									full: "",
									emitted: 0,
									holding: false,
								});
								return;
							}
							case "text-delta": {
								const state = texts.get(part.id);
								if (!state) {
									controller.enqueue(part);
									return;
								}
								state.full += part.delta;
								if (state.holding) {
									return;
								}
								const hold = findHoldIndex(state.full);
								if (hold < state.full.length && hold >= state.emitted) {
									// A partial marker at the very end only delays
									// output; a complete marker starts holding.
									const rest = state.full.slice(hold);
									state.holding = HOLD_MARKERS.some((marker) =>
										rest.startsWith(marker),
									);
								}
								const upTo = Math.max(state.emitted, hold);
								emitText(
									controller,
									state,
									state.full.slice(state.emitted, upTo),
								);
								state.emitted = upTo;
								return;
							}
							case "text-end": {
								const state = texts.get(part.id);
								if (!state) {
									controller.enqueue(part);
									return;
								}
								if (state.holding) {
									state.end = part;
									return;
								}
								// Release a trailing partial marker that never
								// completed.
								emitText(controller, state, state.full.slice(state.emitted));
								state.emitted = state.full.length;
								if (state.started) {
									controller.enqueue(part);
								}
								texts.delete(part.id);
								return;
							}
							case "tool-call": {
								sawNativeToolCall = true;
								controller.enqueue(part);
								return;
							}
							case "finish": {
								finalize(controller, part);
								return;
							}
							default:
								controller.enqueue(part);
						}
					},
					flush(controller) {
						if (!finalized) {
							finalize(controller);
						}
					},
				},
			),
		);

		return { ...result, stream };
	},
};
