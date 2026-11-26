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
 */

export interface RepoMemory {
  body: string;
  /** index → content hash of the session summary at last incorporation */
  sessions: Map<number, string>;
  /** cumulative raw spend across all updates (not per-update rounded) */
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
  const sessionsLine = fm.match(/^sessions: (.+)$/m)?.[1];
  const costLine = fm.match(/^cost_usd: (.+)$/m)?.[1];
  const sessions = new Map<number, string>();
  if (sessionsLine) {
    for (const entry of sessionsLine.split(",")) {
      const e = entry.match(/^\s*(\d+):([0-9a-f]+)\s*$/);
      if (e) sessions.set(Number(e[1]), e[2]);
    }
  }
  return {
    body: m[2].trim(),
    sessions,
    costUsd: costLine ? Number(costLine) || 0 : 0,
  };
}

export interface SessionBody {
  index: number;
  hash: string;
  body: string;
}

/** All session summaries, index-sorted, frontmatter stripped, with content hash. */
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
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (body) out.push({ index: Number(m[1]), hash: hashSession(content), body });
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
  fm: { updated: string; sessions: [number, string][]; cost_usd: number },
  body: string,
): string {
  const lines = [
    "---",
    `updated: ${fm.updated}`,
    `sessions: ${fm.sessions.map(([i, h]) => `${i}:${h}`).join(", ")}`,
    `cost_usd: ${fm.cost_usd}`,
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
  const changed = all.filter((s) => existing?.sessions.get(s.index) !== s.hash);
  if (changed.length === 0) return null;

  const prompt = buildRepoPrompt({
    existingBody: existing?.body,
    sessions: changed.map((s) => s.body),
  });
  const res = await opts.llm({ system: prompt.system, user: prompt.user });

  // accumulate raw cost — per-update round-up would inflate a running total
  // (each sub-cent update becomes a whole cent). Store 4 decimals: drift-free
  // at sub-cent scale, still human-readable.
  const prevCost = existing?.costUsd ?? 0;
  const thisCost = res.usage?.cost ?? 0;
  const merged = new Map(existing?.sessions ?? []);
  for (const s of changed) merged.set(s.index, s.hash);
  const md = renderRepoMemory(
    {
      updated: new Date().toISOString(),
      sessions: [...merged.entries()].sort((a, b) => a[0] - b[0]),
      cost_usd: round4(prevCost + thisCost),
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

/** Round to 4 decimal places (sub-cent precision for a running total). */
function round4(costUsd: number): number {
  return Number(costUsd.toFixed(4));
}
