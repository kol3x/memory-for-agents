import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRepoMemory } from "./repo.js";

/**
 * Agent entry-point sync: makes the repo-layer memory load automatically into
 * new agent sessions with zero toolcalls, without coupling the memory itself
 * to any agent.
 *
 * Two mechanisms, chosen per agent:
 * - Managed block (inline): agents that auto-load AGENTS.md (pi, Codex,
 *   Cursor, ...) get the repo memory body injected into a delimited block.
 *   The block is the only part of AGENTS.md this tool ever writes; user
 *   content around it is preserved.
 * - Import shim (on demand): agents with a different entry file but native
 *   file-import syntax (Claude Code CLAUDE.md, Gemini CLI GEMINI.md) get a
 *   one-line shim that imports .memory/repo.md. Created only when explicitly
 *   requested (--agents ...), but kept fresh by auto-chain once they exist.
 *
 * The generated artifacts are identified by marker comments. A shim file that
 * exists without our marker is user-owned and never touched. Every write is
 * content-compared first, so auto-chaining is a cheap no-op when nothing
 * changed.
 */

export const BLOCK_BEGIN = "<!-- memory-for-agents:begin";
export const BLOCK_END = "<!-- memory-for-agents:end -->";

const BLOCK_STRIP = /<!-- memory-for-agents:begin[\s\S]*?<!-- memory-for-agents:end -->\n?/g;

export interface AgentShim {
  id: string;
  /** entry file, relative to cwd */
  file: string;
  kind: "import" | "inline";
  /** import-kind shims: the literal file-reference line */
  line: string;
}

export const AGENT_SHIMS: AgentShim[] = [
  { id: "claude", file: "CLAUDE.md", kind: "import", line: "@.memory/repo.md" },
  { id: "gemini", file: "GEMINI.md", kind: "import", line: "@.memory/repo.md" },
];

const SHIM_MARKER = (id: string) =>
  `<!-- memory-for-agents:shim agent=${id} (generated — do not edit; delete to remove) -->`;

/** Rendered managed block for the repo memory body. */
export function renderBlock(body: string, updated: string): string {
  return [
    `${BLOCK_BEGIN} (generated from .memory/repo.md — do not edit; updated: ${updated}) -->`,
    body,
    BLOCK_END,
    "",
  ].join("\n");
}

/** Content for a generated shim file. */
export function renderShim(shim: AgentShim, block: string): string {
  if (shim.kind === "import") return `${SHIM_MARKER(shim.id)}\n${shim.line}\n`;
  return `${SHIM_MARKER(shim.id)}\n${block}`;
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return false;
  writeFileSync(path, content);
  return true;
}

export interface SyncAgentsResult {
  /** AGENTS.md outcome */
  agentsMd: "updated" | "created" | "unchanged";
  shimsCreated: string[];
  shimsRefreshed: string[];
  /** user-owned shim files left untouched */
  shimsSkipped: string[];
}

/**
 * Sync agent entry points with the current repo memory. create lists shim
 * agent ids to generate if missing; existing shims are always refreshed,
 * non-shim files never touched. No-op when there is no repo memory yet.
 */
export function syncAgents(cwd: string, create: string[] = []): SyncAgentsResult | null {
  const repo = readRepoMemory(cwd);
  if (!repo || !repo.body) return null;

  const block = renderBlock(repo.body, repo.updated ?? "");
  const result: SyncAgentsResult = {
    agentsMd: "unchanged",
    shimsCreated: [],
    shimsRefreshed: [],
    shimsSkipped: [],
  };

  // managed block in AGENTS.md — replace in place, or append at the end
  const agentsPath = join(cwd, "AGENTS.md");
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : null;
  const next = existing === null ? block : existing.replace(BLOCK_STRIP, "") + block;
  const agentsMd: SyncAgentsResult["agentsMd"] =
    existing === null ? "created" : existing === next ? "unchanged" : "updated";
  if (agentsMd !== "unchanged") writeFileSync(agentsPath, next);
  result.agentsMd = agentsMd;

  for (const shim of AGENT_SHIMS) {
    const path = join(cwd, shim.file);
    const content = renderShim(shim, block);
    if (existsSync(path)) {
      const current = readFileSync(path, "utf-8");
      if (current.startsWith("<!-- memory-for-agents:shim ")) {
        if (writeIfChanged(path, content)) result.shimsRefreshed.push(shim.id);
      } else {
        result.shimsSkipped.push(shim.id);
      }
    } else if (create.includes(shim.id)) {
      writeFileSync(path, content);
      result.shimsCreated.push(shim.id);
    }
  }
  return result;
}
