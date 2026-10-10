# Evaluate your reviewer offline

You can score any code reviewer on the benchmark from your own machine. You do
not need to register, open a pull request, or publish anything. It takes two
steps:

1. Run your reviewer image on the benchmark pull requests to produce findings
   files.
2. Judge those files against the golden set to get metrics.

Offline results are for development and tuning. Only a final run
started from the [self-service portal](https://review-bench.ai/submit) can
appear on the leaderboard.

```sh
git clone https://github.com/review-bench/ReviewBench && cd ReviewBench
npm ci

# Give every run its own directory, so findings and scores never mix across runs.
root=$PWD
run=$root/runs/my-reviewer-$(date +%Y%m%d-%H%M%S)
mkdir -p "$run"

# 1. Findings for the 25 test set pull requests land in $run/findings/
(cd "$run" && TRY_AGENT_WORK=$root/.try-agent "$root/scripts/try-agent.sh" my-reviewer:dev -e OPENAI_API_KEY)

# 2. Judge them
npm run judge -- --candidate "$run/findings" --provider <provider> --model <model-id> \
  --output "$run/scoring/results.json" --concurrency 4
```

## 1. Produce findings

Package your reviewer as an image that follows the
[agent contract](../AGENT_CONTRACT.md). It is the same image you would register
for the leaderboard. The container is part of the benchmark's isolation: the
reviewer cannot inherit your host credentials, read this checkout or its
golden set, or keep tool state between pull requests.

[`scripts/try-agent.sh`](../scripts/try-agent.sh) runs the image on each pull
request in a fresh container, the same way the benchmark does. It fetches the
base and head commits from the
[review-bench mirror](https://github.com/review-bench), checks out the head,
writes the diff and pull request metadata, and runs your image. It then
validates the findings file and copies it to `./findings/<pr key>.json` in the
directory you run it from. Add `--set full` to run all 219 pull requests, or
`--pr <index>` to run one. See [Run your agent locally](RUNNER.md) for passing
API keys and other variables.

It needs docker, git and jq. The script exits non-zero if any pull request
fails.

The findings file uses the format in the
[agent contract](../AGENT_CONTRACT.md#what-you-must-write). If your reviewer
has its own output format, convert it in the image's entrypoint. For example:

```sh
#!/usr/bin/env bash
set -euo pipefail
my-reviewer review --base "$RB_BASE" --head "$RB_HEAD" --json |
  jq --slurpfile pr "$RB_PR_JSON" '{
    pr: ($pr[0] | {repo, pr_number, base, head}),
    agent: env.RB_AGENT,
    findings: [.comments[] | {file: .path, start_line: .start, end_line: .end, message: .body, producer: env.RB_AGENT}]
  }' > "$RB_OUT"
```

To run several pull requests at once, start one `try-agent.sh --pr <index>` per
worker from the same run directory. Two workers can share a repository in the
full set, so give each worker its own `TRY_AGENT_WORK` directory.

### Already have findings?

If your own harness produces findings, write them in the
[judging input format](JUDGING_INPUT.md) and skip to step 2.

## 2. Judge the findings

```sh
export ANTHROPIC_API_KEY=...
npm run judge -- --candidate "$run/findings" --provider anthropic --model <model-id> \
  --output "$run/scoring/results.json" --concurrency 4
```

The judge matches each finding against the golden set. It classifies the
findings that match nothing, then writes grounded and augmented precision and
recall to `results.json`. Per-finding decisions go to `results.details.json`
next to it. See [How to judge findings](JUDGING.md) for providers, resuming,
and the output fields.

Each judge call has a 10-minute budget, plus 2 minutes per finding for the
classifier. A slow endpoint or a high `--concurrency` can exceed it, and the
judge then refuses to write partial results. Raise the budget with
`REVIEW_BENCH_JUDGE_TIMEOUT_MS` (for example `1800000`) and run the same
command again. Pull requests that already finished resume from the checkpoint.

### Use the leaderboard's judge model

The leaderboard is judged by Claude Sonnet 5. The judge model changes the
scores, so use the same model when you compare with the leaderboard. If the
bundled model registry does not list it yet (`npx pi --list-models`), add it to
a `models.json`. You can also route the judge through a proxy or an
Anthropic-compatible gateway the same way:

```sh
mkdir -p .judge
cat > .judge/models.json <<'EOF'
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY",
      "models": [
        { "id": "claude-sonnet-5", "reasoning": true, "contextWindow": 1000000, "maxTokens": 64000 }
      ]
    }
  }
}
EOF
PI_CODING_AGENT_DIR=$PWD/.judge npm run judge -- --candidate "$run/findings" \
  --provider anthropic --model claude-sonnet-5 --output "$run/scoring/results.json"
```

For a gateway, add `"baseUrl"` to the provider. Set `"apiKey"` to the name of
the environment variable that holds its key. `PI_CODING_AGENT_DIR` keeps this
configuration out of your personal pi settings. The
[pi models documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
lists every option.

## Limits of offline results

Offline numbers can differ from leaderboard numbers for reasons unrelated to
reviewer quality:

- **Set size.** The 25 test set pull requests show whether your image works.
  The leaderboard scores all 219 pull requests three times.
- **Coverage.** The judge scores only the pull requests that have a findings
  file. A failed pull request drops out instead of counting as a miss. Check
  that `try-agent.sh` reports `failed 0` and that the judge summary shows the
  expected pull request count. A directory reused across runs can hold stale
  findings from an earlier attempt, set, or configuration, so start every run
  in a fresh directory.
- **Judge.** Record the provider and model with every result. The results file
  stores both, along with the prompt and golden set hashes.
- **Environment.** `try-agent.sh` does not enforce the portal's network
  restrictions, its per-PR time limit, its minimised frozen repositories, or
  its all-or-nothing run contract.
- **Answer leakage.** All 219 pull requests are public, and the golden findings
  are in this repository. The upstream pull request's review comments, which
  are a source of golden findings, are public too, along with later fix
  commits. A reviewer with network access can look up the answers instead of
  finding the issues. Reviewers built to read pull request discussions will do
  this unprompted. One fetched `pulls/<n>/comments` from the unauthenticated
  GitHub API in our testing, so withholding a GitHub token is not enough. The
  container keeps the golden set out of reach, but `try-agent.sh` does not
  restrict its network. Do what the benchmark does: allow outbound traffic only
  to your model provider, for example through an egress proxy on the
  container's network. Then check the reviewer's logs for requests to GitHub.

  An allowlist that admits the model host does not block tools the provider
  hosts behind it. Hosted web search and connectors such as a GitHub app run
  through the model host. In our testing, a Codex reviewer whose network was
  limited to its model host still read upstream review comments through the
  Codex GitHub connector on about half of the pull requests. Turn these tools
  off for benchmark runs; for Codex, set `features.apps = false` and
  `tools.web_search = false` in a dedicated `CODEX_HOME`. Then check the
  agent's transcripts for connector and web search calls, not only its network
  log.
