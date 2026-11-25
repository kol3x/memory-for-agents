import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parsePiSession } from "../src/adapters/pi.js";
import { runPipeline } from "../src/pipeline.js";
import {
  renderMarkdown,
  summaryPath,
  debugDir,
  debugFileName,
  findExistingSummary,
  nextIndex,
  roundCostUp,
} from "../src/writer.js";

const fixture = readFileSync(join(__dirname, "fixtures", "pi-session.jsonl"), "utf-8");

const stubLlm = async ({ user }: { system: string; user: string }) => ({
  text: `Name: session summary layer\nSUMMARY OF INPUT (${user.length} chars)`,
});

const stubNoName = async () => ({ text: "plain summary" });

describe("pipeline", () => {
  it("runs end-to-end with stub LLM and records the llm step", async () => {
    const t = parsePiSession(fixture);
    const r = await runPipeline(t, { llm: stubLlm });
    expect(r.name).toBe("session summary layer");
    expect(r.summary).toContain("SUMMARY OF INPUT");
    expect(r.summary).not.toMatch(/^Name:/);
    expect(r.sessionId).toBe("test-session-001");
    expect(r.agent).toBe("pi");
    expect(r.messageCount).toBe(8);
    expect(r.steps.map((s) => s.name)).toEqual(["llm-response"]);
  });

  it("debug mode captures every step", async () => {
    const t = parsePiSession(fixture);
    const r = await runPipeline(t, { llm: stubLlm, debug: true });
    expect(r.steps.map((s) => s.name)).toEqual([
      "transcript", "input", "prompt", "llm-response", "name",
    ]);
    const input = r.steps.find((s) => s.name === "input")!.content;
    expect(input).not.toContain("[tool result");
    expect(input).toContain("[user] Yes, go ahead");
  });
});

describe("markdown writer", () => {
  it("writes summary with frontmatter (no cwd) and debug artifacts to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mfa-test-"));
    const t = parsePiSession(fixture);
    t.cwd = dir; // redirect output into temp project
    const r = await runPipeline(t, { llm: stubLlm, debug: true });

    const file = summaryPath(dir, 1, "test-session");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderMarkdown({
      session: r.sessionId, name: "test-session", index: 1,
      date: t.startedAt, agent: r.agent, model: t.model,
      cost_usd: roundCostUp(0.0021),
    }, r.summary));
    expect(existsSync(file)).toBe(true);

    const md = readFileSync(file, "utf-8");
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("session: test-session-001");
    expect(md).toContain("agent: pi");
    expect(md).toContain("model: test-model");
    expect(md).toContain("cost_usd: 0.01"); // 0.0021 rounds up to 2 decimals
    expect(md).not.toContain("cwd:");
    expect(md).toContain("SUMMARY OF INPUT");

    const ddir = debugDir(dir, r.sessionId);
    mkdirSync(ddir, { recursive: true });
    for (const [i, step] of r.steps.entries()) {
      writeFileSync(join(ddir, debugFileName(i, step.name)), step.content);
    }
    expect(readdirSync(ddir)).toEqual([
      "01-transcript.md", "02-input.md", "03-prompt.md", "04-llm-response.md", "05-name.md",
    ]);
  });
});

describe("indexing", () => {
  it("rounds costs up to 2 decimals", () => {
    expect(roundCostUp(0.0021)).toBe(0.01);
    expect(roundCostUp(57.1031)).toBe(57.11);
    expect(roundCostUp(2)).toBe(2);
    expect(roundCostUp(0.001)).toBe(0.01);
  });

  it("allocates next index and reuses it for the same session", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfa-idx-"));
    expect(nextIndex(dir)).toBe(1); // dir exists but empty-ish
    mkdirSync(join(dir, ".memory", "sessions"), { recursive: true });
    writeFileSync(summaryPath(dir, 1, "first-session"),
      renderMarkdown({
        session: "s1", name: "first-session", index: 1,
        cost_usd: 0,
      }, "body"));
    writeFileSync(summaryPath(dir, 2, "second-thing"),
      renderMarkdown({
        session: "s2", name: "second-thing", index: 2,
        cost_usd: 0,
      }, "body"));

    expect(nextIndex(dir)).toBe(3);
    const found = findExistingSummary(dir, "s1");
    expect(found?.index).toBe(1);
    expect(found?.name).toBe("first-session");
    expect(findExistingSummary(dir, "s999")).toBeNull();
  });
});
