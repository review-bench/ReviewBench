# An Offline Benchmark Methodology for AI Code Review

## Abstract

We describe an offline benchmark methodology for evaluating AI code review
systems against pull requests (PRs) drawn from a curated set of source
repositories. The methodology produces per-PR sets of *findings* — atomic
review observations attached to specific lines or hunks of changed code — and
labels each finding as a true positive (TP) or false positive (FP) using
human-authored guidelines and a Claude Sonnet 5 classifier. The same
classifier assigns severity, category, and the other auxiliary labels, so
aggregate metrics can be sliced along those axes. Once a labeled corpus is established, any
candidate review agent can be evaluated by generating its own findings on
the same PRs, matching them against the labeled corpus, and classifying any
unmatched findings with the same classifier. From these operations we derive
four primary metrics —
*grounded precision*, *grounded recall*, *augmented precision*, and
*augmented recall* — each of which can also be reported stratified by
severity and category. We also report review duration to capture how long an
agent takes to deliver its review. This document specifies the corpus
construction, finding extraction, labeling, matching, and scoring procedures
in enough detail to support reproduction and extension.

## 1. Motivation and Scope

Code review is a high-context, high-judgment task. Existing benchmarks for
AI code review tend to optimize for one of two extremes: small, hand-curated
sets of canonical bugs (high precision, low coverage of real review
behavior) or fully automated proxies such as later-commit overlap (broad
coverage, noisy labels). Neither captures the full distribution of comments
that human reviewers actually make, and neither lets us cleanly attribute a
score to either *finding quality* or *finding coverage*.

The methodology in this document is designed to:

1. Cover the full gamut of changes that real PRs subject to code review,
   across multiple repositories, languages, and change types.
2. Capture findings from heterogeneous sources — human reviewers, inferred
   author actions, deterministic tools, and LLM-based reviewers — so that
   the labeled corpus is not biased toward any single producer.
3. Provide a reproducible, auditable definition of TP versus FP grounded in
   senior-engineer judgment, and a Claude Sonnet 5 classifier that
   operationalizes that definition at scale.
4. Yield precision and recall metrics that distinguish between findings
   verified against a fixed "golden set" and findings whose labels rely on
   the classifier alone.

## 2. Definitions

We use the following terms throughout.

**Pull request (PR).** A unit of proposed change in a source repository,
identified by its URL. A PR carries a diff, a title, a body, and a set of
reviewer comments and subsequent commits.

**Finding.** An atomic review observation attached to a specific location in
the changed code. A finding has, at minimum: (i) a file path, (ii) a line
range, (iii) a natural-language message, and (iv) a producer identifier
indicating where the finding came from. Findings are the unit of
classification, matching, and scoring.

**True positive (TP).** A finding that a competent senior reviewer would
expect a PR author to address before merge. TPs are correct, verifiable
against the changed code, in scope for the PR, and actionable.

**False positive (FP).** A finding that a competent senior reviewer would
not consider worth addressing. FPs include factually incorrect statements,
unverifiable claims, observations out of scope for the PR, duplicates,
trivial style nits below the project's review bar, and findings whose
suggested action would not improve the change.

**Golden set.** The per-PR set of findings whose TP/FP labels were
assigned during corpus construction and serve as the reference baseline
for evaluating a candidate agent. The initial labels were produced by the
corpus classifier and then reviewed and corrected by humans as described in
Section 5.4.

**Candidate agent.** The system under evaluation. It produces a set of
findings for each PR in the benchmark.

**Match.** A correspondence between a candidate finding and a golden
finding indicating that the two refer to the same underlying issue, even
if their messages and exact line ranges differ.

**Grounded** vs. **augmented** metrics. Grounded metrics are computed using
only golden-set labels. Augmented metrics additionally use the classifier
to label candidate findings that did not match any golden finding. Both
families are reported.

## 3. Corpus Construction

### 3.1 Repository Selection

We select source repositories with the goal of spanning the realistic
distribution of code review work. Selection criteria include:

- **Language and stack diversity** — to avoid overfitting to any single
  ecosystem.
- **Project maturity** — established projects with active review culture,
  so that historical PRs contain meaningful reviewer comments.
- **Change-type diversity** — feature work, refactors, bug fixes,
  performance changes, dependency upgrades, infrastructure changes,
  documentation, and tests.
- **Reviewability** — PRs whose diffs are large enough to elicit non-trivial
  review but bounded enough that the entire change can be analyzed within
  the context budget of typical review agents.

### 3.2 Pull Request Selection

Within each selected repository we collect PR URLs that, in aggregate,
represent the change-type distribution of interest. We do not require PRs
to be merged, but we do require that each PR has reached a state at which
review feedback has plausibly stabilized (for example, merged, closed, or
inactive for a sustained period).

The full corpus contains 219 PRs, all public in
[`corpus/manifest.json`](../corpus/manifest.json). The test corpus contains
25 of those 219 PRs and is published in
[`corpus/showcase/manifest.json`](../corpus/test/test.json). It is a
representative subset intended for small and test runs, not a separate
public/private partition.

For each PR we record:

- The PR URL and identifier.
- The base and head commits used for analysis (a stable snapshot).
  The head commit is the state of the code at the time review feedback
  would have been given — before any follow-up commits the author
  pushed in response to reviewer comments. This is the diff that
  candidate agents will review, and it is the diff against which golden
  findings are validated.
- The PR title and body.
- The set of human review comments associated with the PR.
- The commit history within the PR, including any commits that occurred
  after review comments were posted. These are recorded as evidence for
  finding extraction (Section 4.1) but are not part of the diff
  presented to candidate agents.

## 4. Finding Extraction and Generation

For each PR we assemble candidate findings from multiple producers. The
diversity of producers is essential: it reduces the bias of the labeled
corpus toward any one source and increases the chance that genuinely
useful observations are surfaced.

### 4.1 Extracted Findings

**Human review comments.** Each line- or range-anchored review comment
authored by a human reviewer is extracted as a finding. The comment text
becomes the finding's message; the file and line range come from the
comment anchor.

**Inferred author actions.** When a PR author makes a follow-up commit
that plausibly responds to a review observation — even one that was never
explicitly stated as a comment — we infer a finding describing the
underlying issue. Inference is conservative: the inferred message must be
supportable from the diff between the pre-change and post-change states,
and the location is anchored to the lines that were modified.

### 4.2 Generated Findings

**Deterministic tools.** Linters, type checkers, static analyzers, and
other deterministic tools are run against the PR's diff or the changed
files. Each rule violation that targets changed lines is emitted as a
finding.

**LLM review agents.** One or more LLM-based code review agents are run
against the PR. Each agent's output comments are emitted as findings,
preserving the agent's original line anchors and messages.

### 4.3 Normalization

Before labeling, all findings — regardless of producer — are normalized to
a common schema. This includes: collapsing multi-line messages into
single-message findings where appropriate, canonicalizing file paths
relative to the repository root, and clamping line ranges to the changed
hunks of the PR. Findings that fall entirely outside the diff are
discarded; findings that partially overlap the diff are retained with the
overlap recorded.

## 5. Labeling

### 5.1 What We Are Ultimately Trying to Predict

The benchmark labels findings as TP or FP, but the underlying question we
are trying to answer is empirical: *would a human reviewer or PR author
appreciate and act on this finding?* The TP/FP boundary, the severity
rubric, and the category taxonomy are all proxies for that question. They
exist because we cannot observe human reactions for every finding in the
corpus; we therefore codify the reactions we expect from a competent
senior reviewer and apply them at scale via a classifier. This framing has
two consequences that are made explicit throughout the rest of this
section:

1. The boundary between TP and FP is not fully objective. Findings that
   are factually correct but out of scope for a PR, or that target
   pre-existing code, or that fall below a project's review bar, may be
   judged either way depending on review culture. We address this by
   factoring the subjective dimensions out of the TP/FP decision and
   into auxiliary axes (severity, category, scope) that consumers of the
   benchmark can re-weight.
2. Offline metrics are an approximation of online behavior. Whether
   offline and online benchmarks converge depends on how faithfully the
   classifier reproduces the reactions of real humans on real PRs. This
   is a measurable property and is discussed in Section 8.

### 5.2 Human Guidelines

We treat the TP/FP distinction as a judgment call that must be made
explicit. A working group of senior engineers iteratively drafted a
guideline document that defines TP and FP both qualitatively and through
exact criteria. The guidelines cover, among other dimensions, the axes
listed below. Each axis is also recorded alongside the TP/FP label as an
auxiliary attribute, so that aggregate metrics can be stratified along
these axes in Section 7.

- **TP/FP** — the primary label. A finding is a TP if it is *true*
  (factually correct and verifiable against the changed code),
  *relevant* (a real concern that would improve the PR if addressed),
  and *within scope of the review* (the kind of observation that
  belongs in a code review on this PR at all). A finding is an FP
  otherwise. Note that "within scope of the review" is broader than
  the **Scope** axis below: a pre-existing issue can still be within
  scope of the review depending on review culture.
- **Severity** — the impact of the finding if left unaddressed, on a
  fixed ordinal scale of *high*, *medium*, or *low*. Severity is
  recorded for every finding, including FPs, so that aggregate metrics
  can be sliced by severity.
- **Category** — the kind of concern the finding raises, drawn from a
  fixed taxonomy. The taxonomy is intentionally coarse to keep the
  axes interpretable. The final taxonomy is still being finalized; as
  an illustrative example, candidate buckets include *correctness*
  (logic errors, bugs), *security*, *performance*, *reliability*
  (error handling, concurrency), *api / interface design*,
  *maintainability* (readability, naming, structure),
  *test quality / coverage*, *documentation*, *style / formatting*,
  and *dependency / build*. Each finding is assigned exactly one
  primary category; multi-category findings are split.
- **Scope** — is the issue introduced or materially affected by this
  PR, or is it pre-existing or unrelated? Recorded as one of
  *introduced-by-pr*, *exacerbated-by-pr*, *pre-existing*, or
  *unrelated*. Scope is informational: a finding can be a TP even if
  pre-existing, depending on review culture, and the scope label lets
  consumers of the benchmark filter accordingly.
- **Difficulty** — would a competent author reasonably be expected to
  notice and address the issue without external prompting?
- **Context required** — can the finding be verified from the PR diff
  alone, from the PR plus immediately related files, or only with
  broader project context?
- **Actionability** — is there a concrete change the author could make
  in response, and would making that change improve the PR?

The guidelines also enumerate common FP failure modes: incorrect claims,
unverifiable claims, off-scope observations whose scope is judged out of
bounds for the PR, duplicates, sub-threshold style nits, and advice that
would degrade the change.

### 5.3 Labeling Models

The guidelines are operationalized by one classifier based on Claude Sonnet
5. For each finding, the classifier ingests the finding and PR context (diff,
surrounding code, title, and body) and produces the TP/FP decision together
with severity, category, scope, difficulty, context required, and the other
auxiliary labels. The same classifier is used for corpus labeling and for
unmatched candidate findings during evaluation.

The classifier was hill-climbed against a development set of human-authored
findings that were independently labeled by senior engineers along TP/FP,
severity, category, scope, difficulty, context required, and other
dimensions. Hill-climbing iterated on the classifier prompt and decision
thresholds to maximize agreement with human labels on this development
set, with prompt changes evaluated against labeled examples not used to
motivate that iteration.

Classifier accuracy is reported alongside benchmark results, including
agreement on TP/FP, severity, and category against human labels. When the
classifier is recalibrated, affected labels and downstream metrics are
recomputed. All classifier prompts are published. The current
Claude Sonnet 5 classifier prompt is in
[`scripts/classifier/prompts.ts`](../scripts/classifier/prompts.ts).

### 5.4 Corpus Labeling

The ground-truth corpus was initially labeled by a classifier based on Claude
Sonnet 4.6. That classifier assigned TP/FP, severity, category, scope,
difficulty, context required, and the other auxiliary attributes in Section
5.2. Because Sonnet 4.6 was later deprecated, the classifier was updated to
Claude Sonnet 5 as described in Section 5.3.

The classifier output was not accepted as ground truth without review.
Humans audited the labels, investigated disagreements against the code and
PR context, and corrected the corpus where necessary. This process included
manually correcting 47 findings that the classifier had incorrectly labeled
as TPs.

The classifier evaluation and human audit produced the following results:

- **TP/FP: 96.6% agreement.** Every disagreement was hand-audited. In
  several cases, the human label was incorrect, such as when a reported bug
  was already prevented by an existing guard. Genuine classifier misses
  clustered into repeatable failure modes: overlooking an existing
  mitigation or accepting a finding whose factual premise did not hold up
  under inspection.
- **Severity: 98.7% within one level and 62.9% exact** on the three-point
  scale. The disagreements show that the golden set is conservative: humans
  rated an issue more severe roughly nine times as often as they rated it
  less severe.
- **Category: 79.7% exact.** Most residual disagreement occurred at the
  genuinely ambiguous boundary between correctness and reliability rather
  than as scattered noise. For example, engineers can reasonably disagree
  about whether a swallowed exception is a wrong-result bug or a
  fault-tolerance gap, so the disagreement is recorded rather than hidden.

Before the golden set is finalized, findings from different producers
that refer to the same underlying issue are deduplicated using the same
matching procedure described in Section 6.2. The surviving finding
retains the label; duplicates are discarded. This prevents the recall
denominator from being inflated by redundant findings across producers.

The resulting labeled and deduplicated set, per PR, is the **golden set**
for that PR. The human-reviewed labels are the ground-truth labels used for
scoring. Labels may subsequently be revised through human adjudication as
described in Section 11.

The golden set is not assumed to be exhaustive: there may be valid
findings on a PR that no producer surfaced. This is a known limitation
and motivates the augmented metrics defined in Section 7.

## 6. Evaluating a Candidate Agent

Given a candidate review agent, evaluation proceeds in three steps.

### 6.1 Generation

The candidate agent is run against each PR in the benchmark using the
same base and head commits recorded in Section 3.2. Its output is
collected as a set of candidate findings, normalized to the schema in
Section 4.3.

### 6.2 Matching

Each candidate finding is matched against the golden set for the same
PR to determine which candidate findings refer to the same underlying
issues as which golden findings. Matching is semantic: two findings
match if they describe the same underlying issue, even if their messages,
line ranges, or framing differ. Conversely, two findings at the exact
same location do not match if they describe different issues.

#### 6.2.1 Pair Generation

Candidate and golden findings are grouped by file path. Within each
file, every candidate finding is compared against every golden finding.
Findings in different files are never compared. When the number of
findings in a file is large, the candidate and golden lists are each
chunked into groups (e.g., 10 findings per chunk) and matching is
performed on the cross-product of chunks. Chunking is purely an
operational concern; it does not affect the matching semantics.

#### 6.2.2 LLM Matcher

Matching is performed by an LLM. For each pair group (a chunk of
candidate findings and a chunk of golden findings in the same file),
the matcher receives:

- The code snippet covering the locations of all findings in the group.
- Each candidate finding's file path, line range, and message, together
  with the code at that location.
- Each golden finding's file path, line range, and message, together
  with the code at that location.

The matcher is prompted to reason about each finding's underlying issue
and what a minimal fix would look like, then to decide which candidate
findings refer to the same underlying issue as which golden findings.
The output is a list of correspondences: for each candidate finding, a
(possibly empty) set of golden finding indices that it matches.

#### 6.2.3 Many-to-Many Matching

The matcher produces many-to-many correspondences: a single candidate
finding may match multiple golden findings (when the candidate describes
an issue that spans multiple golden findings), and multiple candidate
findings may match the same golden finding (when several candidate
findings describe the same issue from different angles or at different
levels of specificity). The raw match correspondences are preserved for
audit; deduplication for scoring purposes is described below.

#### 6.2.4 Deduplication for Scoring

The many-to-many correspondences are resolved into scoring inputs as
follows:

- **For recall:** a golden finding is *covered* if at least one
  candidate finding matches it. Multiple candidates matching the same
  golden finding do not inflate recall — the golden finding is counted
  once.
- **For precision:** the first candidate finding that matches a golden
  finding inherits that golden finding's label and is counted as
  matched ($M$). Additional candidate findings matching the same
  golden finding are reclassified as unmatched and proceed to
  Section 6.3 for independent classification. This prevents multiple
  candidates from claiming credit for the same golden TP while still
  letting the classifier assess whether the duplicate findings are
  independently valid.

When a candidate finding matches multiple golden findings, it inherits
the label of the first matched golden finding (by golden-set order) and
the remaining correspondences are recorded but do not affect scoring.

### 6.3 Classification of Unmatched Findings

Candidate findings that do not match any golden finding are classified
using the same Claude Sonnet 5 classifier described in Section 5.3. This
produces a TP/FP decision and the same auxiliary labels for each unmatched
candidate finding under the guidelines used to label the golden set.

## 7. Scoring

Let, for a single PR:

- $G$ = the set of golden findings.
- $G_{TP} \subseteq G$ = the golden findings labeled TP.
- $C$ = the set of candidate findings produced by the agent.
- $M \subseteq C$ = candidate findings that match some golden finding.
- $M_{TP} \subseteq M$ = matched candidate findings whose matched golden
  finding is in $G_{TP}$.
- $U = C \setminus M$ = unmatched candidate findings.
- $U_{TP} \subseteq U$ = unmatched candidate findings classified TP.
- $U_{FP} = U \setminus U_{TP}$.

We define four metrics. The first pair uses only golden-set labels; the
second pair augments with classifier labels on unmatched findings.

### 7.1 Grounded Precision and Recall

Grounded metrics use only the labels assigned during corpus construction.
Unmatched candidate findings are excluded from both numerator and
denominator. This isolates the agent's performance against findings the
methodology has independently labeled.

$$
\text{Grounded precision} = \frac{|M_{TP}|}{|M|}
\qquad
\text{Grounded recall} = \frac{|\{g \in G_{TP} : \exists c \in M \text{ matched to } g\}|}{|G_{TP}|}
$$

Grounded precision answers: of the candidate findings that the
methodology recognizes, what fraction correspond to known true
positives? Grounded recall answers: of the known true positives on this
PR, what fraction did the agent surface?

### 7.2 Augmented Precision and Recall

Augmented metrics additionally credit candidate findings that did not
match the golden set but were classified TP, and additionally penalize
candidate findings classified FP.

$$
\text{Augmented precision} = \frac{|M_{TP}| + |U_{TP}|}{|C|}
$$

$$
\text{Augmented recall} = \frac{|\{g \in G_{TP} : \exists c \in M \text{ matched to } g\}| + |U_{TP}|}{|G_{TP}| + |U_{TP}|}
$$

Augmented precision answers: across all findings the agent produced,
what fraction are useful (whether matched to the golden set or
independently judged useful)? Augmented recall augments the golden TPs
with newly-discovered TPs from the agent itself.

A known limitation of augmented recall is that the denominator,
$|G_{TP}| + |U_{TP}|$, is agent-dependent: each agent is measured against
a different yardstick because its own novel TPs expand the denominator.
An agent that produces many classifier-approved novel findings can
achieve high augmented recall even with poor grounded recall, because
$|U_{TP}|$ appears in both numerator and denominator. For example, with
$|G_{TP}| = 10$ and $m = 5$ matched golden TPs, an agent with
$|U_{TP}| = 2$ scores $7/12 \approx 0.58$, while an agent with
$|U_{TP}| = 100$ scores $105/110 \approx 0.95$ — despite identical
grounded performance.

Augmented recall should therefore not be used as the sole basis for
ranking agents against each other. Its value is as a per-agent diagnostic
that rewards discovery of novel issues and gives a fuller picture of an
agent's capability than grounded recall alone. When comparing agents,
grounded recall is the apples-to-apples metric; augmented recall and
novel TP count ($|U_{TP}|$) provide complementary signal about each
agent's ability to surface issues beyond the known corpus.

### 7.3 Stratified Reporting by Severity and Category

Because every finding carries a severity and a category, all four metrics
in Sections 7.1 and 7.2 can be reported on any subset of findings defined
by these axes. We report severity- and category-stratified metrics by
default, alongside the overall numbers, because aggregate scores can
hide important behavior. Two illustrative use cases:

- **A security-focused agent.** An agent that claims to surface all
  security-relevant issues regardless of severity should be evaluated on
  recall restricted to `category = security`, with severity strata
  reported separately. An agent that catches every *high*-severity
  security finding but misses *medium* and *low* security findings is
  making a different trade-off than one that is uniformly mediocre
  across severities, and stratified recall makes the difference visible.
- **A general-purpose agent that prioritizes high-impact findings.** An
  agent designed to surface only the most impactful issues and to
  suppress noise should be evaluated on recall stratified by severity.
  High recall on `severity = high` paired with deliberately low recall
  on `severity = low` is a feature, not a failure; an unstratified
  recall number would penalize this agent unfairly.

Concretely, for any subset $S$ of findings defined by severity, category,
or both, we recompute Sections 7.1 and 7.2 restricting $G$, $G_{TP}$, $C$,
$M$, $M_{TP}$, $U$, $U_{TP}$, and $U_{FP}$ to elements of $S$. Stratified
metrics use the same matching and classification outputs as the overall
metrics; only the bucketing changes.

Stratification by other axes recorded in Section 5.2 (scope, difficulty,
context required) is supported by the same mechanism and may be reported
on demand.

### 7.4 Interactive Filtering

Users can interactively filter and re-score results along three dimensions:

1. **Severity.** Use the ground-truth severity label when one is available.
   If a finding has no ground-truth severity, the benchmark classifier
   supplies the label.
2. **Category.** Restrict the results to one or more categories assigned in
   the ground truth or, when unavailable, by the benchmark classifier.
3. **Review preference.** Choose whether the score should prioritize
   precision or recall. This changes \(\beta\) in the \(F_\beta\) score:

   $$
   F_\beta = (1 + \beta^2)
   \frac{\text{precision} \cdot \text{recall}}
        {\beta^2 \cdot \text{precision} + \text{recall}}
   $$

   A precision-first preference uses \(\beta < 1\), while a recall-first
   preference uses \(\beta > 1\). The configured values are part of the
   scoring configuration.

When a user changes any severity, category, or review-preference filter, the
backend recomputes the applicable counts and metrics in real time from the
persisted finding, match, judgment, severity, and category data. The client
does not filter or reweight a previously aggregated leaderboard result.

### 7.5 Review Duration

Review latency is measured and reported as duration alongside the quality
metrics. For container-based evaluations, each PR's latency is the elapsed
wall-clock time around the agent's container invocation on the attempt that
succeeded, recorded in milliseconds as `review_ms`. It excludes earlier
failed attempts, retry overhead, repository preparation, and subsequent
matching, classification, and scoring.

For each round, duration is the arithmetic mean of the valid latency
measurements for successful PRs. The leaderboard reports the arithmetic
mean of those round means and their sample standard deviation across the
three rounds. Each round is weighted equally rather than pooling all PR
measurements across rounds.

For older runs without a valid `review_ms`, the reporting pipeline falls
back to `duration_seconds` converted to milliseconds; that legacy value
has whole-second precision and includes retries. Missing measurements
are excluded, not treated as zero. A round with no measurements has no
duration value, and the standard deviation is unavailable when fewer than
two round means are available.

Duration is reported alongside the quality metrics rather than incorporated
into the precision, recall, or \(F_\beta\) calculations.

### 7.6 Aggregation

Per-PR metrics are aggregated across the benchmark using both
macro-averaging (mean over PRs, treating each PR equally) and
micro-averaging (pool counts across PRs before computing the ratio).
Both are reported because they answer different questions: macro
captures behavior on the typical PR; micro captures behavior on the
typical finding.

### 7.7 Repeated Runs and Leaderboard Submission

Each candidate evaluation is run three times using the same benchmark,
configuration, classifier, and scoring procedure. Metrics are computed
independently for each run. The final score submitted to the leaderboard
is the arithmetic mean of the corresponding scores from the three runs.
The three component run scores are retained so the published average can
be audited and run-to-run variance can be inspected.

## 8. Threats to Validity

The methodology has several known limitations that consumers of the
benchmark should keep in mind.

**Golden set incompleteness.** The golden set is the union of findings
produced by a finite set of producers. Genuine TPs that no producer
surfaced are absent. Augmented recall partially mitigates this for any
given agent, but a systematic gap shared by all producers will remain
invisible.

**Classifier dependence.** Both the labels in the golden set and the labels
on unmatched candidate findings depend on a fixed Claude Sonnet 5 classifier.
Classifier errors propagate into both grounded and augmented
metrics. More fundamentally, the TP/FP boundary is partly subjective:
findings that are factually correct but out of scope, or that target
pre-existing code, or that fall below a project's review bar, can be
labeled either way depending on review culture. The classifier prompt encodes
*our* working group's taste; another team running this methodology could
configure the classifier differently and reach different scores for the same agents.
We mitigate this by (i) recording severity, category, and scope alongside
TP/FP so that consumers can re-stratify, (ii) versioning the classifier
configuration, and (iii) reporting the classifier's agreement with human
labels across TP/FP, severity, and category.

**Offline / online convergence.** What the methodology ultimately wants
to measure is whether a finding would be appreciated and acted on by a
real human on a real PR. Offline metrics use the classifier as a
surrogate for that human reaction. Whether offline and online benchmarks
converge is therefore an empirical question about how faithfully the
classifier reproduces human behavior, not a property of the methodology
itself. Where online signal is available (for example, comment reactions,
resolution rates, or follow-up-commit rates on agent-authored review
comments), it should be compared against offline TP/FP labels on a
matched sample, and any systematic divergence should be fed back into
the labeling guidelines and evaluation process.

**Matcher dependence.** Matching depends on an LLM matcher. A missed
match converts a grounded credit into an augmented credit (or, if the
classifier also fails, into a miss). A spurious match credits the agent
for a finding it did not actually surface. Matcher accuracy on a
labeled subset is reported alongside results.

**PR-level snapshot.** Each PR is evaluated at a fixed snapshot of base
and head commits. Findings whose validity depends on later commits
within the same PR will be evaluated against an earlier state of the
code. The selection process in Section 3.2 minimizes this by snapshotting
PRs after review feedback has stabilized.

**Producer bias.** Even with diverse producers, certain finding types
(for example, project-conventions violations specific to a single
repository) are easier to surface than others. Aggregate metrics should
be interpreted with the producer mix in mind.

## 9. Reproducibility

To reproduce a benchmark result, the following artifacts must be fixed
and recorded:

1. The list of PRs, including base and head commits.
2. The set of producers used to assemble the golden set, together with
   their versions and configurations.
3. The Claude Sonnet 5 classifier version, published prompt, and any
   thresholds.
4. The matcher version and published prompt.
5. The candidate agent version and configuration.
6. The severity label and provenance for each finding.
7. The aggregation choice (macro, micro, or both).
8. The three independent run results used to compute the leaderboard
   submission.

A benchmark run is fully described by these artifacts together with the
resulting per-PR finding sets, classifier labels, matches, and
metrics.

## 10. Extensions

The methodology admits several natural extensions.

**Per-producer ablations.** Recomputing the golden set with one producer
removed quantifies how much each producer contributes to the corpus and
how sensitive the metrics are to producer mix.

**Inter-rater agreement.** Periodically re-labeling a sample of the
golden set with fresh human reviewers yields an estimate of the ceiling
for both classifier and matcher accuracy.

**Cost-adjusted metrics.** Augmenting precision and recall with
per-finding cost (compute, latency, token usage of the candidate agent)
yields efficiency-aware leaderboards that better reflect production
trade-offs.

## 11. Feedback and Labeling Improvements

Because the TP/FP boundary encodes a working group's taste, the
labeling process benefits from continued external feedback. We expect to
operate a lightweight review process so that consumers of the benchmark
can flag labels they believe are inaccurate and feed those disputes back
into the guidelines and classifier calibration.

The intended loop is:

1. **Surface labels for inspection.** The public corpus is published
   alongside the benchmark with each finding's TP/FP label, severity,
   category, and the relevant PR context.
2. **Accept dispute submissions.** Reviewers can submit a dispute against
   any published finding: which axis they disagree with (TP/FP, severity,
   category, scope), what they believe the correct label is, and a short
   rationale. We do not require submissions to come from any privileged
   group; we do require that they cite the PR and finding identifier.
3. **Adjudicate.** Submissions are reviewed by the working group. A
   submission is *upheld* if the group agrees the original label is
   wrong, *partially upheld* if a different axis (often severity or
   category) needs to change, or *declined* with a written rationale
   that becomes part of the public guideline corpus. Adjudications are
   themselves published so that the basis for the labeling decisions is
   auditable.
4. **Feed back into the labeling process.** Upheld TP/FP disputes inform
   the human-authored guidelines and classifier evaluation.
   Upheld severity, category, and other auxiliary-label disputes are added
   to the classifier's calibration set. When the classifier is
   retrained, its version is bumped and affected labels and metrics are
   recomputed and republished.
5. **Track convergence.** We track the rate of upheld disputes per
   labeling-system version as a proxy for how well the process reflects the
   guidelines. A falling rate indicates the working group's taste is being
   reproduced reliably; a flat or rising rate is a signal to revisit
   the guidelines, classifier configuration, or classifier prompt.

The same loop applies to the matcher: disputes about whether a candidate
finding should have matched a particular golden finding are accepted
and fed back into matcher calibration.
