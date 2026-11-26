---
session: 01a212b0-9e03-76f8-b56a-acb0a348d400
name: agent-session-summary-layer
index: 1
date: 2026-11-25T12:31:34.404Z
agent: pi
model: z-ai/glm-5.3-flash
cost_usd: 0.22
---

**Project**: memory layer for agents, leveraging prior pawmc experience. First milestone: a session-summary layer — fully local, TypeScript, vitest integration tests, markdown output, pi-only for now with multi-agent support planned via adapters.

**Architecture** (project dir): pi JSONL v3 adapter → normalized transcript → input shaper → summarizer (pawmc-style prompt, OpenRouter, fetch-only for future Cloudflare Workers portability) → markdown writer; pure pipeline with a CLI entry and per-step debug dumps to an untracked debug folder. CLI: `tsx src/cli.ts <session.jsonl> [--debug] [--existing <file>]`, env-configured key/model.

**Confirmed decisions**:
- Summaries in `<project>/.memory/sessions/`; one summary per session for now.
- No prescribed summary structure — no goals/decisions/files/next-steps sections.
- with-tools mode dropped entirely: tool content is a privacy liability (initial A/B comparison was run; no-tools looked better to the eye). Possible future idea (parked): opt-in tool-context layer on top of the no-tools summary, separately stored.
- Minimal frontmatter: session, name, index, date, agent (`pi`), model, `cost_usd`. Session-level cost from pi's per-message `cost.total` (exact, not estimated), rounded up to 2 decimals. cwd removed for shareability; tokens iterated down and dropped entirely ("price is talking for itself anyway").
- Naming: `<index>-<slug>.md`, plain unpadded index (frontmatter index is the sort key), slug from the summarizer's `Name:` line (fallback: first user message). Re-runs reuse existing name/index — stable filenames.
- Git init with repo rules in `AGENTS.md`: regenerate the session summary immediately before every commit, include it in the commit; debug and inputs folders gitignored.
- Private-data filter in the summarizer prompt: never include usernames, home directories, absolute paths, hostnames, emails, keys/tokens — refer generically. Soft enforcement; deterministic post-check left as a future option.
- Shaped no-tools input written to `.memory/inputs/` (gitignored, separate folder from summaries) as a local transparency layer — chosen over tracked-with-redaction after the "timer bomb" concern; structural fix for sharing inputs deferred.

**State**: 23/23 tests, tsc clean. Gradual commits made; caught that the summary wasn't regenerated right before a commit — the amend landed on an already-pushed main, so the regenerated summary went to branch `docs/summary-regen-fix` for a PR. Rebased onto main (summary-file conflict resolved to the fresh version; duplicate ignore-rule changes collapsed). Branch force-pushed with lease to update the PR. Clarified `.memory/inputs/` was never committed — its ignore rule shipped on main; the folder stays local-only.

**Open**: whether raw inputs can ever be shared (structural privacy design), possible secret-pattern post-check, PR push/open remains manual per rules.
