---
session: 01a212b0-9e03-76f8-b56a-acb0a348d400
name: agent-session-summary-layer
index: 1
date: 2026-11-25T12:31:34.404Z
agent: pi
model: z-ai/glm-5.3-flash
cost_usd: 0.13
---

Project: memory layer for agents (follow-on to pawmc). Current component: session-summary layer — local-first, TypeScript, integration tests for major features and critical paths, summaries saved as markdown. Reads pi sessions now; must support multiple popular agents later.

Built and smoke-tested on a live pi session: pi JSONL v3 adapter → normalized transcript → input shaper → summarizer (OpenRouter via env vars, fetch-only core so a future Cloudflare Workers move needs no rewrite) → markdown writer, plus CLI entry. Debug mode dumps every pipeline step (transcript, input, prompt, LLM response, name) to `.memory/debug/<sessionId>/`. Test suite green, tsc clean.

Summaries live in `<project>/.memory/sessions/` (user chose repo-local over central). Filenames: `<index>-<name>.md` — plain, non-padded numeric index (frontmatter `index` is the authoritative sort key) and a name the model derives via a `Name:` line in its output (slugified; fallback: first user-message words). Re-runs reuse a session's existing index/name. Whether re-runs should upgrade the name is an open question.

Prompt: pawmc-style update-by-incorporation. System instruction: "User values succinct and direct outputs without extra formatting, warnings, and politeness." Prioritize user messages (confirmed intent); include assistant content only if the user agreed. No fixed summary sections or format.

Metadata evolution per user decisions: cwd removed (sessions are meant to be shareable in repos — team or open source — so no private paths); cache read/write dropped as too much info; then tokens dropped entirely ("price is talking for itself") — cost_usd is the only spend field. Cost is session-level (not summary-level), summed from pi's per-message `cost.total` (exact, not estimated), rounded up to 2 decimals.

Tools decision: the original A/B plan (with-tools vs no-tools) is resolved — tools-in dropped completely as a liability (tool calls carry absolute paths, file contents, potential secrets). Only user+assistant text feeds the summarizer. User judged no-tools output clearly better to the eye; floated a future opt-in "additional context" layer (tool activity summarized on top of the no-tools summary, stored separately, possibly redacted or run on a local model) — undecided.

Git: initialized on `main`; only no-tools summaries tracked; `.memory/debug/` and any `*with-tools*` files gitignored. AGENTS.md repo rule: regenerate the current session's summary before committing, include it in the commit, never commit debug artifacts, never reintroduce tools-in without resolving the liability. Everything staged but uncommitted — awaiting user's go-ahead.
