---
updated: 2026-11-26T14:14:06.745Z
sessions: 1:1fa4bf8c:0.22, 2:2d9c9134:0.13, 3:7482d90b:0.02
sessions_cost_usd: 0.37
---

Memory layer for AI agents (local-first POC), leveraging prior pawmc experience. Layers: session summaries + repo-wide memory. TypeScript, everything local for now; runtime likely moves to Cloudflare Workers later (fetch-only HTTP keeps the code portable). Works with pi now, more agents later via adapters. Vitest integration tests for major features/critical paths use a fake LLM client.

Session-summary layer:
- Pipeline: pi JSONL (v3) session adapter → normalized transcript → input shaper → summarizer (pawmc-style prompt, OpenRouter, env-configured key/model, fetch-only) → markdown writer. CLI: `tsx src/cli.ts <session.jsonl> [--debug] [--existing <file>]`. Debug mode dumps every step (transcript, input, prompt, LLM response).
- One unstructured summary per session in `.memory/sessions/` — no fixed sections. Prompt style: succinct/direct system instruction; user messages = confirmed intent; assistant content included only if user-agreed; conservative about unconfirmed assumptions.
- Private-data filter (implemented, prompt-enforced): never include usernames, home dirs, absolute paths, hostnames, emails, keys/tokens — refer generically. Deterministic post-check left as a possible future addition.
- Frontmatter: session, name, index, date, agent, model, `session_cost_usd` — session-level cost from exact per-message totals (don't double-count), rounded up to 2 decimals; no token/cache fields; cwd dropped for shareability.
- Filenames: `<index>-<slug>.md`, plain numeric index (frontmatter index is the sort key); slug from the model's `Name:` line, fallback first user message. Re-runs reuse existing index/name.
- Input only, no tools — tools-in dropped as a privacy liability (A/B'd early; no-tools preferred); never reintroduce without resolving it. Parked idea: opt-in tool-context layer stored separately.
- Shaped input written every run to gitignored `.memory/inputs/`, paired by basename with the summary (local transparency layer; treated as a privacy risk — structural fix for sharing deferred; folder never committed, ignore rule shipped on main).
- Day-one privacy-audit/remote-setup session intentionally left unsummarized — stays out of memory entirely; never summarize its transcript. A day-one session summary was regenerated to drop a stale "private-data filter pending" line (the filter is implemented) and record a summary-amend incident that produced the regenerate-before-commit rule.

Repo-memory layer:
- Single file `.memory/repo.md` summarizing all session summaries; no prescribed structure; previous version included as context; privacy rule applies verbatim plus "keep it succinct" (it feeds future agents' system prompts).
- Frontmatter: `updated` timestamp, cumulative `sessions_cost_usd`, `sessions:` map of `<index>:<8-hex sha256>:<cost>`. A session is re-incorporated when its hash or recorded cost differs from the record (missing repo.md → all unprocessed); never rerun all; unchanged state → clean no-op (zero LLM calls, no file write).
- `sessions_cost_usd` semantics (settled over three user-driven iterations): sum of the incorporated sessions' own `session_cost_usd` values, not the cost of generating the summary; re-incorporation replaces a session's prior contribution rather than re-adding it. History: per-update round-up inflated the total ~10× (fixed by raw accumulation, 4-decimal storage); an interim ledger of all CLI LLM spend was reverted; both cost fields were renamed (`sessions_cost_usd` repo-side, `session_cost_usd` session-side) to make the semantics explicit and prevent recurrence — repo reader keeps a legacy fallback for session files still on `cost_usd`.
- Chained onto every session-summary run (two LLM calls); `--repo` / `npm run repo` for manual catch-up, e.g. after hand-edited sessions (reports "already up to date" on no-op); repo-update failure is a warning, not a command failure. No debug recording for this layer. Manual for now; GitHub automation likely later for both layers.

Agent-memory sync:
- Goal: repo.md auto-loads at session start with zero toolcalls, agent-agnostic (pi first). Approach (confirmed): repo.md stays the single source of truth; its content is injected into each agent's auto-loaded entry file — declarative files, no per-agent runtime code. Plain pointer (costs a toolcall) and per-agent hooks were rejected.
- `src/agents.ts`: managed block in AGENTS.md between `memory-for-agents:begin/end` markers containing the repo.md body plus its `updated` timestamp (staleness check); idempotent in-place replacement, surrounding user content untouched, creates AGENTS.md if missing.
- Shims: `claude → CLAUDE.md`, `gemini → GEMINI.md`, each a one-line `@.memory/repo.md` native import (no duplication). Shim files lacking the `memory-for-agents:shim` marker are user-owned and never touched. `kind` field leaves room for future inline shims.
- `src/repo.ts` — `RepoMemory` exposes the `updated` timestamp.
- CLI: `--sync-agents [--agents claude,gemini]`, standalone and LLM-free; auto-chains at the end of every session-summary run and `--repo`, inside the existing non-fatal try/catch. Shims are created only when named via `--agents`; existing shims refresh on every chain. All writes content-compared — unchanged state is a true no-op. `npm run sync-agents`.
- Verified live on this repo: AGENTS.md carries the block after the standing rules.

Rules (AGENTS.md): regenerate the session summary before each commit and include it; commit only summaries (debug artifacts and inputs gitignored); commit in logical steps; never reintroduce tools-in; PR push/open is manual per rules; never amend already-pushed commits — fix on a branch + PR, force-push with lease.

Pending:
- Cost-field rename migration: session 2 regenerated and incorporated under the new field; session 1 still on legacy `cost_usd` (reader fallback covers it) — regenerate it to finish.
- Structural privacy design for ever sharing raw inputs; optional deterministic secret-pattern post-check.
