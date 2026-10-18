#!/usr/bin/env python3
"""Probe how an Ollama model answers tool-using requests, and save the raw
replies as fixtures for the TypeScript text tool-call parser.

Small local models (qwen2.5-coder:7b is the motivating case) often write tool
calls as JSON in the reply text instead of using the chat template's
<tool_call> form, so Ollama returns them as plain `content` with no
`tool_calls`. INCLINE recovers those in
`src/providers/middleware/text-tool-calls.ts`.

This script only captures and summarises. The authoritative check runs the
real TypeScript parser over the saved captures:

    bun run test -- src/providers/middleware/text-tool-calls.captures.test.ts

Standard library only (Python 3.8+), so it runs on any machine that can reach
the Ollama server.

Usage:
    python3 scripts/ollama-tool-probe.py
    python3 scripts/ollama-tool-probe.py --host http://192.168.137.1:11434 \
        --model qwen2.5-coder:7b-instruct-q6_K --runs 3
"""

import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_HOST = "http://192.168.137.1:11434"
DEFAULT_MODEL = "qwen2.5-coder:7b-instruct-q6_K"
DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "src",
    "providers",
    "middleware",
    "__fixtures__",
    "ollama-captures",
)

# Trimmed copies of INCLINE's built-in tool schemas
# (sdk/packages/core/src/extensions/tools/schemas.ts).
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "editor",
            "description": (
                "Edit a text file by replacing old_text with new_text, create "
                "the file with new_text if it does not exist, or insert "
                "new_text at insert_line when insert_line is provided."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The absolute path for the action to be performed on",
                    },
                    "old_text": {
                        "type": ["string", "null"],
                        "description": "Exact text to replace (must match exactly once). Omit when creating a file.",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "The new content, or the replacement text for edits.",
                    },
                    "insert_line": {"type": ["integer", "null"]},
                },
                "required": ["path", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_files",
            "description": "Read the content of one or more text files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "start_line": {"type": ["integer", "null"]},
                                "end_line": {"type": ["integer", "null"]},
                            },
                            "required": ["path"],
                        },
                    }
                },
                "required": ["files"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_commands",
            "description": "Run non-interactive shell commands.",
            "parameters": {
                "type": "object",
                "properties": {
                    "commands": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of complete shell command strings to execute.",
                    }
                },
                "required": ["commands"],
            },
        },
    },
]
TOOL_NAMES = {tool["function"]["name"] for tool in TOOLS}

SYSTEM_PROMPT = (
    "You are INCLINE, a coding agent working in /home/user/test. "
    "Use the provided tools to read files, edit files and run commands. "
    "Paths must be absolute."
)

# (id, prompt, whether a tool call is expected)
CASES = [
    ("write-file", "TypeScriptのHello Worldを hello.ts に保存して", True),
    ("read-file", "/home/user/test/package.json の中身を確認して", True),
    ("run-command", "カレントディレクトリのファイル一覧を見せて", True),
    ("edit-file", "/home/user/test/hello.ts の 'Hello' を 'Hi' に置き換えて", True),
    ("no-tool", "TypeScript の interface と type の違いを3行で説明して", False),
]


def chat(host, model, prompt, num_ctx, timeout):
    body = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "tools": TOOLS,
        "options": {"num_ctx": num_ctx},
    }
    request = urllib.request.Request(
        host.rstrip("/") + "/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def text_json_tool_names(content):
    """Rough preview only: names of advertised tools found in JSON values of
    `content`. The TypeScript parser is the real judge."""
    decoder = json.JSONDecoder()
    found = []
    index = 0
    while index < len(content):
        if content[index] not in "{[":
            index += 1
            continue
        try:
            value, end = decoder.raw_decode(content, index)
        except ValueError:
            index += 1
            continue
        stack = [value]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                for key in ("name", "tool", "tool_name", "toolName"):
                    if item.get(key) in TOOL_NAMES:
                        found.append(item[key])
                for key in ("function", "tool_calls"):
                    if key in item:
                        stack.append(item[key])
        index = end
    return found


def classify(capture):
    if capture["native_tool_calls"]:
        return "native"
    if text_json_tool_names(capture["content"]):
        return "text-json"
    if re.search(r"<tool_call>|\"name\"\s*:", capture["content"]):
        return "text-unparsed"
    return "text-only"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--runs", type=int, default=1, help="runs per case")
    parser.add_argument("--num-ctx", type=int, default=32768)
    parser.add_argument("--timeout", type=int, default=600, help="seconds per request")
    parser.add_argument("--out", default=DEFAULT_OUT, help="capture directory")
    parser.add_argument("--no-save", action="store_true", help="print only")
    args = parser.parse_args()

    try:
        urllib.request.urlopen(args.host.rstrip("/") + "/api/tags", timeout=10).read()
    except (urllib.error.URLError, OSError) as error:
        print("Ollama に接続できません: %s (%s)" % (args.host, error), file=sys.stderr)
        return 2

    if not args.no_save:
        os.makedirs(args.out, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    model_slug = re.sub(r"[^A-Za-z0-9.-]+", "_", args.model)
    rows = []
    for case_id, prompt, expect_tool in CASES:
        for run in range(1, args.runs + 1):
            print("-> %s #%d ..." % (case_id, run), end=" ", flush=True)
            try:
                reply = chat(args.host, args.model, prompt, args.num_ctx, args.timeout)
            except (urllib.error.URLError, OSError, ValueError) as error:
                print("ERROR %s" % error)
                rows.append((case_id, run, "error", str(error)[:60]))
                continue
            message = reply.get("message", {})
            capture = {
                "model": args.model,
                "case": case_id,
                "prompt": prompt,
                "expect_tool_call": expect_tool,
                "tool_names": sorted(TOOL_NAMES),
                "content": message.get("content", ""),
                "native_tool_calls": message.get("tool_calls") or [],
                "done_reason": reply.get("done_reason"),
                "captured_at": stamp,
            }
            kind = classify(capture)
            print(kind)
            rows.append((case_id, run, kind, capture["content"][:60].replace("\n", " ")))
            if not args.no_save:
                name = "%s-%s-%s-%d.json" % (model_slug, case_id, stamp, run)
                with open(os.path.join(args.out, name), "w", encoding="utf-8") as fh:
                    json.dump(capture, fh, ensure_ascii=False, indent=2)
                    fh.write("\n")

    print()
    print("%-12s %-4s %-14s %s" % ("case", "run", "kind", "content (head)"))
    for case_id, run, kind, head in rows:
        print("%-12s %-4d %-14s %s" % (case_id, run, kind, head))
    print()
    print("native        : Ollama が tool_calls として返した (変換不要)")
    print("text-json     : 本文に JSON で書いた (INCLINE のミドルウェアが変換する対象)")
    print("text-unparsed : ツール呼び出しらしいが JSON として読めない (要調査)")
    print("text-only     : ツールを呼んでいない")
    if not args.no_save:
        print()
        print("保存先: %s" % os.path.normpath(args.out))
        print("TS パーサでの判定: bun run test -- src/providers/middleware/text-tool-calls.captures.test.ts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
