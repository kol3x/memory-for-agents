import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { NormalizedTranscript } from "./types.js";
import { parsePiSession } from "./adapters/pi.js";
import {
  type OpencodeSessionRef,
  opencodeProjectId,
  opencodeSessions,
  loadOpencodeTranscript,
} from "./adapters/opencode.js";

/**
 * Session discovery across agents. A repo may have sessions from several
 * agents (pi jsonl files + opencode SQLite rows); discovery yields uniform
 * refs with lazy transcript loading, so triage/backfill never needs to know
 * where a session came from.
 */

export type SessionRef = string; // "pi:<abs path>" | "opencode:<sessionId>"

export interface DiscoveredSession {
  ref: SessionRef;
  /** opaque session id — matches frontmatter/decisions.tsv without loading */
  sessionId: string;
  agent: "pi" | "opencode";
  startedAt?: string;
  updatedAt?: string;
  model?: string;
  /** opencode title, when available */
  title?: string;
  /** session-level spend, when the store provides it (opencode does) */
  spend?: NormalizedTranscript["spend"];
  load: () => NormalizedTranscript;
}

/** pi encodes repo paths as dashed dir names under ~/.pi/agent/sessions. */
function piSessionsDir(repoPath: string): string {
  const encoded = `--${resolve(repoPath).split("/").filter(Boolean).join("-")}--`;
  return join(homedir(), ".pi", "agent", "sessions", encoded);
}

function discoverPi(repoPath: string): DiscoveredSession[] {
  const dir = piSessionsDir(repoPath);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  return files.map((file) => {
    const path = join(dir, file);
    // cheap header peek: the first line carries id + timestamp
    let sessionId = "";
    let startedAt: string | undefined;
    try {
      const header = readFileSync(path, "utf-8").split("\n", 1)[0];
      const parsed = JSON.parse(header) as { id?: string; timestamp?: string };
      sessionId = parsed.id ?? "";
      startedAt = parsed.timestamp;
    } catch {
      // leave undefined; scorecard falls back to message timestamps
    }
    return {
      ref: `pi:${path}` as SessionRef,
      agent: "pi" as const,
      sessionId,
      startedAt,
      load: () => parsePiSession(readFileSync(path, "utf-8")),
    };
  });
}

function discoverOpencode(repoPath: string): DiscoveredSession[] {
  const projectId = opencodeProjectId(undefined, repoPath);
  if (!projectId) return [];
  const sessions = opencodeSessions(projectId);
  return sessions.map((s: OpencodeSessionRef) => ({
    ref: `opencode:${s.id}` as SessionRef,
    agent: "opencode" as const,
    sessionId: s.id,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    model: s.model,
    title: s.title,
    spend: s.spend,
    load: () => loadOpencodeTranscript(s),
  }));
}

/** All known sessions for a repo, across agents, oldest first. */
export function discoverSessions(repoPath: string): DiscoveredSession[] {
  const all = [...discoverOpencode(repoPath), ...discoverPi(repoPath)];
  return all.sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
}
