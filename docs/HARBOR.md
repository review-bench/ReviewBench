# ReviewBench on Harbor (experimental)

This adapter exports one frozen pull request per Harbor task. It preserves the
ReviewBench findings contract and uses the existing TypeScript matcher,
classifier, and scorer in a **separate verifier sandbox**. It does not publish
anything, start jobs, or replace the official ReviewBench submission portal.

The format targets Harbor **v0.24.0**, commit
`b53b8134e1241686dca7759af188f987ecc48e8b`: task schema 1.3 and dataset schema 1.0.
Vendor reviewer containers are not automatically Harbor agents. Start with a
built-in agent; hosted custom reviewers need Harbor's
[ACP integration](https://docs.harborframework.com/hosted-harbor/custom-agents).

## Vendor execution path

The primary path is **Harbor CLI execution, followed by result upload**.
Vendors can run the CLI on an approved Linux Docker runner, or use an approved
cloud sandbox through `--env` / `environment.type`. Direct cloud execution needs
that provider's credentials and optional Harbor dependencies; it does **not**
require Harbor Hosted Alpha access or Docker on the vendor's workstation.
The chosen provider must support this task's separate verifier and exact-host
network policies. Unsupported policies must fail rather than be disabled.

These are different operations:

| Operation | Purpose | Hosted Alpha needed? |
| --- | --- | --- |
| `harbor run -c job.yaml` | CLI orchestrates execution on the configured runner or sandbox | No |
| `harbor upload <job-directory> --private` | Store and share existing job results on Hub | No hosted execution |
| `harbor run --launch -c job.yaml` | Ask Harbor's hosted service to execute the job | May require access approval |

Use the CLI path for private tuning and integration testing. Uploading a job
does not automatically add a ReviewBench leaderboard row or make vendor-supplied
scores authoritative; the complete run and scoring provenance must be checked
before a submission is accepted.

## Export

Requirements: Node 22+, `npm ci`, and a Debian-based Node container image pinned
by digest. Running tasks also requires Harbor, `uv` for its custom metric, and
a Linux sandbox. The local Harbor Docker orchestrator must run on Linux;
a Windows host with a Linux Docker daemon can build the images but Harbor
v0.24.0 rejects Docker allowlists from Windows. Do not disable network
enforcement to work around that rejection. Local Docker allowlists require the nftables features used by
Harbor's egress sidecar. The test suite uses Python 3; `PYTHON` can override its
executable.

Install the matching Harbor version, or install from the pinned source if your
package index does not yet contain it:

```powershell
uv tool install "harbor==0.24.0"
# Alternative:
uv tool install "git+https://github.com/harbor-framework/harbor.git@b53b8134e1241686dca7759af188f987ecc48e8b"
```

Resolve the current `node:22-bookworm-slim` digest with
`docker buildx imagetools inspect node:22-bookworm-slim`. Replace the placeholders
below with that digest and your exact judge model ID. The API key names and
hostnames shown here are for OpenAI; choose your provider's equivalents.

```powershell
npm run harbor:export -- --output .\.harbor\smoke --split test --limit 1 --judge-provider openai --judge-model "<judge-model-id>" --base-image "node:22-bookworm-slim@sha256:<digest>" --agent-host api.openai.com --judge-host api.openai.com --judge-env OPENAI_API_KEY=RB_HARBOR_JUDGE_KEY
```

Use `--organization <owned-hub-org>` when publishing outside `review-bench`.
Repeat `--agent-host`, `--judge-host`, or `--judge-env` for additional endpoints
or variables. `--judge-env` accepts **variable names, never values**, and requires
dedicated `RB_HARBOR_*` host variables to avoid ordinary agent auto-forwarding.
Provision these variables through your secret manager before running.

Remove `--limit` for the complete 25-task test set; use `--split full` for all
219 tasks. Outputs are respectively named `reviewbench-test` and `reviewbench`.
Limited exports have a `-smoke-N` suffix so they cannot accidentally replace the
full dataset package. Export into a new directory each time; existing output
is never overwritten.

The two splits use the same task names and digests when exported with identical
inputs/options. They can therefore reference the same Hub task packages.
Both read labels from canonical `golden` files, **not**
`corpus/test/findings.json`.

```text
export\
  dataset.toml
  metric.py
  <pr-key>\
    task.toml
    instruction.md
    environment\
      Dockerfile
      pr.json
    tests\
      Dockerfile
      test.sh
      task.json
      manifest.json
      golden\
      judge\
    solution\
      solve.sh
      findings.json
```

Tasks are immediate children of the export directory: Harbor's local resolver
and publisher discover them there. Task digests use Harbor's sorted
path/content-hash algorithm. The optional check below uses Harbor's own schemas
and packager (run it in an environment where Harbor is installed):

```powershell
python scripts\harbor\check-format.py .\.harbor\smoke
```

## Snapshots and isolation

Image builds fetch only the pinned base/head histories from the public
`review-bench/owner_repo` mirror. They check out HEAD, generate the three-dot
diff, and remove the Git remote. They do not fetch live PR branches, unrelated
refs, submodules, or LFS objects. Missing commits or merge bases fail the build.
Source licenses and notices remain in the snapshot; image redistribution still
requires the maintainer's licensing/privacy review.

The agent receives `/work/repo`, `/work/pr/pr.json`, `/work/pr/diff.patch`, and
the existing `RB_*` contract variables. The environment build context contains
no golden findings, oracle output, judge source, or judge credentials.

The separate verifier has its own freshly built snapshot and the locked judge
dependencies. Its image bakes in `/tests/test.sh`, as required for dedicated
Harbor verifier images. Only `/work/out/findings.json` is declared as a task
artifact. Harbor also transfers its standard artifact directory; the verifier
does not read or execute it.

The verifier validates the PR identity, regular-file output, paths, line ranges,
and findings before calling the existing strict CLI. A valid empty findings
array is scored; missing/malformed output fails. `--allow-empty` is used only
after the wrapper has established one valid, matching PR. `--snapshot-dir`
validates HEAD, base, merge base, and a clean tree (including ignored files);
it never fetches or clones. Golden files are removed after the judge loads them
into memory, and evaluation never uses `--ingest`.

Reviewer execution is limited to 900 seconds. The verifier budget defaults to
7,200 seconds, adjustable with `--verifier-timeout`; a timeout is not a zero
score. Both phases have explicit hostname allowlists. Agent installation uses
Harbor's public setup baseline, so this is not a claim of parity with the
official runner's proxy/port restrictions. Unsupported policies must fail,
not be silently weakened.

## CLI smoke run

On an approved Linux Docker runner, run the one-task export with a built-in reviewer:

```powershell
harbor run -p .\.harbor\smoke -a codex -m "openai/<reviewer-model-id>" -k 1 -n 1
```

The reviewer uses its ordinary provider credential; the verifier uses the
dedicated variable mapping from `task.toml`. The oracle checks output plumbing
with canonical TP findings:

```powershell
harbor run -p .\.harbor\smoke -a oracle -k 1 -n 1
```

**The oracle still invokes the real LLM judge and costs money.** It is not a
deterministic grading shortcut and need not receive a perfect score. The unit
tests instead check deterministic score parity and run a real empty-review
evaluation without credentials or inference.

Per-trial verifier logs retain `scores.json`, `scores.details.json`, the judge
fingerprints, and `reward.json`. The reward contains numeric sufficient counts,
including severity/category strata and task/evaluation identity markers.

## Aggregation

Use the exported dataset directory for local `-p` runs, not `dataset.toml`.
Harbor v0.24.0 does not automatically load a local directory's custom metric;
configure it explicitly in a job config:

```yaml
datasets:
  - path: .harbor/smoke
agents:
  - name: codex
    model_name: openai/<reviewer-model-id>
n_attempts: 1
n_concurrent_trials: 1
metrics:
  - type: uv-script
    kwargs:
      script_path: .harbor/smoke/metric.py
```

Run that configuration with `harbor run -c smoke.yaml`. Published Hub datasets
load their packaged `metric.py` automatically. Harbor's default mean of reward
fields is not a ReviewBench aggregate.

The metric reports `complete=0` with coverage/failure/duplicate counts during
incomplete runs and withholds all aggregate scores. Once every expected task
has one successful reward from the expected evaluation version, it reports
`complete=1`, macro averages, and pooled micro metrics. Undefined ratios have
`<metric>.defined=0` and no numeric value; the canonical per-PR JSON retains
`null`. Stratum names are URI-encoded in flat reward/metric keys.

For a release gate, pass a JSONL file containing one reward object or `null`
per trial through:

```powershell
python .\.harbor\smoke\metric.py -i rewards.jsonl -o metrics.json --require-complete
```

Also require **zero agent/trial exceptions in Harbor's job result**: the custom
metric receives rewards, not trial statuses, so it cannot detect an agent
failure if Harbor subsequently produced a valid verifier reward.

The release check validates both complete rewards and exception-free,
separate-verifier trial results in a downloaded or local job directory:

```powershell
python scripts\harbor\check-job.py .\.harbor\jobs\<job-name> .\.harbor\smoke\metric.py --output verified-metrics.json
```

CI runs `scripts.harbor.smoke_agent:EmptyReviewAgent` on a Linux Docker host.
It makes no inference calls, writes a valid empty review, checks that golden
and oracle assets and judge credentials are absent from the reviewer, and
requires blocked egress to a non-allowlisted hostname. The real judge then
grades the transferred artifact in a fresh verifier. This validates plumbing,
not real reviewer or authenticated judge performance.

Use one attempt per task per job. For three-round reporting, run three complete
jobs with identical versions, then report the mean/std of the three round
aggregates. Multiple attempts, task filters, and partial regrades intentionally
do not yield a complete score for the original dataset. A smoke subset must be
exported as its own dataset.

## Private result upload

After `check-job.py` succeeds, sign in and upload the job directory, not the
dataset export:

```powershell
harbor auth login
harbor upload .\.harbor\jobs\<job-name> --private
```

Use `--org <owned-hub-org>` to select the owner of a new upload. Keep trial
outputs, trajectories, and scoring provenance with the results, but never
upload credentials or private integration source. For a remote runner, inspect
and download its sanitized job artifacts, then upload from an authenticated
client; no Hub credential needs to be provisioned to the runner.

Result upload and dataset publication are separate actions. This adapter does
not automatically publish results, create leaderboard rows, or replace
ReviewBench's official submission process.

## Optional hosted execution and dataset publication

### Model endpoints and credentials

Harbor does not host the review or judge model. Use an approved inference
provider's endpoint and its exact model identifier. The reviewer uses its
Harbor agent's provider/model configuration; the verifier uses the exported
`--judge-provider` and `--judge-model`. These are independent configurations.

The judge's locked SDK must recognize that exact provider/model pair.
An empty-review smoke test makes no model calls and therefore cannot prove
model availability or authentication. Do not guess a Sonnet 5 identifier or
treat a successful empty-review test as proof that an unregistered model works.

Harbor uses GitHub OAuth for sign-in but has separate organization memberships.
Confirm the owning namespace with `harbor auth org list`. In the Hub, select
that organization, open its Settings, and use **Add secret** for an approved
provider credential. Job `env` fields are plaintext configuration, not a place
for keys. Provider endpoint URLs and model IDs are nonsensitive configuration;
keys belong only in the secret manager.

For a local Anthropic judge, provision a dedicated `RB_HARBOR_JUDGE_KEY` through
your secret manager and export with
`--judge-env ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY` and
`--judge-host api.anthropic.com`. Give the reviewer a different credential.
No key values belong in exported files or images.

For hosted runs, normal agent secret selection grants those credentials to
the reviewer. **Do not select the judge key for the reviewer**, even under a
dedicated `RB_HARBOR_*` name. Confirm a verifier-only delivery route with the
deployed Hub before any authenticated judge trial. A literal, non-secret marker
in `[verifier.env]` can test phase isolation, but does not establish how stored
credentials are delivered. Hosted rollouts may require separate alpha-access
approval even when package publishing and organization ownership already work.

After local review, authenticate and publish a **private** smoke package:

```powershell
harbor auth login
harbor publish .\.harbor\smoke --private --tag v0.1.0
```

Hosted execution requires [Hub access](https://hub.harborframework.com/jobs/launch).
Select the published smoke dataset, a built-in agent/model, and one attempt in
the launcher. Export its job configuration to `smoke.yaml`, then:

```powershell
harbor run --launch -c .\smoke.yaml --dry-run
harbor run --launch -c .\smoke.yaml
```

**Do not launch until verifier-only secret routing is confirmed.** Local
`[verifier.env]` templates are isolated from the agent, but hosted secret
selection is per-agent; selecting the judge key for an agent may expose it.
Confirm with the deployed Hub that dedicated `RB_HARBOR_*` values resolve only
for the verifier. Never solve a routing failure by baking keys into images or
publishing literal secrets. The export alone is not an authenticated hosted
execution test.

Before public CLI release: exercise image builds, a real reviewer/judge trial,
network enforcement, phase-specific secret isolation, artifact transfer,
timeout/error handling, and score parity; archive the resulting image digests.
Hosted secret routing is an additional requirement only when offering the
optional hosted execution path. For repeatable
published runs, prebuild both images and pin their digests in `[environment]`
and `[verifier.environment]`, then run `harbor dataset sync` in the export
directory to refresh task digests. The base image and npm lock are pinned, but
apt repositories and image builds are not bit-for-bit reproducible.

Making a dataset public also exposes its referenced task versions, including
oracle and grading assets. Obtain publication/licensing approval first. These
runs remain experimental until ReviewBench explicitly accepts Harbor
submissions; no leaderboard rows are published automatically.

References: [task format](https://docs.harborframework.com/tasks/overview),
[separate verifier](https://docs.harborframework.com/tasks/separate-verifier),
[metrics](https://docs.harborframework.com/datasets/metrics),
[network policies](https://docs.harborframework.com/tasks/network-policies),
[cloud sandboxes](https://docs.harborframework.com/sandboxes/pre-integrated-sandboxes),
[result upload](https://docs.harborframework.com/harbor-hub/upload),
[publishing](https://docs.harborframework.com/harbor-hub/publish).
