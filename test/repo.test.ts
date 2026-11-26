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

function fakeLlm(responses: string[], calls: { system: string; user: string }[] = []): any {
  let i = 0;
  return async (opts: { system: string; user: string }) => {
    calls.push(opts);
    return { text: responses[i++] ?? "no more canned responses" } satisfies LlmResponse;
  };
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "repo-memory-"));
  mkdirSync(join(cwd, ".memory", "sessions"), { recursive: true });
  return cwd;
}

function sessionFile(
  cwd: string,
  index: number,
  name: string,
  body: string,
  cost = 0.1,
  field = "session_cost_usd",
): void {
  writeFileSync(
    join(cwd, ".memory", "sessions", `${index}-${name}.md`),
    `---\nsession: s-${index}\nname: ${name}\nindex: ${index}\n${field}: ${cost}\n---\n\n${body}\n`,
  );
}

describe("repo memory update", () => {
  it("incorporates all sessions; cost = sum of session costs", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "Built the session summary layer.", 0.22);
    sessionFile(cwd, 2, "second", "Added the repo memory layer.", 0.08);

    const calls: { system: string; user: string }[] = [];
    const llm = fakeLlm(["Chose plan 2 for auto-loading."], calls);
    const result = await updateRepoMemory({ cwd, llm });

    expect(result?.included.map((s) => s.index)).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("Built the session summary layer.");
    expect(calls[0].user).toContain("Added the repo memory layer.");

    const md = readFileSync(join(cwd, ".memory", "repo.md"), "utf-8");
    expect(md).toMatch(/sessions: 1:[0-9a-f]{8}:0.22, 2:[0-9a-f]{8}:0.08/);
    expect(md).toContain("sessions_cost_usd: 0.3"); // 0.22 + 0.08
    expect(md).not.toMatch(/^cost_usd:/m); // old ambiguous name gone
    expect(md).toContain("Chose plan 2 for auto-loading.");
    expect(md.startsWith("---\nupdated: ")).toBe(true);
  });

  it("uses the previous repo memory as context and only sends changed sessions", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "old session", 0.22);
    sessionFile(cwd, 2, "second", "old session 2", 0.08);
    await updateRepoMemory({ cwd, llm: fakeLlm(["Memory v1."]) });

    // session 2 regenerated with new content and a new cost — must be
    // re-incorporated and its cost contribution replaced, not re-added
    sessionFile(cwd, 2, "second", "old session 2 — REGENERATED with new findings", 0.15);
    sessionFile(cwd, 3, "third", "New session about auto-loading.", 0.05);

    const calls: { system: string; user: string }[] = [];
    const llm = fakeLlm(["Memory v2."], calls);
    const result = await updateRepoMemory({ cwd, llm });

    expect(result?.included.map((s) => s.index)).toEqual([2, 3]);
    expect(calls[0].user).toContain("Memory v1.");
    expect(calls[0].user).toContain("REGENERATED");
    expect(calls[0].user).toContain("New session about auto-loading.");
    expect(calls[0].user).not.toContain("old session 2\n"); // unchanged session not sent

    const memory = readRepoMemory(cwd);
    expect(memory?.costUsd).toBe(0.42); // 0.22 + 0.15 (replaced) + 0.05
    expect(memory?.body).toBe("Memory v2.");
    expect(memory?.sessions.get(2)?.cost).toBe(0.15);
    expect(memory?.sessions.get(1)?.hash).toBe(hashSession(
      readFileSync(join(cwd, ".memory", "sessions", "1-first.md"), "utf-8"),
    ));
  });

  it("returns null when nothing changed since the last update", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "body");
    await updateRepoMemory({ cwd, llm: fakeLlm(["Memory."]) });
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm(["x"], calls) });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("strips frontmatter from session bodies sent to the model", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "Just the body.");
    const calls: { system: string; user: string }[] = [];
    await updateRepoMemory({ cwd, llm: fakeLlm(["x"], calls) });
    expect(calls[0].user).not.toContain("session: s-1");
    expect(calls[0].user).not.toContain("cost_usd");
  });

  it("tracks content hashes — same index, new content is unprocessed", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "v1 content");
    await updateRepoMemory({ cwd, llm: fakeLlm(["M1"]) });

    sessionFile(cwd, 1, "first", "v2 content", 0.3);
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm(["M2"], calls) });
    expect(result?.included.map((s) => s.index)).toEqual([1]);
    expect(calls[0].user).toContain("v2 content");

    const memory = readRepoMemory(cwd);
    expect(memory?.costUsd).toBe(0.3); // replaced, not accumulated
  });

  it("reads legacy cost_usd session files too", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "body", 0.25, "cost_usd");
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm(["M"], calls) });
    expect(result?.included.map((s) => s.index)).toEqual([1]);
    expect(readRepoMemory(cwd)?.costUsd).toBe(0.25);
  });

  it("migrates legacy entries without costs by re-incorporating them — even with matching hash", async () => {
    const cwd = makeRepo();
    sessionFile(cwd, 1, "first", "body", 0.25);
    const hash = hashSession(readFileSync(join(cwd, ".memory", "sessions", "1-first.md"), "utf-8"));
    writeFileSync(
      join(cwd, ".memory", "repo.md"),
      `---\nupdated: t\nsessions: 1:${hash}\ncost_usd: 0.01\n---\n\nOld memory.\n`,
    );
    const calls: { system: string; user: string }[] = [];
    const result = await updateRepoMemory({ cwd, llm: fakeLlm(["New memory."], calls) });

    expect(result?.included.map((s) => s.index)).toEqual([1]); // no recorded cost → re-incorporate
    const memory = readRepoMemory(cwd);
    expect(memory?.costUsd).toBe(0.25); // ledger rebuilt from session costs
    expect(memory?.sessions.get(1)?.cost).toBe(0.25);
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
