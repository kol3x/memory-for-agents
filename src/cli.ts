#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parsePiSession } from "./adapters/pi.js";
import { runPipeline } from "./pipeline.js";
import { updateRepoMemory } from "./repo.js";
import { syncAgents } from "./agents.js";
import { openRouterClient } from "./summarizer.js";
import { sessionName, slugify } from "./naming.js";
import {
  renderMarkdown,
  summaryPath,
  inputPath,
  debugDir,
  debugFileName,
  findExistingSummary,
  nextIndex,
  roundCostUp,
} from "./writer.js";

/**
 * Usage:
 *   npx tsx src/cli.ts <session.jsonl> [--debug] [--existing <summary-file>]
 *   npx tsx src/cli.ts --repo
 *   npx tsx src/cli.ts --sync-agents [--agents claude,gemini]
 *
 * Env:
 *   OPENROUTER_API_KEY   required (except for --sync-agents)
 *   OPENROUTER_MODEL     default: z-ai/glm-5.3-flash
 */

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let debug = false;
  let existing: string | undefined;
  let repo = false;
  let syncAgentsFlag = false;
  let agents: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--debug") debug = true;
    else if (a === "--existing") existing = argv[++i];
    else if (a === "--repo") repo = true;
    else if (a === "--sync-agents") syncAgentsFlag = true;
    else if (a === "--agents") agents = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else positional.push(a);
  }
  return { positional, debug, existing, repo, syncAgentsFlag, agents };
}

function reportSync(cwd: string, agents: string[]) {
  const sync = syncAgents(cwd, agents);
  if (!sync) {
    console.log("no repo memory yet — agent entry points not synced");
    return;
  }
  if (sync.agentsMd !== "unchanged") console.log(`AGENTS.md ${sync.agentsMd} (memory block)`);
  if (sync.shimsCreated.length) console.log(`shims created: ${sync.shimsCreated.join(", ")}`);
  if (sync.shimsRefreshed.length) console.log(`shims refreshed: ${sync.shimsRefreshed.join(", ")}`);
  if (sync.shimsSkipped.length)
    console.log(`shims skipped (user-owned): ${sync.shimsSkipped.join(", ")}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionPath = args.positional[0];

  // --sync-agents is LLM-free: pure file transformation
  if (args.syncAgentsFlag) {
    reportSync(process.cwd(), args.agents);
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set");
    process.exit(1);
  }
  const model = process.env.OPENROUTER_MODEL ?? "z-ai/glm-5.3-flash";
  const llm = openRouterClient({ apiKey, model });

  if (args.repo) {
    const result = await updateRepoMemory({ cwd: process.cwd(), llm });
    if (result) {
      console.log(`incorporated sessions: ${result.included.map((s) => s.index).join(", ")}`);
      console.log(".memory/repo.md");
    } else {
      console.log("repo memory already up to date");
    }
    reportSync(process.cwd(), args.agents);
    return;
  }

  if (!sessionPath) {
    console.error(
      "usage: npx tsx src/cli.ts <session.jsonl> [--debug] [--existing <file>] | --repo | --sync-agents [--agents claude,gemini]",
    );
    process.exit(1);
  }

  const jsonl = readFileSync(sessionPath, "utf-8");
  const transcript = parsePiSession(jsonl);
  if (!transcript.sessionId) {
    console.error("not a pi session file (no session header found)");
    process.exit(1);
  }

  let existingSummary: string | undefined;
  if (args.existing) existingSummary = readFileSync(args.existing, "utf-8").trim();

  const result = await runPipeline(transcript, { llm, existingSummary, debug: args.debug });

  const cwd = transcript.cwd ?? process.cwd();

  if (args.debug) {
    const dir = debugDir(cwd, result.sessionId);
    mkdirSync(dir, { recursive: true });
    for (const [i, step] of result.steps.entries()) {
      writeFileSync(`${dir}/${debugFileName(i, step.name)}`, step.content);
    }
    console.error(`debug artifacts: ${dir}/`);
  }

  // reuse index+name if this session already has a summary; else allocate next index
  const existing = findExistingSummary(cwd, result.sessionId);
  const name =
    existing?.name ??
    (result.name ? slugify(result.name) : sessionName(transcript));
  const index = existing?.index ?? nextIndex(cwd);

  // shaped no-tools input — transparency artifact, never committed
  const inputFile = inputPath(cwd, index, name);
  mkdirSync(dirname(inputFile), { recursive: true });
  writeFileSync(inputFile, result.input + "\n");

  const file = summaryPath(cwd, index, name);
  mkdirSync(dirname(file), { recursive: true });
  const spend = transcript.spend;
  const md = renderMarkdown(
    {
      session: result.sessionId,
      name,
      index,
      date: transcript.startedAt,
      agent: transcript.agent,
      model: transcript.model,
      session_cost_usd: spend ? roundCostUp(spend.costUsd) : 0,
    },
    result.summary,
  );
  writeFileSync(file, md);
  console.log(file);
  console.log(inputFile);

  // keep the repo memory current on every session update — re-incorporates
  // this (and any other changed) session summary. Non-fatal on failure.
  try {
    const repoResult = await updateRepoMemory({ cwd, llm });
    if (repoResult) {
      console.log(
        `repo memory updated (sessions: ${repoResult.included.map((s) => s.index).join(", ")})`,
      );
    }
    // agent entry points follow the repo memory (managed block + existing
    // shims); shim creation stays on demand via --agents
    reportSync(cwd, args.agents);
  } catch (err) {
    console.error(`repo memory update failed: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
