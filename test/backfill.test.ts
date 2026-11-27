import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { runBackfill } from "../src/backfill.js";
import type { DiscoveredSession } from "../src/discovery.js";
import type { LlmClient } from "../src/summarizer.js";
import type { NormalizedTranscript } from "../src/types.js";

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "backfill-"));
});

const fakeLlm: LlmClient = async ({ user }) => ({
  text: `Name: test session\n${user.slice(0, 50)}`,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.0001 },
});

function fakeSession(
  id: string,
  over: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  const t: NormalizedTranscript = {
    sessionId: id,
    agent: "pi",
    startedAt: "2026-06-01T10:00:00Z",
    messages: [
      { role: "user", timestamp: 1, text: `first message of ${id}` },
      { role: "assistant", timestamp: 2, text: "reply" },
    ],
    spend: {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
      costUsd: 0.5,
    },
  };
  return {
    ref: `test:${id}`,
    agent: "pi",
    sessionId: id,
    startedAt: "2026-06-01T10:00:00Z",
    load: () => t,
    ...over,
  };
}

describe("runBackfill", () => {
  it("summarizes sessions, skips existing, allocates chronological indices", async () => {
    const sessions = [fakeSession("a"), fakeSession("b"), fakeSession("c")];
    const res = await runBackfill(sessions, cwd, { llm: fakeLlm, concurrency: 3 });

    expect(res.summarized).toBe(3);
    expect(res.failed).toBe(0);
    expect(res.llmCostUsd).toBeCloseTo(0.0003, 6);

    // files exist with chronological indices
    const files = execFileSync("ls", [join(cwd, ".memory", "sessions")], { encoding: "utf-8" })
      .trim()
      .split("\n")
      .sort();
    expect(files).toHaveLength(3);
    expect(files[0]).toMatch(/^1-/);
    expect(files[2]).toMatch(/^3-/);

    // frontmatter + cost rounding
    const md = readFileSync(join(cwd, ".memory", "sessions", files[0]), "utf-8");
    expect(md).toContain("session: a");
    expect(md).toContain("session_cost_usd: 0.5");
    // shaped input paired by basename
    expect(existsSync(join(cwd, ".memory", "inputs", files[0]))).toBe(true);

    // rerun: everything skipped as existing
    const res2 = await runBackfill(sessions, cwd, { llm: fakeLlm });
    expect(res2.summarized).toBe(0);
    expect(res2.skippedExisting).toBe(3);
  });

  it("limit processes only the first N sessions", async () => {
    const cwd2 = mkdtempSync(join(tmpdir(), "backfill-"));
    try {
      const sessions = [fakeSession("x"), fakeSession("y"), fakeSession("z")];
      const res = await runBackfill(sessions, cwd2, { llm: fakeLlm, limit: 1 });
      expect(res.summarized).toBe(1);
      const files = execFileSync("ls", [join(cwd2, ".memory", "sessions")], { encoding: "utf-8" });
      expect(files.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(cwd2, { recursive: true, force: true });
    }
  });

  it("reports per-session failures without aborting the run", async () => {
    const cwd3 = mkdtempSync(join(tmpdir(), "backfill-"));
    try {
      const badLlm: LlmClient = async ({ user }) => {
        if (user.includes("bad")) throw new Error("LLM down");
        return { text: "Name: ok\nsummary text" };
      };
      const sessions = [fakeSession("bad"), fakeSession("good")];
      const res = await runBackfill(sessions, cwd3, { llm: badLlm, concurrency: 2 });
      expect(res.summarized).toBe(1);
      expect(res.failed).toBe(1);
      const files = execFileSync("ls", [join(cwd3, ".memory", "sessions")], { encoding: "utf-8" });
      expect(files.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(cwd3, { recursive: true, force: true });
    }
  });
});
