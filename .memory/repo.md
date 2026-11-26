---
updated: 2026-11-26T13:38:05.510Z
sessions: 1:1fa4bf8c:0.22, 2:9e80ad12:0.1
sessions_cost_usd: 0.32
---

Project: memory layer for AI agents (local-first POC), leveraging prior pawmc experience. Layers: session summaries + repo-wide memory. TypeScript, everything local for now; runtime likely moves to Cloudflare Workers later (fetch-only HTTP keeps the code portable). Works with pi now, more agents later via adapters. Vitest integration tests for major features/critical paths use a fake LLM client.

Session-summary layer:
- Pipeline: pi JSONL (v3) session adapter → normalized transcript → input shaper → summarizer (pawmc-style prompt, OpenRouter, env-configured key/model, fetch-only) → markdown writer. CLI: `tsx src/cli.ts <session.jsonl> [--debug] [--existing <file>]`. Debug mode dumps every step (transcript, input, prompt, LLM response).
- One unstructured summary per session in `.memory/sessions/` — no fixed sections. Prompt style: succinct/direct system instruction; user messages = confirmed intent; assistant content included only if user-agreed; conservative about unconfirmed assumptions.
- Private-data filter (implemented, prompt-enforced): never include usernames, home dirs, absolute paths, hostnames, emails, keys/tokens — refer generically. Deterministic post-check left as a possible future addition.
- Frontmatter: session, name, index, date, agent, model, cost_usd — session-level cost from exact per-message totals (don't double-count), rounded up to 2 decimals; no token/cache fields; cwd dropped for shareability.
- Filenames: `<index>-<slug>.md`, plain numeric index (frontmatter index is the sort key); slug from the model's `Name:` line, fallback first user message. Re-runs reuse existing index/name.
- Input only, no tools — tools-in dropped as a privacy liability (A/B'd early; no-tools preferred); never reintroduce without resolving it. Parked idea: opt-in tool-context layer stored separately.
- Shaped input written every run to gitignored `.memory/inputs/`, paired by basename with the summary (local transparency layer; treated as a privacy risk — structural fix for sharing deferred; folder never committed, ignore rule shipped on main).
- Day-one privacy-audit session intentionally left unsummarized — stays out of memory entirely; never summarize its transcript. A day-one session summary was regenerated to drop a stale "private-data filter pending" line (the filter is implemented) and record a summary-amend incident that produced the regenerate-before-commit rule.

Repo-memory layer:
- Single file `.memory/repo.md` summarizing all session summaries; no prescribed structure; previous version included as context; privacy rule applies verbatim plus "keep it succinct" (it feeds future agents' system prompts).
- Frontmatter: `updated` timestamp, cumulative `sessions_cost_usd`, `sessions:` map of index → 8-hex sha256 content hash. Only new/changed sessions are re-incorporated; never rerun all; a regenerated session with the same index is picked up via hash change; unchanged state → clean no-op, no file write.
- `sessions_cost_usd` semantics (user-corrected twice; field renamed to make the semantics explicit and prevent recurrence): sum of the incorporated sessions' own `cost_usd` values, not the cost of generating the summary. History: per-update round-up inflated the total ~10×; an interim ledger of all LLM-call spend was reverted. Migration re-incorporates sessions whose recorded cost is missing or doesn't match the session file.
- Chained onto every session-summary run (two LLM calls); `--repo` / `npm run repo` for manual catch-up, e.g. after hand-edited sessions (reports "already up to date" on no-op); repo-update failure is a warning, not a command failure. No debug recording for this layer. Manual for now; GitHub automation likely later for both layers.

Rules (AGENTS.md): regenerate the session summary before each commit and include it; commit only summaries (debug artifacts and inputs gitignored); commit in logical steps; never reintroduce tools-in; PR push/open is manual per rules; never amend already-pushed commits — fix on a branch + PR, force-push with lease.

Pending:
- Next feature: auto-load repo memory into new agent sessions with no extra toolcalls. Unconfirmed proposal: keep `.memory/repo.md` agent-neutral and generate an agent-specific system-prompt include from it via the same command on each repo update; plain pointer in agent instructions rejected (costs a toolcall); project extension was the other alternative — user has not chosen an approach.
- Sum-of-sessions migration: final step in progress at last handoff — regenerating session summaries so the chained repo update rebuilds the ledger under `sessions_cost_usd` (also fixes session 1's cost, which had stayed 0 because its hash matched); regenerated-summary commits and memory-file commits still pending.
- Structural privacy design for ever sharing raw inputs; optional deterministic secret-pattern post-check.
