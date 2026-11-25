import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePiSession } from "../src/adapters/pi.js";

const fixture = readFileSync(join(__dirname, "fixtures", "pi-session.jsonl"), "utf-8");

describe("pi adapter", () => {
  const t = parsePiSession(fixture);

  it("extracts session header metadata", () => {
    expect(t.agent).toBe("pi");
    expect(t.sessionId).toBe("test-session-001");
    expect(t.cwd).toBe("/tmp/proj-x");
    expect(t.startedAt).toBe("2026-11-25T10:00:00.000Z");
    expect(t.model).toBe("test-model");
  });

  it("drops system preamble and harness entries", () => {
    expect(t.messages.every((m) => m.role !== ("system" as never))).toBe(true);
    expect(t.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "tool", "assistant", "user", "assistant", "tool",
    ]);
  });

  it("maps assistant tool calls and thinking", () => {
    const a = t.messages[1];
    expect(a.toolCalls).toHaveLength(2);
    expect(a.toolCalls?.[0]).toEqual({
      id: "call_a",
      name: "bash",
      arguments: { command: "ls src/" },
    });
    expect(a.thinking).toBe("I should look at the project structure first.");
    expect(a.text).toBe("");
  });

  it("maps tool results with error flag", () => {
    const r = t.messages[2];
    expect(r.toolName).toBe("bash");
    expect(r.toolCallId).toBe("call_a");
    expect(r.toolError).toBe(false);
    expect(r.toolOutput).toContain("server.ts");

    const err = t.messages[7];
    expect(err.toolError).toBe(true);
    expect(err.toolOutput).toContain("tests failed");
  });

  it("tolerates malformed lines", () => {
    const t2 = parsePiSession(fixture + "\n{not json}\n");
    expect(t2.sessionId).toBe("test-session-001");
  });
});
