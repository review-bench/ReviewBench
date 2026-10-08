# The agent contract

We start a fresh container from your image for every pull request, mount that
pull request into it, and read the findings file it writes. Nothing carries
over between pull requests, and your agent never learns it is part of a
benchmark.

## How we invoke you

```sh
docker run --rm \
  -v <checkout at head>:/work/repo \
  -v <pr metadata>:/work/pr:ro \
  -v <output dir>:/work/out \
  -e RB_NWO=owner/repo \
  -e RB_PR_NUMBER=1938 \
  -e RB_BASE=<40-char sha> \
  -e RB_HEAD=<40-char sha> \
  -e RB_AGENT=your-reviewer \
  -e RB_DIFF=/work/pr/diff.patch \
  -e RB_PR_JSON=/work/pr/pr.json \
  -e RB_OUT=/work/out/findings.json \
  your-image@sha256:...
```

## What you receive

| Path or variable | Contents |
|---|---|
| `/work/repo` | The repository checked out at `RB_HEAD`, with `.git`, so `git diff $RB_BASE...$RB_HEAD` and repository history both work. Marked safe for git through `GIT_CONFIG_*` variables; if your image clears the environment, set `safe.directory` yourself. Writable, discarded after the run. |
| `/work/pr/diff.patch` | The change under review, already computed as a three-dot diff from base to head. Identical to what GitHub shows on the pull request. |
| `/work/pr/pr.json` | `{ repo, pr_number, base, head, nwo, title, body }` |
| `RB_NWO` | `owner/repo` |
| `RB_PR_NUMBER` | Pull request number |
| `RB_BASE`, `RB_HEAD` | Full 40-character commit SHAs |
| `RB_AGENT` | The name you registered. Use it as `agent` and `producer` in your output. |
| `RB_OUT` | Where to write your findings |
| `RB_CONFIG_<KEY>` | One variable per entry in your manifest's `configuration`. The key is upper-cased and every character that is not a letter or digit becomes an underscore (`model` becomes `RB_CONFIG_MODEL`, `max-tokens` becomes `RB_CONFIG_MAX_TOKENS`). Read these to select model, effort or any other setting, so a configuration can be tried without rebuilding the image. Print the settings your agent applies (for example `model=gpt-5.5 effort=high`): the run names any label whose value never appears in your agent's output, since a label your image does not read has no effect. |
| `RB_MODEL_BASE_URL` | The model API URL you registered, if any (for example `https://api.openai.com/v1`). Read it instead of hardcoding your endpoint, so the endpoint and the allowlist come from one place. |
| `RB_ATTEMPT` | Attempt number, starting at 1, if we are retrying |

Your declared credentials arrive as environment variables, as files at the
paths you declared, or both.

## What you must write

One JSON file at `RB_OUT`:

```json
{
  "pr": {
    "repo": "https://github.com/owner/repo",
    "pr_number": 1938,
    "base": "<40-char sha>",
    "head": "<40-char sha>"
  },
  "agent": "your-reviewer",
  "findings": [
    {
      "file": "src/pool.ts",
      "start_line": 42,
      "end_line": 45,
      "message": "Race condition: conns is read without holding the mutex.",
      "producer": "your-reviewer"
    }
  ]
}
```

### Field rules

- `file` is repository-relative, forward slashes, no leading `./`.
- `start_line` and `end_line` refer to the file at `RB_HEAD`. For a single
  line, set both to the same number.
- `message` states what is wrong and why. This is what the judge matches
  against the expert findings, so a vague message scores poorly even when the
  underlying issue is real.
- One entry per logical issue, spanning the full line range. Do not emit one
  entry per line.
- `pr.head` must equal `RB_HEAD` and `pr.pr_number` must equal `RB_PR_NUMBER`.
  A mismatch in either fails the pull request.

### Exit codes

| Outcome | What we do |
|---|---|
| Exit 0 with a valid file | Accepted |
| Exit 0 with `"findings": []` | Accepted. You reviewed it and found nothing. |
| Non-zero exit, missing file, malformed JSON, or wrong head or PR number | The pull request failed. We retry, then fail the run. |

A run is all or nothing. One pull request that never succeeds fails the whole
run rather than publishing a partial score.

## Limits

- **Platform.** `linux/amd64`. On Apple Silicon build with
  `docker build --platform linux/amd64`, or the image will not start. The
  image runs with no arguments, so its `ENTRYPOINT` (or `CMD`) must start
  your adapter.
- **Time.** 15 minutes per pull request by default. Ask if your agent needs
  longer.
- **Network.** Enforced during every run: only the hosts listed in your
  manifest's `egress` are reachable, on port 443, through a forward proxy.
  The host of your model API URL is added for you. Anything else is refused;
  if the first pull request fails because a host was refused, the run stops
  there and names the host. The proxy address arrives as `HTTP_PROXY` and
  `HTTPS_PROXY` (and
  lowercase), which every mainstream HTTP client honours; `NODE_USE_ENV_PROXY=1`
  is set for Node's built-in `fetch`. Declare every host, including any token
  exchange your model provider does (Copilot seats, for example, use
  `api.github.com` plus `api.githubcopilot.com` or
  `api.enterprise.githubcopilot.com`). Refused hosts are listed in your report.
- **No GPUs.** If you use an open model, host it yourself and call it over
  the network.
- **Resources.** A standard GitHub-hosted runner, shared with our driver.

## Things that will surprise you

- **Repositories are frozen.** They are minimised clones containing only what
  is reachable from base and head. `git log` is shallow, other branches do
  not exist, and there is no network path to the original repository.
- **Large files are pointers.** Repositories using Git LFS carry pointer
  files, not the objects.
- **No GitHub API.** There is no token, and the pull request does not exist
  on github.com in the form you are given. Everything you need is mounted.
- **Truncated output is a common failure.** If your agent asks a model for
  JSON, cap the number of findings and check the response parses before
  exiting. We lost a pull request to this during development.
