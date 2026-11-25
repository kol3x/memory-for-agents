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
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    const raw = entry.message;
    // system preamble is harness boilerplate, not conversation
    if (raw.role === "system") continue;

    if (raw.role === "user") {
      messages.push({
        role: "user",
        timestamp: raw.timestamp,
        text: flattenText(raw.content),
      });
      continue;
    }

    if (raw.role === "assistant") {
      const blocks = asBlocks(raw.content);
      const msg: NormalizedMessage = {
        role: "assistant",
        timestamp: raw.timestamp,
        text: flattenText(blocks),
        thinking: flattenText(blocks, "thinking"),
      };
      const toolCalls = blocks
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", arguments: b.arguments }));
      if (toolCalls.length > 0) msg.toolCalls = toolCalls;
      messages.push(msg);
      if (raw.usage) {
        usageAcc.input += raw.usage.input ?? 0;
        usageAcc.output += raw.usage.output ?? 0;
        usageAcc.cacheRead += raw.usage.cacheRead ?? 0;
        usageAcc.cacheWrite += raw.usage.cacheWrite ?? 0;
        usageAcc.total += raw.usage.totalTokens ?? 0;
        const c = raw.usage.cost;
        if (c) {
          costAcc +=
            c.total ??
            (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
        }
      }
      continue;
    }

    if (raw.role === "toolResult") {
      messages.push({
        role: "tool",
        timestamp: raw.timestamp,
        toolCallId: raw.toolCallId,
        toolName: raw.toolName,
        toolOutput: flattenText(raw.content),
        toolError: raw.isError === true,
      });
    }
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
