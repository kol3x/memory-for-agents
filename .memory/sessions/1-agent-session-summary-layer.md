---
session: 01a212b0-9e03-76f8-b56a-acb0a348d400
name: agent-session-summary-layer
index: 1
date: 2026-11-25T12:31:34.404Z
agent: pi
model: z-ai/glm-5.3-flash
cost_usd: 0.17
---

- New project: memory layer for agents, building on experience from pawmc. First component: a session-summary layer.
- Constraints: everything local for now, TypeScript, integration tests for major features and critical paths, summaries saved as markdown, works with pi now and multiple popular agents later; runtime likely moving to Cloudflare Workers in the future.
- Architecture (built and accepted through iteration): pi session adapter → normalized transcript → input shaper → summarizer (OpenRouter, env-configured) → markdown writer, with a debug mode dumping every pipeline step (transcript, input, prompt, LLM response) for review.
- Summaries live in the project's `.memory/sessions/`; one summary per session for now.
- Summary format: deliberately unstructured — no goals/decisions/files/next-steps sections. Prompt follows the pawmc pattern: succinct/direct system instruction, user messages prioritized as confirmed intent, assistant content included only if user-agreed, conservative about unconfirmed assumptions.
- Original A/B plan (with-tools vs no-tools input) resolved: user preferred no-tools by eye and dropped tools-in completely — a liability. A possible opt-in "additional context" tool layer over the no-tools summary was discussed but deferred; structural answer postponed until the product needs it.
- Metadata evolution (user-driven trimming): agent name (Pi), session-level (not summary-level) spend, cost rounded up to 2 decimals, cwd removed entirely for privacy since sessions may be shared in repos (teams/open source). Cache read/write dropped, then total, then tokens dropped entirely — `cost_usd` alone. Final frontmatter: session, name, index, date, agent, model, cost_usd.
- Filenames: human-readable name derived from the summary itself (model emits a `Name:` line, slugified) with a plain numeric index prefix for sorting — no zero-padding. Re-runs reuse existing index/name.
- An early cost estimate double-counted (summed per-message cost components when a total existed); corrected to use per-message cost totals.
- Git initialized; only no-tools summaries tracked, debug artifacts gitignored. Repo rule (AGENTS.md): regenerate the session summary before each commit, include it in the commit, never commit debug artifacts, never reintroduce tools-in without resolving its liability. Committed gradually in logical steps.
- Shaped no-tools input is written on every run to a separate gitignored folder (`.memory/inputs/`) paired by basename with the summary — transparency stays local. Motivation: raw conversation text can contain private info (an assistant message once leaked a home-dir path), so the untracked input is treated as a "timer bomb" risk; structural fix deferred.
- Latest request (pending): add a private-data filter to the summarizer prompt.
