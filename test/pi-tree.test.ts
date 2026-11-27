import { describe, expect, it } from "vitest";
import { parsePiSession } from "../src/adapters/pi.js";

/** build a pi jsonl with a session-tree branch */
function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

const header = { type: "session", version: 3, id: "s-1", timestamp: "2026-06-01T10:00:00Z" };
const msg = (id: string, parentId: string | null, role: string, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-06-01T10:0" + id + ":00Z",
  message: { role, content: [{ type: "text", text }] },
});

describe("parsePiSession session-tree awareness", () => {
  it("marks messages on abandoned branches, keeps the active path clean", () => {
    // linear order: 1(root) → 2(branch A) → 3(rewind to root) → 4(child of 3)
    // active chain from tip: 4 → 3 → 1; entry 2 is abandoned
    const t = parsePiSession(
      jsonl([
        header,
        msg("1", null, "user", "add dark mode"),
        msg("2", "1", "assistant", "branch A answer"),
        msg("3", "1", "user", "actually try a different approach"),
        msg("4", "3", "assistant", "branch B answer"),
      ]),
    );

    expect(t.messages.map((m) => m.branched ?? false)).toEqual([false, true, false, false]);
    expect(t.messages.map((m) => m.text)).toEqual([
      "add dark mode",
      "branch A answer",
      "actually try a different approach",
      "branch B answer",
    ]);
  });

  it("treats a fully linear session as all-active", () => {
    const t = parsePiSession(
      jsonl([header, msg("1", null, "user", "hi"), msg("2", "1", "assistant", "hello")]),
    );
    expect(t.messages.every((m) => !m.branched)).toBe(true);
  });

  it("walks parent chains through non-message entries (custom messages)", () => {
    // a mid-session custom_message sits between assistant A and user B —
    // the chain must not break there, or the head segment looks branched
    const t = parsePiSession(
      jsonl([
        header,
        msg("1", null, "user", "add dark mode"),
        msg("2", "1", "assistant", "working on it"),
        { type: "custom_message", id: "cm1", parentId: "2", content: "steer: keep it simple", customType: "", display: true, data: null },
        msg("3", "cm1", "user", "ok simpler please"),
        msg("4", "3", "assistant", "done simpler"),
      ]),
    );
    expect(t.messages.every((m) => !m.branched)).toBe(true);
    expect(t.messages).toHaveLength(4);
  });

  it("handles entries without ids gracefully (treated as active)", () => {
    const t = parsePiSession(
      jsonl([header, msg("1", null, "user", "hi"), { type: "message", message: { role: "assistant", content: "no id" } }]),
    );
    expect(t.messages.every((m) => !m.branched)).toBe(true);
    expect(t.messages).toHaveLength(2);
  });

  it("still accumulates usage and cost from branched messages", () => {
    const entry = (id: string, parentId: string | null, text: string, cost: number) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-06-01T10:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: cost } },
      },
    });
    const t = parsePiSession(
      jsonl([
        header,
        msg("1", null, "user", "q"),
        entry("2", "1", "abandoned", 0.01),
        entry("3", "1", "active", 0.02),
      ]),
    );
    expect(t.spend?.usage.totalTokens).toBe(30);
    expect(t.spend?.costUsd).toBeCloseTo(0.03, 6);
  });
});
