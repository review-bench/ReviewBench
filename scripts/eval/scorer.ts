/**
 * Scorer — computes metrics from match results and classifications.
 *
 * Implements METHODOLOGY.md §7.
 *
 * Inputs:
 * - Golden findings with TP/FP labels, severity, category
 * - Match results (which candidates matched which goldens)
 * - Unmatched candidate classifications (TP/FP, severity, category)
 *
 * Outputs:
 * - Per-PR metrics: grounded and augmented precision/recall
 * - Stratified by severity and category
 * - Aggregated: macro and micro averages
 */

import type { CandidateUsageAggregate } from "../lib/usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifiedFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  tp_fp: "tp" | "fp";
  severity: "high" | "medium" | "low";
  category: string;
  scope?: string;
  difficulty?: string;
  context_required?: string;
  tp_fp_justification?: string;
  severity_justification?: string;
  category_justification?: string;
}

export interface PRScoringInput {
  pr_key: string;
  golden: ClassifiedFinding[];
  candidate_count: number;
  /** Candidate indices that matched a golden finding, and which golden index */
  matched: Map<number, number>;
  /** Candidate indices that are unmatched */
  unmatched: Set<number>;
  /** Golden indices covered by at least one candidate */
  covered_golden: Set<number>;
  /** Classifications of unmatched candidates (index → classification) */
  unmatched_classifications: Map<number, ClassifiedFinding>;
}

export interface MetricSet {
  grounded_precision: number | null;
  grounded_recall: number | null;
  augmented_precision: number | null;
  augmented_recall: number | null;
  novel_tp_count: number;
  novel_tp_yield: number | null;
  candidate_count: number;
  golden_tp_count: number;
  matched_count: number;
  matched_tp_count: number;
  unmatched_count: number;
  unmatched_tp_count: number;
  unmatched_fp_count: number;
  golden_covered_count: number;
}

export interface StratifiedMetrics {
  overall: MetricSet;
  by_severity: Record<string, MetricSet>;
  by_category: Record<string, MetricSet>;
}

export interface PRScoreResult {
  pr_key: string;
  metrics: StratifiedMetrics;
}

export interface EvalConfig {
  golden_hash: string;
  /** The LLM judge used for matching and classification. */
  classifier_model: string;
  classifier_prompt_hash: string;
  matcher_model: string;
  matcher_prompt_hash: string;
  evaluated_prs_hash: string;
  /** Producer prefixes removed from the golden set before matching (--exclude-producer); absent when none. */
  excluded_producers?: string[];
}

export interface CorpusStats {
  pr_count: number;
  languages: Record<string, number>;
  total_lines_changed: number;
  avg_lines_changed: number;
  total_files_changed: number;
  avg_files_changed: number;
  repo_size_kb_p50: number | null;
  repos: number;
}

export interface AggregateMetrics {
  macro: StratifiedMetrics;
  micro: StratifiedMetrics;
  pr_count: number;
  eval_config?: EvalConfig;
  corpus_stats?: CorpusStats;
  candidate_usage?: CandidateUsageAggregate;
  per_pr: PRScoreResult[];
}

interface ScoringClassification {
  tp_fp: "tp" | "fp";
  severity: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

function computeMetrics(input: {
  golden_tp_indices: Set<number>;
  golden_all_indices: Set<number>;
  matched_candidates: Map<number, number>; // candidate_idx → golden_idx
  covered_golden: Set<number>;
  unmatched_tp_count: number;
  unmatched_fp_count: number;
  candidate_count: number;
}): MetricSet {
  const {
    golden_tp_indices,
    matched_candidates,
    covered_golden,
    unmatched_tp_count,
    unmatched_fp_count,
    candidate_count,
  } = input;

  const golden_tp_count = golden_tp_indices.size;

  // M_TP: matched candidates whose matched golden is TP
  let matched_tp_count = 0;
  for (const [, goldenIdx] of matched_candidates) {
    if (golden_tp_indices.has(goldenIdx)) {
      matched_tp_count++;
    }
  }

  const matched_count = matched_candidates.size;
  const unmatched_count = unmatched_tp_count + unmatched_fp_count;

  // Grounded recall: of golden TPs, how many are covered?
  let golden_tp_covered = 0;
  for (const gi of covered_golden) {
    if (golden_tp_indices.has(gi)) {
      golden_tp_covered++;
    }
  }

  // §7.1
  const grounded_precision =
    matched_count > 0 ? matched_tp_count / matched_count : null;
  const grounded_recall =
    golden_tp_count > 0 ? golden_tp_covered / golden_tp_count : null;

  // §7.2
  const augmented_precision =
    candidate_count > 0
      ? (matched_tp_count + unmatched_tp_count) / candidate_count
      : null;

  const aug_recall_denom = golden_tp_count + unmatched_tp_count;
  const augmented_recall =
    aug_recall_denom > 0
      ? (golden_tp_covered + unmatched_tp_count) / aug_recall_denom
      : null;

  const novel_tp_count = unmatched_tp_count;
  const novel_tp_yield =
    candidate_count > 0 ? unmatched_tp_count / candidate_count : null;

  return {
    grounded_precision,
    grounded_recall,
    augmented_precision,
    augmented_recall,
    novel_tp_count,
    novel_tp_yield,
    candidate_count,
    golden_tp_count,
    matched_count,
    matched_tp_count,
    unmatched_count,
    unmatched_tp_count,
    unmatched_fp_count,
    golden_covered_count: golden_tp_covered,
  };
}

// ---------------------------------------------------------------------------
// Per-PR scoring with stratification
// ---------------------------------------------------------------------------

export function scorePR(input: PRScoringInput): PRScoreResult {
  const { golden, matched, unmatched, covered_golden, unmatched_classifications, candidate_count } = input;
  const normalizedUnmatched = normalizeUnmatchedClassifications(unmatched, unmatched_classifications);

  // Build golden TP index set
  const golden_tp_indices = new Set<number>();
  golden.forEach((g, i) => {
    if (g.tp_fp === "tp") golden_tp_indices.add(i);
  });
  const golden_all_indices = new Set(golden.map((_, i) => i));

  // Count unmatched TPs/FPs
  let unmatched_tp_count = 0;
  let unmatched_fp_count = 0;
  for (const cls of normalizedUnmatched.values()) {
    if (cls.tp_fp === "tp") unmatched_tp_count++;
    else unmatched_fp_count++;
  }

  // Overall metrics
  const overall = computeMetrics({
    golden_tp_indices,
    golden_all_indices,
    matched_candidates: matched,
    covered_golden,
    unmatched_tp_count,
    unmatched_fp_count,
    candidate_count,
  });

  // Stratified by severity
  const severities = new Set<string>();
  golden.forEach((g) => severities.add(g.severity));
  for (const cls of normalizedUnmatched.values()) {
    severities.add(cls.severity);
  }

  const by_severity: Record<string, MetricSet> = {};
  for (const sev of severities) {
    const filtered = filterBySeverity(input, sev, normalizedUnmatched);
    by_severity[sev] = computeMetrics(filtered);
  }

  // Stratified by category
  const categories = new Set<string>();
  golden.forEach((g) => categories.add(g.category));
  for (const cls of normalizedUnmatched.values()) {
    categories.add(cls.category);
  }

  const by_category: Record<string, MetricSet> = {};
  for (const cat of categories) {
    const filtered = filterByCategory(input, cat, normalizedUnmatched);
    by_category[cat] = computeMetrics(filtered);
  }

  return {
    pr_key: input.pr_key,
    metrics: { overall, by_severity, by_category },
  };
}

// ---------------------------------------------------------------------------
// Stratification helpers
// ---------------------------------------------------------------------------

function normalizeUnmatchedClassifications(
  unmatched: Set<number>,
  unmatchedClassifications: Map<number, ClassifiedFinding>,
): Map<number, ScoringClassification> {
  const result = new Map<number, ScoringClassification>();
  for (const candidateIndex of unmatched) {
    result.set(
      candidateIndex,
      unmatchedClassifications.get(candidateIndex) ?? {
        tp_fp: "fp",
        severity: "unclassified",
        category: "unclassified",
      },
    );
  }
  return result;
}

function filterBySeverity(
  input: PRScoringInput,
  severity: string,
  unmatchedClassifications: Map<number, ScoringClassification>,
) {
  const { golden, matched, covered_golden } = input;

  const golden_tp_indices = new Set<number>();
  const golden_all_indices = new Set<number>();
  golden.forEach((g, i) => {
    if (g.severity === severity) {
      golden_all_indices.add(i);
      if (g.tp_fp === "tp") golden_tp_indices.add(i);
    }
  });

  // Filter matched to only those whose golden is in this severity
  const filteredMatched = new Map<number, number>();
  for (const [ci, gi] of matched) {
    if (golden[gi]?.severity === severity) {
      filteredMatched.set(ci, gi);
    }
  }

  // Filter covered golden
  const filteredCovered = new Set<number>();
  for (const gi of covered_golden) {
    if (golden[gi]?.severity === severity) {
      filteredCovered.add(gi);
    }
  }

  // Count unmatched by severity
  let unmatched_tp = 0;
  let unmatched_fp = 0;
  for (const cls of unmatchedClassifications.values()) {
    if (cls.severity !== severity) continue;
    if (cls.tp_fp === "tp") unmatched_tp++;
    else unmatched_fp++;
  }

  // Candidate count for this stratum: matched in stratum + unmatched in stratum
  const stratum_candidate_count = filteredMatched.size + unmatched_tp + unmatched_fp;

  return {
    golden_tp_indices,
    golden_all_indices,
    matched_candidates: filteredMatched,
    covered_golden: filteredCovered,
    unmatched_tp_count: unmatched_tp,
    unmatched_fp_count: unmatched_fp,
    candidate_count: stratum_candidate_count,
  };
}

function filterByCategory(
  input: PRScoringInput,
  category: string,
  unmatchedClassifications: Map<number, ScoringClassification>,
) {
  const { golden, matched, covered_golden } = input;

  const golden_tp_indices = new Set<number>();
  const golden_all_indices = new Set<number>();
  golden.forEach((g, i) => {
    if (g.category === category) {
      golden_all_indices.add(i);
      if (g.tp_fp === "tp") golden_tp_indices.add(i);
    }
  });

  const filteredMatched = new Map<number, number>();
  for (const [ci, gi] of matched) {
    if (golden[gi]?.category === category) {
      filteredMatched.set(ci, gi);
    }
  }

  const filteredCovered = new Set<number>();
  for (const gi of covered_golden) {
    if (golden[gi]?.category === category) {
      filteredCovered.add(gi);
    }
  }

  let unmatched_tp = 0;
  let unmatched_fp = 0;
  for (const cls of unmatchedClassifications.values()) {
    if (cls.category !== category) continue;
    if (cls.tp_fp === "tp") unmatched_tp++;
    else unmatched_fp++;
  }

  const stratum_candidate_count = filteredMatched.size + unmatched_tp + unmatched_fp;

  return {
    golden_tp_indices,
    golden_all_indices,
    matched_candidates: filteredMatched,
    covered_golden: filteredCovered,
    unmatched_tp_count: unmatched_tp,
    unmatched_fp_count: unmatched_fp,
    candidate_count: stratum_candidate_count,
  };
}

// ---------------------------------------------------------------------------
// Aggregation (§7.4)
// ---------------------------------------------------------------------------

function averageMetric(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function macroAverage(results: PRScoreResult[]): StratifiedMetrics {
  const allOveralls = results.map((r) => r.metrics.overall);

  const overall: MetricSet = {
    grounded_precision: averageMetric(allOveralls.map((m) => m.grounded_precision)),
    grounded_recall: averageMetric(allOveralls.map((m) => m.grounded_recall)),
    augmented_precision: averageMetric(allOveralls.map((m) => m.augmented_precision)),
    augmented_recall: averageMetric(allOveralls.map((m) => m.augmented_recall)),
    novel_tp_count: allOveralls.reduce((a, m) => a + m.novel_tp_count, 0),
    novel_tp_yield: averageMetric(allOveralls.map((m) => m.novel_tp_yield)),
    candidate_count: allOveralls.reduce((a, m) => a + m.candidate_count, 0),
    golden_tp_count: allOveralls.reduce((a, m) => a + m.golden_tp_count, 0),
    matched_count: allOveralls.reduce((a, m) => a + m.matched_count, 0),
    matched_tp_count: allOveralls.reduce((a, m) => a + m.matched_tp_count, 0),
    unmatched_count: allOveralls.reduce((a, m) => a + m.unmatched_count, 0),
    unmatched_tp_count: allOveralls.reduce((a, m) => a + m.unmatched_tp_count, 0),
    unmatched_fp_count: allOveralls.reduce((a, m) => a + m.unmatched_fp_count, 0),
    golden_covered_count: allOveralls.reduce((a, m) => a + m.golden_covered_count, 0),
  };

  // Aggregate severity strata
  const allSeverities = new Set<string>();
  results.forEach((r) => Object.keys(r.metrics.by_severity).forEach((s) => allSeverities.add(s)));

  const by_severity: Record<string, MetricSet> = {};
  for (const sev of allSeverities) {
    const strata = results
      .map((r) => r.metrics.by_severity[sev])
      .filter((s): s is MetricSet => !!s);
    by_severity[sev] = {
      grounded_precision: averageMetric(strata.map((m) => m.grounded_precision)),
      grounded_recall: averageMetric(strata.map((m) => m.grounded_recall)),
      augmented_precision: averageMetric(strata.map((m) => m.augmented_precision)),
      augmented_recall: averageMetric(strata.map((m) => m.augmented_recall)),
      novel_tp_count: strata.reduce((a, m) => a + m.novel_tp_count, 0),
      novel_tp_yield: averageMetric(strata.map((m) => m.novel_tp_yield)),
      candidate_count: strata.reduce((a, m) => a + m.candidate_count, 0),
      golden_tp_count: strata.reduce((a, m) => a + m.golden_tp_count, 0),
      matched_count: strata.reduce((a, m) => a + m.matched_count, 0),
      matched_tp_count: strata.reduce((a, m) => a + m.matched_tp_count, 0),
      unmatched_count: strata.reduce((a, m) => a + m.unmatched_count, 0),
      unmatched_tp_count: strata.reduce((a, m) => a + m.unmatched_tp_count, 0),
      unmatched_fp_count: strata.reduce((a, m) => a + m.unmatched_fp_count, 0),
      golden_covered_count: strata.reduce((a, m) => a + m.golden_covered_count, 0),
    };
  }

  // Aggregate category strata
  const allCategories = new Set<string>();
  results.forEach((r) => Object.keys(r.metrics.by_category).forEach((c) => allCategories.add(c)));

  const by_category: Record<string, MetricSet> = {};
  for (const cat of allCategories) {
    const strata = results
      .map((r) => r.metrics.by_category[cat])
      .filter((s): s is MetricSet => !!s);
    by_category[cat] = {
      grounded_precision: averageMetric(strata.map((m) => m.grounded_precision)),
      grounded_recall: averageMetric(strata.map((m) => m.grounded_recall)),
      augmented_precision: averageMetric(strata.map((m) => m.augmented_precision)),
      augmented_recall: averageMetric(strata.map((m) => m.augmented_recall)),
      novel_tp_count: strata.reduce((a, m) => a + m.novel_tp_count, 0),
      novel_tp_yield: averageMetric(strata.map((m) => m.novel_tp_yield)),
      candidate_count: strata.reduce((a, m) => a + m.candidate_count, 0),
      golden_tp_count: strata.reduce((a, m) => a + m.golden_tp_count, 0),
      matched_count: strata.reduce((a, m) => a + m.matched_count, 0),
      matched_tp_count: strata.reduce((a, m) => a + m.matched_tp_count, 0),
      unmatched_count: strata.reduce((a, m) => a + m.unmatched_count, 0),
      unmatched_tp_count: strata.reduce((a, m) => a + m.unmatched_tp_count, 0),
      unmatched_fp_count: strata.reduce((a, m) => a + m.unmatched_fp_count, 0),
      golden_covered_count: strata.reduce((a, m) => a + m.golden_covered_count, 0),
    };
  }

  return { overall, by_severity, by_category };
}

function microAverage(results: PRScoreResult[]): StratifiedMetrics {
  // Pool all counts, then compute ratios
  const allOveralls = results.map((r) => r.metrics.overall);

  const totalMatchedTP = allOveralls.reduce((a, m) => a + m.matched_tp_count, 0);
  const totalMatched = allOveralls.reduce((a, m) => a + m.matched_count, 0);
  const totalGoldenTP = allOveralls.reduce((a, m) => a + m.golden_tp_count, 0);
  const totalGoldenCovered = allOveralls.reduce((a, m) => a + m.golden_covered_count, 0);
  const totalUnmatchedTP = allOveralls.reduce((a, m) => a + m.unmatched_tp_count, 0);
  const totalUnmatchedFP = allOveralls.reduce((a, m) => a + m.unmatched_fp_count, 0);
  const totalCandidates = allOveralls.reduce((a, m) => a + m.candidate_count, 0);

  const overall: MetricSet = {
    grounded_precision: totalMatched > 0 ? totalMatchedTP / totalMatched : null,
    grounded_recall: totalGoldenTP > 0 ? totalGoldenCovered / totalGoldenTP : null,
    augmented_precision: totalCandidates > 0 ? (totalMatchedTP + totalUnmatchedTP) / totalCandidates : null,
    augmented_recall: (totalGoldenTP + totalUnmatchedTP) > 0
      ? (totalGoldenCovered + totalUnmatchedTP) / (totalGoldenTP + totalUnmatchedTP)
      : null,
    novel_tp_count: totalUnmatchedTP,
    novel_tp_yield: totalCandidates > 0 ? totalUnmatchedTP / totalCandidates : null,
    candidate_count: totalCandidates,
    golden_tp_count: totalGoldenTP,
    matched_count: totalMatched,
    matched_tp_count: totalMatchedTP,
    unmatched_count: totalUnmatchedTP + totalUnmatchedFP,
    unmatched_tp_count: totalUnmatchedTP,
    unmatched_fp_count: totalUnmatchedFP,
    golden_covered_count: totalGoldenCovered,
  };

  // Micro-average severity strata by pooling counts
  const allSeverities = new Set<string>();
  results.forEach((r) => Object.keys(r.metrics.by_severity).forEach((s) => allSeverities.add(s)));

  const by_severity: Record<string, MetricSet> = {};
  for (const sev of allSeverities) {
    const strata = results
      .map((r) => r.metrics.by_severity[sev])
      .filter((s): s is MetricSet => !!s);

    const mtp = strata.reduce((a, m) => a + m.matched_tp_count, 0);
    const mt = strata.reduce((a, m) => a + m.matched_count, 0);
    const gtp = strata.reduce((a, m) => a + m.golden_tp_count, 0);
    const gc = strata.reduce((a, m) => a + m.golden_covered_count, 0);
    const utp = strata.reduce((a, m) => a + m.unmatched_tp_count, 0);
    const ufp = strata.reduce((a, m) => a + m.unmatched_fp_count, 0);
    const cc = strata.reduce((a, m) => a + m.candidate_count, 0);

    by_severity[sev] = {
      grounded_precision: mt > 0 ? mtp / mt : null,
      grounded_recall: gtp > 0 ? gc / gtp : null,
      augmented_precision: cc > 0 ? (mtp + utp) / cc : null,
      augmented_recall: (gtp + utp) > 0 ? (gc + utp) / (gtp + utp) : null,
      novel_tp_count: utp,
      novel_tp_yield: cc > 0 ? utp / cc : null,
      candidate_count: cc,
      golden_tp_count: gtp,
      matched_count: mt,
      matched_tp_count: mtp,
      unmatched_count: utp + ufp,
      unmatched_tp_count: utp,
      unmatched_fp_count: ufp,
      golden_covered_count: gc,
    };
  }

  // Micro-average category strata
  const allCategories = new Set<string>();
  results.forEach((r) => Object.keys(r.metrics.by_category).forEach((c) => allCategories.add(c)));

  const by_category: Record<string, MetricSet> = {};
  for (const cat of allCategories) {
    const strata = results
      .map((r) => r.metrics.by_category[cat])
      .filter((s): s is MetricSet => !!s);

    const mtp = strata.reduce((a, m) => a + m.matched_tp_count, 0);
    const mt = strata.reduce((a, m) => a + m.matched_count, 0);
    const gtp = strata.reduce((a, m) => a + m.golden_tp_count, 0);
    const gc = strata.reduce((a, m) => a + m.golden_covered_count, 0);
    const utp = strata.reduce((a, m) => a + m.unmatched_tp_count, 0);
    const ufp = strata.reduce((a, m) => a + m.unmatched_fp_count, 0);
    const cc = strata.reduce((a, m) => a + m.candidate_count, 0);

    by_category[cat] = {
      grounded_precision: mt > 0 ? mtp / mt : null,
      grounded_recall: gtp > 0 ? gc / gtp : null,
      augmented_precision: cc > 0 ? (mtp + utp) / cc : null,
      augmented_recall: (gtp + utp) > 0 ? (gc + utp) / (gtp + utp) : null,
      novel_tp_count: utp,
      novel_tp_yield: cc > 0 ? utp / cc : null,
      candidate_count: cc,
      golden_tp_count: gtp,
      matched_count: mt,
      matched_tp_count: mtp,
      unmatched_count: utp + ufp,
      unmatched_tp_count: utp,
      unmatched_fp_count: ufp,
      golden_covered_count: gc,
    };
  }

  return { overall, by_severity, by_category };
}

export function aggregate(results: PRScoreResult[]): AggregateMetrics {
  return {
    macro: macroAverage(results),
    micro: microAverage(results),
    pr_count: results.length,
    per_pr: results,
  };
}
