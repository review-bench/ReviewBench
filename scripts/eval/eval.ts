#!/usr/bin/env npx tsx

/**
 * Evaluate a candidate agent's findings against the golden set.
 *
 * 1. Match candidate findings against the golden set
 * 2. Classify unmatched candidate findings
 * 3. Score (grounded + augmented metrics)
 * 4. Optionally ingest novel TPs back into the golden set
 *
 * Supports concurrency, checkpointing, and resumption.
 *
 * Usage:
 *   npm run judge -- [options]
 *
 * Options:
 *   --candidate <path>   Candidate findings (file or directory)
 *   --golden <path>      Golden set directory (default: golden/)
 *   --output <path>      Output file for scores (default: scoring/results.json)
 *   --ingest             Also ingest novel TPs into the golden set
 *   --concurrency <n>    Max concurrent PRs (default: 1)
 *   --limit <n>          Process at most N PRs
 *   --strict             Fail on malformed inputs or empty/non-overlapping runs (default)
 *   --no-strict          Warn and continue on malformed inputs where possible
 *   --allow-empty        Allow intentional dry/no-op runs with no candidates/overlap
 *   --provider <name>    Exact LLM provider for matcher/classifier (required)
 *   --model <id>         Exact LLM model ID (required)
 *   --repo-dir <path>    Repo checkout directory (default: /tmp/review-repos)
 *   --exclude-producer <prefix>
 *                        Drop golden findings whose producer starts with <prefix>
 *                        before matching and scoring (repeatable; see docs/JUDGING.md)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, resolve } from "path";

import { dedup, merge, type GoldenSet } from "../golden/pipeline.js";
import { classifyFindings } from "../golden/classify-adapter.js";
import { resolveForScoring } from "../lib/match-types.js";
import { scorePR, aggregate, type ClassifiedFinding, type CorpusStats, type EvalConfig, type PRScoringInput, type PRScoreResult } from "./scorer.js";
import { printSummary } from "./print-summary.js";
import { MATCHER_SYSTEM_PROMPT } from "./matcher.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "../classifier/prompts.js";
import { renderJudgeSystemPrompt } from "./prompt-format.js";
import {
  buildUnmatchedClassificationMap,
  selectNovelTruePositives,
} from "./unmatched-classifications.js";
import {
  buildEvalInputSummary,
  candidateIdentityProblem,
  loadCandidateFindings,
  strictInputProblems,
  type PRFindings,
} from "./input-validation.js";
import { askJudge, JUDGE_CALL_PER_FINDING_MS, JUDGE_CALL_TIMEOUT_MS } from "./judge-call.js";
import type { ManifestEntry } from "../lib/types.js";
import { prKey } from "../lib/types.js";
import { aggregateCandidateUsage } from "../lib/usage.js";
import { checkpointFingerprint } from "./checkpoint-fingerprint.js";
import { outputSidecarPath } from "./output-paths.js";
import { excludeGoldenProducers, normalizeProducerPrefixes } from "./exclude-producers.js";

// ---------------------------------------------------------------------------
// Detailed per-finding output
// ---------------------------------------------------------------------------

interface FindingDetail {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  status: "matched_tp" | "matched_fp" | "novel_tp" | "novel_fp";
  matched_golden_index?: number;
  /** Every golden the matcher said this finding covers; recall counts all of them, the scored match is the first free one. */
  covered_golden_indices: number[];
  golden_tp_fp?: "tp" | "fp";
  golden_severity?: string;
  golden_category?: string;
  classifier_tp_fp?: "tp" | "fp";
  classifier_severity?: string;
  classifier_category?: string;
  matched_to_ground_truth: boolean;
  llm_judged_match: boolean;
  match_method: "llm" | "none";
  matched_truth_label?: "tp" | "fp";
  llm_classification?: "tp" | "fp";
  result_severity?: string;
  result_category?: string;
}

interface PRDetailedOutput {
  pr_key: string;
  candidate_findings: FindingDetail[];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  candidatePath: string;
  goldenDir: string;
  manifestPath: string;
  output: string;
  ingest: boolean;
  concurrency: number;
  limit: number;
  strict: boolean;
  allowEmpty: boolean;
  provider: string;
  modelId: string;
  repoDir: string;
  excludeProducers: string[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    candidatePath: "",
    goldenDir: "golden",
    manifestPath: "corpus/manifest.json",
    output: "scoring/results.json",
    ingest: false,
    concurrency: 1,
    limit: Infinity,
    strict: true,
    allowEmpty: false,
    provider: "",
    modelId: "",
    repoDir: "/tmp/review-repos",
    excludeProducers: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--candidate":
        opts.candidatePath = args[++i];
        break;
      case "--golden":
        opts.goldenDir = args[++i];
        break;
      case "--manifest":
        opts.manifestPath = args[++i];
        break;
      case "--output":
        opts.output = args[++i];
        break;
      case "--ingest":
        opts.ingest = true;
        break;
      case "--concurrency":
        opts.concurrency = parseInt(args[++i], 10);
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--no-strict":
        opts.strict = false;
        break;
      case "--allow-empty":
        opts.allowEmpty = true;
        break;
      case "--provider":
        opts.provider = args[++i];
        break;
      case "--model":
        opts.modelId = args[++i];
        break;
      case "--repo-dir":
        opts.repoDir = args[++i];
        break;
      case "--exclude-producer":
        opts.excludeProducers.push(args[++i] ?? "");
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.candidatePath) {
    console.error("--candidate is required");
    process.exit(1);
  }
  if (!opts.provider || !opts.modelId) {
    console.error("--provider and --model are required");
    process.exit(1);
  }
  try {
    opts.excludeProducers = normalizeProducerPrefixes(opts.excludeProducers);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (opts.ingest && opts.excludeProducers.length > 0) {
    // Ingest writes the in-memory golden set back to disk, which would drop the excluded findings.
    console.error("--exclude-producer cannot be combined with --ingest");
    process.exit(1);
  }

  return opts;
}

/**
 * The golden directory, read once and held in memory for the whole run.
 * Every later use (scoring, hashing) goes through this store, so the files
 * on disk can be removed after loading. With --exclude-producer the store
 * holds only the remaining findings, so all golden indices refer to them.
 */
class GoldenStore {
  readonly keys = new Set<string>();
  readonly excludedCounts = new Map<string, number>();
  private readonly raw = new Map<string, string>();
  private readonly parsed = new Map<string, GoldenSet | null>();

  constructor(readonly dir: string, readonly excludedProducers: readonly string[] = []) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const key = f.slice(0, -".json".length);
      const text = readFileSync(resolve(dir, f), "utf-8");
      this.keys.add(key);
      this.raw.set(key, text);
      try {
        const filtered = excludeGoldenProducers(JSON.parse(text) as GoldenSet, excludedProducers);
        this.parsed.set(key, filtered.golden);
        this.excludedCounts.set(key, filtered.excluded);
      } catch {
        this.parsed.set(key, null);
      }
    }
  }

  /** The golden set for a pull request; null when absent or unreadable. */
  get(key: string): GoldenSet | null {
    return this.parsed.get(key) ?? null;
  }

  /** The file text as loaded, or the remaining findings when producers are excluded, for hashing. */
  text(key: string): string | undefined {
    if (this.excludedProducers.length === 0) return this.raw.get(key);
    const golden = this.parsed.get(key);
    return golden ? JSON.stringify(golden) : this.raw.get(key);
  }

  /** Remove the loaded files from disk; the store keeps serving them. */
  deleteFromDisk(): number {
    let removed = 0;
    for (const key of this.keys) {
      const filePath = resolve(this.dir, `${key}.json`);
      if (!existsSync(filePath)) continue;
      unlinkSync(filePath);
      removed++;
    }
    return removed;
  }
}

function writeGoldenSet(goldenDir: string, goldenSet: GoldenSet): void {
  const filePath = resolve(goldenDir, `${goldenSet.pr_key}.json`);
  mkdirSync(goldenDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(goldenSet, null, 2));
}

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

interface Checkpoint {
  /**
   * Identity of the judge and evaluated inputs that produced these scores.
   * A checkpoint is only reused when the current run's fingerprint matches, so a
   * run can't resume PR scores produced by a different judge.
   */
  fingerprint?: string;
  completed: Record<string, PRScoreResult>;
  details: Record<string, PRDetailedOutput>;
}

/** Load completed PR scores only when all compatibility inputs match. */
function loadCheckpoint(
  outputPath: string,
  expectedFingerprint: string,
): { scores: Map<string, PRScoreResult>; details: Map<string, PRDetailedOutput> } {
  const cpPath = outputSidecarPath(outputPath, "checkpoint");
  const empty = () => ({ scores: new Map<string, PRScoreResult>(), details: new Map<string, PRDetailedOutput>() });
  if (!existsSync(cpPath)) return empty();

  try {
    const data: Checkpoint = JSON.parse(readFileSync(cpPath, "utf-8"));
    // Discard a checkpoint from a different judge (or a pre-fingerprint one),
    // rather than resuming its scores under this run's model label.
    if (data.fingerprint !== expectedFingerprint) {
      console.warn(
        "Ignoring existing checkpoint: its judge, prompts, or evaluation inputs differ. " +
          "Re-scoring from scratch.",
      );
      return empty();
    }
    return {
      scores: new Map(Object.entries(data.completed)),
      details: new Map(Object.entries(data.details ?? {})),
    };
  } catch {
    return empty();
  }
}

function saveCheckpoint(
  outputPath: string,
  fingerprint: string,
  scores: Map<string, PRScoreResult>,
  details: Map<string, PRDetailedOutput>,
): void {
  const cpPath = outputSidecarPath(outputPath, "checkpoint");
  mkdirSync(dirname(resolve(cpPath)), { recursive: true });
  const data: Checkpoint = {
    fingerprint,
    completed: Object.fromEntries(scores),
    details: Object.fromEntries(details),
  };
  writeFileSync(resolve(cpPath), JSON.stringify(data, null, 2));
}

function removeCheckpoint(outputPath: string): void {
  const cpPath = outputSidecarPath(outputPath, "checkpoint");
  if (existsSync(cpPath)) {
    unlinkSync(cpPath);
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function fmt(v: number | null): string {
  if (v === null) return "\u2014";
  return `${(v * 100).toFixed(1)}%`;
}

/** "read=12 bash=3", most used first; "none" when the judge used no tool. */
function formatToolCalls(calls: Record<string, number>): string {
  const parts = Object.entries(calls)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name}=${n}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

// ---------------------------------------------------------------------------
// Per-PR evaluation
// ---------------------------------------------------------------------------

// Frozen-corpus PR metadata (title/body), loaded once per manifest path and
// cached. Scoring reads PR context from the manifest rather than the upstream
// GitHub API so it never depends on the upstream repo still existing. Throws if
// the manifest is unreadable or is missing the requested PR.
let manifestCaches: Map<string, Map<string, ManifestEntry>> | null = null;
function getManifestEntry(manifestPath: string, key: string): ManifestEntry {
  const resolved = resolve(manifestPath);
  if (manifestCaches === null) manifestCaches = new Map();
  let cache = manifestCaches.get(resolved);
  if (!cache) {
    cache = new Map();
    const data: ManifestEntry[] = JSON.parse(readFileSync(resolved, "utf-8"));
    for (const entry of data) {
      const k = prKey(entry);
      if (cache.has(k)) {
        throw new Error(`manifest ${resolved} has duplicate entry for ${k}`);
      }
      cache.set(k, entry);
    }
    manifestCaches.set(resolved, cache);
  }
  const entry = cache.get(key);
  if (!entry) {
    throw new Error(`manifest ${resolved} has no entry for ${key}`);
  }
  return entry;
}

async function evalPR(
  prKeyStr: string,
  candidate: PRFindings,
  goldenStore: GoldenStore,
  opts: CliArgs,
  label: string,
): Promise<{ score: PRScoreResult; details: PRDetailedOutput } | null> {
  const golden = goldenStore.get(prKeyStr);
  if (!golden) return null;
  const identityProblem = candidateIdentityProblem(candidate.pr, golden.pr);
  if (identityProblem) {
    throw new Error(`${prKeyStr}: ${identityProblem}`);
  }

  const judgeName = `${opts.provider}/${opts.modelId}`;
  const pipeline = await askJudge(
    (signal) => dedup(candidate.findings, golden, {
      matcher: { provider: opts.provider, modelId: opts.modelId, signal },
    }),
    {
      what: `${prKeyStr}: matcher ${judgeName}`,
    },
  );
  const correspondences = pipeline.correspondences;

  // Build scoring input before classification so duplicate matches that lose
  // scoring credit are classified alongside truly novel findings.
  const scoring = resolveForScoring(
    correspondences,
    golden.findings.length,
  );
  const unmatchedIndices = [...scoring.unmatched].sort((a, b) => a - b);
  const unmatchedFindings = unmatchedIndices.map((i) => {
    const finding = candidate.findings[i];
    if (!finding) {
      throw new Error(`${prKeyStr}: matcher returned invalid candidate index ${i}`);
    }
    return finding;
  });

  // Step 3: Classify every candidate that is unmatched for scoring.
  let classifications: ClassifiedFinding[];
  if (unmatchedFindings.length > 0) {
    const nwo = golden.pr.repo.replace("https://github.com/", "");
    const manifestEntry = getManifestEntry(opts.manifestPath, prKeyStr);
    // Guard against a manifest/golden mismatch before trusting the manifest's
    // title/body for this PR.
    if (
      manifestEntry.repo !== golden.pr.repo ||
      manifestEntry.pr_number !== golden.pr.pr_number ||
      manifestEntry.head !== golden.pr.head ||
      manifestEntry.base !== golden.pr.base
    ) {
      throw new Error(
        `${prKeyStr}: manifest PR identity does not match golden`,
      );
    }
    // The budget grows with the number of findings the judge has to answer.
    const timeoutMs = JUDGE_CALL_TIMEOUT_MS + JUDGE_CALL_PER_FINDING_MS * unmatchedFindings.length;
    const classificationResult = await askJudge(
      async (signal) => {
        const answer = await classifyFindings({
          nwo,
          prUrl: `${golden.pr.repo}/pull/${golden.pr.pr_number}`,
          headSha: golden.pr.head,
          // Source PR context from the frozen corpus (mirror diff + manifest
          // title/body), never the upstream API.
          baseSha: golden.pr.base,
          prTitle: manifestEntry.title,
          prBody: manifestEntry.body,
          findings: unmatchedFindings,
          repoBaseDir: opts.repoDir,
          signal,
          config: {
            provider: opts.provider,
            modelId: opts.modelId,
          },
          onProgress: (idx, total, r) => {
            console.log(`  ${label}: classifying ${idx + 1}/${total} -> ${r.tp_fp} ${r.severity} ${r.category}`);
          },
        });
        if (answer.classifications.length !== unmatchedFindings.length) {
          throw new Error(`classified ${answer.classifications.length}/${unmatchedFindings.length} findings`);
        }
        return answer;
      },
      {
        what: `${prKeyStr}: classifier ${judgeName}`,
        timeoutMs,
      },
    );
    classifications = classificationResult.classifications;
    console.log(`  ${label}: tools: ${formatToolCalls(classificationResult.tool_calls)}`);
  } else {
    classifications = [];
  }

  const unmatchedCls = buildUnmatchedClassificationMap(
    prKeyStr,
    unmatchedIndices,
    classifications,
  );

  const scoringInput: PRScoringInput = {
    pr_key: prKeyStr,
    golden: golden.findings.map((g) => ({
      file: g.file,
      start_line: g.start_line,
      end_line: g.end_line,
      message: g.message,
      tp_fp: g.tp_fp,
      severity: g.severity,
      category: g.category,
    })),
    candidate_count: candidate.findings.length,
    matched: scoring.matchedToGolden,
    unmatched: scoring.unmatched,
    covered_golden: scoring.coveredGolden,
    unmatched_classifications: unmatchedCls,
  };

  const result = scorePR(scoringInput);
  // Build detailed per-finding output. The scored match is one golden per finding;
  // the full covered list is what grounded recall was computed from, so it goes out too.
  const coveredBy = new Map<number, number[]>();
  for (const c of scoring.raw) {
    if (coveredBy.has(c.candidate_index)) continue;
    coveredBy.set(c.candidate_index, [...new Set(c.matched_golden_indices)].filter((gi) => Number.isInteger(gi) && gi >= 0 && gi < golden.findings.length).sort((a, b) => a - b));
  }
  const findingDetails: FindingDetail[] = candidate.findings.map((f, i) => {
    const goldenIdx = scoring.matchedToGolden.get(i);
    const covered_golden_indices = coveredBy.get(i) ?? [];
    if (goldenIdx !== undefined) {
      const g = golden.findings[goldenIdx];
      return {
        file: f.file,
        start_line: f.start_line,
        end_line: f.end_line,
        message: f.message,
        status: g.tp_fp === "tp" ? "matched_tp" as const : "matched_fp" as const,
        matched_golden_index: goldenIdx,
        covered_golden_indices,
        golden_tp_fp: g.tp_fp,
        golden_severity: g.severity,
        golden_category: g.category,
        matched_to_ground_truth: true,
        llm_judged_match: true,
        match_method: "llm",
        matched_truth_label: g.tp_fp,
        result_severity: g.severity,
        result_category: g.category,
      };
    }
    const cls = unmatchedCls.get(i);
    if (cls) {
      return {
        file: f.file,
        start_line: f.start_line,
        end_line: f.end_line,
        message: f.message,
        status: cls.tp_fp === "tp" ? "novel_tp" as const : "novel_fp" as const,
        covered_golden_indices,
        classifier_tp_fp: cls.tp_fp,
        classifier_severity: cls.severity,
        classifier_category: cls.category,
        matched_to_ground_truth: false,
        llm_judged_match: false,
        match_method: "none",
        llm_classification: cls.tp_fp,
        result_severity: cls.severity,
        result_category: cls.category,
      };
    }
    return {
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
      message: f.message,
      status: "novel_fp" as const,
      covered_golden_indices,
      matched_to_ground_truth: false,
      llm_judged_match: false,
      match_method: "none" as const,
    };
  });

  const details: PRDetailedOutput = {
    pr_key: prKeyStr,
    candidate_findings: findingDetails,
  };

  // Optional: ingest novel TPs
  if (opts.ingest && pipeline.novel_findings.length > 0) {
    const novelTruePositives = selectNovelTruePositives(
      prKeyStr,
      pipeline.novel_indices,
      pipeline.novel_findings,
      unmatchedCls,
    );
    if (novelTruePositives.findings.length > 0) {
      const updated = merge(
        golden.findings,
        novelTruePositives.findings,
        novelTruePositives.classifications,
        golden.pr,
        prKeyStr,
      );
      writeGoldenSet(opts.goldenDir, updated);
    }
  }

  return { score: result, details };
}

// ---------------------------------------------------------------------------
// Eval config (fingerprinting for comparability)
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function computeEvalConfig(
  prKeys: string[],
  goldenStore: GoldenStore,
  provider: string,
  modelId: string,
  excludedProducers: readonly string[] = [],
): EvalConfig {
  // Hash golden findings content for evaluated PRs
  const goldenContents: string[] = [];
  for (const key of [...prKeys].sort()) {
    const text = goldenStore.text(key);
    if (text !== undefined) goldenContents.push(text);
  }
  const goldenHash = sha256(goldenContents.join("\n"));

  // Hash of sorted PR keys
  const evaluatedPrsHash = sha256([...prKeys].sort().join("\n"));

  const matcherPromptHash = sha256(renderJudgeSystemPrompt(MATCHER_SYSTEM_PROMPT));

  const classifierPromptHash = sha256(renderJudgeSystemPrompt(CLASSIFIER_SYSTEM_PROMPT));

  const judgeName = `${provider}/${modelId}`;
  return {
    golden_hash: goldenHash,
    classifier_model: judgeName,
    classifier_prompt_hash: classifierPromptHash,
    matcher_model: judgeName,
    matcher_prompt_hash: matcherPromptHash,
    evaluated_prs_hash: evaluatedPrsHash,
    ...(excludedProducers.length > 0 ? { excluded_producers: [...excludedProducers] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Corpus stats
// ---------------------------------------------------------------------------

function computeCorpusStats(
  prKeys: string[],
  manifestByKey: Map<string, ManifestEntry>,
): CorpusStats {
  const languages: Record<string, number> = {};
  const repos = new Set<string>();
  let totalLines = 0;
  let totalFiles = 0;
  const repoSizes: number[] = [];
  let enrichedCount = 0;

  for (const key of prKeys) {
    const entry = manifestByKey.get(key) as any;
    if (!entry) continue;

    repos.add(entry.nwo);

    if (entry.language) {
      const lang = entry.language as string;
      languages[lang] = (languages[lang] ?? 0) + 1;
      enrichedCount++;
    }
    if (entry.lines_added !== undefined) {
      totalLines += (entry.lines_added ?? 0) + (entry.lines_removed ?? 0);
    }
    if (entry.files_changed !== undefined) {
      totalFiles += entry.files_changed ?? 0;
    }
    if (entry.repo_size_kb !== undefined) {
      repoSizes.push(entry.repo_size_kb);
    }
  }

  repoSizes.sort((a, b) => a - b);
  const p50 = repoSizes.length > 0
    ? repoSizes[Math.floor(repoSizes.length / 2)]
    : null;

  return {
    pr_count: prKeys.length,
    languages,
    total_lines_changed: totalLines,
    avg_lines_changed: enrichedCount > 0 ? Math.round(totalLines / enrichedCount) : 0,
    total_files_changed: totalFiles,
    avg_files_changed: enrichedCount > 0 ? Math.round(totalFiles / enrichedCount) : 0,
    repo_size_kb_p50: p50,
    repos: repos.size,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  console.log("Loading candidate findings...");
  const candidateLoad = loadCandidateFindings(opts.candidatePath);
  const candidateByPR = candidateLoad.byPR;

  console.log("Loading golden set...");
  const goldenStore = new GoldenStore(resolve(opts.goldenDir), opts.excludeProducers);
  const goldenKeys = goldenStore.keys;
  // Inside the runner container the labels stay in memory only, so nothing
  // that runs later in the job can read them from the filesystem.
  if (process.env.RB_DELETE_GOLDEN_AFTER_LOAD === "1") {
    // Ingest rewrites only the golden sets that gained a finding; the rest
    // would stay deleted.
    if (opts.ingest) throw new Error("RB_DELETE_GOLDEN_AFTER_LOAD=1 cannot be combined with --ingest");
    const removed = goldenStore.deleteFromDisk();
    console.log(`  Golden files removed from disk after loading: ${removed}`);
  }

  const inputSummary = buildEvalInputSummary(candidateLoad, goldenKeys, opts.limit);
  console.log(`  Candidate files loaded: ${inputSummary.candidate_files_loaded}`);
  console.log(`  Candidate malformed JSON skipped: ${inputSummary.skipped_malformed_files}`);
  console.log(`  Candidate invalid files skipped: ${inputSummary.skipped_invalid_files}`);
  console.log(`  Candidate PRs: ${inputSummary.candidate_prs}`);
  console.log(`  Candidate findings: ${inputSummary.candidate_findings}`);
  console.log(`  Golden PRs: ${inputSummary.golden_prs}`);
  console.log(`  Golden overlaps: ${inputSummary.golden_overlaps}`);
  console.log(`  Missing golden: ${inputSummary.missing_golden}`);

  const inputProblems = strictInputProblems(inputSummary, candidateLoad.stats, {
    strict: opts.strict,
    allowEmpty: opts.allowEmpty,
  });
  if (inputProblems.length > 0) {
    console.error("\nInput validation failed:");
    for (const problem of inputProblems) {
      console.error(`  - ${problem}`);
    }
    console.error("\nUse --allow-empty only for intentional dry/no-op runs.");
    process.exit(1);
  }

  // Find common PRs
  const commonKeys = inputSummary.evaluation_keys;
  if (opts.excludeProducers.length > 0) {
    let excluded = 0;
    let emptied = 0;
    for (const key of commonKeys) {
      const count = goldenStore.excludedCounts.get(key) ?? 0;
      excluded += count;
      if (count > 0 && goldenStore.get(key)?.findings.length === 0) emptied++;
    }
    console.log(`  Excluded producers: ${opts.excludeProducers.join(", ")}`);
    console.log(`  Golden findings excluded: ${excluded} (${emptied} PRs left with no golden findings)`);
  }
  console.log(`  Concurrency: ${opts.concurrency}`);
  console.log(`\n${commonKeys.length} PRs to evaluate\n`);

  if (commonKeys.length === 0) {
    const reason = inputSummary.golden_overlaps === 0
      ? "No common PRs between candidate and golden set."
      : "No PRs selected for evaluation.";
    console.log(`${reason} --allow-empty set; exiting without scoring.`);
    return;
  }

  // Load checkpoint (only reused if it came from the same judge fingerprint)
  const fingerprint = checkpointFingerprint({
    provider: opts.provider,
    modelId: opts.modelId,
    classifierPrompt: renderJudgeSystemPrompt(CLASSIFIER_SYSTEM_PROMPT),
    matcherPrompt: renderJudgeSystemPrompt(MATCHER_SYSTEM_PROMPT),
    prKeys: commonKeys,
    candidates: commonKeys.map((key) => candidateByPR.get(key)),
    goldenSets: commonKeys.map((key) => goldenStore.get(key)),
    manifestEntries: commonKeys.map((key) => getManifestEntry(opts.manifestPath, key)),
    excludedProducers: opts.excludeProducers,
  });
  const checkpoint = loadCheckpoint(opts.output, fingerprint);
  const completed = checkpoint.scores;
  const allDetails = checkpoint.details;
  const skippedFromCheckpoint = commonKeys.filter((k) => completed.has(k)).length;
  if (skippedFromCheckpoint > 0) {
    console.log(`Resuming: ${skippedFromCheckpoint} PRs already completed\n`);
  }

  let nextIndex = 0;
  let errorCount = 0;
  let missingGoldenDuringEval = 0;

  async function worker() {
    while (nextIndex < commonKeys.length) {
      const i = nextIndex++;
      const prKeyStr = commonKeys[i];
      const candidate = candidateByPR.get(prKeyStr)!;
      const label = `[${i + 1}/${commonKeys.length}] ${prKeyStr}`;

      if (completed.has(prKeyStr)) {
        console.log(`${label}: skipped (checkpoint)`);
        continue;
      }

      try {
        const evalResult = await evalPR(prKeyStr, candidate, goldenStore, opts, label);

        if (!evalResult) {
          missingGoldenDuringEval++;
          console.log(`${label}: skipped (no golden set)`);
          continue;
        }

        completed.set(prKeyStr, evalResult.score);
        allDetails.set(prKeyStr, evalResult.details);
        saveCheckpoint(opts.output, fingerprint, completed, allDetails);

        const m = evalResult.score.metrics.overall;
        console.log(
          `${label}: ${candidate.findings.length}c vs ${m.golden_tp_count}g` +
          ` GP=${fmt(m.grounded_precision)} GR=${fmt(m.grounded_recall)}` +
          ` AP=${fmt(m.augmented_precision)} AR=${fmt(m.augmented_recall)}` +
          ` matched=${m.matched_count} novel=${m.novel_tp_count}`,
        );
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`${label}: FAILED: ${msg.slice(0, 200)}`);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(opts.concurrency, commonKeys.length) },
    () => worker(),
  );
  await Promise.all(workers);

  if (opts.strict && missingGoldenDuringEval > 0) {
    console.error(
      `\nInput validation failed: ${missingGoldenDuringEval} PR(s) were skipped because golden files were missing or unreadable during eval.`,
    );
    process.exit(1);
  }

  if (opts.strict && errorCount > 0) {
    console.error(
      `\nInput validation failed: ${errorCount} PR(s) errored during eval; refusing to write a partial leaderboard. ` +
      `Investigate the failures above (re-run, or pass --no-strict to accept partial results).`,
    );
    process.exit(1);
  }

  // Aggregate all completed results
  const prResults = commonKeys
    .map((k) => completed.get(k))
    .filter((r): r is PRScoreResult => !!r);

  if (opts.strict && prResults.length === 0 && !opts.allowEmpty) {
    console.error("\nInput validation failed: all candidate PRs were skipped; no scores were produced.");
    process.exit(1);
  }

  const agg = aggregate(prResults);
  agg.candidate_usage = aggregateCandidateUsage(
    commonKeys.map((key) => candidateByPR.get(key)?.usage),
  );

  // Compute corpus stats from manifest
  let manifestByKey: Map<string, ManifestEntry> | undefined;
  if (existsSync(resolve(opts.manifestPath))) {
    try {
      const manifestData: ManifestEntry[] = JSON.parse(readFileSync(resolve(opts.manifestPath), "utf-8"));
      manifestByKey = new Map<string, ManifestEntry>();
      for (const entry of manifestData) {
        manifestByKey.set(prKey(entry), entry);
      }
      agg.corpus_stats = computeCorpusStats(commonKeys, manifestByKey);
    } catch {
      // manifest not available or unparseable — skip
    }
  }

  // Compute eval config fingerprint
  agg.eval_config = computeEvalConfig(commonKeys, goldenStore, opts.provider, opts.modelId, opts.excludeProducers);

  // Write output
  const outputPath = resolve(opts.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(agg, null, 2));

  // Write detailed per-finding output
  const detailsPath = outputSidecarPath(outputPath, "details");
  const detailsArray = commonKeys
    .map((k) => allDetails.get(k))
    .filter((d): d is PRDetailedOutput => !!d);
  writeFileSync(detailsPath, JSON.stringify(detailsArray, null, 2));
  console.log(`Details written to ${detailsPath}`);

  // Print summary
  console.log();
  printSummary(agg, detailsArray, { errors: errorCount });

  if (opts.ingest) {
    console.log(`\nNovel TPs ingested into ${opts.goldenDir}/`);
  }

  console.log(`\nResults written to ${opts.output}`);

  // Clean up checkpoint on full success
  if (errorCount === 0 && prResults.length === commonKeys.length) {
    removeCheckpoint(opts.output);
  }
}

// Exit explicitly: an abandoned judge call may still hold the event loop.
main().then(
  () => process.exit(0),
  (err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  },
);
