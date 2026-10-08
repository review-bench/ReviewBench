import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { aggregate, scorePR, type ClassifiedFinding, type PRScoreResult } from "../scripts/eval/scorer.js";
import { getFullDiff, validateSnapshot } from "../scripts/extraction/git.js";
import { exportDataset, packageDigest, type ExportOptions } from "../scripts/harbor/export.js";
import { toRewards } from "../scripts/harbor/rewards.js";
import { validateCandidate, verifyTask } from "../scripts/harbor/verify.js";
import { prKey, type ManifestEntry } from "../scripts/lib/types.js";

const ROOT = resolve(".");
const PYTHON = process.env.PYTHON ?? "python";
const BASE = `node:22-bookworm-slim@sha256:${"a".repeat(64)}`;
const pr: ManifestEntry = {
  repo: "https://github.com/example/repo", nwo: "example/repo", pr_number: 1,
  pr_url: "https://github.com/example/repo/pull/1", base: "a".repeat(40), head: "b".repeat(40),
  title: "A frozen PR", body: "Review this change.",
};

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewbench-harbor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function options(output: string): ExportOptions {
  return {
    output, organization: "review-bench", split: "test", provider: "openai", model: "fixture-model",
    baseImage: BASE, agentHosts: ["api.openai.com"], judgeHosts: ["api.openai.com"],
    judgeEnv: { OPENAI_API_KEY: "RB_HARBOR_JUDGE_KEY" }, verifierTimeout: 7200,
  };
}

function sourceFixture(dir: string): void {
  write(join(dir, "corpus", "manifest.json"), [pr]);
  write(join(dir, "corpus", "test", "test.json"), [pr]);
  write(join(dir, "golden", `${prKey(pr)}.json`), {
    pr_key: prKey(pr), pr,
    findings: [
      { ...finding("tp", "high", "security"), producer: "fixture" },
      { ...finding("fp", "low", "testing"), producer: "fixture" },
    ],
  });
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) write(join(dir, file), {});
  write(join(dir, "LICENSE"), "Fixture license\n");
  write(join(dir, "scripts", "fixture.ts"), "export {};\r\n");
  write(join(dir, "scripts", "harbor", "metric.py"), readFileSync(join(ROOT, "scripts", "harbor", "metric.py"), "utf8"));
}

function finding(tp_fp: "tp" | "fp", severity: "high" | "medium" | "low", category: string): ClassifiedFinding {
  return { file: "file.ts", start_line: 1, end_line: 2, message: "A specific issue.", tp_fp, severity, category };
}

function score(golden: ClassifiedFinding[], empty = false): PRScoreResult {
  return scorePR({
    pr_key: "fixture", golden, candidate_count: empty ? 0 : 3,
    matched: empty ? new Map() : new Map([[0, 0]]),
    covered_golden: empty ? new Set() : new Set(golden.map((_, i) => i)),
    unmatched: empty ? new Set() : new Set([1, 2]),
    unmatched_classifications: empty ? new Map() : new Map([
      [1, finding("tp", "medium", "new category")], [2, finding("fp", "low", "testing")],
    ]),
  });
}

function metric(dir: string, scores: PRScoreResult[], rewards = scores.map((s, i) => toRewards(s, { task_id: i, evaluation_id: 42 })) as (Record<string, number> | null)[], strict = false) {
  const expected = Object.fromEntries(scores.map((_, i) => [i, 42]));
  write(join(dir, "metric.py"), readFileSync(join(ROOT, "scripts", "harbor", "metric.py"), "utf8")
    .replace("EXPECTED_TASKS = {}", `EXPECTED_TASKS = ${JSON.stringify(expected)}`));
  write(join(dir, "rewards.jsonl"), rewards.map((r) => JSON.stringify(r)).join("\n") + "\n");
  rmSync(join(dir, "result.json"), { force: true });
  const result = spawnSync(PYTHON, [join(dir, "metric.py"), "-i", join(dir, "rewards.jsonl"),
    "-o", join(dir, "result.json"), ...(strict ? ["--require-complete"] : [])], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { ...result, output: existsSync(join(dir, "result.json"))
    ? JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, number> : null };
}

function assertParity(output: Record<string, number>, scores: PRScoreResult[]): void {
  const expected = aggregate(scores);
  for (const mode of ["macro", "micro"] as const) {
    const strata = [
      ["overall", expected[mode].overall] as const,
      ...Object.entries(expected[mode].by_severity).map(([k, v]) => [`by_severity.${encodeURIComponent(k)}`, v] as const),
      ...Object.entries(expected[mode].by_category).map(([k, v]) => [`by_category.${encodeURIComponent(k)}`, v] as const),
    ];
    for (const [prefix, values] of strata) {
      for (const [field, value] of Object.entries(values)) {
        const key = `${mode}.${prefix}.${field}`;
        if (value === null) {
          assert.equal(output[`${key}.defined`], 0, key);
          assert.equal(key in output, false, key);
        } else {
          assert.ok(Math.abs(output[key] - value) < 1e-12, `${key}: ${output[key]} != ${value}`);
        }
      }
    }
  }
}

test("Harbor metric preserves all macro/micro strata, null denominators, and many-to-many recall", (t) => {
  const scores = [
    score([finding("tp", "high", "security"), finding("tp", "high", "security")]),
    score([finding("fp", "low", "testing")]),
    score([finding("tp", "high", "security")], true),
    score([], true),
  ];
  const result = metric(fixture(t), scores);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output!.complete, 1);
  assertParity(result.output!, scores);
});

test("Harbor metric withholds scores for pending, failed, and repeated trials", (t) => {
  const dir = fixture(t);
  const scores = [score([], true), score([], true)];
  const reward = toRewards(scores[0], { task_id: 0, evaluation_id: 42 });
  for (const rewards of [[reward], [reward, null], [reward, reward]]) {
    const result = metric(dir, scores, rewards);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output!.complete, 0);
    assert.equal(Object.keys(result.output!).some((k) => k.startsWith("macro.")), false);
    assert.notEqual(metric(dir, scores, rewards, true).status, 0);
  }
});

test("Harbor metric rejects wrong versions, invalid counts, and incomplete reward shapes", (t) => {
  const dir = fixture(t);
  const scores = [score([], true)];
  const reward = toRewards(scores[0], { task_id: 0, evaluation_id: 42 });
  const missing = { ...reward };
  delete missing["overall.matched_count"];
  for (const bad of [
    { ...reward, rb_evaluation: 43 }, { ...reward, rb_task: 5 },
    { ...reward, "overall.matched_count": -1 }, { ...reward, "overall.candidate_count": 3 }, missing,
  ]) {
    const result = metric(dir, scores, [bad]);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, null);
  }
});

test("Harbor release gate requires complete rewards and exception-free separate trials", (t) => {
  const dir = fixture(t);
  const scores = [score([], true)];
  metric(dir, scores);
  const jobDir = join(dir, "job");
  const output = join(dir, "verified.json");
  const job = {
    finished_at: "2026-10-08T00:00:00Z", n_total_trials: 1,
    stats: { n_errored_trials: 0, n_running_trials: 0, n_pending_trials: 0, n_cancelled_trials: 0 },
  };
  const trial = {
    trial_name: "smoke", finished_at: job.finished_at, exception_info: null,
    verifier_environment_mode: "separate",
    verifier_result: { rewards: toRewards(scores[0], { task_id: 0, evaluation_id: 42 }) },
  };
  write(join(jobDir, "result.json"), job);
  write(join(jobDir, "smoke", "result.json"), trial);
  const check = () => spawnSync(PYTHON, [
    join(ROOT, "scripts", "harbor", "check-job.py"), jobDir, join(dir, "metric.py"), "--output", output,
  ], { encoding: "utf8" });
  const success = check();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).complete, 1);
  for (const bad of [
    { ...trial, exception_info: { exception_type: "AgentTimeoutError" } },
    { ...trial, finished_at: null },
    { ...trial, verifier_environment_mode: "shared" },
    { ...trial, verifier_result: null },
  ]) {
    write(join(jobDir, "smoke", "result.json"), bad);
    write(output, { complete: 1 });
    assert.notEqual(check().status, 0);
    assert.equal(existsSync(output), false, "failed checks must remove stale metrics");
  }
  write(join(jobDir, "smoke", "result.json"), trial);
  write(join(jobDir, "result.json"), { ...job, stats: { ...job.stats, n_errored_trials: 1 } });
  assert.notEqual(check().status, 0);
  write(join(jobDir, "result.json"), { ...job, n_total_trials: 2 });
  assert.notEqual(check().status, 0);
});

test("Harbor exports are deterministic and keep judge inputs out of the agent build context", (t) => {
  const dir = fixture(t);
  sourceFixture(dir);
  write(join(dir, "scripts", "secret.env"), "MUST_NOT_BE_PACKAGED");
  const outputs = [join(dir, "first"), join(dir, "second")];
  for (const output of outputs) exportDataset(options(output), dir);
  assert.equal(readFileSync(join(outputs[0], "dataset.toml"), "utf8"), readFileSync(join(outputs[1], "dataset.toml"), "utf8"));
  const task = join(outputs[0], prKey(pr));
  assert.deepEqual(readdirSync(join(task, "environment")).sort(), ["Dockerfile", "pr.json"]);
  assert.ok(!existsSync(join(task, "tests", "judge", "scripts", "secret.env")));
  assert.ok(readFileSync(join(task, "tests", "Dockerfile"), "utf8").includes("COPY . /tests/"));
  assert.ok(readFileSync(join(task, "task.toml"), "utf8").includes('OPENAI_API_KEY = "${RB_HARBOR_JUDGE_KEY}"'));
  const oracle = JSON.parse(readFileSync(join(task, "solution", "findings.json"), "utf8"));
  assert.equal(oracle.findings.length, 1);
  assert.equal(oracle.findings[0].tp_fp, undefined);
  validateCandidate(join(task, "solution", "findings.json"), pr);
  const full = join(dir, "full");
  exportDataset({ ...options(full), split: "full" }, dir);
  assert.equal(readFileSync(join(task, "task.toml"), "utf8"), readFileSync(join(full, prKey(pr), "task.toml"), "utf8"));
});

test("Harbor task hashing matches the documented path/content algorithm", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.equal(packageDigest(new Map([["b.txt", "b"], ["a.txt", "a"]])),
    hash(`a.txt\0${hash("a")}\nb.txt\0${hash("b")}\n`));
});

test("Harbor exporter rejects overwrites, unsafe inputs, mutable images, and inconsistent labels", (t) => {
  const dir = fixture(t);
  sourceFixture(dir);
  const opts = options(join(dir, "export"));
  for (const changes of [
    { baseImage: "node:22" }, { organization: "../escape" }, { limit: 0 },
    { agentHosts: ["https://api.openai.com"] }, { judgeEnv: { OPENAI_API_KEY: "raw-secret" } },
  ]) assert.throws(() => exportDataset({ ...opts, ...changes }, dir));
  assert.throws(() => exportDataset({ ...opts, output: dir }, dir), /already exists/);
  write(join(dir, "golden", `${prKey(pr)}.json`), { pr_key: prKey(pr), pr: { ...pr, base: "c".repeat(40) }, findings: [] });
  assert.throws(() => exportDataset(opts, dir), /Golden identity/);
  assert.equal(existsSync(opts.output), false);
});

test("Harbor candidate validation accepts empty findings but rejects missing, malformed, unsafe, and wrong-PR outputs", (t) => {
  const path = join(fixture(t), "findings.json");
  const candidate = { pr, agent: "fixture", findings: [] };
  assert.throws(() => validateCandidate(path, pr));
  write(path, candidate);
  validateCandidate(path, pr);
  for (const bad of [
    "{", { ...candidate, agent: "" }, { ...candidate, pr: { ...pr, base: "c".repeat(40) } },
    { ...candidate, findings: [{ ...finding("tp", "high", "security"), producer: "fixture", file: "../outside" }] },
    { ...candidate, findings: [{ ...finding("tp", "high", "security"), producer: "fixture", start_line: 0 }] },
  ]) {
    write(path, bad);
    assert.throws(() => validateCandidate(path, pr));
  }
});

function snapshot(dir: string): { repo: string; base: string; head: string } {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  write(join(repo, ".gitignore"), "ignored.txt\n");
  write(join(repo, "file.ts"), "before\n");
  git("add", ".");
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
  commit();
  const base = git("rev-parse", "HEAD");
  write(join(repo, "file.ts"), "after\n");
  git("add", ".");
  commit();
  return { repo, base, head: git("rev-parse", "HEAD") };
}

test("Trusted snapshots validate without a remote and reject dirty, ignored, wrong-head, or missing-base inputs", (t) => {
  const { repo, base, head } = snapshot(fixture(t));
  assert.equal(validateSnapshot(repo, base, head), repo);
  assert.match(getFullDiff(repo, base, head, { offline: true }), /-before\n\+after/);
  assert.throws(() => validateSnapshot(repo, base, base), /HEAD differs/);
  assert.throws(() => validateSnapshot(repo, "c".repeat(40), head));
  write(join(repo, "ignored.txt"), "hidden context");
  assert.throws(() => validateSnapshot(repo, base, head), /must be clean/);
  rmSync(join(repo, "ignored.txt"));
  write(join(repo, "file.ts"), "changed");
  assert.throws(() => validateSnapshot(repo, base, head), /must be clean/);
});

test("Harbor verifier runs the real judge for an empty review without credentials or remote access", (t) => {
  const dir = fixture(t);
  const { repo, base, head } = snapshot(dir);
  const entry = { ...pr, base, head };
  const paths = {
    snapshot: repo, candidate: join(dir, "findings.json"), golden: join(dir, "golden"),
    manifest: join(dir, "manifest.json"), output: join(dir, "scores.json"), reward: join(dir, "reward.json"),
  };
  write(paths.candidate, { pr: entry, agent: "empty", findings: [] });
  write(paths.manifest, [entry]);
  write(join(paths.golden, `${prKey(entry)}.json`), {
    pr_key: prKey(entry), pr: entry, findings: [{ ...finding("tp", "high", "security"), producer: "fixture" }],
  });
  verifyTask({ pr: entry, provider: "not-a-provider", model: "not-a-model", task_id: 7, evaluation_id: 42 }, paths);
  const rewards = JSON.parse(readFileSync(paths.reward, "utf8"));
  assert.equal(rewards["overall.candidate_count"], 0);
  assert.equal(rewards["overall.golden_tp_count"], 1);
  assert.equal(rewards.rb_task, 7);
  assert.equal(readdirSync(paths.golden).length, 0);
  const scores = JSON.parse(readFileSync(paths.output, "utf8"));
  assert.equal(scores.micro.overall.grounded_recall, 0);
  assert.equal(scores.micro.overall.grounded_precision, null);

  write(paths.candidate, "{bad");
  assert.throws(() => verifyTask({ pr: entry, provider: "not-a-provider", model: "not-a-model", task_id: 7, evaluation_id: 42 }, paths));
  assert.equal(existsSync(paths.reward), false, "failed retry must not retain a successful reward");
});
