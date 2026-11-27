import { join, dirname } from "node:path";
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";

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
  /** the agent session's own spend, rounded up to 2 decimals */
  session_cost_usd: number;
}

export function sessionsDir(cwd: string): string {
  return join(cwd, ".memory", "sessions");
}

/** Shaped no-tools inputs — kept for transparency, never committed. */
export function inputsDir(cwd: string): string {
  return join(cwd, ".memory", "inputs");
}

/** Same basename as the summary, different folder — clean pairing. */
export function inputPath(cwd: string, index: number, name: string): string {
  return join(inputsDir(cwd), `${index}-${name}.md`);
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
    `session_cost_usd: ${fm.session_cost_usd}`,
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

// ---------------------------------------------------------------------------
// Local artifacts: everything the tool writes into a repo that must never be
// committed. Managed .gitignore block, same pattern as the AGENTS.md sync.
// ---------------------------------------------------------------------------

/** private artifacts written into target repos — always gitignored */
export const LOCAL_ARTIFACTS = [
  ".memory/inputs/", // shaped no-tools inputs (privacy liability)
  ".memory/debug/", // debug dumps
  ".memory/triage/manifest.md", // triage review table (message snippets)
];

const GITIGNORE_BEGIN = "# memory-for-agents:begin (local artifacts — never commit)";
const GITIGNORE_END = "# memory-for-agents:end";
const GITIGNORE_BLOCK = [GITIGNORE_BEGIN, ...LOCAL_ARTIFACTS, GITIGNORE_END, ""].join("\n");

/**
 * Ensure the target repo's .gitignore carries the managed block for local
 * artifacts. Idempotent; replaces a stale block in place; surrounding user
 * content untouched. Returns "created" | "updated" | "unchanged".
 */
export function ensureGitignore(cwd: string): "created" | "updated" | "unchanged" {
  const file = join(cwd, ".gitignore");
  let content = "";
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    // missing → create
  }
  const re = new RegExp(
    `^${GITIGNORE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?^${GITIGNORE_END}[^\\n]*\\n?`,
    "m",
  );
  if (re.test(content)) {
    if (content.includes(GITIGNORE_BLOCK)) return "unchanged";
    writeFileSync(file, content.replace(re, GITIGNORE_BLOCK));
    return "updated";
  }
  if (content.trim() === "") {
    writeFileSync(file, GITIGNORE_BLOCK);
    return content ? "updated" : "created";
  }
  writeFileSync(file, content.replace(/\n*$/, "\n") + "\n" + GITIGNORE_BLOCK);
  return "updated";
}

// ---------------------------------------------------------------------------
// Summary artifacts: one writer shared by the single-session flow and the
// concurrent backfill.
// ---------------------------------------------------------------------------

export interface SummaryArtifacts {
  sessionId: string;
  /** already slugged */
  name: string;
  index: number;
  date?: string;
  agent?: string;
  model?: string;
  /** the agent session's own spend, rounded up to 2 decimals */
  sessionCostUsd: number;
  /** shaped no-tools input (pipeline) */
  input: string;
  /** summary body (pipeline) */
  summary: string;
}

export interface WrittenSummary {
  file: string;
  inputFile: string;
  gitignore: "created" | "updated" | "unchanged";
}

/** Write summary + paired shaped input, ensuring the gitignore block. */
export function writeSummaryArtifacts(cwd: string, a: SummaryArtifacts): WrittenSummary {
  const inputFile = inputPath(cwd, a.index, a.name);
  mkdirSync(dirname(inputFile), { recursive: true });
  writeFileSync(inputFile, a.input + "\n");

  const file = summaryPath(cwd, a.index, a.name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    renderMarkdown(
      {
        session: a.sessionId,
        name: a.name,
        index: a.index,
        date: a.date,
        agent: a.agent,
        model: a.model,
        session_cost_usd: a.sessionCostUsd,
      },
      a.summary,
    ),
  );

  return { file, inputFile, gitignore: ensureGitignore(cwd) };
}
