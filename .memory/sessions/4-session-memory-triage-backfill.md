---
session: 01a21c69-86c1-76eb-9c83-5dede3aeae66
name: session-memory-triage-backfill
index: 4
date: 2026-11-27T09:50:07.553Z
agent: pi
model: z-ai/glm-5.3-flash
session_cost_usd: 0.55
---

Worked on the memory-for-agents tooling, which summarizes agent coding sessions into per-repo memory (session summaries + shaped inputs, a chained repo-memory update, AGENTS.md sync).

Decisions from the scale discussion: a Rust rewrite of the JSON parser was rejected — parsing measures in milliseconds per session while LLM calls dominate wall clock, so parallelism is the lever, not parser speed. Batch APIs were rejected because the user requires zero-data-retention providers (training-on-data ones are disabled) and only those providers expose batching; settled on plain GLM 5.3 flash, unbatched. Session-name generation cost judged too minor to optimize.

Multi-agent discovery added: pi jsonl stores plus opencode's SQLite store (legacy and v2 tables, deduped). The target repo (a personal-assistant project) has 33 pi and 222 opencode sessions — 183 after dedupe.

Triage was built and then tightened per user direction: sessions with no changes are skipped (with a bash-mutation carve-out); "dropped work" is verified by whether the changes later landed in main rather than by timing; keep-by-commits requires change evidence, closing the parallel-session false positive the user identified. A git log parsing bug that silently dropped ~75% of commits (record-separator quirk) was fixed with a regression test. The land-check is deterministic file-path overlap: a session's edited file paths (extracted from edit/write tool arguments, repo-relative) checked against later commits touching the same files. The review bucket was cut 29 → 2 without LLMs by fixing stderr-redirect false positives, splitting content vs. infra mutations (installs, pulls, API calls, commit-only sessions), and treating outside-repo edits as skips. The user then defaulted the remaining ambiguous rows to skip and removed the LLM triage layer entirely: triage is now fully deterministic, needs no API key, and --dry-run just prints stats and writes nothing. Final split: 82 keep / 101 skip.

Backfill built on request: concurrent summarization (5 at a time) of KEEP rows, skip-existing idempotency, one chained repo-memory update + AGENTS.md sync at the end. Full run: 82 summaries, 0 failures, ~7 minutes, ~$0.12; reruns are no-ops.

Auto-gitignore added per user request: a managed block ignores private artifacts (shaped inputs, debug dumps, triage manifest) while decisions.tsv, sessions/, repo.md, and AGENTS.md stay committable; ensured on every write path.

DRY refactor per user: shared summary-artifact writer and chained-repo-update helper; the concurrency pool moved into the backfill module. Test suite at 63, green.

Target-repo artifacts remain uncommitted pending user review. Per user instruction, tool changes are being committed gradually in logical steps on a new branch off main (multi-agent-backfill), including regenerating this session's own summary per the repo's memory rules; the commit sequence was still in progress at session end.
