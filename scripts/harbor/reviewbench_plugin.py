"""Harness-independent run planning for the pinned Harbor 0.24 job plugin API."""

import ast
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import runpy

from harbor.metrics.base import BaseMetric
from harbor.metrics.uv_script import UvScript


PLAN = "reviewbench-plan.json"
METRIC = "reviewbench-metric.py"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expected_tasks(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    assignments = [
        node for node in tree.body
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "EXPECTED_TASKS" for target in node.targets
        )
    ]
    if len(assignments) != 1:
        raise ValueError("Expected one frozen EXPECTED_TASKS map in the dataset metric")
    expected = ast.literal_eval(assignments[0].value)
    if not isinstance(expected, dict) or not expected or any(
        not isinstance(key, str) or not key.isdecimal()
        or type(value) is not int or not 0 <= value < 2**53
        for key, value in expected.items()
    ):
        raise ValueError("Invalid frozen dataset evaluation map")
    return expected


class RoundMetric(BaseMetric):
    def __init__(self, plan, metric):
        self.plan = plan
        self.metric = metric

    def compute(self, rewards):
        return self.metric["compute_rounds"](
            rewards, self.plan["expected_tasks"], self.plan["n_attempts"], self.plan["source_prs"],
        )


class ReviewBenchPlugin:
    async def on_job_start(self, job):
        if version("harbor") != "0.24.0":
            raise ValueError("ReviewBench run planning requires pinned Harbor 0.24.0")
        if len(job.config.agents) != 1 or len(job.config.datasets) != 1 or job.config.tasks:
            raise ValueError("Run one configured reviewer and one ReviewBench dataset per job; any harness is supported")
        if job.config.source_jobs or job.config.install_only or job.config.verifier.disable:
            raise ValueError("ReviewBench run planning requires a normal, verified benchmark run")
        # Harbor 0.24 exposes hooks but not its resolved plan or metric replacement.
        # Keep the pinned SDK compatibility boundary here, without modifying Harbor.
        trials = job._trial_configs
        downloads = job._task_download_results
        metrics = job._metrics
        if not trials or not isinstance(metrics, dict):
            raise ValueError("Unsupported Harbor resolved-plan interface")
        candidates = [
            metric for group in metrics.values() for metric in group if isinstance(metric, UvScript)
        ]
        if not candidates:
            raise ValueError("The dataset must supply its frozen ReviewBench uv-script metric")
        catalogs = [expected_tasks(metric._script_path) for metric in candidates]
        if any(catalog != catalogs[0] for catalog in catalogs):
            raise ValueError("Cannot combine different ReviewBench scoring profiles")
        catalog = catalogs[0]
        counts = {}
        selected = {}
        trial_rounds = {}
        self.job_dir = job.job_dir
        profile_path = self.job_dir / PLAN
        existing = json.loads(profile_path.read_text(encoding="utf-8")) if profile_path.exists() else None
        reserved = {trial.trial_name for trial in trials}
        for trial in trials:
            downloaded = downloads[trial.task.get_task_id()]
            task = json.loads((downloaded.path / "tests" / "task.json").read_text(encoding="utf-8"))
            task_id, evaluation = task.get("task_id"), task.get("evaluation_id")
            if type(task_id) is not int or type(evaluation) is not int or catalog.get(str(task_id)) != evaluation:
                raise ValueError("Selected task identity/version does not match the dataset metric")
            identity = str(task_id)
            selected[identity] = evaluation
            counts[identity] = counts.get(identity, 0) + 1
            if counts[identity] > job.config.n_attempts or trial.trial_name in trial_rounds:
                raise ValueError("Duplicate task selection or ambiguous trial plan")
            number = counts[identity]
            if existing:
                previous = existing["trials"].get(trial.trial_name)
                if previous is None:
                    # Harbor regenerates names for pending attempts on resume.
                    available = [
                        (name, entry) for name, entry in existing["trials"].items()
                        if name not in reserved and name not in trial_rounds
                        and entry["task_id"] == task_id and entry["evaluation_id"] == evaluation
                    ]
                    if not available:
                        raise ValueError("Resumed trial is absent from the frozen run plan")
                    name, previous = min(available, key=lambda pair: pair[1]["round"])
                    trial.trial_name = name
                if previous["task_id"] != task_id or previous["evaluation_id"] != evaluation:
                    raise ValueError("Resumed trial does not match the frozen task/version")
                number = previous["round"]
            trial_rounds[trial.trial_name] = {
                "round": number, "task_id": task_id, "evaluation_id": evaluation,
            }
        if any(count != job.config.n_attempts for count in counts.values()):
            raise ValueError("Every selected task must have exactly k planned attempts")
        source = Path(__file__).with_name("metric.py")
        if not source.exists():
            source = Path(__file__).with_name(METRIC)
        text = source.read_text(encoding="utf-8")
        tree = ast.parse(text)
        assignment = next(
            node for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "EXPECTED_TASKS" for target in node.targets)
        )
        lines = text.splitlines(keepends=True)
        lines[assignment.lineno - 1:assignment.end_lineno] = [
            f"EXPECTED_TASKS = {json.dumps(selected, sort_keys=True)}\n"
        ]
        snapshot = "".join(lines)
        plan = {
            "schema_version": 1, "job_id": str(job.id),
            "expected_tasks": selected, "source_prs": len(catalog),
            "n_attempts": job.config.n_attempts,
            "n_concurrent_trials": job.config.n_concurrent_trials,
            "trials": trial_rounds,
            "source_metric_sha256": sorted({digest(metric._script_path) for metric in candidates}),
            "metric_sha256": hashlib.sha256(snapshot.encode()).hexdigest(),
            "aggregation": "independent-rounds-mean-population-stddev",
            "official_submission": False,
        }
        self.job_dir.mkdir(parents=True, exist_ok=True)
        if profile_path.exists():
            if json.loads(profile_path.read_text(encoding="utf-8")) != plan:
                raise ValueError("Existing frozen run plan differs; use a new job or resume the identical plan")
            if (self.job_dir / METRIC).read_text(encoding="utf-8") != snapshot:
                raise ValueError("Existing run metric snapshot differs")
        else:
            if (self.job_dir / "result.json").exists():
                raise ValueError("Cannot attach a new run plan to previously executed trials")
            (self.job_dir / METRIC).write_text(snapshot, encoding="utf-8", newline="\n")
            profile_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8", newline="\n")
        self.plan, implementation = runpy.run_path(str(source))["load_profile"](self.job_dir, self.job_dir / METRIC)
        replacement = RoundMetric(self.plan, implementation)
        for group in metrics.values():
            group[:] = [replacement if isinstance(metric, UvScript) else metric for metric in group]
        job.on_trial_ended(self.on_trial_end)
        print(
            f"ReviewBench plan: {len(selected)}/{len(catalog)} PRs, "
            f"{job.config.n_attempts} rounds, {len(trials)} trials, "
            f"concurrency {job.config.n_concurrent_trials}."
        )

    async def on_trial_end(self, event):
        planned = self.plan["trials"].get(event.trial_name)
        if planned is None:
            raise ValueError("Trial is absent from the frozen ReviewBench plan")
        result = event.result
        reward = result.verifier_result.rewards if result.verifier_result else None
        if reward is not None:
            if reward.get("rb_task") != planned["task_id"] or reward.get("rb_evaluation") != planned["evaluation_id"]:
                raise ValueError("Trial reward does not match its planned task/version")
            reward["rb_round"] = planned["round"]
            reward["rb_failed"] = int(
                bool(result.exception_info) or not result.finished_at
                or result.verifier_environment_mode != "separate"
                or any(step.exception_info for step in result.step_results or [])
            )
            (self.job_dir / event.trial_name / "result.json").write_text(
                result.model_dump_json(indent=4), encoding="utf-8",
            )

    async def on_job_end(self, job_result):
        if self.plan["n_attempts"] == 1:
            projector = runpy.run_path(str(Path(__file__).with_name("hub_metrics.py")))["write_upload_metrics"]
            projector(self.job_dir, allow_partial=True)
        else:
            print("Hub headline metrics require independent single-round jobs; round verification is unchanged.")
        # Reuse the offline gate so the retained report and live metric agree.
        checker = Path(__file__).with_name("check-job.py")
        check = runpy.run_path(str(checker))["check_job"]
        report = self.job_dir / "reviewbench-summary.json"
        report.unlink(missing_ok=True)
        output = check(self.job_dir, self.job_dir / METRIC)
        report.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(f"ReviewBench verified {output['expected_prs']} PRs x {output['n_attempts']} rounds; report: {report}")
