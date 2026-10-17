"""Create a six-metric macro Hub view with augmented F1 selected."""

import argparse
import asyncio
import hashlib
import json
import math
from pathlib import Path
import runpy
from uuid import UUID


PRIMARY_METRIC = "augmented_f1"
METRICS = (
    PRIMARY_METRIC, "grounded_f1",
    "grounded_precision", "grounded_recall",
    "augmented_precision", "augmented_recall",
)


def f1(precision, recall):
    if precision is None or recall is None:
        return None
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def prepare_job(job_dir, *, allow_partial=False):
    job_dir = Path(job_dir)
    job = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
    implementation = runpy.run_path(str(Path(__file__).with_name("metric.py")))
    plan, metric = implementation["load_profile"](job_dir, job_dir / "reviewbench-metric.py")
    job_id = str(UUID(job["id"]))
    if plan["job_id"] != job_id or not job.get("finished_at"):
        raise ValueError("Expected a finished job matching its frozen run plan")
    if plan["n_attempts"] != 1:
        raise ValueError("Hub macro display supports one round; upload independent rounds separately")
    stats = job["stats"]
    if any(stats[key] != 0 for key in ("n_running_trials", "n_pending_trials", "n_cancelled_trials")):
        raise ValueError("Cannot update metrics for an active or cancelled job")
    trials = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(job_dir.glob("*/result.json"))
    ]
    if len(trials) != job["n_total_trials"] or len(trials) != len(plan["trials"]) or {
        trial["trial_name"] for trial in trials
    } != set(plan["trials"]):
        raise ValueError("Trial coverage does not match the frozen run plan")
    prepared = {}
    rewards = []
    failed = 0
    for trial in trials:
        trial_id = str(UUID(trial["id"]))
        if trial_id in prepared:
            raise ValueError("Duplicate trial ID")
        planned = plan["trials"][trial["trial_name"]]
        reward = (trial.get("verifier_result") or {}).get("rewards")
        unsuccessful = bool(
            trial.get("exception_info") or not trial.get("finished_at")
            or trial.get("verifier_environment_mode") != "separate"
            or any(step.get("exception_info") for step in trial.get("step_results") or [])
            or reward is None
        )
        display = None
        if reward is not None:
            if not isinstance(reward, dict) or (
                reward.get("rb_task") != planned["task_id"]
                or reward.get("rb_evaluation") != planned["evaluation_id"]
                or reward.get("rb_round") != planned["round"]
                or reward.get("rb_failed") != int(unsuccessful)
            ):
                raise ValueError("Trial reward does not match its frozen task/version/round/status")
            clean = {key: value for key, value in reward.items() if key not in ("rb_round", "rb_failed")}
            counts = metric["read_counts"](clean)["overall"]
            if not unsuccessful:
                ratios = metric["ratios"](counts)
                for prefix in ("grounded", "augmented"):
                    ratios[f"{prefix}_f1"] = f1(
                        ratios[f"{prefix}_precision"], ratios[f"{prefix}_recall"],
                    )
                display = {key: ratios[key] for key in METRICS if ratios[key] is not None}
        failed += int(unsuccessful)
        rewards.append(reward)
        prepared[trial_id] = {"original": reward, "display": display}
    result = metric["compute_rounds"](
        rewards, plan["expected_tasks"], plan["n_attempts"], plan["source_prs"],
    )
    if stats["n_errored_trials"] != failed or result["failed_trials"] != failed:
        raise ValueError("Job failure counters do not match its trial evidence")
    if not result["complete"] and not allow_partial:
        raise ValueError("Incomplete run: use --allow-partial only for a clearly labeled partial display")
    if failed == len(trials):
        raise ValueError("No scored trials to display")
    scores = {}
    for key in METRICS:
        values = [row["display"][key] for row in prepared.values()
                  if row["display"] is not None and key in row["display"]]
        scores[key] = sum(values) / len(values) if values else None
    return {
        "job_id": job_id, "job_name": job_dir.name, "trials": prepared,
        "summary": {
            "aggregation": "macro", "complete": bool(result["complete"]),
            "planned_trials": len(trials), "scored_trials": len(trials) - failed,
            "failed_trials": failed, "scores": scores,
        },
    }


async def read_remote(client, job_id):
    rows = []
    while True:
        response = await (
            client.table("trial").select("id,rewards").eq("job_id", job_id)
            .order("id").range(len(rows), len(rows) + 999).execute()
        )
        if not isinstance(response.data, list):
            raise RuntimeError("Unexpected Hub trial response")
        rows.extend(response.data)
        if len(response.data) < 1000:
            break
    if len({row["id"] for row in rows}) != len(rows):
        raise RuntimeError("Duplicate Hub trial IDs")
    return {row["id"]: row["rewards"] for row in rows}


def validate_remote(remote, trials):
    if set(remote) != set(trials):
        raise ValueError("Upload the identical full job first; Hub trial IDs differ from local evidence")
    for trial_id, reward in remote.items():
        row = trials[trial_id]
        previous_display = (
            {key: value for key, value in row["display"].items() if not key.endswith("_f1")}
            if row["display"] is not None else None
        )
        if reward not in (row["original"], row["display"], previous_display):
            raise ValueError("Hub rewards differ from both original evidence and the intended display")


async def sync_metrics(client, prepared):
    job_id, trials = prepared["job_id"], prepared["trials"]
    remote = await read_remote(client, job_id)
    validate_remote(remote, trials)
    updated = 0
    for trial_id, row in trials.items():
        if remote[trial_id] == row["display"]:
            continue
        response = await (
            client.table("trial").update({"rewards": row["display"]})
            .eq("job_id", job_id).eq("id", trial_id).execute()
        )
        if not isinstance(response.data, list) or len(response.data) != 1 or response.data[0]["id"] != trial_id:
            raise RuntimeError("Hub metric update was not confirmed; synchronization is incomplete")
        updated += 1
    if await read_remote(client, job_id) != {key: row["display"] for key, row in trials.items()}:
        raise RuntimeError("Hub metric verification failed; synchronization is incomplete")
    return {**prepared["summary"], "updated_trials": updated}


async def publish_metrics(client, hub_client, copy_job, prepared, *, refresh_display=False):
    output = await sync_metrics(client, prepared)
    label = f"{prepared['job_name']} - macro metrics"
    if not output["complete"]:
        label += f" - partial {output['scored_trials']} of {output['planned_trials']}"
    # Hub's finalized overview can retain the original metric keys after row updates.
    copied = await copy_job(prepared["job_id"], name=label, overwrite=refresh_display)
    if not copied.complete:
        raise RuntimeError("Hub display copy is incomplete; re-run to resume it")
    overview = await hub_client.get_job_overview([copied.job_id], combined=True)
    verify_overview(overview, output)
    return view_result(output, prepared["job_id"], copied.job_id)


def verify_overview(overview, output):
    if (overview.n_total_trials, overview.n_errors) != (output["planned_trials"], output["failed_trials"]):
        raise RuntimeError("Hub display copy changed trial coverage or failure counts")
    if len(overview.eval_rows) != 1:
        raise RuntimeError("Expected one combined Hub overview")
    actual = {key: value for item in overview.eval_rows[0]["metrics"] for key, value in item.items()}
    expected = {key: value for key, value in output["scores"].items() if value is not None}
    if set(actual) != set(expected) or any(
        not math.isclose(actual[key], value, rel_tol=1e-12, abs_tol=1e-12)
        for key, value in expected.items()
    ):
        raise RuntimeError(
            "Hub overview does not expose the expected six macro metrics; "
            "use --refresh-display to refresh an existing display snapshot"
        )


def view_result(output, source_job_id, display_job_id):
    return {
        **output, "source_job_id": source_job_id,
        "display_job_id": display_job_id,
        "primary_metric": PRIMARY_METRIC,
        "url": f"https://hub.harborframework.com/jobs/{display_job_id}?breakdown_metric={PRIMARY_METRIC}",
    }


def write_upload_metrics(job_dir, *, allow_partial=False):
    from harbor.upload.metrics import UPLOAD_METRICS_FILENAME, UploadMetrics

    job_dir = Path(job_dir)
    prepared = prepare_job(job_dir, allow_partial=allow_partial)
    trials = {}
    for path in sorted(job_dir.glob("*/result.json")):
        result = json.loads(path.read_text(encoding="utf-8"))
        trials[result["id"]] = {
            "source_result_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "rewards": prepared["trials"][result["id"]]["display"],
        }
    name = prepared["job_name"]
    if not prepared["summary"]["complete"]:
        name += (
            f" - partial {prepared['summary']['scored_trials']}"
            f" of {prepared['summary']['planned_trials']}"
        )
    manifest = {
        "schema_version": 1, "job_id": prepared["job_id"], "trials": trials,
        "primary_metric": PRIMARY_METRIC if prepared["summary"]["scores"][PRIMARY_METRIC] is not None else None,
        "job_name": name, "partial": not prepared["summary"]["complete"],
    }
    UploadMetrics.model_validate(manifest)
    path = job_dir / UPLOAD_METRICS_FILENAME
    path.write_text(
        json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8",
    )
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--allow-partial", action="store_true",
                        help="Display scored trials from an incomplete job without hiding failed trials")
    parser.add_argument("--dry-run", action="store_true", help="Preview scores without accessing Hub")
    parser.add_argument("--refresh-display", action="store_true",
                        help="Replace an existing private display snapshot with current metric metadata")
    args = parser.parse_args()
    prepared = prepare_job(args.job_dir, allow_partial=args.allow_partial)
    if args.dry_run:
        output = prepared["summary"]
    else:
        async def publish():
            from harbor.auth.client import create_authenticated_client, require_user_id
            from harbor.hub.client import HubClient
            from harbor.hub.copy import copy_job

            await require_user_id()
            return await publish_metrics(
                await create_authenticated_client(), HubClient(), copy_job, prepared,
                refresh_display=args.refresh_display,
            )

        output = asyncio.run(publish())
    print(json.dumps(output, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
