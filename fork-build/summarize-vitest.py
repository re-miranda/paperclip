#!/usr/bin/env python3
"""Gambiarra, MIR-2027. Turns a vitest log into passed/failed/skipped counts and failing test names.

Usage: summarize-vitest.py <log-file> <title>   (appends Markdown to $GITHUB_STEP_SUMMARY, prints it too)
test:run can start several vitest processes, so every "Tests" summary line is added up.
"""
import os
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;]*m")
COUNT = re.compile(r"(\d+) (failed|passed|skipped|todo)")


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return [ANSI.sub("", line.rstrip("\n")) for line in handle]


def tally(lines: list[str]) -> tuple[dict[str, int], int]:
    totals = {"passed": 0, "failed": 0, "skipped": 0, "todo": 0}
    summaries = 0
    for line in lines:
        if not re.match(r"\s*Tests\s", line):
            continue
        summaries += 1
        for number, kind in COUNT.findall(line):
            totals[kind] += int(number)
    return totals, summaries


def failing_names(lines: list[str]) -> list[str]:
    names = [line.strip()[len("FAIL"):].strip() for line in lines if re.match(r"\s*FAIL\s", line)]
    return sorted(set(names))


def render(title: str, lines: list[str]) -> str:
    totals, summaries = tally(lines)
    out = [f"## {title}", ""]
    if summaries == 0:
        out.append("**No vitest summary line found**: the run ended early (timeout, crash or setup failure). Counts below are not available.")
    else:
        out.append(f"passed {totals['passed']}, failed {totals['failed']}, skipped {totals['skipped']}, todo {totals['todo']} ({summaries} vitest summary line(s))")
    names = failing_names(lines)
    out += ["", f"Failing tests ({len(names)}):"] + [f"- `{name}`" for name in names]
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: summarize-vitest.py <log-file> <title>; got {argv[1:]}", file=sys.stderr)
        return 2
    if not os.path.exists(argv[1]):
        print(f"log file '{argv[1]}' does not exist; the phase did not start", file=sys.stderr)
        return 2
    text = render(argv[2], read_lines(argv[1]))
    print(text)
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
