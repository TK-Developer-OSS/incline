#!/usr/bin/env python3
"""Audit an upstream (Cline) merge: list what the merge newly brought in that INCLINE must not ship.

Usage: scripts/audit-upstream-merge.py <old-ref> [<new-ref>]     (new-ref defaults to HEAD)
Compares source lines (docs, markdown, tests and lockfiles excluded) that match INCLINE's invariants and prints the ones that are
new in <new-ref> compared with <old-ref>. Exit code 1 when any new match exists, so it can gate a merge.
Invariants: no Cline cloud / account hosts (#33), no telemetry endpoint (#34), data dir ~/.incline (#35),
Incline identity in User-Agent / originator / X-Title (#32), no cloud sessions (#107).
"""
import collections
import re
import subprocess
import sys

PATTERNS = {
    "cline.bot hosts (cloud / account / telemetry) [#33 #34]": r"(api|app|data|docs)\.cline\.bot|https?://cline\.bot",
    "Cline identity in headers [#32]": r"\"User-Agent\":\s*[`\"']Cline|originator:\s*\"cline\"|\"X-Title\":\s*\"Cline\"|HTTP-Referer\":\s*\"https://cline",
    "~/.cline data directory [#35]": r"[\"'`]~/\.cline[/\"'`]|\.cline/data/(settings|db|globalState)",
    "cloud sessions [#107]": r"CLINE_CLOUD_SESSIONS|cloudSessionsEnabled|isCloudSessionsFeatureEnabled",
    "telemetry client keys [#34]": r"TELEMETRY_SERVICE_API_KEY|phc_[A-Za-z0-9]{20,}",
}
EXCLUDE = [":!docs", ":!*.md", ":!*.test.*", ":!*.spec.*", ":!bun.lock", ":!package-lock.json", ":!apps/examples", ":!.github____"]


def grep(ref, pattern):
    out = subprocess.run(["git", "grep", "-n", "-I", "-E", pattern, ref, "--", "."] + EXCLUDE, capture_output=True, text=True).stdout
    lines = set()
    for line in out.split("\n"):
        if not line:
            continue
        # strip "<ref>:" and the line number so a moved line is not reported as new
        lines.add(re.sub(r"^[^:]+:([^:]+):\d+:", r"\1:", line))
    return lines


def main():
    old = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
    new = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    found = 0
    for name, pattern in PATTERNS.items():
        added = sorted(grep(new, pattern) - grep(old, pattern))
        print(f"## {name}: {len(added)} new")
        by_file = collections.Counter(a.split(":")[0] for a in added)
        for f, c in by_file.most_common(12):
            print(f"   {c:3d}  {f}")
        found += len(added)
    print(f"\nTOTAL new matches: {found}")
    sys.exit(1 if found else 0)


main()
