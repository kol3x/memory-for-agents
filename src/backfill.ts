import type { LlmClient } from "./summarizer.js";
import { runPipeline } from "./pipeline.js";
import { slugify, sessionName } from "./naming.js";
import {
  ensureGitignore,
  roundCostUp,
  writeSummaryArtifacts,
  findExistingSummary,
  nextIndex,
} from "./writer.js";
import type { DiscoveredSession } from "./discovery.js";

/**
 * Backfill: summarize historical sessions that triage marked keep.
 *
 * Concurrent (pool), skips sessions that already have a summary, writes
 * summaries + shaped inputs like the single-session flow, and leaves the
 * chained repo-memory update to the caller (one update for the whole run).
 * Indices are pre-allocated chronologically so files sort by session date
 * regardless of LLM completion order.
 */

export interface BackfillOptions {
  llm: LlmClient;
  concurrency?: number;
  /** process at most N sessions (pilot runs) */
  limit?: number;
  /** progress callback per completed session */
  onResult?: (o: BackfillOutcome) => void;
}

export interface BackfillOutcome {
  session: DiscoveredSession;
  status: "summarized" | "skipped-existing" | "failed";
  path?: string;
  name?: string;
  index?: number;
  error?: string;
}

export interface BackfillResult {
  outcomes: BackfillOutcome[];
  /** total USD spent by the backfill's own LLM calls */
  llmCostUsd: number;
  summarized: number;
  skippedExisting: number;
  failed: number;
  gitignore: "created" | "updated" | "unchanged";
}

/** async concurrency pool (fulfilled/rejected per item) */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

export async function runBackfill(
  sessions: DiscoveredSession[],
  cwd: string,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  // sessions without an existing summary, in chronological order
  const todo = sessions.filter((s) => findExistingSummary(cwd, s.sessionId) === null);
  const limited = opts.limit ? todo.slice(0, opts.limit) : todo;

  // pre-allocate indices so concurrent writes never race and files stay
  // chronological (discovery order = session start order)
  const base = nextIndex(cwd);
  const indexByRef = new Map(limited.map((s, i) => [s.ref, base + i]));

  let llmCostUsd = 0;
  const outcomes: BackfillOutcome[] = [];
  const gitignore = ensureGitignore(cwd);

  const results = await pool(limited, opts.concurrency ?? 5, async (session) => {
    const transcript = session.load();
    const result = await runPipeline(transcript, { llm: opts.llm });
    const name = slugify(result.name ?? session.title ?? sessionName(transcript));
    const index = indexByRef.get(session.ref) ?? nextIndex(cwd);
    const spend = transcript.spend;
    const written = writeSummaryArtifacts(cwd, {
      sessionId: result.sessionId,
      name,
      index,
      date: transcript.startedAt,
      agent: transcript.agent,
      model: transcript.model,
      sessionCostUsd: spend ? roundCostUp(spend.costUsd) : 0,
      input: result.input,
      summary: result.summary,
    });
    llmCostUsd += result.usage?.cost ?? 0;

    return {
      session,
      status: "summarized" as const,
      path: written.file,
      name,
      index,
    };
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const session = limited[i];
    if (r.status === "fulfilled") {
      outcomes.push(r.value);
      opts.onResult?.(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      const o: BackfillOutcome = { session, status: "failed", error: reason };
      outcomes.push(o);
      opts.onResult?.(o);
    }
  }

  // sessions not processed (skipped-existing or beyond limit)
  const doneRefs = new Set(outcomes.map((o) => o.session?.ref).filter(Boolean));
  for (const s of sessions) {
    if (doneRefs.has(s.ref)) continue;
    if (findExistingSummary(cwd, s.sessionId)) {
      const existing = findExistingSummary(cwd, s.sessionId)!;
      const o: BackfillOutcome = { session: s, status: "skipped-existing", path: existing.path };
      outcomes.push(o);
      opts.onResult?.(o);
    }
  }

  return {
    outcomes,
    llmCostUsd,
    summarized: outcomes.filter((o) => o.status === "summarized").length,
    skippedExisting: outcomes.filter((o) => o.status === "skipped-existing").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    gitignore,
  };
}
