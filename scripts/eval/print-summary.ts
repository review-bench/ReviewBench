/**
 * Shared summary printing for eval results.
 *
 * Used by both eval.ts (inline after a run) and print-scores.ts (standalone).
 */

import type { AggregateMetrics, CorpusStats, EvalConfig, MetricSet } from "./scorer.js";

export interface FindingDetails {
  candidate_findings: Array<{ status: string }>;
}

function fmt(v: number | null): string {
  if (v === null) return "\u2014";
  return `${(v * 100).toFixed(1)}%`;
}

function printMetrics(label: string, m: MetricSet) {
  console.log(`  ${label}:`);
  console.log(`    Grounded:  P=${fmt(m.grounded_precision)}  R=${fmt(m.grounded_recall)}`);
  console.log(`    Augmented: P=${fmt(m.augmented_precision)}  R=${fmt(m.augmented_recall)}`);
  console.log(`    Novel TPs: ${m.novel_tp_count}`);
  console.log(`    Counts: ${m.candidate_count}c, ${m.golden_tp_count}g_tp, ${m.matched_tp_count}/${m.matched_count} matched_tp, ${m.unmatched_tp_count}/${m.unmatched_count} unmatched_tp`);
}

function printCorpusStats(stats: CorpusStats): void {
  console.log(`\nCorpus: ${stats.pr_count} PRs across ${stats.repos} repos`);
  if (Object.keys(stats.languages).length > 0) {
    const langSummary = Object.entries(stats.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}(${count})`)
      .join(", ");
    console.log(`  Languages: ${langSummary}`);
  }
  if (stats.avg_lines_changed > 0) {
    console.log(`  Avg PR size: ${stats.avg_lines_changed} lines changed, ${stats.avg_files_changed} files`);
  }
  if (stats.repo_size_kb_p50 !== null) {
    console.log(`  Repo size (p50): ${(stats.repo_size_kb_p50 / 1024).toFixed(1)} MB`);
  }
}

export function printSummary(
  agg: AggregateMetrics,
  details?: FindingDetails[] | null,
  opts?: { errors?: number },
): void {
  const errorSuffix = opts?.errors != null ? `, ${opts.errors} errors` : "";
  console.log(`=== Results (${agg.pr_count} PRs${errorSuffix}) ===`);

  if (agg.corpus_stats) {
    printCorpusStats(agg.corpus_stats);
  }

  if (agg.eval_config) {
    console.log(`\nFingerprint:`);
    console.log(`  Golden hash:       ${agg.eval_config.golden_hash.slice(0, 12)}...`);
    console.log(`  Classifier model:  ${agg.eval_config.classifier_model}`);
    console.log(`  Classifier prompt: ${agg.eval_config.classifier_prompt_hash.slice(0, 12)}...`);
    console.log(`  Matcher model:     ${agg.eval_config.matcher_model}`);
    console.log(`  Matcher prompt:    ${agg.eval_config.matcher_prompt_hash.slice(0, 12)}...`);
    console.log(`  PR set:            ${agg.eval_config.evaluated_prs_hash.slice(0, 12)}...`);
    if (agg.eval_config.excluded_producers?.length) {
      console.log(`  Excluded producers: ${agg.eval_config.excluded_producers.join(", ")}`);
    }
  }

  if (details && details.length > 0) {
    const counts = { matched_tp: 0, matched_fp: 0, novel_tp: 0, novel_fp: 0 };
    let total = 0;
    for (const d of details) {
      for (const f of d.candidate_findings) {
        counts[f.status as keyof typeof counts]++;
        total++;
      }
    }
    if (total > 0) {
      console.log(`\nOutcome Breakdown (${total} candidate findings):`);
      console.log(`  Matched TP:  ${counts.matched_tp}  (${(counts.matched_tp / total * 100).toFixed(1)}%)`);
      console.log(`  Matched FP:  ${counts.matched_fp}  (${(counts.matched_fp / total * 100).toFixed(1)}%)`);
      console.log(`  Novel TP:    ${counts.novel_tp}  (${(counts.novel_tp / total * 100).toFixed(1)}%)`);
      console.log(`  Novel FP:    ${counts.novel_fp}  (${(counts.novel_fp / total * 100).toFixed(1)}%)`);
    }
  }

  console.log("\nMacro Average:");
  printMetrics("Overall", agg.macro.overall);

  console.log("\nMicro Average:");
  printMetrics("Overall", agg.micro.overall);

  if (Object.keys(agg.macro.by_severity).length > 0) {
    console.log("\nBy Severity (macro):");
    for (const [sev, m] of Object.entries(agg.macro.by_severity)) {
      console.log(`  ${sev}: GP=${fmt(m.grounded_precision)} GR=${fmt(m.grounded_recall)} AP=${fmt(m.augmented_precision)} AR=${fmt(m.augmented_recall)} (${m.golden_tp_count} golden TPs)`);
    }
  }

  if (Object.keys(agg.macro.by_category).length > 0) {
    console.log("\nBy Category (macro):");
    for (const [cat, m] of Object.entries(agg.macro.by_category)) {
      console.log(`  ${cat}: GP=${fmt(m.grounded_precision)} GR=${fmt(m.grounded_recall)} AP=${fmt(m.augmented_precision)} AR=${fmt(m.augmented_recall)} (${m.golden_tp_count} golden TPs)`);
    }
  }
}
