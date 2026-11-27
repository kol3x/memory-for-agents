import type { NormalizedMessage } from "./types.js";

/**
 * Shapes a normalized transcript into the plain-text input fed to the
 * summarizer. Tool activity is always omitted — tool content is a privacy
 * liability and stays out of summaries entirely (dropped by design).
 * Tool outputs are truncated defensively even though they never render.
 * Messages on abandoned session-tree branches (branched flag) are excluded:
 * the summary describes the conversation that actually happened.
 */

const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 2000;

export interface ShapeOptions {
  toolOutputMaxChars?: number;
}

export function shapeInput(
  transcript: { messages: NormalizedMessage[] },
  opts: ShapeOptions = {},
): string {
  void opts; // truncation reserved for future, tool outputs never render
  const rendered = transcript.messages
    .filter((m) => !m.branched)
    .map((m) => renderMessage(m))
    .filter((s): s is string => s !== null);
  return rendered.join("\n\n").trim();
}

function renderMessage(m: NormalizedMessage): string | null {
  if (m.role === "user") {
    return m.text ? `[user] ${m.text}` : null;
  }
  if (m.role === "assistant") {
    return m.text ? `[assistant] ${m.text}` : null;
  }
  return null; // tool results are never included
}
