"""Require a complete, exception-free Harbor job before reporting its metrics."""

import argparse
import json
import runpy
from pathlib import Path


def check_job(job_dir, metric_path):
    job = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
    if not job.get("finished_at"):
        raise ValueError("Harbor job has not finished")
    stats = job["stats"]
    for field in (
        "n_errored_trials", "n_running_trials", "n_pending_trials",
        "n_cancelled_trials",
    ):
        if stats[field] != 0:
            raise ValueError(f"Harbor job has {field}={stats[field]}")
    trials = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(job_dir.glob("*/result.json"))
    ]
    if len(trials) != job["n_total_trials"] or not trials:
        raise ValueError("Missing trial results or empty job")
    rewards = []
    for trial in trials:
        if not trial.get("finished_at") or trial.get("exception_info"):
            raise ValueError(f"Unfinished or failed trial: {trial['trial_name']}")
        if trial.get("verifier_environment_mode") != "separate":
            raise ValueError("Trial did not use a separate verifier sandbox")
        if any(step.get("exception_info") for step in trial.get("step_results") or []):
            raise ValueError("Trial contains a failed step")
        rewards.append((trial.get("verifier_result") or {}).get("rewards"))
    metric = runpy.run_path(str(metric_path))
    output = metric["compute"](rewards, metric["EXPECTED_TASKS"])
    if output["complete"] != 1:
        raise ValueError("Incomplete or duplicate ReviewBench reward coverage")
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("metric", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.unlink(missing_ok=True)
    output = check_job(args.job_dir, args.metric)
    args.output.write_text(
        json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(f"Verified {output['scored_prs']} PRs with zero Harbor trial exceptions")


if __name__ == "__main__":
    main()
