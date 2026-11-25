import type { LlmUsage } from "./types.js";

/**
 * Prompt construction + LLM client for session summarization.
 * Prompt style follows pawmc: conservative update of an existing summary,
 * user messages are ground truth, assistant content only when confirmed.
 * No prescribed output format — the model decides the shape of the summary.
 */

export const DEFAULT_SYSTEM_INSTRUCTION =
  "User values succinct and direct outputs without extra formatting, warnings, and politeness.";

export interface PromptInput {
  /** previously generated summary, if updating */
  existingSummary?: string;
  /** shaped transcript text from input.ts */
  messages: string;
}

export function buildPrompt(input: PromptInput): { system: string; user: string } {
  const parts: (string | null)[] = [
    input.existingSummary ? `Existing summary: ${input.existingSummary}` : null,
    [
      "Update the summary by incorporating the following messages from an agentic coding session.",
      'Messages are labeled with role fields ("user" and "assistant").',
      'Prioritize "user" messages — they represent confirmed information and intent.',
      '"assistant" messages are speculative; only include their content if the user explicitly agreed or confirmed it.',
      "Be conservative — avoid adding unconfirmed assumptions.",
      "Tool activity has been omitted from this input; do not invent or reference tool details.",
      "Never include private data in the summary: usernames, home directories, absolute paths, hostnames, email addresses, API keys, tokens, or other secrets. Refer to such things generically (e.g. \"the project dir\", \"the auth config\").",
      'Begin the response with a single line "Name: <2-5 word name for this session>" followed by the summary.',
    ].join(" "),
    "Messages:",
    input.messages,
  ];
  return {
    system: DEFAULT_SYSTEM_INSTRUCTION,
    user: parts.filter((p) => p !== null).join("\n\n"),
  };
}

export interface LlmResponse {
  text: string;
  usage?: LlmUsage;
}

export type LlmClient = (opts: { system: string; user: string }) => Promise<LlmResponse>;

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

export function openRouterClient(opts: OpenRouterOptions): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return async ({ system, user }) => {
    const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
      };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter response contained no content");
    const u = data.usage;
    return {
      text: content.trim(),
      usage: u
        ? {
            inputTokens: u.prompt_tokens,
            outputTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
            cost: u.cost,
          }
        : undefined,
    };
  };
}
