import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePiSession } from "../src/adapters/pi.js";
import { shapeInput } from "../src/input.js";

const fixture = readFileSync(join(__dirname, "fixtures", "pi-session.jsonl"), "utf-8");
const transcript = parsePiSession(fixture);

describe("input shaping", () => {
  it("keeps user and assistant text only", () => {
    const input = shapeInput(transcript);
    expect(input).toContain("[user] Add a login endpoint");
    expect(input).toContain("[assistant] I will use jsonwebtoken");
    expect(input).toContain("[assistant] Done. Added POST /login");
  });

  it("strips all tool activity — always, by design", () => {
    const input = shapeInput(transcript);
    expect(input).not.toContain("[tool result");
    expect(input).not.toContain("[assistant toolCall]");
    expect(input).not.toContain("tests failed");
    // assistant messages that were tool-only disappear
    const expected = transcript.messages.filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.text,
    ).length;
    expect(input.split("\n\n")).toHaveLength(expected);
  });

  it("never leaks thinking blocks", () => {
    expect(shapeInput(transcript)).not.toContain("project structure first");
  });
});

  it("excludes branched (abandoned session-tree) messages", () => {
    const input = shapeInput({
      messages: [
        { role: "user", text: "retracted question", branched: true },
        { role: "assistant", text: "retracted answer", branched: true },
        { role: "user", text: "the real question" },
        { role: "assistant", text: "the real answer" },
      ],
    });
    expect(input).toBe("[user] the real question\n\n[assistant] the real answer");
  });
