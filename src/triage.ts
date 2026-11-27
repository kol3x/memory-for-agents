import { execFileSync } from "node:child_process";
import { join, resolve, isAbsolute, relative } from "node:path";
import { readFileSync } from "node:fs";
import type { NormalizedTranscript } from "./types.js";
import type { DiscoveredSession } from "./discovery.js";

/**
 * Session triage: deciding which historical sessions deserve memory.
 *
 * Layer 1 — deterministic heuristics, no LLM:
 *   commits in window                  → keep (main code changes)
 *   no file changes at all             → skip (searches, Q&A, personal asides)
 *   edits, never landed                → skip (dropped work — verified against
 *                                         later commits touching the same files)
 *   edits, landed in later commits     → keep
 *   changes but no extractable paths   → review (LLM layer + human eyes)
 *
 * "Landed" = a commit made after the session touched one of the files the
 * session edited (deterministic file-overlap check, not timing).
 *
 * Human review of the manifest can flip any verdict; edited calls win.
 *
 * Artifacts (in <repo>/.memory/triage/):
 *   manifest.md    — human review table, contains snippets → local only
 *   decisions.tsv  — machine verdicts, no snippets → safe to commit
 */

export type Verdict = "keep" | "skip";

export interface TriageScorecard {
  ref: string;
  /** opaque id — the key in decisions.tsv (refs may contain private paths) */
  sessionId: string;
  agent: string;
  date?: string;
  model?: string;
  title?: string;
  /** first user message, truncated — manifest only, never in decisions.tsv */
  snippet: string;
  totalTokens: number;
  costUsd: number;
  userMsgs: number;
  asstMsgs: number;
  /** session wall time in minutes, when determinable */
  minutes: number | null;
  tools: { writeLike: number; readLike: number; bash: number; bashContent: number; bashInfra: number; other: number };
  /** tool calls from abandoned session-tree branches (not counted above) */
  offPathToolCalls: number;
  /** repo-relative files the session edited (inside the repo, active path) */
  changedPaths: string[];
  /** edit calls whose paths were all outside this repo (cross-repo work) */
  outsideEdits: number;
  /** commits made by the repo during the session window */
  commits: number;
  /** whether later commits touched the changed files (null = unknown/N.A.) */
  landedLater: boolean | null;
  verdict: Verdict;
  reason: string;
}

/** tunable knobs — adjust after a dry run against real data */
export interface TriageOptions {
  /** treat "landed" as requiring this many later commits touching the files */
  minLaterCommits?: number;
}

const DEFAULTS = { minLaterCommits: 1 };

/** tool names that modify files / ship changes */
const WRITE_LIKE = new Set(["edit", "write", "multiedit", "patch", "apply_patch", "str_replace", "create"]);
/** tool names that are pure reads */
const READ_LIKE = new Set([
  "read", "grep", "glob", "list", "ls", "find", "tree",
  "websearch", "webfetch", "fetch", "search",
]);

export function classifyTool(name: string): "write" | "read" | "bash" | "other" {
  if (name === "bash" || name.endsWith("_bash")) return "bash";
  if (WRITE_LIKE.has(name)) return "write";
  if (READ_LIKE.has(name)) return "read";
  // namespaced tools (playwright_*, cloudflare-*, ctx_*) and unknowns
  return "other";
}

const TOOL_BUCKETS = { write: "writeLike", read: "readLike", bash: "bash", other: "other" } as const;

/**
 * bash commands split by what they mutate: repo content vs. infra/state ops
 * (pulls, installs, api calls). Only content mutations count as "changes".
 */
const BASH_CONTENT = new RegExp(
  "\\b(sed\\s+(-\\w+\\s+)*-\\w*i|rm\\s|mv\\s|cp\\s|mkdir|touch\\s|chmod|ln\\s|tee\\s|" +
  "git\\s+(apply|am|cherry-pick|restore))",
);
const BASH_INFRA = new RegExp(
  "\\b(git\\s+(pull|push|merge|rebase|commit|add|stash|checkout)|npm\\s+(install|i|ci)|" +
  "pnpm\\s+(add|install|remove)|yarn\\s+(add|remove)|npx\\s|make\\b|codeql\\b|brew\\b|pip\\d?\\s|curl\\s|wget\\s)",
);

/** file redirect to a writable target — never /dev/null, never an fd dup (2>&1) */
const REDIRECT = /(?:^|[^0-9&(])>{1,2}\s*(?!\/dev\/null)[\w./~"']/;

export type BashMutationKind = "content" | "infra" | null;

/**
 * Classify a bash command's mutation effect. Redirects only count when the
 * target is inside the repo (relative targets assumed in-repo — agents run
 * at the repo root; absolute targets are checked against repoRoot).
 */
export function bashMutationKind(command: string, repoRoot?: string): BashMutationKind {
  if (BASH_CONTENT.test(command)) {
    // e.g. `rm -rf /tmp/cache` — content verb, but targets live outside the repo
    if (repoRoot && contentTargetsAllOutside(command, repoRoot)) return null;
    return "content";
  }
  if (REDIRECT.test(command)) {
    if (repoRoot && redirectOutsideRepo(command, repoRoot)) return null;
    return "content";
  }
  if (BASH_INFRA.test(command)) return "infra";
  return null;
}

/** every absolute path in the command resolves outside repoRoot (and there is ≥1) */
function contentTargetsAllOutside(command: string, repoRoot: string): boolean {
  // whitespace-anchored so sed's s/a/b/ expression bodies don't read as paths
  const paths = command.match(/(?:^|\s)\/[\w@%+=:.,~_-]+/g) ?? [];
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const rel = relative(resolve(repoRoot), p.trim());
    return rel.startsWith("..") || rel === "";
  });
}

/** first redirect target that resolves outside repoRoot */
function redirectOutsideRepo(command: string, repoRoot: string): boolean {
  const m = command.match(/(?:^|[^0-9&(])>{1,2}\s*([^\s|;&]+)/);
  if (!m) return false;
  const target = m[1].replace(/^["']|["']$/g, "");
  if (!target.startsWith("/")) return false; // relative → assume in-repo
  const rel = relative(resolve(repoRoot), target);
  return rel.startsWith("..") || rel === "";
}

export interface GitCommit {
  /** epoch ms */
  ts: number;
  files: string[];
}

/** Commit history of the current branch with touched files. */
/**
 * Commit history of the current branch with touched files. Each entry:
 * epoch-ms timestamp + repo-relative file paths.
 */
export function gitHistory(repoPath: string): GitCommit[] {
  try {
    const out = execFileSync(
      "git",
      // \x01 as a leading record separator — NUL placement in %x00 mixes
      // the next commit's timestamp into the previous block when parsing
      ["-C", repoPath, "log", "--format=%x01%ct", "--name-only"],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    const commits: GitCommit[] = [];
    for (const block of out.split("\x01")) {
      if (!block) continue; // leading separator
      const lines = block.split("\n");
      const ts = Number(lines[0]);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      commits.push({ ts: ts * 1000, files: lines.slice(1).filter((l) => l.trim()) });
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * Recursively pull file paths out of tool-call arguments. Keys considered:
 * path, filePath, file_path, file, filename. Paths are split into inside
 * (repo-relative) and outside (absolute paths pointing beyond the repo).
 */
export function extractEditPaths(args: unknown, repoRoot: string): { inside: string[]; outside: string[] } {
  const keys = new Set(["path", "filepath", "file_path", "file", "filename"]);
  const inside: string[] = [];
  const outside: string[] = [];
  const root = resolve(repoRoot);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && keys.has(k.toLowerCase())) {
          add(val);
        } else {
          walk(val);
        }
      }
    }
  };
  const add = (p: string) => {
    if (isAbsolute(p)) {
      const rel = relative(root, p);
      if (rel.startsWith("..") || rel === "") {
        if (!outside.includes(p)) outside.push(p); // another repo / elsewhere
        return;
      }
      p = rel;
    }
    p = p.replace(/^\.\//, "");
    if (p && !inside.includes(p)) inside.push(p);
  };
  walk(args);
  return { inside, outside };
}

/** True when a commit strictly after `endMs` touched any of `paths`. */
function landedLater(history: GitCommit[], paths: string[], endMs: number, min: number): boolean {
  if (paths.length === 0) return false;
  const set = new Set(paths);
  let n = 0;
  for (const c of history) {
    if (c.ts <= endMs) continue;
    if (c.files.some((f) => set.has(f))) n++;
  }
  return n >= min;
}

/** Heuristic verdict for one session. Exported for tests. */
export function scorecard(
  session: DiscoveredSession,
  transcript: NormalizedTranscript,
  history: GitCommit[],
  repoPath: string,
  opts: TriageOptions = {},
): TriageScorecard {
  const { minLaterCommits } = { ...DEFAULTS, ...opts };

  let firstUser = "";
  let userMsgs = 0;
  let asstMsgs = 0;
  const tools = { writeLike: 0, readLike: 0, bash: 0, bashContent: 0, bashInfra: 0, other: 0 };
  const changedPaths: string[] = [];
  let outsideEdits = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let offPathToolCalls = 0;

  for (const m of transcript.messages) {
    if (m.branched) {
      // abandoned session-tree branch: real tool calls, but not part of the
      // conversation that happened — counted separately, never verdict input
      offPathToolCalls += (m.toolCalls ?? []).length;
      continue;
    }
    if (m.timestamp !== undefined) {
      firstTs ??= m.timestamp;
      lastTs = m.timestamp;
    }
    if (m.role === "user") {
      userMsgs++;
      if (!firstUser && m.text) firstUser = m.text;
    } else if (m.role === "assistant") {
      asstMsgs++;
      for (const call of m.toolCalls ?? []) {
        const kind = classifyTool(call.name);
        if (kind === "bash") {
          tools.bash++;
          const cmd =
            typeof call.arguments === "object" && call.arguments !== null
              ? String((call.arguments as { command?: unknown }).command ?? "")
              : "";
          if (cmd) {
            const mutation = bashMutationKind(cmd, repoPath);
            if (mutation === "content") tools.bashContent++;
            else if (mutation === "infra") tools.bashInfra++;
          }
        } else {
          tools[TOOL_BUCKETS[kind]]++;
        }
        if (kind === "write" || call.name === "patch") {
          const { inside, outside } = extractEditPaths(call.arguments, repoPath);
          for (const p of inside) {
            if (!changedPaths.includes(p)) changedPaths.push(p);
          }
          if (inside.length === 0 && outside.length > 0) outsideEdits++;
        }
      }
    }
  }

  const totalTokens = transcript.spend?.usage.totalTokens ?? 0;
  const startedMs = transcript.startedAt ? Date.parse(transcript.startedAt) : firstTs;
  // last message timestamp is the honest session end; opencode's
  // session time_updated also moves on metadata edits (title/share), which
  // would inflate the commit window and misattribute commits
  const endedMs = lastTs ?? (session.updatedAt ? Date.parse(session.updatedAt) : undefined);
  const minutes =
    startedMs && endedMs && endedMs > startedMs
      ? Math.round((endedMs - startedMs) / 60_000)
      : null;
  const commitsInWindow =
    startedMs && endedMs
      ? history.filter((c) => c.ts >= startedMs && c.ts <= endedMs).length
      : 0;

  // window needs both ends; single-message sessions can't be windowed
  const windowKnown = Boolean(startedMs && endedMs);
  const madeChanges = tools.writeLike > 0 || tools.bashContent > 0;
  const landed =
    windowKnown && changedPaths.length > 0 && endedMs
      ? landedLater(history, changedPaths, endedMs, minLaterCommits)
      : null;

  let verdict: Verdict;
  let reason: string;
  if (!firstUser) {
    verdict = "skip";
    reason = "no user content";
  } else if (windowKnown && commitsInWindow > 0 && madeChanges) {
    // require change evidence so a parallel session's commits (or a manual
    // terminal commit during a Q&A session) don't falsely keep this one
    verdict = "keep";
    reason = `${commitsInWindow} commit${commitsInWindow === 1 ? "" : "s"} in session window`;
  } else if (!madeChanges) {
    verdict = "skip";
    reason = "no file changes (reads/Q&A only)";
  } else if (changedPaths.length === 0 && outsideEdits > 0) {
    verdict = "skip";
    reason = "changes in another repo (not this one's memory)";
  } else if (changedPaths.length === 0) {
    verdict = "skip";
    reason = "untraceable changes, ambiguous — default skip";
  } else if (landed) {
    verdict = "keep";
    reason = "edits landed in later commits";
  } else {
    verdict = "skip";
    reason = "edits never landed in later commits (dropped work)";
  }

  return {
    ref: session.ref,
    sessionId: transcript.sessionId,
    agent: session.agent,
    date: session.startedAt ?? transcript.startedAt,
    model: session.model ?? transcript.model,
    title: session.title,
    snippet: firstUser.replace(/\s+/g, " ").slice(0, 100),
    totalTokens,
    costUsd: transcript.spend?.costUsd ?? session.spend?.costUsd ?? 0,
    userMsgs,
    asstMsgs,
    minutes,
    tools,
    offPathToolCalls,
    commits: commitsInWindow,
    changedPaths,
    outsideEdits,
    landedLater: landed,
    verdict,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface TriageRun {
  scorecards: TriageScorecard[];
  manifest: string;
  decisions: string;
  stats: {
    total: number;
    keep: number;
    skip: number;
  };
}

export function renderManifest(cards: TriageScorecard[]): string {
  const head = [
    "# Session triage — review manifest",
    "",
    "Local only, never committed (contains message snippets).",
    "Edit `verdict` per row (keep/skip) to override a machine verdict; the",
    "backfill consumes the corrected decisions.tsv.",
    "",
    "Columns: W=edit/write calls, R=read calls, B=bash calls (C=content-mutating bash),",
    "off=tool calls on abandoned session-tree branches, commits=in-window commits,",
    "landed=changed files touched by later commits (Y/N, – = not applicable).",
    "",
    "| # | date | agent | verdict | tok | min | W/R/B(C) | off | commits | landed | reason | snippet |",
    "|---|------|-------|---------|-----|-----|----------|-----|---------|--------|--------|---------|",
  ];
  const rows = cards.map((c, i) => {
    const date = c.date ? c.date.slice(0, 10) : "?";
    const tok = c.totalTokens >= 1000 ? `${Math.round(c.totalTokens / 1000)}k` : String(c.totalTokens);
    const min = c.minutes === null ? "?" : String(c.minutes);
    const landed = c.landedLater === null ? "–" : c.landedLater ? "Y" : "N";
    return `| ${i + 1} | ${date} | ${c.agent} | ${c.verdict} | ${tok} | ${min} | ${c.tools.writeLike}/${c.tools.readLike}/${c.tools.bash}(${c.tools.bashContent}) | ${c.offPathToolCalls} | ${c.commits} | ${landed} | ${c.reason} | ${escapeCell(c.snippet)} |`;
  });
  return [...head, ...rows, ""].join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

export function renderDecisions(cards: TriageScorecard[]): string {
  const lines = ["# agent:sessionId\tverdict\treason"]; // no snippets, no paths
  for (const c of cards) {
    lines.push([`${c.agent}:${c.sessionId}`, c.verdict, c.reason].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** Parse decisions.tsv: "agent:sessionId" → verdict. Comment lines skipped. */
export function loadDecisions(file: string): Map<string, Verdict> {
  const map = new Map<string, Verdict>();
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return map; // no triage artifacts yet → empty (caller treats as all-skip)
  }
  for (const line of content.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [key, verdict] = line.split("\t");
    if (key && (verdict === "keep" || verdict === "skip")) map.set(key.trim(), verdict);
  }
  return map;
}

/**
 * Full triage run. `llm` is required only when not dry-running; dry run
 * leaves `review` verdicts untouched for human inspection.
 */
/**
 * Triage every discovered session deterministically. No LLM involved;
 * ambiguous cases default to skip (they stay visible in the manifest).
 */
export function runTriage(
  sessions: DiscoveredSession[],
  repoPath: string,
  opts: TriageOptions = {},
): TriageRun {
  const history = gitHistory(repoPath);
  const cards: TriageScorecard[] = [];
  for (const session of sessions) {
    const transcript = session.load();
    cards.push(scorecard(session, transcript, history, repoPath, opts));
  }

  const stats = {
    total: cards.length,
    keep: cards.filter((c) => c.verdict === "keep").length,
    skip: cards.filter((c) => c.verdict === "skip").length,
  };

  return { scorecards: cards, manifest: renderManifest(cards), decisions: renderDecisions(cards), stats };
}
