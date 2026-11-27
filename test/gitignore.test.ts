import { describe, expect, it, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { ensureGitignore, LOCAL_ARTIFACTS } from "../src/writer.js";

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "gitignore-"));
});

describe("ensureGitignore", () => {
  it("creates .gitignore with the block when missing", () => {
    const state = ensureGitignore(cwd);
    expect(state).toBe("created");
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    for (const entry of LOCAL_ARTIFACTS) expect(content).toContain(entry);
  });

  it("is a true no-op when the block is already present", () => {
    expect(ensureGitignore(cwd)).toBe("unchanged");
  });

  it("appends the block without touching user content", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitignore-"));
    const file = join(dir, ".gitignore");
    writeFileSync(file, "node_modules/\n.env\n");
    expect(ensureGitignore(dir)).toBe("updated");
    const content = readFileSync(file, "utf-8");
    expect(content.startsWith("node_modules/\n.env\n")).toBe(true);
    expect(content).toContain(".memory/inputs/");
  });

  it("replaces a stale managed block in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitignore-"));
    const file = join(dir, ".gitignore");
    writeFileSync(
      file,
      "keep-me/\n# memory-for-agents:begin (local artifacts — never commit)\n.memory/old/\n# memory-for-agents:end\nkeep-me-too/\n",
    );
    expect(ensureGitignore(dir)).toBe("updated");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("keep-me/");
    expect(content).toContain("keep-me-too/");
    expect(content).not.toContain(".memory/old/");
    expect(content).toContain(".memory/triage/manifest.md");
    // exactly one block
    expect(content.match(/memory-for-agents:begin/g)).toHaveLength(1);
  });

  it("lists the artifact set we rely on", () => {
    expect(LOCAL_ARTIFACTS).toContain(".memory/inputs/");
    expect(LOCAL_ARTIFACTS).toContain(".memory/debug/");
    expect(LOCAL_ARTIFACTS).toContain(".memory/triage/manifest.md");
    expect(existsSync(join(cwd, ".gitignore"))).toBe(true);
  });
});
