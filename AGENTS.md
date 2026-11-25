# Memory rules

## Session summaries on commit

- Before committing, regenerate the summary for the current agentic session so the repo's memory stays current:
  `npx tsx src/cli.ts <session.jsonl>` (add `--debug` when reviewing pipeline steps).
- Include the regenerated summary file(s) under `.memory/sessions/` in the commit.
- If a session already has a summary, re-running the CLI reuses its index and name — never fork new files for the same session.

## Privacy

- Summaries must never contain private system info (paths, usernames, hostnames, secrets). Tool activity is excluded from summary input by design.
- `.memory/debug/` is never committed. There is no tools-in summary mode; do not reintroduce one without removing its privacy liability.
