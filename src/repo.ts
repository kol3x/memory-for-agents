import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LlmClient } from "./summarizer.js";
import { DEFAULT_SYSTEM_INSTRUCTION } from "./summarizer.js";
import { sessionsDir } from "./writer.js";

/**
 * Repo-layer memory: one file (<cwd>/.memory/repo.md) summarizing all session
 * summaries. Updated on every session-summary run: any session whose content
 * changed since the last repo update is re-incorporated, with the previous
 * repo memory as context. No prescribed structure; the model decides the
 * shape. Loaded verbatim into future agents' system prompts (via
 * agent-specific shims), so it must stay succinct and private.
 *
 * sessions_cost_usd is the sum of the incorporated sessions' own
 * session_cost_usd values — the cost of the work the sessions did, not the
 * cost of making the memory (naming is deliberate: the field was misread as
 * "cost of generating the repo memory" twice). A re-incorporated session
 * replaces its previous contribution.
 */

export interface SessionRef {
  hash: string;
  /** cost_usd as written in the session summary (rounded to 2 decimals);
   *  undefined marks a legacy entry predating per-session costs */
  cost?: number;
}

export interface RepoMemory {
  body: string;
  /** updated timestamp from the frontmatter (used for shim staleness) */
  updated?: string;
  /** index → session reference at last incorporation */
  sessions: Map<number, SessionRef>;
  /** sum of the incorporated sessions' session_cost_usd */
  costUsd: number;
}

export function repoMemoryPath(cwd: string): string {
  return join(cwd, ".memory", "repo.md");
}

/** Short content hash identifying a version of a session summary. */
export function hashSession(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

export function readRepoMemory(cwd: string): RepoMemory | null {
  const path = repoMemoryPath(cwd);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: content.trim(), sessions: new Map(), costUsd: 0 };
  const fm = m[1];
  const updatedLine = fm.match(/^updated: (.+)$/m)?.[1];
  const sessionsLine = fm.match(/^sessions: (.+)$/m)?.[1];
  const costLine = fm.match(/^sessions_cost_usd: (.+)$/m)?.[1];
  const sessions = new Map<number, SessionRef>();
  if (sessionsLine) {
    for (const entry of sessionsLine.split(",")) {
      const e = entry.match(/^\s*(\d+):([0-9a-f]+)(?::(\d+(?:\.\d+)?))?\s*$/);
      if (e)
        sessions.set(Number(e[1]), {
          hash: e[2],
          cost: e[3] === undefined ? undefined : Number(e[3]),
        });
    }
  }
  return {
    body: m[2].trim(),
    updated: updatedLine,
    sessions,
    costUsd: costLine ? Number(costLine) || 0 : 0,
  };
}

export interface SessionBody {
  index: number;
  hash: string;
  /** session_cost_usd from the session summary frontmatter */
  cost: number;
  body: string;
}

/** All session summaries, index-sorted, frontmatter stripped, with hash + cost. */
export function collectSessionBodies(cwd: string): SessionBody[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: SessionBody[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = file.match(/^(\d+)-(.+)\.md$/);
    if (!m) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    // session_cost_usd, falling back to the pre-rename cost_usd field
    const cost =
      Number(fm.match(/^session_cost_usd: (.+)$/m)?.[1] ?? fm.match(/^cost_usd: (.+)$/m)?.[1] ?? 0) || 0;
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (body) out.push({ index: Number(m[1]), hash: hashSession(content), cost, body });
  }
  return out;
}

export interface RepoPromptInput {
  /** previous repo memory body, if one exists */
  existingBody?: string;
  /** bodies of not-yet-incorporated session summaries */
  sessions: string[];
}

export function buildRepoPrompt(input: RepoPromptInput): { system: string; user: string } {
  const parts: (string | null)[] = [
    input.existingBody ? `Existing repository memory: ${input.existingBody}` : null,
    [
      "Update the repository memory by incorporating the following session summaries.",
      "The repository memory is loaded into the system prompt of future agent sessions in this repo, so keep it succinct.",
      "When older and newer information conflict, prefer the newer sessions.",
      "Be conservative — avoid adding unconfirmed assumptions.",
      "Never include private data in the memory: usernames, home directories, absolute paths, hostnames, email addresses, API keys, tokens, or other secrets. Refer to such things generically (e.g. \"the project dir\", \"the auth config\").",
      "Output only the updated repository memory — no preamble, no commentary.",
    ].join(" "),
    "Session summaries:",
    input.sessions.join("\n\n"),
  ];
  return {
    system: DEFAULT_SYSTEM_INSTRUCTION,
    user: parts.filter((p) => p !== null).join("\n\n"),
  };
}

export function renderRepoMemory(
  fm: { updated: string; sessions: [number, SessionRef][]; sessions_cost_usd: number },
  body: string,
): string {
  const lines = [
    "---",
    `updated: ${fm.updated}`,
    `sessions: ${fm.sessions.map(([i, r]) => `${i}:${r.hash}:${r.cost ?? 0}`).join(", ")}`,
    `sessions_cost_usd: ${fm.sessions_cost_usd}`,
    "---",
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

export interface RepoUpdateResult {
  /** sessions incorporated in this update */
  included: SessionBody[];
  /** captured user prompt (for tests / review) */
  prompt: string;
  response: string;
}

/**
 * Incorporate every changed session summary into the repo memory and write it
 * back. Returns null when nothing has changed since the last update.
 */
export async function updateRepoMemory(opts: {
  cwd: string;
  llm: LlmClient;
}): Promise<RepoUpdateResult | null> {
  const existing = readRepoMemory(opts.cwd);
  const all = collectSessionBodies(opts.cwd);
  // changed = content hash drifted, or the recorded cost no longer matches
  // the session file (also catches legacy entries without a recorded cost)
  const changed = all.filter((s) => {
    const rec = existing?.sessions.get(s.index);
    return rec?.hash !== s.hash || rec?.cost !== s.cost;
  });
  if (changed.length === 0) return null;

  const prompt = buildRepoPrompt({
    existingBody: existing?.body,
    sessions: changed.map((s) => s.body),
  });
  const res = await opts.llm({ system: prompt.system, user: prompt.user });

  // sessions ledger: changed sessions replace their previous entry; cost is
  // the sum of the incorporated sessions' own session_cost_usd (never re-added)
  const merged = new Map<number, SessionRef>(existing?.sessions ?? []);
  for (const s of changed) merged.set(s.index, { hash: s.hash, cost: s.cost });
  const total = [...merged.values()].reduce((acc, r) => acc + (r.cost ?? 0), 0);
  const md = renderRepoMemory(
    {
      updated: new Date().toISOString(),
      sessions: [...merged.entries()].sort((a, b) => a[0] - b[0]),
      sessions_cost_usd: Number(total.toFixed(2)),
    },
    res.text,
  );
  writeFileSync(repoMemoryPath(opts.cwd), md);

  return {
    included: changed,
    prompt: prompt.user,
    response: res.text,
  };
}
