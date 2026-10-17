# Public ReviewBench on Harbor

Run the public **219-PR** benchmark with a Harbor-compatible reviewer, score
its findings in a separate verifier, and optionally upload verified results
to Harbor Hub. Execution uses CPU-only Linux x86-64 sandboxes; no GPU is needed.
This package provides the benchmark runtime, not a reviewer-specific adapter.

| Component | Version or reference |
| --- | --- |
| Public dataset | [`review-bench/reviewbench-public@v1`](https://hub.harborframework.com/datasets/review-bench/reviewbench-public) |
| Harbor | `0.24.0`, installed automatically from the package's dependency pin |
| Judge | Anthropic `claude-opus-5`, via `api.anthropic.com` |
| Judge SDK | `@earendil-works/pi-coding-agent@0.75.5` |

The judge preserves the existing ReviewBench matcher, classifier, and scoring:
adaptive thinking, low matcher effort, medium classifier effort, and an
8,192-token output budget. The dataset requires no Hub login. You need your
reviewer's credentials and a separate Anthropic API key with access to the
judge. Review and judging incur charges. These are self-funded benchmark runs,
not automatic official leaderboard submissions.

## 1. Prepare Linux and Docker

Use a Linux Docker runner or **WSL2 Ubuntu with Docker Desktop** on Windows.
Harbor must run inside Ubuntu, not native PowerShell.

For a new Windows installation, run in Administrator PowerShell:

```powershell
wsl --install -d Ubuntu
winget install --exact --id Docker.DockerDesktop
```

Docker's actual kernel must support `CONFIG_NFT_FIB_INET=y` or `m`.
The validated Windows setup uses **WSL 3.0.3 / kernel 6.18.54.1**; the older
6.6.87.2 WSL kernel does not satisfy this requirement. Update WSL with
`wsl --update`. If that returns HTTP 403, use Microsoft's
[official WSL 3.0.3 installer](https://github.com/microsoft/WSL/releases/tag/3.0.3)
for your architecture and verify its Microsoft signature.
Save work before restarting WSL to load the new kernel.

Start Docker Desktop, use Linux containers, and enable **Settings > Resources >
WSL Integration > Ubuntu**, then **Apply & Restart**. Do not also install a
second Docker engine inside Ubuntu.

All remaining commands run in **Linux/Ubuntu Bash**:

```bash
sudo apt-get update &&
sudo apt-get install -y git curl ca-certificates

curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

docker info
docker compose version
```

## 2. Install the public runtime

While this change is under review, install from the public PR ref:

```bash
uv tool install --force --refresh --python 3.12 --with-executables-from harbor \
  "reviewbench-harbor @ git+https://github.com/review-bench/ReviewBench.git@refs/pull/51/head"
```

This installs Harbor, the run plugin, and result checkers in one isolated
Python environment. No host-side Node.js or Harbor Git commit is needed.
This pre-release temporarily pins an immutable commit of a Harbor fork that
adds native upload-metric projections. Released Harbor 0.24.0 does not yet
support that extension; installing the runtime installs the required native
CLI dependency automatically.
Reviewer-specific adapters, authentication, and model configuration are
separate. If your reviewer is a Python package, include it in the same
installation with uv's `--with` option.

Do not upgrade an environment while a job is running. Updates are explicit:
re-run installation with the chosen runtime release and reviewer package.
The PR ref is a temporary pre-release source, not an immutable release;
`--refresh` updates it, whereas plain `uv tool upgrade` does not advance this
Git ref. Record resolved versions or commit SHAs with the run evidence.

Dataset and judge versions are independent of runtime upgrades. Select a new
published dataset version when its reference findings or judge policy changes;
normally no tool reinstall is needed. An upgraded runtime must not silently
replace a frozen dataset's judge.

## 3. Configure your reviewer and check readiness

Use a Harbor-compatible agent that follows each task's `instruction.md`:
review the frozen base/HEAD changes and write the required findings JSON to
`/work/out/findings.json`. Keep paths and line numbers anchored to the frozen
HEAD. Emit an empty findings array only after a completed review with no
findings; incomplete reviews must fail.

Provide the installed agent name or import path using `REVIEWBENCH_AGENT`.
Configure its credentials according to its own documentation, without exposing
the judge key to it. The published reviewer endpoint allowlist must support its
provider; an adapter cannot override the dataset's network policy.

Check Docker's network-isolation support before spending model requests:

```bash
"$(uv tool dir)/reviewbench-harbor/bin/python" - <<'PY'
from harbor.environments.docker.docker import DockerEnvironment

if not DockerEnvironment._egress_control_kernel_support():
    raise SystemExit("Docker kernel lacks Harbor's required network-isolation support.")
print("Docker kernel check passed.")
PY
```

Unsupported network policies must fail; do not bypass the check or disable
isolation. Reviewer containers must not receive reference findings or verifier
assets.

## 4. Run, then verify

Start with one PR. Set `REVIEWBENCH_AGENT` to your configured reviewer first.
Enter the **Anthropic judge key** at the hidden prompt:

```bash
mkdir -p ~/reviewbench-harbor
cd ~/reviewbench-harbor

read -rsp 'Anthropic judge key: ' RB_HARBOR_JUDGE_KEY
printf '\n'
export RB_HARBOR_JUDGE_KEY

job="reviewbench-smoke-$(date +%Y%m%d-%H%M%S)"

harbor run \
  -d review-bench/reviewbench-public@v1 \
  -a "${REVIEWBENCH_AGENT:?Set your installed Harbor reviewer agent}" \
  -e docker \
  --plugin reviewbench_harbor.reviewbench_plugin:ReviewBenchPlugin \
  -n 1 -l 1 -k 1 \
  --job-name "$job" \
  --yes &&
reviewbench-check-job \
  "jobs/$job" \
  "jobs/$job/reviewbench-metric.py" \
  --output "$job-metrics.json" >/dev/null &&
printf '\nVerification passed. Metrics: %s\n' "$job-metrics.json"

unset RB_HARBOR_JUDGE_KEY
```

The judge key is mapped to `ANTHROPIC_API_KEY` **only inside the separate
verifier**. Keep the terminal open while the job runs.

Use a fresh job name and these controls for larger runs:

| Run | Flags | Planned trials |
| --- | --- | --- |
| One-PR smoke | `-n 1 -l 1 -k 1` | 1 |
| First 50 PRs, concurrency 10 | `-n 10 -l 50 -k 1` | 50 |
| All 219 PRs, concurrency 10 | `-n 10 -k 1` | 219 |

`-n` caps concurrent trials, `-l` limits selected tasks, and `-k` repeats each
selected task. A limit selects a subset, not a random sample. Concurrency also
depends on Docker resources and provider rate limits; one trial can make
multiple model requests.

The plugin freezes task/evaluation identities and round membership in
`reviewbench-plan.json`, and retains `reviewbench-metric.py` inside the job.
Each round is scored independently; complete repeated runs report means,
population standard deviations, and defined-round counts. Attempts are not
pooled or selected by best score. Resume only with the same configuration and
plugin; back up failed evidence before retrying instead of converting failures
to empty findings.

## 5. Interpret the results

**Harbor's completion counter or exit code alone is not the scoring gate.**
Require the checker to succeed, `complete=1`, the intended `expected_prs`,
`scored_trials=expected_prs*n_attempts`, and no trial exceptions or duplicates.
`source_prs=219` and `expected_prs=219` are required for a full benchmark.

Use the named metrics in `$job-metrics.json` or `reviewbench-summary.json`:

| Field | Meaning |
| --- | --- |
| `summary.micro.overall.grounded_precision.mean` | True-positive matched findings / all reference-matched findings |
| `summary.micro.overall.grounded_recall.mean` | Reference true-positive issues covered / reference true-positive issues |
| `summary.micro.overall.augmented_precision.mean` | Also credits unmatched findings judged valid |
| `summary.micro.overall.augmented_recall.mean` | Recall with valid novel findings added to the reference set |
| `round.1.*` | One round's counts, scores, severity/category breakdowns |

Macro metrics average per-PR results; micro metrics pool the underlying counts.
Undefined ratios remain undefined, not zero. The terminal's **Reward / Count**
table mixes counts and flags without useful labels. Large `rb_task` and
`rb_evaluation` numbers are integrity identifiers, not scores.
A successful one-PR smoke establishes integration, not reviewer quality.

## 6. Optional private Hub upload

After verification, inspect the job for credentials or other sensitive content:

```bash
harbor auth login --no-browser
harbor upload "jobs/$job" --private
```

Uploads are not automatic and do not create official leaderboard entries.
Preserve the job directory's original basename, plan, retained metric,
findings, reviewer evidence, and judge evidence. Recheck downloaded jobs with
their retained metric before trusting their scores.

### Six headline metrics in Hub

Hub derives its metric dropdown from uploaded trial rewards, not the custom
job-level aggregate. The run plugin writes `upload-metrics.json` for
single-round jobs so native `harbor upload` submits only
`grounded_precision`, `grounded_recall`, `grounded_f1`,
`augmented_precision`, `augmented_recall`, and `augmented_f1`.
The returned link selects **augmented F1** as the main displayed metric.
These are **macro** scores: Hub averages each defined per-PR score.
F1 is the harmonic mean of each PR's precision and recall, then averaged
across PRs, not the harmonic mean of the macro precision and recall.
F1 is undefined if either input is undefined, and zero if both are zero.
Undefined scores stay undefined rather than becoming zero.
They are not the pooled **micro** scores in `reviewbench-summary.json`.

Native Harbor reads the declarative projection and applies it in memory.
New jobs submit only those six fields as Hub trial reward metadata from the
first upload. The original files are archived unchanged, including their
detailed raw counts. No second synchronization command or display copy is
needed for a new upload. Use `--private` to explicitly keep the uploaded job
private.

Original local trial results, uploaded evidence archives, frozen task
identities, detailed counts, and local verification reports remain unchanged.
Harbor validates the projection's job/trial identities and original result-file
SHA-256 digests before uploading. Changed evidence requires regenerating its
projection, not editing scores by hand. Re-running resumes incomplete uploads
without replacing completed evidence or trial metadata.

An intentionally partial projection requires native `harbor upload
"jobs/$job" --private --allow-partial`. All failed trials remain present;
these macro scores describe only scored PRs, not a verified full benchmark
result. Projection generation does not weaken the strict checker. Repeated-round
jobs retain independent-round verification but do not receive a headline
projection; use independent single-round jobs for this Hub presentation.

Existing uploads retain their original trial metadata and cached overview.
For those legacy jobs only, `reviewbench-sync-hub-metrics` can still synchronize
metadata and create a corrected private display copy without rerunning reviews.
An outdated display snapshot requires explicit `--refresh-display`. This legacy
repair is unnecessary for a new native upload with a projection.

## Maintainer checks

`npm run harbor:export` builds frozen task packages; `npm run
harbor:validate-findings` checks the findings contract without inference.
Exports preserve pinned base/HEAD commits, the existing matcher/classifier,
separate verifier execution, exact-host network policies, and content digests.
The standard Anthropic Opus 5 model definition is explicit, not an alias.
Changing sources or judge policy requires new evaluation identities; do not
overwrite the published `v1` profile.

CI covers schema/content validation, scorer parity, generic Harbor run
controls, installed-runtime behavior, and no-inference Docker isolation.
Reviewer-specific integration tests belong with their respective adapters.
CI does not run paid reviews or publish datasets, images, results, or
leaderboard entries.
