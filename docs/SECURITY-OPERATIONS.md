# Security operations: quarantine, dispute, rollback

What we do when a benchmark input, a vendor, or a published score is suspect. Every action here leaves the audit trail intact: publications, their rounds and per-finding rows are never deleted, only marked.

## Roles

- Maintainers: the `@review-bench/reviewbench-maintainers` team, code owner in `review-bench/reviewbench-internal`, `review-bench/api` and `review-bench/ReviewBench`. Two maintainers decide; one executes.
- Admin actions run against the API with `RB_ADMIN_TOKEN` (`X-Admin-Token` header). The token lives in the App Service configuration; it is never pasted into issues.

## 1. Quarantine and removal

### A published score is suspect

1. Retract the row: `POST /api/admin/publications/<id>/retract` with `{ "reason": "<one line>" }`. The row leaves the leaderboard at once. The publication, its runs, scores and per-finding rows stay in the database with `status = retracted` and the reason.
2. Open an issue in `review-bench/reviewbench-internal` titled `Retraction: <site id>` with the publication id, the reason and links to the workflow run and the review pull request. This is the record.
3. Tell the agent's contacts by email (`agents.report_email`) within one working day.

### A vendor is suspect

1. Retract every published row of the agent (as above).
2. Reject or close the agent's manifest pull request in `review-bench/ReviewBench`; the sync loop moves the agent to `rejected`, and its contacts can no longer start runs or publish.
3. Rotate nothing of ours: vendor credentials are the vendor's; the reference key is only exposed to organisation members on stage.
4. Do not delete the agent (`DELETE /api/admin/agents/<name>` cascades to runs and scores and destroys the audit trail). Deletion is for test agents only.

### A corpus pull request is suspect (poisoned diff, injected instructions)

1. Remove the PR from the manifest (`corpus/manifest.json`) and its golden file in a pull request to `review-bench/reviewbench-internal`, and the same change to the public copy in `review-bench/ReviewBench`; two maintainers approve.
2. Rebuild the leaderboard runner image, which bakes in the full corpus (`publish-heldback-image.yml`). The golden hash changes; every new score records the new hash, so old and new scores are distinguishable.
3. Rows measured against the old golden set stay published unless the poisoned PR affected their result materially; if it did, retract and re-measure (see rollback).
4. Re-run the corpus injection scan (`scripts/corpus/injection-scan.sh <runner image>`: added lines of every diff, instruction-like text) before the image is used.

## 2. Dispute

Disputes follow the process in [CONTRIBUTING.md](https://github.com/review-bench/ReviewBench/blob/main/CONTRIBUTING.md#label-disputes) of `review-bench/ReviewBench`.

## 3. Rollback

To return the leaderboard to a previous state for one row:

1. Retract the current publication (section 1).
2. If a previous publication for the same `site_id` exists with `status = superseded`, a maintainer re-publishes it from the database (`store.publish(<id>)`: the row becomes `published`, any other published row for the site becomes `superseded`). There is no admin route for this yet; see gaps.
3. If no previous publication exists, the row stays off the leaderboard until re-measured.

To re-measure: the agent's contact (or a maintainer, on stage) starts a publication from the portal against the same configuration; three fresh rounds run, and the new review pull request goes through the normal approval.

## What is recorded, per run

| Field | Where |
|---|---|
| Vendor image digest | `runs.image`, `publications.image` |
| Internal commit the run measured with | `runs.source_ref`, `publications.source_ref` |
| Workflow run | `runs.github_run_id`, `publications.github_run_id` |
| Golden set hash, prompt hashes, judge models, combination | `run_scores.eval_config` |
| Scoring profile | `run_scores.profile_id`, `publications.profile_id` |
| Per-PR metrics and per-finding verdicts with judge votes | `run_prs`, `run_findings` |
| Publication bundle as reviewed | `publications.bundle`, and the merged pull request in `review-bench/reviewbench-internal` |

Gap: the runner image is referenced by tag (`heldback-latest`), not by digest, in a run record. Until the workflow records the digest, resolve it from the workflow run's log.

## Known gaps

- No admin route to set an agent `disabled` without deleting it; today rejection goes through the manifest pull request.
- No admin route to re-publish a superseded publication; rollback of a row is a database action by a maintainer.
- The website shows the current row only; superseded and retracted publications are visible through the API and the internal repository, not on the site.
