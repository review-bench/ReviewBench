import type { PRScoreResult, MetricSet } from "../eval/scorer.js";

export const COUNT_FIELDS = [
  "candidate_count", "golden_tp_count", "matched_count", "matched_tp_count",
  "unmatched_count", "unmatched_tp_count", "unmatched_fp_count", "golden_covered_count",
] as const;

export interface TaskIdentity {
  task_id: number;
  evaluation_id: number;
}

export function toRewards(score: PRScoreResult, identity: TaskIdentity): Record<string, number> {
  const rewards: Record<string, number> = {
    rb_schema: 1,
    rb_task: identity.task_id,
    rb_evaluation: identity.evaluation_id,
  };
  function add(prefix: string, metrics: MetricSet): void {
    for (const field of COUNT_FIELDS) {
      const value = metrics[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid score count ${prefix}.${field}: ${value}`);
      }
      rewards[`${prefix}.${field}`] = value;
    }
  }
  add("overall", score.metrics.overall);
  for (const dimension of ["by_severity", "by_category"] as const) {
    for (const [name, metrics] of Object.entries(score.metrics[dimension])) {
      add(`${dimension}.${encodeURIComponent(name)}`, metrics);
    }
  }
  return rewards;
}
