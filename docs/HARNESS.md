# Evaluation Harness

This document describes the harness that runs candidate review agents
against benchmark PRs and collects their findings. The harness is the
bridge between the PR manifest (the benchmark corpus) and the
downstream evaluation pipeline (matching, classification, scoring) defined
in METHODOLOGY.md §6–7.

## 1. Overview

The harness iterates over a manifest of benchmark PRs. For each PR it
prepares the environment an agent needs, invokes the agent, collects
the raw findings the agent produced, normalizes them to a common schema,
and writes the result to disk. Two adapter types support the two ways
agents consume PRs:

- **GitHub adapter** — for agents that operate as GitHub Apps or
  integrations and require a real PR on GitHub.
- **Local adapter** — for agents that accept a diff, repo path, or API
  call and return structured output without GitHub.

Both adapters produce the same normalized output so that everything
downstream is identical regardless of how the agent was invoked.

## 2. PR Manifest

The manifest is the list of PRs in the benchmark. Each entry contains
the fields recorded in METHODOLOGY.md §3.2:

```yaml
prs:
  - repo: https://github.com/org/repo
    pr_number: 1234
    base: abc123def
    head: 456fed789
    title: "fix race condition in connection pool"
    body: |
      The pool was not holding the mutex when accessing the
      connection list, leading to data races under load.
```

The `base` and `head` commits define the review-time snapshot: the
state of the code at the time review feedback would have been given,
before any follow-up fix commits (METHODOLOGY.md §3.2).

The manifest is the source of truth for which commits the harness
checks out and which diff the agent reviews. Agents must not see
commits after `head`.

The full-corpus manifest contains all 219 public PRs. Small and test runs may
instead use the 25-PR test-corpus manifest, which is a representative subset
of those same 219 PRs; the harness behavior and output schema are identical.

## 3. Agent Configuration

Each agent is described by a configuration entry specifying how to
invoke it and how to collect its output.

```yaml
agents:
  - name: coderabbit
    type: github
    bot_user: "coderabbitai[bot]"
    completion:
      strategy: poll_for_summary_comment
      timeout: 300

  - name: internal-reviewer
    type: local
    command: "review-agent --diff {diff_path} --repo {repo_path} --output {output_path}"
    output_format: json

  - name: static-analysis
    type: local
    command: "run-linter --changed-files {changed_files} --output {output_path}"
    output_format: sarif
```

Fields common to all agents:

- `name` — unique identifier for the agent.
- `type` — `github` or `local`.

Fields specific to GitHub agents:

- `bot_user` — the GitHub username of the agent's bot account, used
  to filter comments during collection.
- `completion` — how to detect that the agent has finished posting
  comments. See §5.2.

Fields specific to local agents:

- `command` — the command to invoke. Placeholders are expanded by the
  harness: `{diff_path}`, `{repo_path}`, `{output_path}`,
  `{changed_files}`, `{base}`, `{head}`.
- `output_format` — the format of the agent's output file. The harness
  includes a parser for each supported format. Initially: `json`
  (a list of finding objects) and `sarif` (Static Analysis Results
  Interchange Format).

## 4. Adapter Interface

Each adapter implements the following lifecycle:

```
prepare(pr, agent) → RunContext
run(ctx)           → void
collect(ctx)       → RawFinding[]
cleanup(ctx)       → void
```

**prepare** — sets up whatever the agent needs to review the PR.
Returns an opaque context object that carries state through the
remaining steps.

**run** — invokes the agent and blocks until the agent has finished.
What "finished" means is adapter- and agent-specific (see §5 and §6).

**collect** — gathers the raw findings the agent produced and returns
them as a list.

**cleanup** — tears down temporary resources (closes PRs, deletes
branches, removes temp directories).

The harness calls these in sequence for each (PR, agent) pair. If
`run` or `collect` fails, `cleanup` is still called.

## 5. GitHub Adapter

### 5.1 Preparation

The GitHub adapter maintains one fork per source repository. Forks are
created on first use and reused across PRs and eval runs. The fork
lives in a dedicated GitHub organization or user account controlled by
the harness operator.

For each (PR, agent) pair:

1. Ensure the fork of the source repo exists.
2. Create a branch on the fork from the `base` commit.
3. Reset the branch to the `head` commit (via force-push or
   cherry-pick, depending on what the commit history requires).
4. Open a pull request on the fork, targeting `base`, from the
   branch at `head`.
5. Return a context containing the fork repo, PR number, and branch
   name.

If multiple agents are being evaluated on the same benchmark PR, each
agent gets its own PR on the fork. This prevents agents from seeing or
reacting to each other's comments.

### 5.2 Completion Detection

GitHub-native agents operate asynchronously: the harness opens a PR and
the agent eventually posts comments. The harness needs to know when the
agent is done. Completion detection is agent-specific and configured per
agent. Strategies include:

- **Poll for summary comment.** Many agents post a summary comment
  when they finish. The harness polls the PR comments for a comment
  from `bot_user` matching a pattern (e.g., contains "review summary"
  or a known marker). Polling interval and timeout are configurable.
- **Wait for status check.** Some agents set a commit status or check
  run when they complete. The harness polls the commit status API.
- **Fixed delay.** As a fallback, wait a fixed duration after PR
  creation. Least reliable but works for agents with no completion
  signal.

All strategies are subject to a configurable timeout. If the timeout
expires without completion, the harness records a timeout failure for
that (PR, agent) pair and proceeds to cleanup.

### 5.3 Collection

Once the agent has completed:

1. Fetch all review comments and issue comments on the PR via the
   GitHub API.
2. Filter to comments authored by `bot_user`.
3. For each comment, extract:
   - File path and line range (from the review comment anchor, if
     present).
   - Message text (the comment body).
   - Whether the comment is a line-level review comment or a
     PR-level comment. PR-level comments (e.g., summary comments)
     are recorded but may be excluded during normalization if they
     do not reference specific code locations.
4. Record the review duration as the elapsed time from PR creation to
   the latest timestamp among the agent's comments posted as part of the
   completed review.

### 5.4 Cleanup

1. Close the PR.
2. Delete the branch on the fork.
3. The fork itself is retained for reuse.

## 6. Local Adapter

### 6.1 Preparation

1. Clone the source repo into a temporary directory (or use a cached
   clone and create a worktree).
2. Check out the `head` commit.
3. Generate the diff: `git diff base..head`.
4. Write the diff to a temporary file.
5. Compute the list of changed files.
6. Return a context containing the repo path, diff path, and
   changed file list.

### 6.2 Invocation

1. Expand the agent's `command` template with paths from the context.
2. Execute the command as a subprocess.
3. Block until the process exits. If it exceeds a configurable
   timeout, kill it and record a timeout failure.
4. Capture stdout and stderr for diagnostics.

### 6.3 Collection

1. Read the output file at `{output_path}`.
2. Parse it according to the agent's `output_format`.
3. For each entry, extract file path, line range, and message.

For `json` format, the expected shape is a list of objects with `file`,
`start_line`, `end_line`, and `message` fields. For `sarif`, findings
are extracted from the `results` array using the SARIF location and
message schema.

Additional output formats can be added by implementing a parser that
maps the format to the common `RawFinding` structure.

### 6.4 Cleanup

Remove the temporary directory (or worktree). If using a cached clone,
leave the cache intact.

## 7. Normalization

Raw findings from both adapters are normalized to the common schema
defined in METHODOLOGY.md §4.3 before being written to disk. This
includes:

- Canonicalizing file paths relative to the repository root.
- Clamping line ranges to the changed hunks of the PR. Findings
  outside the diff are retained but flagged as out-of-diff.
- Collapsing multi-part comments (e.g., a GitHub review comment
  thread) into a single finding where they describe one issue.
- Attaching the agent name as the producer identifier.

## 8. Output

For each (PR, agent) pair the harness writes a result file. The
output format is not yet finalized; the following is the minimum
viable structure:

```json
{
  "pr": {
    "repo": "https://github.com/org/repo",
    "pr_number": 1234,
    "base": "abc123def",
    "head": "456fed789"
  },
  "agent": "coderabbit",
  "status": "success",
  "findings": [
    {
      "file": "src/pool.go",
      "start_line": 42,
      "end_line": 45,
      "message": "Race condition: pool.conns is accessed without holding the mutex",
      "in_diff": true
    }
  ],
  "metadata": {
    "duration_seconds": 47,
    "timestamp": "2026-05-12T10:30:00Z"
  }
}
```

`duration_seconds` is an evaluated metric defined in METHODOLOGY.md §7.5.
For GitHub reviews, it is calculated from the harness-created PR's creation
timestamp to the final agent review comment's timestamp.

When `status` is not `success` (e.g., `timeout`, `error`), the
`findings` array may be empty and a `failure_reason` field is
included.

Result files are written to a directory tree organized as:

```
results/
  {repo_name}/
    {pr_number}/
      {agent_name}.json
```

These files are the input to the matching step (METHODOLOGY.md §6.2).

After matching and classification, the evaluation pipeline writes a scored
result that preserves the Claude Sonnet 5 classifier output for every
finding. A finding's record includes its TP/FP decision and the severity,
category, and other auxiliary labels produced by that same classifier. The
exact scored-result schema is not yet defined. Scored results
must also retain the run identifier because each candidate evaluation is
executed three times and the leaderboard submission is the average of those
run scores.

Persisting the classifier decision and its justification supports the
results UI and auditability without an aggregation layer.

## 9. Execution

### 9.1 Sequencing

The harness processes (PR, agent) pairs sequentially by default. This
is the simplest mode and avoids GitHub API rate limits, agent
concurrency issues, and resource contention.

For a leaderboard evaluation, the complete benchmark execution is repeated
three times. Each run has a stable identifier and produces an independent
set of result and score artifacts.

### 9.2 Resumption

The harness checks for existing result files before running a (PR,
agent) pair. If a result file already exists and `status` is
`success`, the pair is skipped. This allows interrupted runs to be
resumed without re-running completed evaluations. A `--force` flag
overrides this behavior.

### 9.3 Error Handling

If an agent fails on a PR (timeout, crash, API error), the harness:

1. Records the failure in the result file with the appropriate status.
2. Calls cleanup to release resources.
3. Continues to the next (PR, agent) pair.

A failed pair does not block the rest of the run. Summary statistics
(success/failure/timeout counts per agent) are printed at the end.

## 10. Future Considerations

These are not needed for the initial implementation but are worth
keeping in mind.

**Parallel execution.** Running multiple (PR, agent) pairs concurrently
would speed up large benchmark runs. For local agents this is
straightforward (parallel subprocesses). For GitHub agents it requires
managing concurrent PRs on the fork without hitting API rate limits.
A concurrency limit per adapter type would be the natural control.

**Agent-specific setup.** Some agents require per-repo configuration
files (e.g., `.coderabbit.yaml`, `.github/copilot-review.yml`).
The harness could support an optional `setup` step in the agent config
that copies configuration files into the repo before opening the PR.

**Diff-only agents.** Some agents don't need a full repo checkout —
they operate on the diff alone. A third adapter type (or a local
adapter mode) that skips the clone and just provides the diff would
reduce overhead for these agents.

**Cost tracking.** Recording token usage, API calls, and wall-clock
time per (PR, agent) pair would support the cost-adjusted metrics
discussed in METHODOLOGY.md §10.
