import { describe, expect, it } from "vitest";
import { sessionName, slugify } from "../src/naming.js";
import { parsePiSession } from "../src/adapters/pi.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(join(__dirname, "fixtures", "pi-session.jsonl"), "utf-8");

describe("session naming", () => {
  it("derives the name from the first user message", () => {
    const t = parsePiSession(fixture);
    expect(sessionName(t)).toBe("add-a-login-endpoint-to-the");
  });

  it("falls back to untitled when there is no user text", () => {
    expect(sessionName({ sessionId: "x", messages: [] })).toBe("untitled-session");
  });

  it("slugify: lowercase, kebab, word and length caps", () => {
    expect(slugify("Hello, World! This is A TEST")).toBe("hello-world-this-is-a-test");
    expect(slugify(".*")).toBe("untitled");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});
