import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  NormalizedMessage,
  NormalizedTranscript,
  SessionSpend,
} from "../types.js";

/**
 * Adapter for opencode (https://github.com/sst/opencode) sessions.
 *
 * Storage: SQLite DB at ~/.local/share/opencode/opencode.db (read-only).
 * Sessions belong to projects (worktree = repo root); messages live in a
 * `message` table (JSON `data` column), message content in a `part` table.
 *
 * Normalization choices (deliberate):
 * - tool parts carry invocation + result in one row; we map the invocation
 *   (name + input) onto the assistant message and emit a tool-result message
 *   with an EMPTY output. Tool outputs are never rendered by the shaper, and
 *   they dominate DB size — skipping them keeps loads fast and light.
 * - reasoning parts are skipped: they are never used downstream.
 *
 * Both the legacy `session` table and `session_v2` are read; ids are
 * deduplicated.
 */

interface SessionRow {
  id: string;
  title: string | null;
  slug: string;
  directory: string;
  time_created: number;
  time_updated: number;
  model: string | null;
  agent: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

export interface OpencodeSessionRef {
  id: string;
  title?: string;
  slug: string;
  directory: string;
  startedAt: string;
  updatedAt: string;
  model?: string;
  /** opencode agent mode, e.g. "build" | "plan" */
  mode?: string;
  spend: SessionSpend;
}

interface MessageRow {
  id: string;
  data: string;
}

interface MessageData {
  role?: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
    total?: number;
  };
  time?: { created?: number; completed?: number };
}

interface TextPart {
  type: "text";
  text?: string;
}
interface ToolPart {
  type: "tool";
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown };
}

const DEFAULT_DB = join(homedir(), ".local/share/opencode", "opencode.db");

function openDb(dbPath = DEFAULT_DB): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Find the opencode project row for a repo root, or null. */
export function opencodeProjectId(dbPath = DEFAULT_DB, repoPath = process.cwd()): string | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT id FROM project WHERE worktree = ?")
      .get(resolve(repoPath)) as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

/** All sessions (legacy + v2, deduped) for one project, oldest first. */
export function opencodeSessions(projectId: string, dbPath = DEFAULT_DB): OpencodeSessionRef[] {
  const db = openDb(dbPath);
  try {
    const byId = new Map<string, OpencodeSessionRef>();
    for (const table of ["session", "session_v2"] as const) {
      const rows = db
        .prepare(
          `SELECT id, title, slug, directory, time_created, time_updated,
                  model, agent, cost, tokens_input, tokens_output,
                  tokens_cache_read, tokens_cache_write
           FROM ${table} WHERE project_id = ? ORDER BY time_created`,
        )
        .all(projectId) as unknown as SessionRow[];
      for (const r of rows) {
        if (byId.has(r.id)) continue; // v2 supersedes legacy rows with the same id
        byId.set(r.id, {
          id: r.id,
          title: r.title ?? undefined,
          slug: r.slug,
          directory: r.directory,
          startedAt: new Date(r.time_created).toISOString(),
          updatedAt: new Date(r.time_updated).toISOString(),
          model: r.model ?? undefined,
          mode: r.agent ?? undefined,
          spend: {
            usage: {
              inputTokens: r.tokens_input,
              outputTokens: r.tokens_output,
              cacheReadTokens: r.tokens_cache_read,
              cacheWriteTokens: r.tokens_cache_write,
              totalTokens: r.tokens_input + r.tokens_output + r.tokens_cache_read + r.tokens_cache_write,
            },
            costUsd: r.cost ?? 0,
          },
        });
      }
    }
    return [...byId.values()];
  } finally {
    db.close();
  }
}

/**
 * Load one opencode session as a normalized transcript. Tool outputs are
 * intentionally left empty (see module doc); usage comes from the session
 * row aggregates.
 */
export function loadOpencodeTranscript(
  session: OpencodeSessionRef,
  dbPath = DEFAULT_DB,
): NormalizedTranscript {
  const db = openDb(dbPath);
  try {
    const messages: NormalizedMessage[] = [];
    const msgRows = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(session.id) as unknown as MessageRow[];

    // tool parts only: pull invocation fields via json_extract so the (huge)
    // state.output never crosses into JS
    const toolParts = db
      .prepare(
        `SELECT message_id, id,
                json_extract(data, '$.tool')      AS tool,
                json_extract(data, '$.callID')    AS callID,
                json_extract(data, '$.state.status') AS status,
                json_extract(data, '$.state.input')  AS input
         FROM part
         WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
         ORDER BY time_created, id`,
      )
      .all(session.id) as unknown as {
      message_id: string;
      id: string;
      tool: string | null;
      callID: string | null;
      status: string | null;
      input: string | null;
    }[];
    const toolByMessage = new Map<string, typeof toolParts>();
    for (const t of toolParts) {
      const list = toolByMessage.get(t.message_id) ?? [];
      list.push(t);
      toolByMessage.set(t.message_id, list);
    }

    for (const row of msgRows) {
      let data: MessageData;
      try {
        data = JSON.parse(row.data) as MessageData;
      } catch {
        continue;
      }
      const role = data.role;
      if (role !== "user" && role !== "assistant") continue;

      const textRows = db
        .prepare(
          `SELECT json_extract(data, '$.text') AS text
           FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
           ORDER BY time_created, id`,
        )
        .all(row.id) as unknown as { text: string | null }[];
      const text = textRows
        .map((r) => r.text ?? "")
        .join("\n")
        .trim();

      const msg: NormalizedMessage = {
        role,
        timestamp: data.time?.created,
        text: text || undefined,
      };

      const tools = toolByMessage.get(row.id);
      if (tools) {
        const toolCalls = tools
          .filter((t) => t.tool)
          .map((t) => ({
            id: t.callID ?? t.id,
            name: t.tool as string,
            arguments: t.input ? safeParse(t.input) : undefined,
          }));
        if (toolCalls.length > 0) msg.toolCalls = toolCalls;
        messages.push(msg);
        for (const t of tools) {
          messages.push({
            role: "tool",
            timestamp: data.time?.created,
            toolCallId: t.callID ?? undefined,
            toolName: t.tool ?? undefined,
            toolOutput: "", // skipped by design — see module doc
            toolError: t.status === "error",
          });
        }
        continue;
      }
      messages.push(msg);
    }

    return {
      sessionId: session.id,
      agent: "opencode",
      cwd: session.directory,
      startedAt: session.startedAt,
      model: session.model,
      spend: session.spend,
      messages,
    };
  } finally {
    db.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
