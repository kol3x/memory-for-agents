import type {
  NormalizedMessage,
  NormalizedTranscript,
  SessionSpend,
} from "../types.js";

/**
 * Adapter for pi (https://github.com/badlogic/pi-mono) session JSONL files.
 * Session files live in ~/.pi/agent/sessions/<encoded-cwd>/<session>.jsonl
 *
 * Entry types: "session" (header), "message" (role: system|user|assistant|toolResult),
 * "model_change", "thinking_level_change". We map to the normalized transcript
 * and drop system boilerplate + harness metadata.
 */

interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface RawMessage {
  role: string;
  content: string | RawBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: Record<string, number>;
  };
}

interface RawEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  message?: RawMessage;
}

export function parsePiSession(jsonl: string): NormalizedTranscript {
  const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  let sessionId = "";
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let model: string | undefined;
  const messages: NormalizedMessage[] = [];
  const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let costAcc = 0;

  // pass 1: collect entries — the tree indexes ALL id'd entries (parent
  // chains run through custom_message/model_change nodes), messages are
  // normalized in pass 2
  interface MsgEntry {
    id?: string;
    parentId?: string | null;
    message: RawMessage;
  }
  const msgEntries: MsgEntry[] = [];
  const entries: { id: string; parentId?: string | null }[] = [];
  for (const line of lines) {
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue; // tolerate malformed lines
    }

    if (entry.type === "session") {
      sessionId = entry.id ?? "";
      cwd = entry.cwd;
      startedAt = entry.timestamp;
      continue;
    }
    if (entry.type === "model_change") {
      model = entry.modelId;
    }
    if (entry.type === "message" && entry.message) {
      msgEntries.push({ id: entry.id, parentId: entry.parentId, message: entry.message });
    }
    if (entry.id) entries.push({ id: entry.id, parentId: entry.parentId });
  }

  // active path: the parent chain ending at the last message entry (the
  // session's current tip). Everything else is an abandoned branch.
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id as string, e]));
  const activeIds = new Set<string>();
  let tip = msgEntries[msgEntries.length - 1]?.id;
  if (tip) {
    while (tip && byId.has(tip)) {
      activeIds.add(tip);
      tip = byId.get(tip)!.parentId ?? undefined;
    }
  }
  // no resolvable chain (old/odd files) → treat all as active
  if (msgEntries.some((e) => e.id) && activeIds.size === 0) {
    for (const e of msgEntries) if (e.id) activeIds.add(e.id);
  }

  // pass 2: normalize in file order, marking off-path messages
  for (const msgEntry of msgEntries) {
    const branched = Boolean(msgEntry.id && byId.has(msgEntry.id) && !activeIds.has(msgEntry.id));
    messages.push(...normalizeMessage(msgEntry.message, branched, usageAcc, (c) => (costAcc += c)));
  }

  const spend: SessionSpend = {
    usage: {
      inputTokens: usageAcc.input,
      outputTokens: usageAcc.output,
      cacheReadTokens: usageAcc.cacheRead,
      cacheWriteTokens: usageAcc.cacheWrite,
      totalTokens: usageAcc.total,
    },
    costUsd: costAcc,
  };

  return { sessionId, agent: "pi", cwd, startedAt, model, spend, messages };
}

/** Normalize one raw message; usage/cost always accumulated (real spend). */
function normalizeMessage(
  raw: RawMessage,
  branched: boolean,
  usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
  addCost: (usd: number) => void,
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];

  // system preamble is harness boilerplate, not conversation
  if (raw.role === "system") return out;

  if (raw.role === "user") {
    out.push({ role: "user", timestamp: raw.timestamp, text: flattenText(raw.content), branched: branched || undefined });
    return out;
  }

  if (raw.role === "assistant") {
    const blocks = asBlocks(raw.content);
    const msg: NormalizedMessage = {
      role: "assistant",
      timestamp: raw.timestamp,
      text: flattenText(blocks),
      thinking: flattenText(blocks, "thinking"),
      branched: branched || undefined,
    };
    const toolCalls = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", arguments: b.arguments }));
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    out.push(msg);
    if (raw.usage) {
      usageAcc.input += raw.usage.input ?? 0;
      usageAcc.output += raw.usage.output ?? 0;
      usageAcc.cacheRead += raw.usage.cacheRead ?? 0;
      usageAcc.cacheWrite += raw.usage.cacheWrite ?? 0;
      usageAcc.total += raw.usage.totalTokens ?? 0;
      const c = raw.usage.cost;
      if (c) {
        addCost(
          c.total ??
            (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0),
        );
      }
    }
    return out;
  }

  if (raw.role === "toolResult") {
    out.push({
      role: "tool",
      timestamp: raw.timestamp,
      toolCallId: raw.toolCallId,
      toolName: raw.toolName,
      toolOutput: flattenText(raw.content),
      toolError: raw.isError === true,
      branched: branched || undefined,
    });
  }
  return out;
}

function asBlocks(content: string | RawBlock[]): RawBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content ?? [];
}

/** Concatenate text blocks of the given type (default "text"). */
function flattenText(content: string | RawBlock[], blockType = "text"): string {
  const blocks = asBlocks(content);
  return blocks
    .filter((b) => b.type === blockType && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
