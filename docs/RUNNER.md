# Run your agent on the test set

The test set, 25 pull requests listed in [`corpus/test/test.json`](../corpus/test/test.json), is yours to iterate on. Two ways to run on them:

## Locally, without scoring

[`scripts/try-agent.sh`](../scripts/try-agent.sh) runs your image on each test set pull request the way the benchmark does: a fresh container per pull request, the repository checked out at head under `/work/repo`, the diff and metadata under `/work/pr`, the same `RB_*` variables, and the same checks on the findings file your agent writes.

```sh
scripts/try-agent.sh my-reviewer:dev --pr 0 -e OPENAI_API_KEY      # one pull request
scripts/try-agent.sh my-reviewer:dev -e OPENAI_API_KEY             # all 25
scripts/try-agent.sh my-reviewer:dev --set full -e OPENAI_API_KEY  # the full set, all 219
```

`-e NAME` passes that variable from your shell into the container under the name your agent reads; the script never puts the value on a command line or into the findings files. If your endpoint is not OpenAI, add `-e RB_MODEL_BASE_URL=https://…` as well. A private package needs `docker login ghcr.io` on your machine first.

`--set full` reads the full set's manifest, [`corpus/manifest.json`](../corpus/manifest.json).

It needs docker, git and jq. It fetches each pull request's base and head commits from its mirror in the [review-bench organization](https://github.com/review-bench), `review-bench/<owner>_<repo>` (for example, `review-bench/AA-Factory_aafactory-prototype`), which is the same copy the judge checks out. If the mirror lacks a commit, it falls back to the upstream repository; if neither has it, that pull request fails. Set `MIRROR_ORG` to fetch from a different organization. Findings land in `./findings/`. It stops at checking the format. To score the findings, pass `./findings` to the [judging CLI](JUDGING.md); see [Evaluate your reviewer offline](OFFLINE_EVAL.md).

## In the portal, with scoring

A **test run** on the website runs the same 25 pull requests with the benchmark's judge and shows, for each pull request, what matched the expert findings, what your agent missed, and how each judge voted. Register your reviewer first; see the [onboarding guide](ONBOARDING.md).

## What the benchmark does that the script does not

- Blocks network access to anything outside your manifest's `egress` hosts.
- Enforces the time limit per pull request (15 minutes by default).
- Uses minimised repositories frozen in time, so history and other branches may be missing. The script uses full clones, which is more forgiving.

See the [agent contract](../AGENT_CONTRACT.md) for the details.
