---
session: 01a2181c-f8c7-76eb-9c83-5de74e65c2db
name: agent-agnostic-memory-auto-load
index: 3
date: 2026-11-26T13:48:01.607Z
agent: pi
model: z-ai/glm-5.3-flash
session_cost_usd: 0.02
---

Goal: load `.memory/repo.md` automatically at session start (no tool calls), in an agent-agnostic way — pi is the current target but coverage of other agents is planned.

Confirmed decisions (user): shims generated on demand; sync auto-chained. Approach: repo.md stays the single source of truth; content is injected into each agent's auto-loaded entry file, avoiding both tool calls and per-agent runtime code (per-agent extension/hook approach rejected in favor of declarative files).

Implementation:
- `src/agents.ts` — managed block in `AGENTS.md` between `memory-for-agents:begin/end` markers containing the repo.md body plus its `updated` timestamp (staleness check); idempotent in-place replacement, surrounding user content untouched, creates AGENTS.md if missing. Shim registry: `claude → CLAUDE.md`, `gemini → GEMINI.md`, each a one-line `@.memory/repo.md` native import (no duplication); shim files lacking the `memory-for-agents:shim` marker are user-owned and never touched; `kind` field leaves room for future inline shims.
- `src/repo.ts` — `RepoMemory` now exposes the `updated` timestamp.
- `src/cli.ts` — `--sync-agents [--agents claude,gemini]` standalone (LLM-free); auto-chain runs a sync at the end of every session-summary run and `--repo`, inside the existing non-fatal try/catch. Shims are created only when named via `--agents`; existing shims refresh on every chain. All writes content-compared, so unchanged state is a true no-op.
- `package.json` — `npm run sync-agents`.

Verified live on this repo: AGENTS.md carries the block after the standing rules; a test CLAUDE.md shim was created then deleted (on-demand policy); test suite green.

Note: repo.md's Pending section still marks the approach unconfirmed — self-corrects on the next summary run.

Next (user directive): commit gradually, after updating memory first.
