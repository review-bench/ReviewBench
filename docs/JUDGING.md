# How to judge your findings

Use this pipeline when your reviewer has already produced normalized findings
and you only want to match, classify, and score them. The pipeline accepts one
JSON file or recursively loads every JSON file in a directory.

This is a private tuning tool. Results produced locally cannot be submitted or
published directly to the ReviewBench leaderboard. To receive an official
evaluation and appear on the leaderboard, onboard your reviewer and start the
final through the ReviewBench self-service portal.

You choose the LLM judge. The selected model is used for both matching candidate
findings to the golden set and classifying unmatched findings.

This is a standalone local command, not a GitHub Actions workflow. It does not
run the review agent or generate new candidate findings. It:

1. Loads your existing findings and the published golden findings.
2. Calls your selected LLM judge to match candidate findings to golden findings.
3. Calls the same judge to classify candidate findings that remain unmatched.
4. Calculates the metrics and writes the result JSON files.

The final artifacts are metrics JSON, but producing them requires judge model
calls because semantic matching and unmatched-finding validation are part of
the scoring procedure. If findings have already been matched and classified,
this command does not currently accept those intermediate judgments as input.

## Install

The judging tools require Node.js 20 or newer.

```sh
npm ci
```

## Configure your API key

Set your provider's API key in the environment before running the judge. The
pipeline reads the key through the bundled pi model registry; keys do not belong
in candidate files, command arguments, or the repository.

The pi package is used as an SDK for provider authentication, model discovery,
LLM calls, and read-only classifier tools. ReviewBench initializes an API
session for the model selected with `--provider` and `--model`; it does not
train, download, or start a local model.

Common providers include:

| Provider | Environment variable | CLI provider |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |

For example, in bash:

```sh
export OPENAI_API_KEY="<your key>"
```

In PowerShell:

```powershell
$env:OPENAI_API_KEY = "<your key>"
```

See the [pi provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
for the full provider list and provider-specific settings.

## Choose a judge model

If needed, list model IDs available through the bundled provider registry:

```sh
npx pi --list-models
```

This optional command only prints models from the pi CLI. It does not run the
ReviewBench judging pipeline. You do not need to run `npx pi` when using an API
key environment variable.

Pass the selected provider and model to the ReviewBench pipeline:

```sh
--provider <provider> --model <model-id>
```

The model must support the tool calls used by the matcher and classifier. Judge
choice affects the resulting labels and metrics, so record the exact provider
and model when comparing runs. Both values are required and must exactly match
an authenticated model; the evaluator does not fall back to another provider.

## Prepare the input

Candidate files must follow the [judging input format](JUDGING_INPUT.md). PR
identity and commit SHAs must match [`corpus/manifest.json`](../corpus/manifest.json).

Strict validation is enabled by default. It rejects malformed files, candidate
PRs without a golden file, and runs with no overlap with the golden set. Add
`--allow-empty` only for an intentionally empty candidate set.

## Run a smoke test

Start with one PR to verify the API key, model ID, input, and output paths:

```sh
npm run judge -- \
  --candidate ./my-agent-findings \
  --provider openai \
  --model <your-model-id> \
  --output ./scoring/smoke.json \
  --repo-dir ./.reviewbench-repos \
  --limit 1
```

Replace `openai` and `<your-model-id>` with your chosen provider and model.

## Judge the full candidate set

```sh
npm run judge -- \
  --candidate ./my-agent-findings \
  --golden ./golden \
  --manifest ./corpus/manifest.json \
  --provider openai \
  --model <your-model-id> \
  --output ./scoring/results.json \
  --repo-dir ./.reviewbench-repos \
  --concurrency 4
```

Choose concurrency according to your provider's rate limits and budget. Local
judging is part of self-service tuning: both the agent inference that produced
the candidate findings and these judge calls are your responsibility.
ReviewBench covers judge inference only when scoring your final submission;
your agent inference remains yours.

## Resume and inspect results

During a run, `results.checkpoint.json` is updated after each PR. Running the
same command again resumes compatible completed work. A checkpoint created by a
different model or prompt fingerprint is ignored. The checkpoint is removed
after a fully successful run.

The command prints the final summary and writes:

- `scoring/results.json`: aggregate grounded and augmented precision and recall,
  plus corpus and evaluator provenance.
- `scoring/results.details.json`: each candidate finding, its judge decision,
  and its golden matches, grouped by PR.
- `scoring/results.checkpoint.json`: resumable intermediate state while a run
  is incomplete.

Grounded metrics compare against the original golden findings. Augmented
metrics also credit unmatched findings that your selected LLM judge classifies
as valid.

## Frozen local snapshots

For single-PR integrations such as the [Harbor adapter](HARBOR.md), pass
`--snapshot-dir <path>` to use an already materialized, trusted checkout instead
of the mirror cache. The checkout must be at the exact candidate HEAD, contain
the base commit and merge base, and have no modified, untracked, or ignored
files. This mode never fetches or clones and rejects evaluations selecting
more than one PR. Do not point it at a reviewer-modified checkout.
