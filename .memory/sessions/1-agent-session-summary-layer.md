---
session: 01a212b0-9e03-76f8-b56a-acb0a348d400
name: agent-session-summary-layer
index: 1
date: 2026-11-25T12:31:34.404Z
agent: pi
model: z-ai/glm-5.3-flash
cost_usd: 0.19
---

New project: a memory layer for agents, building on prior pawmc experience. First milestone: a session-summary layer — fully local, TypeScript, integration tests for major features and critical paths, markdown summaries. Reads pi sessions now; multi-agent support later via per-agent adapters.

Architecture: pi JSONL adapter → normalized transcript → input shaper → LLM summarizer (OpenRouter) → markdown writer, built as a pure pipeline that records every step. CLI with a `--debug` flag dumping each step (transcript, input, prompt, LLM response) for review; `--existing` feeds a prior summary back in for updates. Core is fetch-only so a future Cloudflare Workers move needs no pipeline rewrite.

User-confirmed decisions:
- Summaries live in `<project>/.memory/sessions/`; one summary per session for now.
- No fixed summary format — no goals/decisions/files/next-steps sections. Prompt is pawmc-style: prioritize user messages as confirmed intent; be conservative with assistant claims.
- Tools-in input mode dropped entirely — a liability (tool calls can leak paths/secrets to a cloud LLM). Only user/assistant text is summarized. Early A/B comparison favored no-tools visually.
- Frontmatter: session id, name, index, date, agent, model, cost_usd. cwd removed for privacy (sessions may be repo-shared later); token counts also dropped — cost suffices. Cost rounds up to 2 decimals; session-level spend comes from pi's per-message usage records (an initial estimate double-counted cache — real cost ~$0.10, not $57).
- Filename `<index>-<slug>.md`: plain unpadded index, stable per session across re-runs; slug derives from a `Name:` line the summarizer emits, not the first user-message words.
- Shaped no-tools input is a first-class pipeline output written to `.memory/inputs/` (same basename as the summary, separate folder, gitignored) — transparency without leak risk; raw input deemed a "time bomb" after an assistant message itself leaked a home-dir path. Structural fix deferred until product needs it.
- Private-data filter added to the summarizer prompt: never include usernames, home directories, absolute paths, hostnames, email addresses, API keys, tokens, or other secrets — refer to them generically ("the project dir", "the auth config"). Prompt-side only (soft enforcement); a deterministic post-check was discussed but not built.

Git initialized on main, nothing pushed. AGENTS.md repo rule: regenerate the current session's summary before each commit and include it; never commit debug artifacts or the inputs folder; never reintroduce tools-in without resolving its liability. `.memory/debug/` and `.memory/inputs/` are gitignored.

Status: 23/23 tests passing, tsc clean, smoke-tested live against the development session itself. Commits so far: scaffold, pi adapter + pipeline, repo rules/ignores, inputs-alongside-summary, private-data filter, summary docs.

Latest: user caught a rule violation — the last commit batch shipped a stale summary that wasn't regenerated before committing. Fix in progress: regenerate the summary and amend the docs commit.
