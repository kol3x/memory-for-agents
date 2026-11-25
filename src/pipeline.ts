import type {
  NormalizedTranscript,
  PipelineResult,
  PipelineStep,
} from "./types.js";
import type { LlmClient } from "./summarizer.js";
import { buildPrompt } from "./summarizer.js";
import { shapeInput } from "./input.js";

/**
 * Pipeline: transcript → shaped input → prompt → LLM → summary.
 * Pure (no file I/O) so it runs anywhere; the CLI does the writing.
 * Every step is captured for review when debug is on.
 */

export interface RunOptions {
  llm: LlmClient;
  /** update-mode: incorporate into an existing summary instead of starting fresh */
  existingSummary?: string;
  debug?: boolean;
}

export async function runPipeline(
  transcript: NormalizedTranscript,
  opts: RunOptions,
): Promise<PipelineResult> {
  const steps: PipelineStep[] = [];
  const record = (name: string, content: string) => {
    steps.push({ name, content });
  };

  // 1. transcript (debug only — never leaves the machine otherwise)
  if (opts.debug) {
    record("transcript", JSON.stringify(transcript, null, 2));
  }

  // 2. shaped input (tool activity omitted by design)
  const messages = shapeInput(transcript);
  record("input", messages);

  // 3. prompt
  const prompt = buildPrompt({
    existingSummary: opts.existingSummary,
    messages,
  });
  record("prompt", `--- system ---\n${prompt.system}\n\n--- user ---\n${prompt.user}`);

  // 4. LLM
  const response = await opts.llm({ system: prompt.system, user: prompt.user });
  record("llm-response", response.text);

  const { name, summary } = extractName(response.text);
  if (opts.debug) record("name", name ?? "(none — fell back to first user message)");

  const keep = opts.debug ? steps : steps.filter((s) => s.name === "llm-response");

  return {
    name,
    summary,
    sessionId: transcript.sessionId,
    agent: transcript.agent,
    messageCount: transcript.messages.length,
    steps: keep,
  };
}

/** Peel the "Name: ..." first line off the model response. */
export function extractName(text: string): { name?: string; summary: string } {
  const m = text.match(/^Name:\s*(.+?)\s*(\n|$)/);
  if (!m) return { summary: text.trim() };
  return { name: m[1].trim(), summary: text.slice(m[0].length).trim() };
}
