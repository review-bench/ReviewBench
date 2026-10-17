"""Check Hub presentation without inference, credentials, or remote writes."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from uuid import uuid4

if os.environ.get("REVIEWBENCH_TEST_INSTALLED") == "1":
    from reviewbench_harbor import hub_metrics as hub
else:
    source = Path(__file__).resolve().parents[1] / "scripts" / "harbor" / "hub_metrics.py"
    spec = importlib.util.spec_from_file_location("hub_metrics", source)
    hub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hub)


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.job = Path(temp.name)
        self.job_id = str(uuid4())
        expected = {"1": 42, "2": 42}
        text = Path(hub.__file__).with_name("metric.py").read_text().replace(
            "EXPECTED_TASKS = {}", f"EXPECTED_TASKS = {expected!r}",
        )
        (self.job / "reviewbench-metric.py").write_text(text, encoding="utf-8", newline="\n")
        digest = hashlib.sha256((self.job / "reviewbench-metric.py").read_bytes()).hexdigest()
        self.plan = {
            "schema_version": 1, "job_id": self.job_id, "expected_tasks": expected,
            "n_attempts": 1, "source_prs": 219, "metric_sha256": digest,
            "source_metric_sha256": [digest],
            "trials": {f"trial-{n}": {"task_id": n, "evaluation_id": 42, "round": 1} for n in (1, 2)},
        }
        self.write("reviewbench-plan.json", self.plan)
        self.result = {
            "id": self.job_id, "finished_at": "2026-10-16T00:00:00Z", "n_total_trials": 2,
            "stats": {
                "n_errored_trials": 0, "n_running_trials": 0,
                "n_pending_trials": 0, "n_cancelled_trials": 0,
            },
        }
        self.write("result.json", self.result)
        self.trials = []
        for n, matched, correct, novel, covered in ((1, 2, 1, 1, 2), (2, 1, 1, 0, 1)):
            reward = {
                "rb_schema": 1, "rb_task": n, "rb_evaluation": 42, "rb_round": 1, "rb_failed": 0,
                "overall.candidate_count": matched + novel,
                "overall.golden_tp_count": 4,
                "overall.matched_count": matched, "overall.matched_tp_count": correct,
                "overall.unmatched_count": novel, "overall.unmatched_tp_count": novel,
                "overall.unmatched_fp_count": 0, "overall.golden_covered_count": covered,
            }
            trial = {
                "id": str(uuid4()), "trial_name": f"trial-{n}", "finished_at": self.result["finished_at"],
                "exception_info": None, "verifier_environment_mode": "separate",
                "verifier_result": {"rewards": reward},
            }
            self.trials.append(trial)
            self.write(f"trial-{n}/result.json", trial)

    def write(self, name, value):
        path = self.job / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def prepare(self, **kwargs):
        return hub.prepare_job(self.job, **kwargs)


class PreparationTests(Fixture):
    def test_only_six_macro_scores_and_original_evidence_unchanged(self):
        before = {str(path): path.read_bytes() for path in self.job.rglob("*") if path.is_file()}
        prepared = self.prepare()
        self.assertTrue(prepared["summary"]["complete"])
        self.assertEqual(set(prepared["summary"]["scores"]), set(hub.METRICS))
        self.assertAlmostEqual(prepared["summary"]["scores"]["grounded_precision"], .75)
        self.assertNotAlmostEqual(prepared["summary"]["scores"]["grounded_precision"], 2 / 3)
        self.assertAlmostEqual(prepared["summary"]["scores"]["grounded_f1"], .45)
        self.assertAlmostEqual(prepared["summary"]["scores"]["augmented_f1"], (12 / 19 + .4) / 2)
        self.assertNotAlmostEqual(
            prepared["summary"]["scores"]["grounded_f1"],
            hub.f1(prepared["summary"]["scores"]["grounded_precision"],
                   prepared["summary"]["scores"]["grounded_recall"]),
        )
        for row in prepared["trials"].values():
            self.assertEqual(set(row["display"]), set(hub.METRICS))
            self.assertIn("overall.golden_tp_count", row["original"])
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.job.rglob("*") if path.is_file()})

    def test_undefined_ratios_are_not_zero(self):
        reward = self.trials[0]["verifier_result"]["rewards"]
        for key in list(reward):
            if key.startswith("overall."):
                reward[key] = 0
        self.write("trial-1/result.json", self.trials[0])
        prepared = self.prepare()
        self.assertEqual(prepared["trials"][self.trials[0]["id"]]["display"], {})
        self.assertEqual(prepared["summary"]["scores"]["grounded_precision"], 1)

    def test_f1_zero_and_undefined_are_distinct(self):
        self.assertEqual(hub.f1(0, 0), 0)
        self.assertEqual(hub.f1(1, 0), 0)
        self.assertEqual(hub.f1(0, 1), 0)
        self.assertIsNone(hub.f1(None, 0))
        self.assertIsNone(hub.f1(0, None))
        self.assertAlmostEqual(hub.f1(.5, 1), 2 / 3)

    def test_partial_display_requires_explicit_flag_and_preserves_failure(self):
        self.trials[1]["exception_info"] = {"exception_type": "RuntimeError"}
        self.trials[1]["verifier_result"] = None
        self.result["stats"]["n_errored_trials"] = 1
        self.write("trial-2/result.json", self.trials[1])
        self.write("result.json", self.result)
        with self.assertRaisesRegex(ValueError, "--allow-partial"):
            self.prepare()
        prepared = self.prepare(allow_partial=True)
        self.assertFalse(prepared["summary"]["complete"])
        self.assertEqual((prepared["summary"]["planned_trials"], prepared["summary"]["scored_trials"],
                          prepared["summary"]["failed_trials"]), (2, 1, 1))
        self.assertIsNone(prepared["trials"][self.trials[1]["id"]]["display"])

    def test_active_wrong_identity_invalid_counts_and_wrong_failure_counts_fail(self):
        changes = (
            ("result.json", {**self.result, "finished_at": None}),
            ("result.json", {**self.result, "id": str(uuid4())}),
            ("result.json", {**self.result, "stats": {**self.result["stats"], "n_errored_trials": 1}}),
            ("trial-1/result.json", {**self.trials[0], "id": self.trials[1]["id"]}),
            ("trial-1/result.json", {**self.trials[0], "verifier_result": {"rewards": {
                **self.trials[0]["verifier_result"]["rewards"], "rb_evaluation": 43,
            }}}),
            ("trial-1/result.json", {**self.trials[0], "verifier_result": {"rewards": {
                **self.trials[0]["verifier_result"]["rewards"], "overall.matched_count": -1,
            }}}),
        )
        for name, value in changes:
            original = (self.job / name).read_bytes()
            with self.subTest(value=value):
                self.write(name, value)
                with self.assertRaises(ValueError):
                    self.prepare(allow_partial=True)
                (self.job / name).write_bytes(original)

    def test_missing_trials_and_tampered_frozen_metric_fail(self):
        (self.job / "trial-2/result.json").unlink()
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.prepare(allow_partial=True)
        self.write("trial-2/result.json", self.trials[1])
        with (self.job / "reviewbench-metric.py").open("a") as output:
            output.write("\n# altered\n")
        with self.assertRaisesRegex(ValueError, "digest"):
            self.prepare(allow_partial=True)

    def test_repeated_rounds_are_not_silently_pooled(self):
        self.plan["n_attempts"] = 2
        self.plan["trials"].update({
            f"round-2-{n}": {"task_id": n, "evaluation_id": 42, "round": 2}
            for n in (1, 2)
        })
        self.write("reviewbench-plan.json", self.plan)
        with self.assertRaisesRegex(ValueError, "one round"):
            self.prepare()


class FakeClient:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
        self.writes = []
        self.reject_write = False

    def table(self, name):
        assert name == "trial"
        self.filters = {}
        self.update_values = None
        return self

    def select(self, columns):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def order(self, key):
        return self

    def range(self, start, end):
        self.bounds = (start, end)
        return self

    def update(self, values):
        self.update_values = values
        return self

    async def execute(self):
        if self.update_values is not None:
            if self.reject_write:
                return SimpleNamespace(data=[])
            trial_id = self.filters["id"]
            self.writes.append(trial_id)
            self.rows[trial_id] = copy.deepcopy(self.update_values["rewards"])
            return SimpleNamespace(data=[{"id": trial_id}])
        start, end = self.bounds
        return SimpleNamespace(data=[
            {"id": key, "rewards": copy.deepcopy(value)}
            for key, value in sorted(self.rows.items())
        ][start:end + 1])


class SyncTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def test_sync_only_display_metadata_and_is_idempotent(self):
        prepared = self.prepare()
        client = FakeClient({key: row["original"] for key, row in prepared["trials"].items()})
        result = await hub.sync_metrics(client, prepared)
        self.assertEqual(result["updated_trials"], 2)
        self.assertEqual(client.rows, {key: row["display"] for key, row in prepared["trials"].items()})
        again = await hub.sync_metrics(client, prepared)
        self.assertEqual(again["updated_trials"], 0)
        self.assertEqual(len(client.writes), 2)

    async def test_wrong_remote_ids_or_changed_rewards_abort_before_any_write(self):
        prepared = self.prepare()
        original = {key: row["original"] for key, row in prepared["trials"].items()}
        for rows in ({}, {**original, str(uuid4()): None},
                     {**original, next(iter(original)): {"unexpected": 1}}):
            client = FakeClient(rows)
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                await hub.sync_metrics(client, prepared)
            self.assertEqual(client.writes, [])

    async def test_previous_four_metric_display_can_be_upgraded(self):
        prepared = self.prepare()
        client = FakeClient({
            key: {metric: value for metric, value in row["display"].items()
                  if not metric.endswith("_f1")}
            for key, row in prepared["trials"].items()
        })
        result = await hub.sync_metrics(client, prepared)
        self.assertEqual(result["updated_trials"], 2)
        self.assertEqual(client.rows, {key: row["display"] for key, row in prepared["trials"].items()})

    async def test_denied_update_is_not_success(self):
        prepared = self.prepare()
        client = FakeClient({key: row["original"] for key, row in prepared["trials"].items()})
        client.reject_write = True
        with self.assertRaisesRegex(RuntimeError, "not confirmed"):
            await hub.sync_metrics(client, prepared)

    async def test_display_copy_is_verified_against_actual_overview(self):
        prepared = self.prepare()
        client = FakeClient({key: row["original"] for key, row in prepared["trials"].items()})
        copy_job = AsyncMock(return_value=SimpleNamespace(complete=True, job_id="display"))
        overview = SimpleNamespace(
            n_total_trials=2, n_errors=0,
            eval_rows=[{"metrics": [{key: value} for key, value in prepared["summary"]["scores"].items()]}],
        )
        hub_client = SimpleNamespace(get_job_overview=AsyncMock(return_value=overview))
        result = await hub.publish_metrics(client, hub_client, copy_job, prepared)
        self.assertEqual(result["display_job_id"], "display")
        self.assertEqual(result["source_job_id"], prepared["job_id"])
        self.assertEqual(result["primary_metric"], "augmented_f1")
        self.assertTrue(result["url"].endswith("?breakdown_metric=augmented_f1"))
        copy_job.assert_awaited_once()
        self.assertFalse(copy_job.await_args.kwargs["overwrite"])
        await hub.publish_metrics(client, hub_client, copy_job, prepared, refresh_display=True)
        self.assertTrue(copy_job.await_args.kwargs["overwrite"])
        overview.eval_rows[0]["metrics"] = [{"overall.candidate_count": 3}]
        with self.assertRaisesRegex(RuntimeError, "expected six"):
            await hub.publish_metrics(client, hub_client, copy_job, prepared)

    async def test_incomplete_copy_or_lost_failures_are_not_success(self):
        prepared = self.prepare()
        client = FakeClient({key: row["original"] for key, row in prepared["trials"].items()})
        copy_job = AsyncMock(return_value=SimpleNamespace(complete=False, job_id="display"))
        hub_client = SimpleNamespace(get_job_overview=AsyncMock())
        with self.assertRaisesRegex(RuntimeError, "copy is incomplete"):
            await hub.publish_metrics(client, hub_client, copy_job, prepared)
        hub_client.get_job_overview.assert_not_awaited()
        copy_job.return_value.complete = True
        hub_client.get_job_overview.return_value = SimpleNamespace(n_total_trials=2, n_errors=1)
        with self.assertRaisesRegex(RuntimeError, "failure counts"):
            await hub.publish_metrics(client, hub_client, copy_job, prepared)


if __name__ == "__main__":
    unittest.main()
