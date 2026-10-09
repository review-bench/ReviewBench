import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { candidateIdentityProblem, loadCandidateFindings } from "../eval/input-validation.js";
import { outputSidecarPath } from "../eval/output-paths.js";
import type { AggregateMetrics } from "../eval/scorer.js";
import type { ManifestEntry } from "../lib/types.js";
import { prKey } from "../lib/types.js";
import { toRewards, type TaskIdentity } from "./rewards.js";

export interface VerifierTask extends TaskIdentity {
  pr: ManifestEntry;
  provider: string;
  model: string;
}

export interface VerifierPaths {
  candidate: string;
  snapshot: string;
  golden: string;
  manifest: string;
  output: string;
  reward: string;
}

export function validateCandidate(path: string, expected: ManifestEntry): void {
  if (!lstatSync(path).isFile()) throw new Error("Findings artifact must be a regular file");
  const loaded = loadCandidateFindings(path);
  if (loaded.stats.files_loaded !== 1 || loaded.byPR.size !== 1 || loaded.stats.skipped_files.length) {
    throw new Error(`Expected one valid findings file: ${JSON.stringify(loaded.stats.skipped_files)}`);
  }
  const candidate = [...loaded.byPR.values()][0];
  const problem = candidateIdentityProblem(candidate.pr, expected);
  if (problem) throw new Error(problem);
  const raw: { agent?: unknown } = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw.agent !== "string" || !raw.agent.trim()) throw new Error("agent must be non-empty");
  for (const [index, finding] of candidate.findings.entries()) {
    if (!finding.file || finding.file.includes("\\") || finding.file.includes(":") ||
        finding.file.split("/").some((part) => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(finding.start_line) || !Number.isSafeInteger(finding.end_line) ||
        finding.start_line < 1 || finding.end_line < finding.start_line ||
        !finding.message.trim() || !finding.producer.trim()) {
      throw new Error(`Invalid findings[${index}]: require a relative path, positive line range, message and producer`);
    }
  }
}

export function verifyTask(task: VerifierTask, paths: VerifierPaths): void {
  mkdirSync(dirname(paths.reward), { recursive: true });
  // A retry must never consume an earlier success or a stale judge checkpoint.
  for (const path of [paths.reward, paths.output, outputSidecarPath(paths.output, "checkpoint"), outputSidecarPath(paths.output, "details")]) {
    rmSync(path, { force: true });
  }
  validateCandidate(paths.candidate, task.pr);
  const judgeDir = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync(process.execPath, [
    "--import", "tsx", resolve(judgeDir, "scripts", "eval", "eval.ts"),
    "--candidate", paths.candidate, "--golden", paths.golden,
    "--manifest", paths.manifest, "--snapshot-dir", paths.snapshot,
    "--provider", task.provider, "--model", task.model,
    "--output", paths.output, "--strict", "--allow-empty",
  ], {
    cwd: judgeDir,
    stdio: "inherit",
    env: { ...process.env, RB_DELETE_GOLDEN_AFTER_LOAD: "1" },
  });
  const result: AggregateMetrics = JSON.parse(readFileSync(paths.output, "utf8"));
  if (result.pr_count !== 1 || result.per_pr.length !== 1 || result.per_pr[0].pr_key !== prKey(task.pr)) {
    throw new Error("Judge did not produce exactly the expected PR score");
  }
  writeFileSync(paths.reward, JSON.stringify(toRewards(result.per_pr[0], task), null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: verify.ts /tests/task.json");
    const task: VerifierTask = JSON.parse(readFileSync(process.argv[2], "utf8"));
    verifyTask(task, {
      candidate: "/work/out/findings.json",
      snapshot: "/work/repo",
      golden: "/tests/golden",
      manifest: "/tests/manifest.json",
      output: "/logs/verifier/scores.json",
      reward: "/logs/verifier/reward.json",
    });
  } catch (error) {
    console.error("ReviewBench verifier failed:", error);
    process.exitCode = 1;
  }
}
