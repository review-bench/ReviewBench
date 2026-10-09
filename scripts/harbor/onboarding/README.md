# ReviewBench user kit

This kit connects your reviewer to an approved ReviewBench task export. It does
not copy the dataset, change the judge, install credentials, or publish results.
The dataset paths in `job.json` refer to the machine running Harbor; regenerate
the kit if you move the dataset or use a different execution machine.

## Prepare

Install the supported Harbor CLI and `uv`. Cloud sandboxes also require the
matching Harbor provider extra and your sandbox account credentials. A Linux
Docker runner must support Harbor's network allowlists.

Set up your reviewer credential through the approved secret mechanism. Obtain
the approved verifier-only judge connection from the dataset maintainer; the
task export must already specify that connection and any required model
registration. This kit does not grant judge access.

Never put secret values in `job.json`, findings, source files, or command
arguments. Keep judge credentials confined to the verifier.

## Use your agent

For a built-in agent, `job.json` already selects the agent and optional model
you supplied to `harbor:onboard`. Configure provider-specific nonsecret settings
in its `kwargs` if your endpoint needs them.

For a custom harness, edit `custom_agent.py`: implement `install()` and replace
the example CLI arguments in `run()` with your harness's invocation. The
template deliberately fails until installation is implemented. Convert native
output deterministically into the findings format; do not add or discard
findings during conversion.

Make the adapter importable before running a custom agent:

```powershell
$env:PYTHONPATH = (Get-Location).Path
```

Run this from the kit directory. On Linux, use `export PYTHONPATH="$PWD"`.

## Findings contract

The agent writes `/work/out/findings.json`:

```json
{
  "pr": {
    "repo": "https://github.com/owner/repo",
    "pr_number": 1,
    "base": "<task base SHA>",
    "head": "<task head SHA>"
  },
  "agent": "my-agent",
  "findings": [
    {
      "producer": "my-agent",
      "file": "src/example.ts",
      "start_line": 42,
      "end_line": 42,
      "message": "Describe the issue and its consequences."
    }
  ]
}
```

Copy PR identity from `/work/pr/pr.json`. Paths must be repository-relative,
use forward slashes, and refer to the frozen HEAD. Line numbers are positive
integers and `end_line` cannot precede `start_line`. An empty findings array is
valid; a missing file is not.

From the ReviewBench source checkout, validate sample output without a judge:

```powershell
npm run harbor:validate-findings -- --candidate <findings.json> --pr <task-directory>\environment\pr.json
```

This checks format and PR identity, not correctness of the reported issue.
The separate verifier repeats validation before scoring.

## Run, check, and upload

From the kit directory:

```powershell
harbor run -c .\job.json
```

After execution, from the ReviewBench source checkout:

```powershell
python scripts\harbor\check-job.py <kit-directory>\jobs\<job-name> <dataset-directory>\metric.py --output verified-metrics.json
```

Only complete, exception-free runs with the expected evaluation version pass.
To smoke-test, obtain a limited task export from the maintainer and generate
its own kit; do not submit a partial run of a full dataset as a complete score.

Inspect the job for secrets and private source before uploading:

```powershell
harbor auth login
harbor auth org list
harbor upload <job-directory> --private --org <approved-org>
```

Harbor organization membership is separate from GitHub organization membership.
Uploading results does not launch a hosted job or automatically publish a
ReviewBench leaderboard row.
