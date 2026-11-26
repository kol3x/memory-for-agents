import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syncAgents,
  renderBlock,
  BLOCK_BEGIN,
  BLOCK_END,
} from "../src/agents.js";

const REPO_MD =
  "---\nupdated: 2026-11-26T13:45:47.142Z\nsessions: 1:1fa4bf8c:0.22\nsessions_cost_usd: 0.22\n---\n\nMemory body v1.\n";

function makeRepo(repoMd?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "agent-sync-"));
  if (repoMd !== undefined) {
    mkdirSync(join(cwd, ".memory"), { recursive: true });
    writeFileSync(join(cwd, ".memory", "repo.md"), repoMd);
  }
  return cwd;
}

describe("agent entry-point sync", () => {
  it("creates AGENTS.md with the managed block when absent", () => {
    const cwd = makeRepo(REPO_MD);
    const result = syncAgents(cwd);
    expect(result?.agentsMd).toBe("created");
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(md).toContain(BLOCK_BEGIN);
    expect(md).toContain("Memory body v1.");
    expect(md).toContain("updated: 2026-11-26T13:45:47.142Z");
    expect(md).toContain(BLOCK_END);
  });

  it("injects the block into an existing AGENTS.md, preserving user content", () => {
    const cwd = makeRepo(REPO_MD);
    writeFileSync(join(cwd, "AGENTS.md"), "# Standing rules\n\n- Be nice.\n");
    const result = syncAgents(cwd);
    expect(result?.agentsMd).toBe("updated");
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(md).toContain("# Standing rules");
    expect(md).toContain("- Be nice.");
    expect(md).toContain("Memory body v1.");
    expect(md.indexOf("# Standing rules")).toBeLessThan(md.indexOf("Memory body v1."));
  });

  it("replaces an existing managed block in place and is idempotent", () => {
    const cwd = makeRepo(REPO_MD);
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `# Rules\n\n${renderBlock("Stale memory.", "2026-11-01T00:00:00.000Z")}\n- Be nice.\n`,
    );
    syncAgents(cwd);
    const md = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(md).toContain("Memory body v1.");
    expect(md).not.toContain("Stale memory.");
    expect(md).toContain("# Rules");
    expect(md).toContain("- Be nice.");

    // second sync — same content, no write (agentsMd unchanged)
    const again = syncAgents(cwd);
    expect(again?.agentsMd).toBe("unchanged");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(md);
  });

  it("creates shims only on demand, refreshes existing ones, skips user-owned", () => {
    const cwd = makeRepo(REPO_MD);

    // nothing created without --agents
    let result = syncAgents(cwd);
    expect(result?.shimsCreated).toEqual([]);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, "GEMINI.md"))).toBe(false);

    // on demand
    result = syncAgents(cwd, ["claude"]);
    expect(result?.shimsCreated).toEqual(["claude"]);
    const claude = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("memory-for-agents:shim agent=claude");
    expect(claude).toContain("@.memory/repo.md");

    // user-owned GEMINI.md is never touched, even when requested
    writeFileSync(join(cwd, "GEMINI.md"), "# My own Gemini notes\n");
    result = syncAgents(cwd, ["claude", "gemini"]);
    expect(result?.shimsCreated).toEqual([]); // claude exists now
    expect(result?.shimsSkipped).toEqual(["gemini"]);
    expect(readFileSync(join(cwd, "GEMINI.md"), "utf-8")).toBe("# My own Gemini notes\n");

    // auto-chain keeps existing shims fresh (content unchanged → no refresh)
    result = syncAgents(cwd);
    expect(result?.shimsRefreshed).toEqual([]);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toBe(claude);
  });

  it("is a no-op when there is no repo memory", () => {
    const cwd = makeRepo();
    expect(syncAgents(cwd, ["claude"])).toBeNull();
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });
});
