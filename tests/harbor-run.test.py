"""Exercise native Harbor flags and hooks with synthetic trials, never inference."""

import asyncio
from datetime import datetime
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ["HARBOR_TELEMETRY"] = "off"

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "harbor"
PLUGIN = "reviewbench_plugin:ReviewBenchPlugin"
if os.environ.get("REVIEWBENCH_TEST_INSTALLED") == "1":
    import reviewbench_harbor

    SOURCE = Path(reviewbench_harbor.__file__).resolve().parent
    PLUGIN = "reviewbench_harbor.reviewbench_plugin:ReviewBenchPlugin"
sys.path.insert(0, str(SOURCE))
METRIC = runpy.run_path(str(SOURCE / "metric.py"))
CHECK = runpy.run_path(str(SOURCE / "check-job.py"))["check_job"]


def reward(task, true_positives, number=None):
    result = {
        "rb_schema": 1, "rb_task": task, "rb_evaluation": 42,
        "overall.candidate_count": 2, "overall.golden_tp_count": 2,
        "overall.matched_count": 2, "overall.matched_tp_count": true_positives,
        "overall.unmatched_count": 0, "overall.unmatched_tp_count": 0,
        "overall.unmatched_fp_count": 0, "overall.golden_covered_count": true_positives,
    }
    if number is not None:
        result.update(rb_round=number, rb_failed=0)
    return result


class RoundMetricTests(unittest.TestCase):
    def compute(self, rewards, attempts=3):
        return METRIC["compute_rounds"](rewards, {"0": 42, "1": 42}, attempts, 219)

    def complete_rewards(self):
        return [reward(task, 3 - number, number) for number in (1, 2, 3) for task in (0, 1)]

    def test_independent_rounds_mean_population_stddev_not_best_of(self):
        result = self.compute(list(reversed(self.complete_rewards())))
        self.assertEqual((result["complete"], result["expected_prs"], result["expected_trials"]), (1, 2, 6))
        self.assertEqual((result["source_prs"], result["full_dataset"], result["completed_rounds"]), (219, 0, 3))
        for number, precision in ((1, 1), (2, .5), (3, 0)):
            self.assertEqual(result[f"round.{number}.micro.overall.grounded_precision"], precision)
        self.assertEqual(result["summary.micro.overall.grounded_precision.mean"], .5)
        self.assertAlmostEqual(result["summary.micro.overall.grounded_precision.stddev"], math.sqrt(1 / 6))
        self.assertEqual(result["summary.micro.overall.grounded_precision.defined_rounds"], 3)

    def test_missing_failed_duplicate_or_unassigned_attempts_withhold_summary(self):
        rewards = self.complete_rewards()
        failed = {**rewards[-1], "rb_failed": 1}
        for rows in (rewards[:-1], [*rewards[:-1], None], [*rewards[:-1], rewards[0]],
                     [*rewards[:-1], failed], [*rewards[:-1], reward(1, 0)]):
            with self.subTest(rows=rows):
                result = self.compute(rows)
                self.assertEqual(result["complete"], 0)
                self.assertFalse(any(key.startswith("summary.") for key in result))

    def test_versions_round_bounds_and_reward_shapes_are_not_relaxed(self):
        valid = self.complete_rewards()
        for changed in (
            {"rb_evaluation": 43}, {"rb_task": 219}, {"rb_round": 0}, {"rb_round": 4},
            {"rb_round": True}, {"rb_failed": None}, {"rb_failed": 2},
            {"overall.candidate_count": 3}, {"unexpected": 1},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.compute([*valid[:-1], {**valid[-1], **changed}])
        for attempts in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                self.compute(valid, attempts)

    def test_null_ratios_are_excluded_and_counted_not_coerced_to_zero(self):
        first = reward(0, 2, 1)
        second = reward(0, 0, 2)
        for key in list(second):
            if key.startswith("overall.") and key != "overall.golden_tp_count":
                second[key] = 0
        result = METRIC["compute_rounds"]([first, second], {"0": 42}, 2, 1)
        self.assertEqual(result["summary.micro.overall.grounded_precision.mean"], 1)
        self.assertEqual(result["summary.micro.overall.grounded_precision.defined_rounds"], 1)
        self.assertEqual(result["summary.micro.overall.grounded_precision.stddev"], 0)
        for key in list(first):
            if key.startswith("overall.") and key != "overall.golden_tp_count":
                first[key] = 0
        result = METRIC["compute_rounds"]([first, second], {"0": 42}, 2, 1)
        self.assertEqual(result["summary.micro.overall.grounded_precision.defined_rounds"], 0)
        self.assertNotIn("summary.micro.overall.grounded_precision.mean", result)

    def test_categories_missing_from_a_round_have_zero_counts_not_inflated_means(self):
        first, second = reward(0, 2, 1), reward(0, 0, 2)
        first.update({
            key.replace("overall.", "by_category.new."): value
            for key, value in list(first.items()) if key.startswith("overall.")
        })
        result = METRIC["compute_rounds"]([first, second], {"0": 42}, 2, 1)
        self.assertEqual(result["summary.micro.by_category.new.candidate_count.mean"], 1)
        self.assertEqual(result["summary.micro.by_category.new.candidate_count.stddev"], 1)


class NativeHarborTests(unittest.TestCase):
    def setUp(self):
        from harbor.cli.main import app
        from typer.testing import CliRunner

        self.app = app
        self.runner = CliRunner()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(self.close_fixture_loggers)
        self.dataset = self.root / "dataset"
        self.dataset.mkdir()
        for task in range(3):
            directory = self.dataset / f"task-{task}"
            (directory / "environment").mkdir(parents=True)
            (directory / "tests").mkdir()
            (directory / "instruction.md").write_text("Frozen fixture review.\n", encoding="utf-8")
            (directory / "environment" / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
            (directory / "tests" / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
            (directory / "tests" / "test.sh").write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            (directory / "tests" / "task.json").write_text(
                json.dumps({"task_id": task, "evaluation_id": 42}), encoding="utf-8",
            )
            (directory / "task.toml").write_text(
                f'schema_version = "1.3"\n[task]\nname = "fixture/task-{task}"\n'
                '[verifier]\nenvironment_mode = "separate"\n', encoding="utf-8",
            )
        self.metric = self.dataset / "metric.py"
        self.metric.write_text((SOURCE / "metric.py").read_text(encoding="utf-8").replace(
            "EXPECTED_TASKS = {}", 'EXPECTED_TASKS = {"0":42,"1":42,"2":42}',
        ), encoding="utf-8", newline="\n")
        self.config = self.root / "job.json"
        self.config.write_text(json.dumps({
            "job_name": "native-flags", "jobs_dir": str(self.root / "jobs"),
            "datasets": [{"path": str(self.dataset)}],
            "agents": [{"name": "nop"}],
            "metrics": [{"type": "uv-script", "kwargs": {"script_path": str(self.metric)}}],
        }), encoding="utf-8")
        self.job = self.root / "jobs" / "native-flags"
        self.active = self.peak = self.executed = 0
        self.completion_order = []
        self.fail_trial = False

    def close_fixture_loggers(self):
        from harbor.utils.logger import logger
        for handler in list(logger.handlers):
            path = getattr(handler, "baseFilename", None)
            if path and Path(path).is_relative_to(self.root):
                handler.close()
                logger.removeHandler(handler)

    def invoke(self, extra=None, custom=False):
        from harbor.environments.factory import EnvironmentFactory
        from harbor.models.trial.result import AgentInfo, ExceptionInfo, TrialResult
        from harbor.models.verifier.result import VerifierResult
        from harbor.trial.hooks import TrialEvent
        from harbor.trial.queue import TrialQueue

        if custom:
            module_path = self.root / "fixture_agent.py"
            module_path.write_text(
                "from harbor.agents.base import BaseAgent\n"
                "class CustomAgent(BaseAgent):\n"
                "    @staticmethod\n"
                "    def name(): return 'fixture-custom'\n"
                "    def version(self): return 'fixture'\n"
                "    async def setup(self, environment): raise AssertionError('No real environment allowed')\n"
                "    async def run(self, instruction, environment, context): raise AssertionError('No inference allowed')\n",
                encoding="utf-8",
            )
            sys.path.insert(0, str(self.root))
            self.addCleanup(lambda: sys.path.remove(str(self.root)))
            importlib.invalidate_caches()

        async def synthetic_trial(queue, config):
            self.executed += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
            task = json.loads((config.task.path / "tests" / "task.json").read_text())["task_id"]
            plan = json.loads((self.job / "reviewbench-plan.json").read_text())
            number = plan["trials"][config.trial_name]["round"]
            directory = self.job / config.trial_name
            directory.mkdir()
            (directory / "config.json").write_text(config.model_dump_json(), encoding="utf-8")
            result = TrialResult(
                task_name=f"task-{task}", trial_name=config.trial_name,
                trial_uri=directory.as_uri(), task_id=config.task.get_task_id(),
                source=config.task.source, task_checksum="a" * 64, config=config,
                agent_info=AgentInfo(name="fixture-custom" if custom else "nop", version="fixture"),
                started_at=datetime.now(), verifier_environment_mode="separate",
            )
            event = SimpleNamespace(
                config=config, result=result, trial_name=config.trial_name,
                task_name=result.task_name, timestamp=datetime.now(),
            )
            for callback in queue._hooks[TrialEvent.START]:
                await callback(event)
            # Complete task 1 before task 0 so round identity cannot use completion order.
            await asyncio.sleep(.08 if task == 0 else .001)
            result.finished_at = datetime.now()
            result.verifier_result = VerifierResult(rewards=reward(task, max(0, 3 - number)))
            if self.fail_trial and task == 0 and number == 1:
                result.exception_info = ExceptionInfo.from_exception(RuntimeError("fixture failure"))
            (directory / "result.json").write_text(result.model_dump_json(), encoding="utf-8")
            for callback in queue._hooks[TrialEvent.END]:
                await callback(event)
            self.completion_order.append((task, number))
            self.active -= 1
            return result

        arguments = [
            "run", "-c", str(self.config), "-p", str(self.dataset), "-n", "2", "-l", "2", "-k", "3",
            "--plugin", PLUGIN, "--yes",
        ]
        if custom:
            arguments += ["-a", "fixture_agent:CustomAgent"]
        arguments += extra or []
        with patch.object(EnvironmentFactory, "run_preflight"), patch.object(
            TrialQueue, "_execute_trial_with_retries", synthetic_trial,
        ):
            return self.runner.invoke(self.app, arguments)

    def test_native_flags_and_final_live_metrics_for_builtin_and_custom_harnesses(self):
        for custom in (False, True):
            with self.subTest(custom=custom):
                if custom:
                    self.config.write_text(self.config.read_text().replace("native-flags", "custom-flags"))
                    self.job = self.root / "jobs" / "custom-flags"
                    self.executed = self.peak = 0
                    self.completion_order.clear()
                result = self.invoke(custom=custom)
                self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
                self.assertEqual((self.executed, self.peak), (6, 2))
                plan = json.loads((self.job / "reviewbench-plan.json").read_text())
                self.assertEqual(plan["expected_tasks"], {"0": 42, "1": 42})
                self.assertEqual((plan["n_attempts"], plan["n_concurrent_trials"]), (3, 2))
                self.assertEqual(self.completion_order[0], (1, 1))
                report = CHECK(self.job, self.metric)
                self.assertEqual(report["complete"], 1)
                self.assertAlmostEqual(report["summary.micro.overall.grounded_precision.mean"], .5)
                retained = json.loads((self.job / "reviewbench-summary.json").read_text())
                self.assertEqual(retained, report)
                job_result = json.loads((self.job / "result.json").read_text())
                live = next(iter(job_result["stats"]["evals"].values()))["metrics"][0]
                self.assertEqual(live, report)
                self.assertFalse((self.job / "upload-metrics.json").exists())

    def test_native_other_limits_and_filters_freeze_actual_selection(self):
        result = self.invoke(["-n", "1", "-l", "1", "-k", "2", "--include-task-name", "task-1"])
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertEqual((self.executed, self.peak), (2, 1))
        report = CHECK(self.job, self.metric)
        self.assertEqual((report["expected_prs"], report["expected_trials"], report["n_attempts"]), (1, 2, 2))
        self.assertEqual(json.loads((self.job / "reviewbench-plan.json").read_text())["expected_tasks"], {"1": 42})

    def test_full_run_without_limit_remains_distinct_from_subset(self):
        result = self.invoke(["-l", "3", "-k", "1"])
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        report = CHECK(self.job, self.metric)
        self.assertEqual((report["full_dataset"], report["expected_prs"], report["n_attempts"]), (1, 3, 1))
        manifest = json.loads((self.job / "upload-metrics.json").read_text())
        self.assertEqual(manifest["primary_metric"], "augmented_f1")
        self.assertFalse(manifest["partial"])
        self.assertEqual(len(manifest["trials"]), 3)
        for path in self.job.glob("*/result.json"):
            trial = json.loads(path.read_text())
            projected = manifest["trials"][trial["id"]]
            self.assertEqual(projected["source_result_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(set(projected["rewards"]), {
                "grounded_precision", "grounded_recall", "grounded_f1",
                "augmented_precision", "augmented_recall", "augmented_f1",
            })

    def test_partial_single_round_exports_all_trials_without_weakening_the_gate(self):
        self.fail_trial = True
        result = self.invoke(["-k", "1"])
        self.assertEqual(self.executed, 2, result.output)
        with self.assertRaises(ValueError):
            CHECK(self.job, self.metric)
        self.assertFalse((self.job / "reviewbench-summary.json").exists())
        manifest = json.loads((self.job / "upload-metrics.json").read_text())
        self.assertTrue(manifest["partial"])
        self.assertEqual(len(manifest["trials"]), 2)
        self.assertEqual(sum(row["rewards"] is None for row in manifest["trials"].values()), 1)

    def test_invalid_native_numbers_never_execute_trials(self):
        for arguments in (["-n", "0"], ["-l", "0"], ["-k", "0"], ["-k", "-1"], ["-l", "not-a-number"]):
            with self.subTest(arguments=arguments):
                result = self.invoke(arguments)
                self.assertNotEqual(result.exit_code, 0, result.output)
                self.assertEqual(self.executed, 0)

    def test_gate_rejects_missing_round_wrong_metadata_and_metric_tampering(self):
        result = self.invoke()
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        path = next(self.job.glob("*/result.json"))
        original = path.read_text()
        trial = json.loads(original)
        for changed in (
            {"rb_round": 99}, {"rb_task": 2}, {"rb_evaluation": 43}, {"rb_failed": 1},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                path.write_text(json.dumps({
                    **trial, "verifier_result": {"rewards": {**trial["verifier_result"]["rewards"], **changed}},
                }))
                CHECK(self.job, self.metric)
        path.unlink()
        with self.assertRaises(ValueError):
            CHECK(self.job, self.metric)
        path.write_text(original)
        snapshot = self.job / "reviewbench-metric.py"
        snapshot.write_text(snapshot.read_text() + "\n# changed\n")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            CHECK(self.job, self.metric)

    def test_failed_trials_never_gain_round_or_summary_scores(self):
        self.fail_trial = True
        result = self.invoke()
        self.assertEqual(self.executed, 6, result.output)
        with self.assertRaises(ValueError):
            CHECK(self.job, self.metric)
        self.assertFalse((self.job / "reviewbench-summary.json").exists())
        job = json.loads((self.job / "result.json").read_text())
        metric = next(iter(job["stats"]["evals"].values()))["metrics"][0]
        self.assertEqual(metric["complete"], 0)
        self.assertFalse(any(key.startswith("summary.") for key in metric))

    def test_downloaded_job_is_self_contained_and_resume_preserves_rounds(self):
        result = self.invoke()
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        original = CHECK(self.job, self.metric)
        frozen = (self.job / "reviewbench-plan.json").read_text()
        result = self.invoke()
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertEqual(self.executed, 6, "completed attempts must not be run twice")
        self.assertEqual((self.job / "reviewbench-plan.json").read_text(), frozen)
        missing = next(self.job.glob("*/result.json")).parent
        shutil.rmtree(missing)
        result = self.invoke()
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        self.assertEqual(self.executed, 7, "resume must run only the missing planned attempt")
        self.assertEqual((self.job / "reviewbench-plan.json").read_text(), frozen)
        readback = self.root / "readback"
        shutil.copytree(self.job, readback)
        self.assertEqual(CHECK(readback, readback / "reviewbench-metric.py"), original)

    def test_changed_existing_plan_and_wrong_source_metric_fail_closed(self):
        result = self.invoke()
        self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
        wrong = self.root / "wrong-metric.py"
        wrong.write_text(self.metric.read_text() + "\n# another profile\n")
        with self.assertRaisesRegex(ValueError, "scoring profile"):
            CHECK(self.job, wrong)
        plan = self.job / "reviewbench-plan.json"
        content = json.loads(plan.read_text())
        content["trials"][next(iter(content["trials"]))]["round"] = 99
        plan.write_text(json.dumps(content))
        result = self.invoke()
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(self.executed, 6)


if __name__ == "__main__":
    unittest.main()
