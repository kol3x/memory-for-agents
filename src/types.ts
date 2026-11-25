/**
 * Runtime-agnostic core types. Everything downstream of the adapter only
 * knows this shape; adding a new agent = adding a new adapter.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type NormalizedRole = "user" | "assistant" | "tool";

export interface NormalizedMessage {
  role: NormalizedRole;
  timestamp?: number;
  /** user/assistant plain text */
  text?: string;
  /** assistant: thinking blocks (kept out of summary input by default) */
  thinking?: string;
  /** assistant: tool invocations */
  toolCalls?: ToolCall[];
  /** tool result message */
  toolName?: string;
  toolCallId?: string;
  toolOutput?: string;
  toolError?: boolean;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SessionSpend {
  usage: SessionUsage;
  /** cumulative USD across the session */
  costUsd: number;
}

export interface NormalizedTranscript {
  sessionId: string;
  /** e.g. "pi" — set by the adapter */
  agent?: string;
  cwd?: string;
  startedAt?: string;
  model?: string;
  spend?: SessionSpend;
  messages: NormalizedMessage[];
}

/** usage of a single LLM call (e.g. the summarization call) */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** USD */
  cost?: number;
}

export interface PipelineStep {
  name: string;
  content: string;
}

export interface PipelineResult {
  /** human-readable name, from the model's Name: line when present */
  name?: string;
  summary: string;
  sessionId: string;
  agent?: string;
  messageCount: number;
  steps: PipelineStep[];
}
