# Run your agent on the test set

The test set, 25 pull requests in [`corpus/showcase`](../corpus/showcase/), is yours to iterate on. Two ways to run on them:

## Locally, without scoring

[`scripts/try-agent.sh`](../scripts/try-agent.sh) runs your image on each test set pull request the way the benchmark does: a fresh container per pull request, the repository checked out at head under `/work/repo`, the diff and metadata under `/work/pr`, the same `RB_*` variables, and the same checks on the findings file your agent writes.

```sh
scripts/try-agent.sh my-reviewer:dev --pr 0                  # one pull request
scripts/try-agent.sh my-reviewer:dev -e OPENAI_API_KEY       # all 25, passing a key through
scripts/try-agent.sh my-reviewer:dev --set full              # the full set, all 219
```

`--set full` reads the full set's manifest, [`corpus/manifest.json`](../corpus/manifest.json), which exists from launch.

It needs docker, git and jq, and fetches each pull request from GitHub. Findings land in `./findings/`. It stops at checking the format; it does not judge the findings.

## In the portal, with scoring

A **test run** on the website runs the same 25 pull requests with the benchmark's judge and shows, for each pull request, what matched the expert findings, what your agent missed, and the judge's decision. Register your reviewer first; see the [onboarding guide](ONBOARDING.md).

## What the benchmark does that the script does not

- Blocks network access to anything outside your manifest's `egress` hosts.
- Enforces the time limit per pull request (15 minutes by default).
- Uses minimised repositories frozen in time, so history and other branches may be missing. The script uses full clones, which is more forgiving.

See the [agent contract](../AGENT_CONTRACT.md) for the details.
