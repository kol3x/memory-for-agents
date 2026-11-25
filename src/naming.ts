import type { NormalizedTranscript } from "./types.js";

/**
 * Human-readable session naming: slug derived from the first user message
 * (the session's stated intent), prefixed with a numeric index on disk so
 * files sort in chronological order.
 */

export function sessionName(transcript: NormalizedTranscript): string {
  const first = transcript.messages.find((m) => m.role === "user" && m.text)?.text;
  return slugify(first ?? "untitled session");
}

export function slugify(text: string, maxWords = 6, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug || "untitled";
}
