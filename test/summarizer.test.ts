import { describe, expect, it } from "vitest";
import { buildPrompt, DEFAULT_SYSTEM_INSTRUCTION, openRouterClient } from "../src/summarizer.js";

describe("prompt builder", () => {
  const base = { messages: "[user] hi" };

  it("uses the pawmc system instruction", () => {
    const p = buildPrompt(base);
    expect(p.system).toBe(DEFAULT_SYSTEM_INSTRUCTION);
  });

  it("includes conservative guidance prioritizing user messages", () => {
    const p = buildPrompt(base);
    expect(p.user).toContain("Prioritize \"user\" messages");
    expect(p.user).toContain("Be conservative");
    expect(p.user).toContain("[user] hi");
  });

  it("includes existing summary when updating", () => {
    const p = buildPrompt({ ...base, existingSummary: "Prior summary text." });
    expect(p.user).toContain("Existing summary: Prior summary text.");
  });

  it("tells the model not to invent tool details", () => {
    const p = buildPrompt(base);
    expect(p.user).toContain("Tool activity has been omitted");
  });

  it("instructs the model to filter out private data", () => {
    const p = buildPrompt(base);
    expect(p.user).toContain("Never include private data");
    expect(p.user).toContain("usernames");
    expect(p.user).toContain("API keys");
  });
});

describe("openrouter client", () => {
  it("maps usage tokens and cost when present", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "out" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            total_tokens: 1200,
            cost: 0.0042,
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = openRouterClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(client({ system: "s", user: "u" })).resolves.toEqual({
      text: "out",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cost: 0.0042 },
    });
  });

  it("sends system+user, returns content, throws on http error", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "  summary body  " } }] }), {
          status: 200,
        });
      }
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    const client = openRouterClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(client({ system: "s", user: "u" })).resolves.toEqual({
      text: "summary body",
      usage: undefined,
    });
    await expect(client({ system: "s", user: "u" })).rejects.toThrow(/500/);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("m");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toBe("u");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });
});
