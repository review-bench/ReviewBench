"""Harbor live metric; only complete, single-attempt datasets receive scores."""

import argparse
import json
import sys
from pathlib import Path

EXPECTED_TASKS = {}  # Replaced by the exporter with task_id: evaluation_id.
COUNTS = (
    "candidate_count", "golden_tp_count", "matched_count", "matched_tp_count",
    "unmatched_count", "unmatched_tp_count", "unmatched_fp_count", "golden_covered_count",
)
RATIOS = (
    "grounded_precision", "grounded_recall", "augmented_precision",
    "augmented_recall", "novel_tp_yield",
)


def ratios(counts):
    def divide(numerator, denominator):
        return numerator / denominator if denominator else None

    return {
        "grounded_precision": divide(counts["matched_tp_count"], counts["matched_count"]),
        "grounded_recall": divide(counts["golden_covered_count"], counts["golden_tp_count"]),
        "augmented_precision": divide(
            counts["matched_tp_count"] + counts["unmatched_tp_count"], counts["candidate_count"]
        ),
        "augmented_recall": divide(
            counts["golden_covered_count"] + counts["unmatched_tp_count"],
            counts["golden_tp_count"] + counts["unmatched_tp_count"],
        ),
        "novel_tp_yield": divide(counts["unmatched_tp_count"], counts["candidate_count"]),
    }


def read_counts(reward):
    groups = {}
    for key, value in reward.items():
        if key in ("rb_schema", "rb_task", "rb_evaluation"):
            continue
        prefix, separator, field = key.rpartition(".")
        if not separator or field not in COUNTS or not (
            prefix == "overall" or prefix.startswith(("by_severity.", "by_category."))
        ):
            raise ValueError(f"Unknown reward field: {key}")
        if type(value) not in (int, float) or not 0 <= value <= 2**53 - 1 or value != int(value):
            raise ValueError(f"Invalid count: {key}={value!r}")
        groups.setdefault(prefix, {})[field] = value
    if "overall" not in groups:
        raise ValueError("Missing overall counts")
    for prefix, counts in groups.items():
        if set(counts) != set(COUNTS):
            raise ValueError(f"Incomplete counts: {prefix}")
        if (
            counts["candidate_count"] != counts["matched_count"] + counts["unmatched_count"]
            or counts["unmatched_count"] != counts["unmatched_tp_count"] + counts["unmatched_fp_count"]
            or counts["matched_tp_count"] > counts["matched_count"]
            or counts["golden_covered_count"] > counts["golden_tp_count"]
        ):
            raise ValueError(f"Inconsistent counts: {prefix}")
    return groups


def compute(rewards, expected):
    if not expected:
        raise ValueError("Metric has no expected tasks; use the generated dataset metric.py")
    seen = set()
    rows = []
    failed = duplicates = 0
    for reward in rewards:
        if reward is None:
            failed += 1
            continue
        if not isinstance(reward, dict) or reward.get("rb_schema") != 1:
            raise ValueError("Unsupported ReviewBench reward schema")
        task_id = str(reward.get("rb_task"))
        if task_id not in expected or reward.get("rb_evaluation") != expected[task_id]:
            raise ValueError("Reward belongs to another task or evaluation version")
        if task_id in seen:
            duplicates += 1
        seen.add(task_id)
        rows.append(read_counts(reward))

    complete = not failed and not duplicates and len(seen) == len(expected)
    output = {
        "complete": int(complete), "expected_prs": len(expected), "scored_prs": len(seen),
        "failed_trials": failed, "duplicate_trials": duplicates,
    }
    if not complete:
        print(f"ReviewBench incomplete: {output}; aggregate scores withheld", file=sys.stderr)
        return output

    for prefix in sorted({key for row in rows for key in row}):
        strata = [row[prefix] for row in rows if prefix in row]
        pooled = {key: sum(row[key] for row in strata) for key in COUNTS}
        per_pr = [ratios(row) for row in strata]
        micro = ratios(pooled)
        for mode in ("macro", "micro"):
            for field, value in {**pooled, "novel_tp_count": pooled["unmatched_tp_count"]}.items():
                output[f"{mode}.{prefix}.{field}"] = value
            for field in RATIOS:
                defined = [row[field] for row in per_pr if row[field] is not None]
                value = (sum(defined) / len(defined) if defined else None) if mode == "macro" else micro[field]
                key = f"{mode}.{prefix}.{field}"
                output[f"{key}.defined"] = int(value is not None)
                if value is not None:
                    output[key] = value
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", type=Path, required=True)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    rewards = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    result = compute(rewards, EXPECTED_TASKS)
    if args.require_complete and not result["complete"]:
        raise ValueError("Refusing to publish an incomplete ReviewBench evaluation")
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
