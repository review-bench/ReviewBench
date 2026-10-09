/**
 * Adapter to call the classifier from the extraction pipeline.
 *
 * Converts extraction Finding[] to the classifier's input format,
 * runs classification, and converts results back to ClassifiedFinding[].
 */

import { classifyPR, type ClassifierConfig } from "../classifier/classify.js";
import type { FindingInput, ClassificationResult } from "../classifier/types.js";
import type { ClassifiedFinding } from "../eval/scorer.js";
import type { Finding } from "../lib/types.js";
import { checkoutRepo, fetchCommit, getFullDiff, validateSnapshot } from "../extraction/git.js";

export interface ClassifyOptions {
  nwo: string;
  prUrl: string;
  headSha: string;
  findings: Finding[];
  config: ClassifierConfig;
  repoBaseDir: string;
  snapshotDir?: string;
  signal?: AbortSignal;
  onProgress?: (index: number, total: number, result: ClassificationResult) => void;
  baseSha: string;
  prTitle: string;
  prBody: string;
}

/**
 * Classify a set of findings for a single PR.
 *
 * Fetches PR context from GitHub, runs the classifier session,
 * and returns ClassifiedFinding[] in the format the scorer expects.
 */
export interface ClassifyResult {
  classifications: ClassifiedFinding[];
  usage: { input_tokens: number; output_tokens: number; estimated_cost_usd: number };
  /** Tool calls the classifier session made, by tool name. */
  tool_calls: Record<string, number>;
}

export async function classifyFindings(opts: ClassifyOptions): Promise<ClassifyResult> {
  const { nwo, prUrl, headSha, findings, config } = opts;

  if (findings.length === 0) {
    return {
      classifications: [],
      usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
      tool_calls: {},
    };
  }

  // Checkout repo for tool access
  const repoDir = opts.snapshotDir
    ? validateSnapshot(opts.snapshotDir, opts.baseSha, headSha)
    : checkoutRepo(nwo, headSha, opts.repoBaseDir);

  // Convert to classifier input format
  const inputs: FindingInput[] = findings.map((f, i) => ({
    id: `finding-${i}`,
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    message: f.message,
    producer: f.producer,
  }));

  if (opts.prTitle.trim().length === 0) {
    throw new Error(`${nwo} (${prUrl}): corpus PR title missing/empty; refusing to classify with empty context`);
  }
  if (!opts.snapshotDir) fetchCommit(repoDir, opts.baseSha);
  const diff = getFullDiff(repoDir, opts.baseSha, headSha, { offline: !!opts.snapshotDir });

  // Track partial results in case the classifier fails mid-batch
  const partialResults: ClassificationResult[] = [];

  // Run classifier
  let usage = { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, cache_read_tokens: 0, cache_write_tokens: 0, elapsed_seconds: 0 };
  let toolCalls: Record<string, number> = {};
  try {
    const response = await classifyPR({
      nwo,
      prUrl,
      prTitle: opts.prTitle,
      prBody: opts.prBody,
      diff,
      headSha,
      findings: inputs,
      signal: opts.signal,
      config: {
        ...config,
        ...(repoDir ? { repoDir } : {}),
      },
      onProgress: (result, idx, total) => {
        partialResults.push(result);
        opts.onProgress?.(idx, total, result);
      },
    });
    usage = response.usage;
    toolCalls = response.tool_calls;
  } catch (err) {
    if (partialResults.length === 0) throw err;
    console.warn(
      `  Classifier failed after ${partialResults.length}/${findings.length} findings: ${err instanceof Error ? err.message : err}`,
    );
  }

  const results = partialResults;

  // Convert results to ClassifiedFinding format (only for findings we got results for)
  return {
    classifications: results.map((r, i) => ({
      file: findings[i].file,
      start_line: findings[i].start_line,
      end_line: findings[i].end_line,
      message: findings[i].message,
      tp_fp: r.tp_fp,
      severity: r.severity,
      category: r.category,
      scope: r.scope,
      difficulty: r.difficulty,
      context_required: r.context_required,
      tp_fp_justification: r.tp_fp_justification,
      severity_justification: r.severity_justification,
      category_justification: r.category_justification,
    })),
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_cost_usd: usage.estimated_cost_usd,
    },
    tool_calls: toolCalls,
  };
}
