import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createOnboardingKit } from "../scripts/harbor/onboard.js";
import { validateFindings } from "../scripts/harbor/validate-findings.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "reviewbench-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataset = join(root, "dataset");
  mkdirSync(join(dataset, "one-pr"), { recursive: true });
  writeFileSync(join(dataset, "dataset.toml"), "[dataset]\n");
  writeFileSync(join(dataset, "metric.py"), "EXPECTED_TASKS = {}\n");
  writeFileSync(join(dataset, "one-pr", "task.toml"), "[task]\n");
  const pr = {
    repo: "https://github.com/example/repo", pr_number: 1,
    base: "a".repeat(40), head: "b".repeat(40),
  };
  const prPath = join(root, "pr.json");
  writeFileSync(prPath, JSON.stringify(pr));
  return { root, dataset, output: join(root, "kit"), pr, prPath };
}

test("onboarding emits a model-independent job with the approved metric and no copied task assets", (t) => {
  const f = fixture(t);
  const original = readFileSync(join(f.dataset, "one-pr", "task.toml"), "utf8");
  createOnboardingKit({
    dataset: f.dataset, output: f.output,
    agent: "codex", model: "example/reviewer-model", environment: "docker",
  });
  const job = JSON.parse(readFileSync(join(f.output, "job.json"), "utf8"));
  assert.deepEqual(job.agents, [{ name: "codex", model_name: "example/reviewer-model" }]);
  assert.deepEqual(job.datasets, [{ path: resolve(f.dataset) }]);
  assert.equal(job.metrics[0].type, "uv-script");
  assert.equal(job.metrics[0].kwargs.script_path, join(f.dataset, "metric.py"));
  assert.equal(job.n_attempts, 1);
  assert.equal(job.n_concurrent_trials, 1);
  assert.equal(job.environment.type, "docker");
  assert.equal("env" in job.agents[0], false);
  assert.equal("verifier" in job, false);
  assert.deepEqual(readdirSync(f.output).sort(), ["README.md", "custom_agent.py", "job.json", "kit.json"]);
  assert.equal(readFileSync(join(f.dataset, "one-pr", "task.toml"), "utf8"), original);
});

test("custom harness kit uses an importable adapter and fails explicitly until implemented", (t) => {
  const f = fixture(t);
  createOnboardingKit({
    dataset: f.dataset, output: f.output, customAgent: true, environment: "daytona",
  });
  const job = JSON.parse(readFileSync(join(f.output, "job.json"), "utf8"));
  assert.deepEqual(job.agents, [{ import_path: "custom_agent:CustomReviewAgent" }]);
  assert.equal(job.environment.type, "daytona");
  const adapter = readFileSync(join(f.output, "custom_agent.py"), "utf8");
  assert.match(adapter, /raise NotImplementedError/);
  assert.match(adapter, /shlex\.join\(arguments\)/);
  assert.match(adapter, /result\.return_code != 0/);
  assert.match(adapter, /\/work\/out\/findings\.json/);
});

test("onboarding rejects incomplete or ambiguous configuration without creating output", (t) => {
  const f = fixture(t);
  const base = { dataset: f.dataset, output: f.output, environment: "docker" as const };
  for (const bad of [
    base,
    { ...base, agent: "codex" },
    { ...base, agent: "codex", customAgent: true, model: "example/model" },
    { ...base, agent: "codex", model: "bare-model" },
    { ...base, agent: "codex;echo", model: "example/model" },
  ]) {
    assert.throws(() => createOnboardingKit(bad));
    assert.equal(existsSync(f.output), false);
  }
  createOnboardingKit({ ...base, agent: "codex", model: "example/model" });
  assert.throws(() => createOnboardingKit({ ...base, agent: "codex", model: "example/model" }), /already exists/);
});

test("onboarding rejects a missing approved export and unsupported sandbox", (t) => {
  const f = fixture(t);
  assert.throws(() => createOnboardingKit({
    dataset: f.root, output: f.output, agent: "codex", model: "example/model", environment: "docker",
  }), /approved ReviewBench export/);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "scripts/harbor/onboard.ts",
    "--dataset", f.dataset, "--output", f.output,
    "--agent", "codex", "--model", "example/model", "--environment", "unsupported",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /environment must be/);
  assert.equal(existsSync(f.output), false);
});

test("standalone validator accepts valid and empty findings, rejects identity and format errors", (t) => {
  const f = fixture(t);
  const path = join(f.root, "findings.json");
  const finding = { producer: "my-agent", file: "src/a.ts", start_line: 1, end_line: 2, message: "An issue." };
  function write(value: unknown) { writeFileSync(path, JSON.stringify(value)); }
  for (const findings of [[], [finding]]) {
    write({ pr: f.pr, agent: "my-agent", findings });
    assert.doesNotThrow(() => validateFindings(path, f.prPath));
  }
  for (const bad of [
    { pr: { ...f.pr, head: "c".repeat(40) }, agent: "my-agent", findings: [finding] },
    { pr: f.pr, agent: "", findings: [finding] },
    ...[
      { file: "../a.ts" }, { file: "C:\\a.ts" }, { start_line: 0 },
      { start_line: "1" }, { end_line: 0 }, { message: "" }, { producer: "" },
    ].map(change => ({ pr: f.pr, agent: "my-agent", findings: [{ ...finding, ...change }] })),
  ]) {
    write(bad);
    assert.throws(() => validateFindings(path, f.prPath));
  }
  writeFileSync(path, "{not json");
  assert.throws(() => validateFindings(path, f.prPath));
  writeFileSync(f.prPath, JSON.stringify({ ...f.pr, head: "invalid" }));
  assert.throws(() => validateFindings(path, f.prPath), /PR metadata/);
});

test("validator CLI explicitly reports success and fails malformed output", (t) => {
  const f = fixture(t);
  const path = join(f.root, "findings.json");
  writeFileSync(path, JSON.stringify({ pr: f.pr, agent: "my-agent", findings: [] }));
  const args = [
    "--import", "tsx", "scripts/harbor/validate-findings.ts",
    "--candidate", path, "--pr", f.prPath,
  ];
  const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /No judging or inference performed/);
  writeFileSync(path, "{}");
  const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Findings validation failed/);
});
