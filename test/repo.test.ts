import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateRepoMemory,
  readRepoMemory,
  buildRepoPrompt,
  hashSession,
  type RepoUpdateResult,
} from "../src/repo.js";
import type { LlmResponse } from "../src/summarizer.js";

function fakeLlm(
  responses: { text: string; cost: number }[],
  calls: { system: string; user: string }[] = [],
): any {
  let i = 0;
  return async (opts: { system: string; user: string }) => {
    calls.push(opts);
    const r = responses[i++] ?? { text: "no more canned responses", cost: 0 };
    return { text: r.text, usage: { cost: r.cost } } satisfies LlmResponse;
  };
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "repo-memory-"));
  mkdirSync(join(cwd, ".memory", "sessions"), { recursive: true });
  return cwd;
}

function sessionFile(cwd: string, index: number, name: string, body: string): void {
  writeFileSync(
    join(cwd, ".memory", "sessions", `${index}-${name}.md`),
    `---\nsession: s-${index}\nname: ${name}\nindex: ${index}\ncost_usd: 0.1\n---\n\n${body}\n`,
  );
}

describe("repo memory update", () => {
  it("incorporates all sessions into a fresh repo memory", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "Built the session summary layer.");
    sessionFile(cwd, 2, "second", "Added the repo memory layer.");

    const calls: { system: string; user: string }[] = [];
    const llm = fakeLlm([{ text: "Chose plan 2 for auto-loading.", cost: 0.113 }], calls);
    const result = await updateRepoMemory({ cwd, llm });

    expect(result?.included.map((s) => s.index)).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("Built the session summary layer.");
    expect(calls[0].user).toContain("Added the repo memory layer.");

    const md = readFileSync(join(cwd, ".memory", "repo.md"), "utf-8");
    expect(md).toMatch(/sessions: 1:[0-9a-f]{8}, 2:[0-9a-f]{8}/);
    expect(md).toContain("cost_usd: 0.113"); // raw cost, not rounded up
    expect(md).toContain("Chose plan 2 for auto-loading.");
    expect(md.startsWith("---\nupdated: ")).toBe(true);
  });

  it("uses the previous repo memory as context and only sends changed sessions", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "old session");
    sessionFile(cwd, 2, "second", "old session 2");
    // first update records both hashes
    await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "Memory v1.", cost: 0.0011 }]) });

    // session 2 regenerated with new content — must be re-incorporated
    sessionFile(cwd, 2, "second", "old session 2 — REGENERATED with new findings");
    sessionFile(cwd, 3, "third", "New session about auto-loading.");

    const calls: { system: string; user: string }[] = [];
    const llm = fakeLlm([{ text: "Memory v2.", cost: 0.0022 }], calls);
    const result = await updateRepoMemory({ cwd, llm });

    expect(result?.included.map((s) => s.index)).toEqual([2, 3]);
    expect(calls[0].user).toContain("Memory v1.");
    expect(calls[0].user).toContain("REGENERATED");
    expect(calls[0].user).toContain("New session about auto-loading.");
    expect(calls[0].user).not.toContain("old session 2\n"); // unchanged session not sent

    const memory = readRepoMemory(cwd);
    expect(memory?.costUsd).toBe(0.0033); // raw accumulation: 0.0011 + 0.0022
    expect(memory?.body).toBe("Memory v2.");
    expect(memory?.sessions.get(1)).toBe(hashSession(
      readFileSync(join(cwd, ".memory", "sessions", "1-first.md"), "utf-8"),
    ));
    expect(memory?.sessions.get(2)).not.toBe(memory?.sessions.get(1)); // new hash recorded
  });

  it("returns null when nothing changed since the last update", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "body");
    await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "Memory.", cost: 0 }]) });
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "x", cost: 0 }], calls) });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("strips frontmatter from session bodies sent to the model", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "Just the body.");
    const calls: { system: string; user: string }[] = [];
    await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "x", cost: 0 }], calls) });
    expect(calls[0].user).not.toContain("session: s-1");
    expect(calls[0].user).not.toContain("cost_usd");
  });

  it("tracks content hashes, not just indices — same index, new content is unprocessed", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "v1 content");
    await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "M1", cost: 0 }]) });

    sessionFile(cwd, 1, "first", "v2 content");
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm([{ text: "M2", cost: 0 }], calls) });
    expect(result?.included.map((s) => s.index)).toEqual([1]);
    expect(calls[0].user).toContain("v2 content");
  });
});

describe("repo prompt", () => {
  it("carries the privacy and succinctness rules, no Name line", () => {
    const { system, user } = buildRepoPrompt({
      existingBody: "prev",
      sessions: ["s1"],
    });
    expect(system).toContain("succinct and direct");
    expect(user).toContain("Never include private data");
    expect(user).toContain("keep it succinct");
    expect(user).not.toContain("Name:");
  });
});
