---
updated: 2026-11-27T13:17:24.383Z
sessions: 1:1fa4bf8c:0.22, 2:2d9c9134:0.13, 3:7482d90b:0.02, 4:0a5e35cd:0.84
sessions_cost_usd: 1.21
---

Memory layer for AI agents (local-first POC), leveraging prior pawmc experience. Layers: session summaries + repo-wide memory. TypeScript, everything local for now; runtime likely moves to Cloudflare Workers later (fetch-only HTTP keeps the code portable). Works with pi now, more agents later via adapters. Vitest suite green (69 tests; integration tests use a fake LLM client).

Scope framing: new repos save memory on commit; existing repos get deterministic triage of all past sessions (searches, Q&A, dropped work) into save/skip before any summarizing.

Session-summary layer:
- Pipeline: pi JSONL (v3) session adapter → normalized transcript → input shaper → summarizer (pawmc-style prompt, OpenRouter, env-configured key/model, fetch-only) → markdown writer. CLI: `tsx src/cli.ts <session.jsonl> [--debug] [--existing <file>]`; debug dumps every step.
- Tree-awareness: pi session files are trees (`parentId`); the adapter resolves the active chain from the tip (fallback: all active if no id'd tip). Branched messages are marked, not dropped — excluded from summary input, counted separately in triage. Two fixes: an abandoned branch leaked into a regenerated summary as a wrong "planned but not built" line; and the chain walk must continue through non-message entries (custom messages, model changes), marking only messages as branched.
- One unstructured summary per session in `.memory/sessions/` — no fixed sections. Prompt: succinct/direct system instruction; user messages = confirmed intent; assistant content only if user-agreed; conservative about unconfirmed assumptions.
- Private-data filter (prompt-enforced): never include usernames, home dirs, absolute paths, hostnames, emails, keys/tokens — refer generically. Deterministic post-check deferred.
- Frontmatter: session, name, index, date, agent, model, `session_cost_usd` — session cost from exact per-message totals (don't double-count), rounded up to 2 decimals; no token/cache fields; cwd dropped for shareability.
- Filenames: `<index>-<slug>.md`; slug from the model's `Name:` line, fallback first user message; re-runs reuse existing index/name (index guarantees uniqueness — name-generation cost too minor to optimize).
- Input only, no tools — tools-in dropped as a privacy liability (A/B'd early; never reintroduce without resolving it). Parked idea: opt-in tool-context layer stored separately.
- Shaped input written every run to gitignored `.memory/inputs/`, paired by basename with the summary (transparency layer; treated as a privacy risk — structural fix for sharing deferred; folder never committed).
- Day-one privacy-audit/remote-setup session intentionally left unsummarized — never summarize its transcript. A day-one summary was regenerated to drop a stale "private-data filter pending" line and record the incident → regenerate-before-commit rule.

Scale & provider decisions (settled): zero-data-retention providers required (training-on-data ones disabled); batch APIs rejected — only data-training providers expose batching → plain unbatched flash-model calls (backfill used GLM 5.3 flash via OpenRouter, user-confirmed). Rust parser rewrite rejected: parsing ~1–2 ms/session, LLM calls dominate wall clock — the levers are concurrency and incremental skip.

Multi-agent discovery & backfill:
- Discovery: pi JSONL stores + opencode SQLite (read-only via node:sqlite; legacy and v2 tables, deduped) → shared normalized transcript. pi discovery reads the session header for `startedAt`; opencode `time_updated` is metadata, not last activity — triage window end comes from the last message; multi-day resumed opencode sessions are genuine, not a bug.
- Triage is fully deterministic (no LLM, no API key — user removed the LLM triage layer entirely); ambiguous defaults to skip; the only human-in-the-loop is editing the local review manifest, whose corrections flow into `decisions.tsv`. CLI: `--triage <repo> [--dry-run]`; dry-run prints stats, writes nothing.
- Heuristics: write-like vs read-only tool calls; bash mutations split content vs infra (installs, pulls, API calls, commit-only sessions = infra → skip); commit-window overlap where keep requires change evidence (closes a read-only session inheriting a sibling's commits, and vice versa); landed-later check — dropped work verified by whether later commits touched the same paths, not by timing; outside-repo edits and empty sessions skip; stderr-redirect (`2>/dev/null`, `2>&1`) false positives fixed. Git-log parser bug (NUL-separator quirk silently dropped ~75% of commits) fixed with a regression test against a real temp repo — these fixes cut the review bucket 29 → 2. Final split: 82 keep / 101 skip.
- Outputs: local-only `manifest.md` review file (snippets — private, never committed) plus committable `decisions.tsv` with opaque `agent:sessionId` keys — the durable historical opt-in record.
- Backfill (`--backfill`): concurrent summarization (5 at a time) of KEEP rows, per-session failure collection, skip-existing idempotency, one chained repo-memory update + AGENTS.md sync at the end. Target repo (personal-assistant project, developed on opencode before switching to pi): 33 pi + 222 opencode sessions → 183 after dedupe → 82 summaries, 0 failures, ~7 min, ~$0.12; reruns are true no-ops. Known quirk: a single-session rerun always spends an LLM call even when unchanged (hash-skip candidate).
- Auto-gitignore: managed `ensureGitignore` block on every write path ignores private artifacts (shaped inputs, debug dumps, triage manifest); decisions.tsv, sessions/, repo.md, AGENTS.md stay committable.
- DRY refactor: shared `writeSummaryArtifacts` (writer.ts) and `chainRepoMemory` (cli.ts); the concurrency `pool()` lives in backfill.

Repo-memory layer:
- Single `.memory/repo.md` summarizing all session summaries; no prescribed structure; previous version included as context; privacy rule applies verbatim plus "keep it succinct" (it feeds future agents' system prompts).
- Frontmatter: `updated` timestamp, cumulative `sessions_cost_usd`, `sessions:` map `<index>:<8-hex sha256>:<cost>`. Re-incorporation when a session's hash or recorded cost differs (missing repo.md → all unprocessed); never rerun all; unchanged state → clean no-op (zero LLM calls, no file write).
- `sessions_cost_usd` semantics (settled over three user-driven iterations): sum of the incorporated sessions' own `session_cost_usd`, not the cost of generating the summary; re-incorporation replaces a session's prior contribution. History: per-update round-up inflated the total ~10× (fixed by raw accumulation, 4-decimal storage); an interim ledger of all CLI LLM spend was reverted; both fields renamed (`sessions_cost_usd` repo-side, `session_cost_usd` session-side) to make semantics explicit — repo reader keeps a legacy fallback for `cost_usd`.
- Chained onto every session-summary run (two LLM calls); `--repo` / `npm run repo` for manual catch-up (reports "already up to date" on no-op); repo-update failure is a warning, not a command failure. No debug recording for this layer. Manual for now; GitHub automation likely later for both layers.

Agent-memory sync:
- repo.md auto-loads at session start with zero toolcalls, agent-agnostic (pi first). Confirmed approach: repo.md is the single source of truth; its content is injected into each agent's auto-loaded entry file — declarative files, no per-agent runtime code. Plain pointer (costs a toolcall) and per-agent hooks rejected.
- `src/agents.ts`: managed block in AGENTS.md between `memory-for-agents:begin/end` markers containing the repo.md body plus its `updated` timestamp (staleness check); idempotent in-place replacement, surrounding user content untouched, creates AGENTS.md if missing.
- Shims: `claude → CLAUDE.md`, `gemini → GEMINI.md`, each a one-line `@.memory/repo.md` native import (no duplication). Shim files lacking the `memory-for-agents:shim` marker are user-owned, never touched. `kind` field leaves room for future inline shims.
- `src/repo.ts` — `RepoMemory` exposes the `updated` timestamp.
- CLI: `--sync-agents [--agents claude,gemini]`, standalone and LLM-free; auto-chains at the end of every session-summary run and `--repo`, inside the non-fatal try/catch. Shims created only when named via `--agents`; existing shims refresh on every chain. All writes content-compared — unchanged state is a true no-op. `npm run sync-agents`. Verified live on this repo.

Rules (AGENTS.md): regenerate the session summary before each commit and include it; commit only summaries (debug artifacts, shaped inputs, triage manifest gitignored via the managed block); commit in logical steps; never reintroduce tools-in; memory is tool-owned — never hand-edit `.memory/` contents, regenerate via the CLI instead; PR push/open is manual per rules; never amend already-pushed commits — fix on a branch + PR, force-push with lease.

Pending:
- Target-repo artifacts (summaries, decisions.tsv, repo.md, AGENTS.md) uncommitted pending user review. Tool changes committed in logical steps on branch `multi-agent-backfill` off main — each layer self-contained, each with a regenerated summary + memory update; the sequence closed with regenerating the live session's summary and committing the memory update; PR/push is manual.
- Cost-field rename migration: session 2 regenerated and incorporated under the new field; session 1 still on legacy `cost_usd` (reader fallback covers it) — regenerate it to finish.
- Structural privacy design for ever sharing raw inputs; optional deterministic secret-pattern post-check.
