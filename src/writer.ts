import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";

/**
 * Markdown output: summary body is whatever the model produced (no prescribed
 * format); frontmatter carries provenance metadata. No cwd — files must be
 * safe to share in a repo.
 *
 * Files: <cwd>/.memory/sessions/<index>-<name>.md   (index zero-padded, sorts)
 * Debug: <cwd>/.memory/debug/<sessionId>/           (never committed)
 */

export interface Frontmatter {
  session: string;
  name: string;
  index: number;
  date?: string;
  agent?: string;
  model?: string;
  cost_usd: number;
}

export function sessionsDir(cwd: string): string {
  return join(cwd, ".memory", "sessions");
}

export function summaryPath(cwd: string, index: number, name: string): string {
  return join(sessionsDir(cwd), `${index}-${name}.md`);
}

/** Round cost up to 2 decimal places. */
export function roundCostUp(costUsd: number): number {
  return Math.ceil(costUsd * 100) / 100;
}

export interface ExistingSummary {
  path: string;
  index: number;
  name: string;
}

/**
 * Find an already-written summary for a session: its index and name are
 * reused so re-running a session doesn't fork into multiple files.
 */
export function findExistingSummary(cwd: string, sessionId: string): ExistingSummary | null {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const m = content.match(/^session: (.+)$/m);
    if (m && m[1] === sessionId) {
      const fm = file.match(/^(\d+)-(.+)\.md$/);
      return {
        path,
        index: fm ? Number(fm[1]) : 0,
        name: fm ? fm[2] : file.replace(/\.md$/, ""),
      };
    }
  }
  return null;
}

/** Next free index = max existing + 1. */
export function nextIndex(cwd: string): number {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(\d+)-/);
    if (m) max = Math.max(max, Number(m[1])); // numeric, no zero-padding
  }
  return max + 1;
}

export function renderMarkdown(fm: Frontmatter, body: string): string {
  const lines = [
    "---",
    `session: ${fm.session}`,
    `name: ${fm.name}`,
    `index: ${fm.index}`,
    fm.date ? `date: ${fm.date}` : null,
    fm.agent ? `agent: ${fm.agent}` : null,
    fm.model ? `model: ${fm.model}` : null,
    `cost_usd: ${fm.cost_usd}`,
    "---",
    "",
    body,
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function debugDir(cwd: string, sessionId: string): string {
  return join(cwd, ".memory", "debug", sessionId);
}

export function debugFileName(stepIndex: number, stepName: string): string {
  return `${String(stepIndex + 1).padStart(2, "0")}-${stepName}.md`;
}
