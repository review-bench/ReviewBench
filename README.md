# ReviewBench
[![License: MIT](https://img.shields.io/badge/License-MIT-000000?style=for-the-badge)](LICENSE)

ReviewBench is an open, reproducible benchmark for evaluating AI code review systems on real-world pull requests.

For each pull request, the benchmark provides a human-reviewed golden set of code review findings that serves as the ground truth. ReviewBench compares an agent's findings with this reference set to measure how reliably it identifies useful issues while avoiding false positives. Results can also be explored by dimensions such as severity and category.

## What is in the Repository?

- **[The public full corpus of 219 tasks](corpus/manifest.json).** The pull
  requests come from 187 repositories and span a broad range of languages,
  repository sizes, change sizes, finding categories, and severities. The
  [25-task test corpus](corpus/test/test.json) is a representative
  subset of the full corpus intended for small and test runs.
- **[Benchmark documentation](docs/METHODOLOGY.md).** This includes the
  [methodology](docs/METHODOLOGY.md), [corpus extraction process](docs/EXTRACTION.md),
  and [evaluation harness](docs/HARNESS.md).
- **[The Claude Sonnet 5 classifier prompt](scripts/classifier/prompts.ts).**
  It assigns TP/FP, severity, category, and the other auxiliary labels. The
  [matcher prompt](scripts/eval/matcher.ts) is also public.

### Corpus Distribution

All 219 full-corpus PRs are public. The 25-PR test corpus is included within
the full corpus and preserves a representative mix of major languages, change
sizes, finding categories, and severity levels for small and test runs.

#### Languages

| Language | Test-corpus tasks | Test-corpus share | Full-corpus PRs | Full-corpus share |
|---|---:|---:|---:|---:|
| TypeScript | 5 | 20.0% | 68 | 31.1% |
| Python | 4 | 16.0% | 41 | 18.7% |
| C# | 3 | 12.0% | 25 | 11.4% |
| Go | 3 | 12.0% | 19 | 8.7% |
| JavaScript | 1 | 4.0% | 15 | 6.8% |
| Other languages | 9 | 36.0% | 51 | 23.3% |
| **Total** | **25** | **100%** | **219** | **100%** |

The test corpus's other languages are Rust, Java, Jupyter Notebook, Kotlin,
PHP, Ruby, Shell, and Swift.

#### PR Change Size

| Added and removed lines | Test-corpus tasks | Test-corpus share | Full-corpus PRs | Full-corpus share |
|---|---:|---:|---:|---:|
| 50 or fewer | 3 | 12.0% | 17 | 7.8% |
| 51-200 | 5 | 20.0% | 40 | 18.3% |
| 201-500 | 5 | 20.0% | 44 | 20.1% |
| 501-1,000 | 5 | 20.0% | 40 | 18.3% |
| More than 1,000 | 7 | 28.0% | 78 | 35.6% |
| **Total** | **25** | **100%** | **219** | **100%** |

#### Test-Corpus Finding Severities

| Severity | Findings | Share |
|---|---:|---:|
| High | 37 | 10.3% |
| Medium | 135 | 37.5% |
| Low | 188 | 52.2% |
| **Total** | **360** | **100%** |

#### Test-Corpus Finding Categories

| Category | Findings | Category | Findings |
|---|---:|---|---:|
| Correctness | 138 | Reliability | 59 |
| Maintainability | 45 | Testing | 35 |
| Security | 27 | Documentation | 21 |
| Performance | 13 | API architecture | 12 |
| Accessibility | 10 |  |  |

### Full Corpus Distribution

The full corpus contains 219 PRs from 187 distinct repositories. No single
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

## Run your Code Review Agent on ReviewBench

Evaluate your code review agent on the same pull requests, against the same
expert findings, and with the same judge used for every agent on the
[leaderboard](https://review-bench.ai). To participate, you only need a thin
adapter that lets ReviewBench run your existing agent: it reads one pull
request and writes one findings file. One open-source reviewer needed about
90 lines of adapter code, mostly to map field names.

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

### Try it locally first

[`scripts/try-agent.sh`](scripts/try-agent.sh) runs your image on the test
set the way the benchmark does: one fresh container per pull request, the
same mounts and variables, and the same checks on the findings file. With
`--set full` it runs the full set instead. It needs docker, git and jq, and
fetches each pull request from GitHub.

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
yourself (see Running).

### Onboarding

Sign in to the [website](https://review-bench.ai/submit) with GitHub and
register your reviewer. You fill in a display name, the image pinned by
digest, the hosts your agent talks to, the names of the secrets it needs, the
configuration labels you want shown, and a contact. If your image is private,
choose "private package" and the website adds `GHCR_PULL_TOKEN` to the secret
names for you; see [private images](docs/ONBOARDING.md#public-or-private).

The website opens an onboarding pull request in this repository for you. It
adds a manifest under [`agents/`](agents/) that follows
[the schema](schema/agent-manifest.schema.json); CI validates it with
[`schema/validate-manifest.mjs`](schema/validate-manifest.mjs). A maintainer
merges it. You do not write the manifest or open the pull request yourself.

Credentials are entered on the website, never in the pull request. They are
stored in Azure Key Vault and travel from there straight into your container.
No person reads the values.

### Running

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
row shows how many configurations you tested.

### Costs

- **Your agent's inference is yours.** It runs with your credentials, inside
  your container. We never see them, and the model you use is part of what
  the benchmark measures, so we cannot supply it.
- **The judge's cost is coverd by us for test and final runs.** Every reviewer's result are evaluated
  with the same judge panel models, at our cost. Tuning on the full set on your
  side uses your own judge calls.

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

## Governance
ReviewBench follows a consensus-based governance model:
- [Governance policy](GOVERNANCE.md) — project roles, decisions, appeals, and amendments
- [Maintainers](MAINTAINERS.md) — current project maintainers
- [Project document license](LICENSE) — license accompanying the imported project documents

## License
The repository is licensed under the [MIT License](LICENSE). The project documents copied from the MVG proposal retain the notices included in those files.