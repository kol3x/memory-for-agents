import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { bashMutationKind, classifyTool, extractEditPaths, gitHistory, scorecard } from "../src/triage.js";
import type { GitCommit } from "../src/triage.js";
import type { DiscoveredSession } from "../src/discovery.js";
import type { NormalizedTranscript } from "../src/types.js";

const REPO = "/repo";

function fakeSession(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    ref: "test:1",
    agent: "pi",
    sessionId: "s-1",
    startedAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T11:00:00Z",
    load: () => fakeTranscript(),
    ...over,
  };
}

function fakeTranscript(over: Partial<NormalizedTranscript> = {}): NormalizedTranscript {
  return {
    sessionId: "s-1",
    agent: "pi",
    startedAt: "2026-06-01T10:00:00Z",
    messages: [
      { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "add dark mode" },
      { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "done" },
    ],
    ...over,
  };
}

describe("classifyTool", () => {
  it("buckets known tool families", () => {
    expect(classifyTool("edit")).toBe("write");
    expect(classifyTool("write")).toBe("write");
    expect(classifyTool("patch")).toBe("write");
    expect(classifyTool("read")).toBe("read");
    expect(classifyTool("grep")).toBe("read");
    expect(classifyTool("websearch")).toBe("read");
    expect(classifyTool("bash")).toBe("bash");
    expect(classifyTool("todowrite")).toBe("other");
    expect(classifyTool("playwright_browser_click")).toBe("other");
    expect(classifyTool("cloudflare-docs_search_cloudflare_documentation")).toBe("other");
  });
});

describe("bashMutationKind", () => {
  it("counts in-repo content mutations", () => {
    expect(bashMutationKind("sed -i 's/a/b/' src/f.ts", REPO)).toBe("content");
    expect(bashMutationKind("rm -rf build", REPO)).toBe("content");
    expect(bashMutationKind("echo hi > out.txt", REPO)).toBe("content");
  });
  it("does not count stderr guards or fd dups as redirects", () => {
    expect(bashMutationKind("git log --oneline main..x 2>/dev/null; echo done", REPO)).toBeNull();
    expect(bashMutationKind("ls -la .env* 2>/dev/null || echo none", REPO)).toBeNull();
    expect(bashMutationKind("cmd > log 2>&1", REPO)).toBe("content");
    expect(bashMutationKind("git show abc 2>&1 | head", REPO)).toBeNull();
  });
  it("buckets infra ops separately", () => {
    expect(bashMutationKind("npm install --save-dev wrangler@4.126.0", REPO)).toBe("infra");
    expect(bashMutationKind("git pull && git push", REPO)).toBe("infra");
    expect(bashMutationKind("curl -s https://api.github.com/users/x", REPO)).toBe("infra");
    expect(bashMutationKind("git add src/index.ts && git commit -m x", REPO)).toBe("infra");
  });
  it("ignores mutations targeting outside the repo", () => {
    expect(bashMutationKind("rm -rf /tmp/pawmc-codeql && codeql database create /tmp/pawmc-codeql", REPO)).toBeNull();
    expect(bashMutationKind("cat << 'EOF' > /tmp/check.sh", REPO)).toBeNull();
    expect(bashMutationKind("echo x > /repo/src/f.ts", REPO)).toBe("content");
  });
  it("returns null for pure reads", () => {
    expect(bashMutationKind("find . -name '*.ts' | head -50", REPO)).toBeNull();
    expect(bashMutationKind("cat src/index.ts", REPO)).toBeNull();
    expect(bashMutationKind("git status", REPO)).toBeNull();
  });
});

describe("extractEditPaths", () => {
  it("splits inside (repo-relative) from outside paths", () => {
    const { inside, outside } = extractEditPaths(
      [
        { path: "src/index.ts" },
        { filePath: "/repo/web/app.svelte" },
        { filePath: "/elsewhere/outside.ts" },
        { nested: [{ filename: "a/b.md" }] },
      ],
      REPO,
    );
    expect(inside).toEqual(["src/index.ts", "web/app.svelte", "a/b.md"]);
    expect(outside).toEqual(["/elsewhere/outside.ts"]);
  });
});

describe("gitHistory", () => {
  it("parses every commit with its files (no dropped commits)", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-git-"));
    const run = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
    try {
      run("init", "-q");
      run("config", "user.email", "t@t");
      run("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "1");
      run("add", ".");
      run("commit", "-q", "-m", "first");
      writeFileSync(join(dir, "b.txt"), "2");
      run("add", ".");
      run("commit", "-q", "-m", "second");
      const hist = gitHistory(dir);
      expect(hist.length).toBe(2);
      expect(hist[0].files).toEqual(["b.txt"]); // newest first
      expect(hist[1].files).toEqual(["a.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scorecard verdicts", () => {
  const edit = { id: "1", name: "edit", arguments: { path: "src/index.ts" } };
  const read = { id: "2", name: "grep", arguments: {} };
  const commitAt = (iso: string, files: string[] = ["src/index.ts"]): GitCommit => ({
    ts: Date.parse(iso),
    files,
  });

  it("keeps sessions containing commits when the session also made changes", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "ship it" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [edit] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [commitAt("2026-06-01T10:05:00Z")], REPO);
    expect(sc.verdict).toBe("keep");
    expect(sc.commits).toBe(1);
  });

  it("skips a commit-window session with no changes (parallel-session false positive)", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "brainstorming" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "thoughts", toolCalls: [read] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [commitAt("2026-06-01T10:05:00Z")], REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.reason).toContain("no file changes");
  });

  it("skips a commit-only session (bookkeeping — edits belong to their session)", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "commit this" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [
          { id: "3", name: "bash", arguments: { command: "git add -A && git commit -m 'x'" } },
        ] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [commitAt("2026-06-01T10:05:00Z")], REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.tools.bashInfra).toBe(1);
  });

  it("keeps an edit+commit session", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "fix and commit" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [
          edit,
          { id: "3", name: "bash", arguments: { command: "git add -A && git commit -m 'x'" } },
        ] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [commitAt("2026-06-01T10:05:00Z")], REPO);
    expect(sc.verdict).toBe("keep");
  });

  it("skips read-only sessions regardless of size", () => {
    const t = fakeTranscript({
      spend: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 500_000 }, costUsd: 1 },
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "explore the pipeline" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:33:00Z"), text: "notes", toolCalls: [read] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [], REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.reason).toContain("no file changes");
  });

  it("skips dropped work: edits whose files are never touched by later commits", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "try a refactor" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "hm", toolCalls: [edit] },
      ],
    });
    // later commit touches only an unrelated file
    const history = [commitAt("2026-06-03T10:00:00Z", ["other/file.ts"])];
    const sc = scorecard(fakeSession(), t, history, REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.reason).toContain("never landed");
    expect(sc.landedLater).toBe(false);
  });

  it("keeps edits that landed in later commits (no commits in window)", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "do the thing" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [edit] },
      ],
    });
    const history = [commitAt("2026-06-03T10:00:00Z", ["src/index.ts"])];
    const sc = scorecard(fakeSession(), t, history, REPO);
    expect(sc.verdict).toBe("keep");
    expect(sc.reason).toContain("landed in later commits");
    expect(sc.landedLater).toBe(true);
  });

  it("ignores commits before the window for the landed check (strictly later only)", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "do the thing" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [edit] },
      ],
    });
    // the commit predates the session → cannot be this session's landing
    const history = [commitAt("2026-06-01T09:50:00Z", ["src/index.ts"])];
    const sc = scorecard(fakeSession(), t, history, REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.landedLater).toBe(false);
  });

  it("skips sessions whose edits all happened in another repo", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "fork it" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [
          { id: "5", name: "edit", arguments: { filePath: "/other/repo/src/x.ts" } },
        ] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [], REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.reason).toContain("another repo");
    expect(sc.outsideEdits).toBe(1);
  });

  it("defaults untraceable changes to skip", () => {
    const t = fakeTranscript({
      messages: [
        { role: "user", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "patch it" },
        { role: "assistant", timestamp: Date.parse("2026-06-01T10:10:00Z"), text: "ok", toolCalls: [
          { id: "4", name: "apply_patch", arguments: { diff: "+++ b/foo.ts" } },
        ] },
      ],
    });
    const sc = scorecard(fakeSession(), t, [], REPO);
    expect(sc.verdict).toBe("skip");
    expect(sc.reason).toContain("ambiguous");
  });

  it("skips sessions with no user content", () => {
    const t = fakeTranscript({ messages: [{ role: "assistant", timestamp: Date.parse("2026-06-01T10:00:00Z"), text: "hi" }] });
    const sc = scorecard(fakeSession(), t, [], REPO);
    expect(sc.verdict).toBe("skip");
  });
});
