---
session: 01a21c69-86c1-76eb-9c83-5dede3aeae66
name: session-memory-triage-backfill
index: 4
date: 2026-11-27T09:50:07.553Z
agent: pi
model: z-ai/glm-5.3-flash
session_cost_usd: 0.84
---

**Settled questions.** Rust for parsing rejected: the real parser benchmarks at ~1–2 ms per typical session and LLM calls dominate wall clock by orders of magnitude; the real levers are LLM concurrency and skip-existing. Batching rejected: all OpenRouter batch providers for the flash model train on data (user's setup enforces zero-data-retention), so simple no-batch flash calls it is. Generating session names inside summaries judged still too minor to change (index guarantees uniqueness).

**Selection before backfill (user's framing).** New repos only save memory on commit; existing repos need triage of hundreds of sessions (searches, Q&A, dropped work) into save/skip before any summarizing.

**Built in this repo:**
- Multi-agent discovery + adapters: pi (jsonl) and opencode (SQLite read-only via node:sqlite; legacy + v2 tables, deduped) → shared normalized transcript.
- Deterministic triage (`--triage <repo> [--dry-run]`, zero LLM): read/write tool mix; commit-window overlap where keep requires change evidence (closes the user-identified false positive of a read-only session inheriting a sibling's commits); landed-later check (edits whose paths later commits touched → keep; never touched → "dropped work" skip); bash mutations split content vs infra (git pull/push/commit, installs, curl don't count; `2>/dev/null`/`2>&1` guards no longer false-positive); all-outside-repo edits → "another repo's memory" skip; empty sessions skip. Ambiguous defaults to skip — user removed the LLM triage layer entirely. `--dry-run` prints stats, writes nothing; `--triage` needs no API key.
- Artifacts: local reviewable `manifest.md` (snippets, never committed) + committable `decisions.tsv` (opaque keys) as the durable historical opt-in record; human flips rows by editing the manifest.
- Backfill (`--backfill`): concurrent summarization of KEEP rows, skip-existing idempotency, one chained repo-memory update + AGENTS.md sync at the end.
- Auto-gitignore (user request): managed `ensureGitignore` block on every write path; ignores `.memory/inputs/`, `.memory/debug/`, `.memory/triage/manifest.md`; `decisions.tsv`, `sessions/`, `repo.md`, `AGENTS.md` stay committable.
- DRY refactor (user request): shared `writeSummaryArtifacts` (writer.ts), `chainRepoMemory` (cli.ts); `pool()` lives in backfill. Known quirk: single-session reruns always spend an LLM call even when nothing changed.

**Results on the target repo** (183 sessions: 33 pi + 150 opencode after dedupe): verdicts tightened from 47/16/120 (draft) to 82 keep / 101 skip; backfill summarized 82 sessions, 0 failures, ~7 min at concurrency 5, ~$0.115 total; rerun is a true no-op. 69 tests green.

**Bugs fixed:** git log parsing silently dropped ~75% of commits (NUL-separator quirk; fixed + regression test against a real temp repo); pi discovery lacked `startedAt` (read session header at discovery); opencode `time_updated` is metadata, not last activity — window end now from the last message; multi-day resumed opencode sessions are genuine, not a bug.

**Tree-aware pi parsing (user's root-cause insight).** pi session files are trees; rewound branches stay in the JSONL and polluted summaries — a "planned but not built" line in a regenerated summary was faithfully read from an abandoned branch. Softer variant (user choice): `parsePiSession` resolves the active path via the `parentId` chain from the tip; off-path messages get `branched: true` — kept in transcript, excluded from summary input, counted separately in triage (`offPathToolCalls`, new `off` manifest column). Fixed during implementation: the chain walk must run through non-message entries (custom_message/model_change nodes); no-id tip falls back to all-active. A suspected keep→skip flip was a stale-manifest misread; verdicts unchanged (82/101).

**Rule added** (AGENTS.md standing rules, user-owned section): "Memory is tool-owned: never hand-edit `.memory/` contents; regenerate via the CLI instead." Regeneration replaces hand-edits as the correct mechanism.

**Git.** User asked for gradual commits on a new branch off main (`multi-agent-backfill`), each layer self-contained, each with a regenerated session summary + memory update per repo rules. Tree-awareness changes were committed; the closing step was regenerating the live session's summary and committing the memory update. One clarification: user briefly interrupted thinking regeneration targeted the fork repo — it targeted this repo's own session summary; the only target-repo touch that turn was a `--triage` verification run with identical verdicts.
