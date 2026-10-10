# ReviewBench
[![License: MIT](https://img.shields.io/badge/License-MIT-000000?style=for-the-badge)](LICENSE)

ReviewBench is an open, reproducible benchmark for evaluating AI code review systems on real-world pull requests developed by GitHub Inc.

For each pull request, the benchmark provides a human-reviewed golden set of code review findings that serves as the ground truth. ReviewBench compares an agent's findings with this reference set to measure how reliably it identifies useful issues while avoiding false positives. Results can also be explored by dimensions such as severity and category.

## Table of Contents

- [What is in the Repository?](#what-is-in-the-repository)
- [Evaluate your Reviewer Offline](#evaluate-your-reviewer-offline)
- [Submit your Reviewer to the ReviewBench Leaderboard](#submit-your-reviewer-to-the-reviewbench-leaderboard)
  - [1. Validate your submission locally](#1-validate-your-submission-locally)
  - [2. Onboard through the self-service portal](#2-onboard-through-the-self-service-portal)
  - [3. Run official test and final evaluations](#3-run-official-test-and-final-evaluations)
  - [Optional: Judge your own findings locally for tuning](#optional-judge-your-own-findings-locally-for-tuning)
  - [Costs](#costs)
  - [Credentials](#credentials)
- [Contribution](#contribution)
- [License](#license)

## What is in the Repository?

- **[The test set: 25 tasks](corpus/test/).** The selected pull
  requests come from 25 repositories and span a broad range of languages,
  repository sizes, change sizes, finding categories, and severities.
- **[The full set: 219 tasks](corpus/manifest.json).** Every pull request the
  leaderboard runs on, with its corresponding findings in [`golden/`](golden/).
- **[Repository mirrors](https://github.com/review-bench).** Each source
  repository in the corpus has a mirror in the review-bench organization,
  named `review-bench/<owner>_<repo>`, holding every task's base and head
  commits. If an original repository link is unavailable, use its corresponding
  mirror. The judge and the local test script check out pull requests from these
  mirrors, so the benchmark still runs if an upstream repository is deleted or
  rewritten.
- **[Benchmark documentation](docs/METHODOLOGY.md).** How the corpus was
  built, how findings are labeled, and how agents are judged and scored.
- **[Everything a reviewer vendor needs](#submit-your-reviewer-to-the-reviewbench-leaderboard).**
  The [agent contract](AGENT_CONTRACT.md), the [Codex CLI example](examples/codex-cli/), a
  [local test script](scripts/try-agent.sh) and the
  [onboarding guide](docs/ONBOARDING.md).
- **[The classifier prompt and supporting script](scripts/classifier/prompts.ts).**
  The classifier artifacts used to assign severity and category labels are
  published so the labeling process can be inspected and reproduced.
- **[The judging CLI](#evaluate-your-reviewer-offline).**
  Privately score findings for tuning with an LLM judge you choose.

The full corpus manifest and all golden findings are public.

### Test Set Distribution

The 25 test set tasks were selected as a representative sample of the full
set. They preserve its mix of major languages, change sizes, and
repository diversity while also covering every finding category and severity
level.

#### Languages

| Language | Test set PRs | Test set share | Full set PRs | Full set share |
|---|---:|---:|---:|---:|
| TypeScript | 5 | 20.0% | 68 | 31.1% |
| Python | 4 | 16.0% | 41 | 18.7% |
| C# | 3 | 12.0% | 25 | 11.4% |
| Go | 3 | 12.0% | 19 | 8.7% |
| JavaScript | 1 | 4.0% | 15 | 6.8% |
| Other languages | 9 | 36.0% | 51 | 23.3% |
| **Total** | **25** | **100%** | **219** | **100%** |

The test set's other languages are Rust, Java, Jupyter Notebook, Kotlin,
PHP, Ruby, Shell, and Swift.

#### PR Change Size

| Added and removed lines | Test set PRs | Test set share | Full set PRs | Full set share |
|---|---:|---:|---:|---:|
| 50 or fewer | 3 | 12.0% | 17 | 7.8% |
| 51-200 | 5 | 20.0% | 40 | 18.3% |
| 201-500 | 5 | 20.0% | 44 | 20.1% |
| 501-1,000 | 5 | 20.0% | 40 | 18.3% |
| More than 1,000 | 7 | 28.0% | 78 | 35.6% |
| **Total** | **25** | **100%** | **219** | **100%** |

#### Finding Severities

| Severity | Findings | Share |
|---|---:|---:|
| High | 36 | 10.2% |
| Medium | 134 | 38.1% |
| Low | 182 | 51.7% |
| **Total** | **352** | **100%** |

#### Finding Categories

| Category | Findings | Category | Findings |
|---|---:|---|---:|
| Correctness | 133 | Reliability | 58 |
| Maintainability | 44 | Testing | 35 |
| Security | 27 | Documentation | 21 |
| Performance | 12 | API architecture | 12 |
| Accessibility | 10 |  |  |

### Full Set Distribution

The full set contains 219 PRs from 187 distinct repositories. No single
repository dominates the benchmark. The most represented repository contributes
10 PRs, or only 4.6% of the corpus. The corpus covers both common and
long-tail languages as well as changes ranging from small patches to
large-scale updates.

#### Primary PR Types

PR types are inferred from titles and descriptions for coverage analysis;
they are not formal human labels.

| Primary PR type | PRs | Share |
|---|---:|---:|
| Feature | 79 | 36.1% |
| Bug fix | 59 | 26.9% |
| Documentation | 15 | 6.8% |
| Performance | 14 | 6.4% |
| Refactor | 12 | 5.5% |
| Other | 40 | 18.3% |
| **Total** | **219** | **100%** |

## Evaluate your Reviewer Offline

You can benchmark any reviewer on your own machine without registering or
opening a pull request. Run your reviewer image on the benchmark pull requests,
then judge the findings against the golden set:

```shell
git clone https://github.com/review-bench/ReviewBench && cd ReviewBench && npm ci
root=$PWD run=$PWD/runs/my-reviewer-1 && mkdir -p "$run"
(cd "$run" && TRY_AGENT_WORK=$root/.try-agent "$root/scripts/try-agent.sh" my-reviewer:dev -e OPENAI_API_KEY)
npm run judge -- --candidate "$run/findings" --provider <provider> --model <model-id> --output "$run/scoring/results.json"
```

Add `--set full` for all 219 pull requests. Use a fresh run directory each time
so findings from different runs never mix.
[Evaluate your reviewer offline](docs/OFFLINE_EVAL.md) covers entrypoint
adapters, matching the leaderboard's judge model, and the limits of offline
results. Offline results are for development and tuning and cannot be
published on the leaderboard.

## Submit your Reviewer to the ReviewBench Leaderboard

Evaluate your code review agent on the same pull requests, against the same
expert findings, and with the same judge used for every agent on the
[leaderboard](https://review-bench.ai). **To appear on the leaderboard, you
must onboard and submit through the ReviewBench self-service portal.** Local
runs and locally generated metrics are for development only and cannot be
published as leaderboard results.

To participate, you only need a thin adapter that lets ReviewBench run your
existing agent: it reads one pull request and writes one findings file. One
open-source reviewer needed about 90 lines of adapter code, mostly to map field
names.

Four steps; the [onboarding guide](docs/ONBOARDING.md) walks through each one.

1. **Wrap your agent** in a container that satisfies
   [the contract](AGENT_CONTRACT.md). Start from
   [`examples/codex-cli`](examples/codex-cli/), a complete reviewer backed by a
   model.
2. **Build and push** the image to GitHub Container Registry and note its
   digest ([how](docs/ONBOARDING.md#1-build-and-push-your-image)).
3. **Try it locally** on the test set (25 pull requests), below.
4. **Register it** on the [website](https://review-bench.ai/submit). Everything
   after that happens there.

### 1. Validate your submission locally

[`scripts/try-agent.sh`](scripts/try-agent.sh) runs your image on the test
set the way the benchmark does: one fresh container per pull request, the
same mounts and variables, and the same checks on the findings file. With
`--set full` it runs the full set instead. It needs docker, git and jq, and
fetches each pull request's commits from its mirror in the
[review-bench organization](https://github.com/review-bench)
(`review-bench/<owner>_<repo>`), the same copy the judge uses. It falls back
to the upstream repository only if the mirror lacks a commit.

This checks that the same container you plan to submit can complete the
benchmark PRs and produce valid findings. It does not score the findings or
submit anything to ReviewBench.

```sh
git clone https://github.com/review-bench/ReviewBench && cd ReviewBench
scripts/try-agent.sh my-reviewer:dev --pr 0 -e MY_API_KEY      # one pull request
scripts/try-agent.sh my-reviewer:dev -e MY_API_KEY             # all 25
scripts/try-agent.sh my-reviewer:dev --set full -e MY_API_KEY  # the full set, all 219
```

`-e NAME` passes that variable from your shell into the container under the
name your agent reads; the script never puts the value on a command line or
into the findings files. If your endpoint is not OpenAI, add
`-e RB_MODEL_BASE_URL=https://…` as well. A private package needs
`docker login ghcr.io` on your machine first.

It does not score. Scores come from a **test run** in the portal, which runs
the same 25 pull requests with the benchmark's judge and shows the result for
each one.

**Test set scores are not leaderboard scores.** These 25 pull requests are a
small sample, so a score on them says your adapter works, not how good your
agent is. The leaderboard runs on the full set of 219, which you can score
privately while tuning (see
[Judge your own findings locally](#optional-judge-your-own-findings-locally-for-tuning)).

### 2. Onboard through the self-service portal

Sign in to the [website](https://review-bench.ai/submit) with GitHub and
register your reviewer. You fill in a display name, the image pinned by
digest, the hosts your agent talks to, the names of the secrets it needs, the
configuration labels you want shown, and a contact. If your image is private,
choose "private package" and the website adds `GHCR_PULL_TOKEN` to the secret
names for you; see [private images](docs/ONBOARDING.md#public-or-private).

The website opens an onboarding pull request in this repository for you. It
stores your contact email privately; it is not written to the pull request.
The pull request adds a manifest under
[`agents/`](agents/) that follows
[the schema](schema/agent-manifest.schema.json); CI validates it with
[`schema/validate-manifest.mjs`](schema/validate-manifest.mjs). A maintainer
merges it. You do not write the manifest or open the pull request yourself.

Credentials are entered on the website, never in the pull request. They are
stored in Azure Key Vault and travel from there straight into your container.
No person reads the values.

### 3. Run official test and final evaluations

Once the manifest is merged, test runs and finals start from the website;
tuning happens on your side:

1. **Test run.** Your image runs on the test set (25 pull requests). You
   get a result for each pull request, so you can see exactly what your
   adapter produced and fix it.
2. **Tuning on the full set** happens on your side. The full set, the judge
   prompts and the judge models are public, so you can score all 219 pull
   requests yourself, as often as you like, with your own compute.
3. **Final.** Three rounds on the full set (219 pull requests) with the
   configuration you pick. A maintainer reviews the result; once approved,
   your leaderboard row is published.

There is no monthly cap on runs. You choose which configuration goes to the
final; you do not choose which run, because the final is measured fresh. Your
row shows how many configurations you tested. **Only a final run started
through this self-service flow can be published on the leaderboard.**

### Optional: Judge your own findings locally for tuning

If you want to run your agent entirely on your own infrastructure, use any
runner or process you prefer to produce findings in the
[normalized input format](docs/JUDGING_INPUT.md). You can then run only the
judging pipeline. You choose the LLM judge and pay for its calls with your own
provider credentials. This standalone command does not run the reviewer
container or a GitHub Actions workflow; it judges the existing findings and
writes metrics JSON.

This path is for private tuning and hill-climbing. It does not onboard your
reviewer, submit a final run, or publish a leaderboard result. Use the
self-service path above when you are ready for an official evaluation.

```sh
npm ci
export OPENAI_API_KEY="<your key>" # Or your provider's documented environment variable
npm run judge -- \
  --candidate ./my-agent-findings \
  --provider openai \
  --model <your-model-id> \
  --output ./scoring/smoke.json \
  --limit 1
```

See [How to judge findings](docs/JUDGING.md) for supported API-key variables,
model selection, full-corpus commands, checkpoints, and output metrics, and
[Evaluate your reviewer offline](docs/OFFLINE_EVAL.md) for the full offline
workflow.

### Costs

- **Tuning and hill-climbing are self-funded.** For test runs, local
  experiments, and repeated full-set scoring, both your review agent's
  inference and the judge's inference use your credentials and compute.
- **ReviewBench covers the judge only for your final submission.** The final is
  scored with the benchmark judge at our cost. Your review agent still runs
  with your credentials because its model and configuration are part of what
  the benchmark measures.

ReviewBench currently uses Claude Sonnet 5 to judge official leaderboard results.

We never read your credentials or supply your agent's model access.

### Credentials

The manifest declares only the *shape* of what your agent needs: which
environment variables, which file paths. Values never go in a pull request or
an issue. You enter them on the website and they are stored in Azure Key Vault.

They travel from the vault straight into your container, are scrubbed after
every run, and are never printed or logged. The runner is destroyed when the
job ends.

Two things we strongly recommend:

- **Use a dedicated key** with a spend cap that you can revoke at any time.
- **Never bake a key into your image.** Anyone who can pull the image can
  extract it, and deleting it in a later layer does not remove it.

If your agent needs no key at all, leave the secrets empty and skip this
entirely.

### Questions

Open an issue. The
[Onboard an agent](https://github.com/review-bench/ReviewBench/issues/new?template=onboard-agent.yml)
form is a good place to ask about your setup before you register, but it is
not the onboarding path; the website is. For how the benchmark works, see the
[methodology](docs/METHODOLOGY.md).

## Contribution
ReviewBench welcomes contributions, suggestions, and feedback. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, the process for disputing golden-set labels, and information about becoming a maintainer.
The benchmark corpus is not currently accepting new pull-request submissions. Instructions will be published in the contribution guide when submissions open.

## License
The repository is licensed under the [MIT License](LICENSE).
