import assert from "node:assert/strict";
import test from "node:test";

import { checkpointFingerprint } from "../scripts/eval/checkpoint-fingerprint.js";
import {
  excludeGoldenProducers,
  isExcludedProducer,
  normalizeProducerPrefixes,
} from "../scripts/eval/exclude-producers.js";
import { scorePR } from "../scripts/eval/scorer.js";
import { dedup, type GoldenEntry, type GoldenSet } from "../scripts/golden/pipeline.js";
import { resolveForScoring } from "../scripts/lib/match-types.js";

function entry(producer: string, message: string, tp_fp: "tp" | "fp" = "tp"): GoldenEntry {
  return {
    file: "src/app.ts",
    start_line: 1,
    end_line: 1,
    message,
    tp_fp,
    severity: "high",
    category: "correctness",
    producer,
  };
}

const golden: GoldenSet = {
  pr_key: "owner_repo_1-abcdef12",
  pr: { repo: "https://github.com/owner/repo", pr_number: 1, base: "base", head: "abcdef123456" },
  findings: [
    entry("ccr:model-a", "excluded 0"),
    entry("llm_review:model-b", "kept 0"),
    entry("ccr:model-c", "excluded 1"),
    entry("human_review", "kept 1", "fp"),
  ],
};

test("normalizeProducerPrefixes sorts, de-duplicates, and rejects empty prefixes", () => {
  assert.deepEqual(normalizeProducerPrefixes(["llm_review:", "ccr:", "ccr:"]), ["ccr:", "llm_review:"]);
  assert.deepEqual(normalizeProducerPrefixes([]), []);
  assert.throws(() => normalizeProducerPrefixes([""]), /non-empty/);
  assert.throws(() => normalizeProducerPrefixes(["  "]), /non-empty/);
});

test("isExcludedProducer matches producer prefixes only", () => {
  assert.equal(isExcludedProducer("ccr:model-a", ["ccr:"]), true);
  assert.equal(isExcludedProducer("ccr:model-a", ["ccr:model-a"]), true);
  assert.equal(isExcludedProducer("llm_review:ccr", ["ccr:"]), false);
  assert.equal(isExcludedProducer(undefined, ["ccr:"]), false);
  assert.equal(isExcludedProducer(null, ["ccr:"]), false);
});

test("excludeGoldenProducers removes matching findings without mutating the input", () => {
  const result = excludeGoldenProducers(golden, ["ccr:"]);
  assert.equal(result.excluded, 2);
  assert.deepEqual(result.golden.findings.map((f) => f.message), ["kept 0", "kept 1"]);
  assert.equal(result.golden.pr, golden.pr);
  assert.equal(golden.findings.length, 4);

  const unchanged = excludeGoldenProducers(golden, []);
  assert.equal(unchanged.golden, golden);
  assert.equal(unchanged.excluded, 0);
});

test("matcher and scorer indices refer to the filtered golden list", () => {
  const filtered = excludeGoldenProducers(golden, ["ccr:"]).golden;
  const scoring = resolveForScoring(
    [
      { candidate_index: 0, matched_golden_indices: [0] },
      { candidate_index: 1, matched_golden_indices: [1] },
      { candidate_index: 2, matched_golden_indices: [2] },
    ],
    filtered.findings.length,
  );
  assert.equal(filtered.findings[scoring.matchedToGolden.get(0)!].message, "kept 0");
  assert.equal(filtered.findings[scoring.matchedToGolden.get(1)!].message, "kept 1");
  assert.ok(scoring.unmatched.has(2), "an index past the filtered list is not a match");

  const result = scorePR({
    pr_key: filtered.pr_key,
    golden: filtered.findings,
    candidate_count: 3,
    matched: scoring.matchedToGolden,
    unmatched: scoring.unmatched,
    covered_golden: scoring.coveredGolden,
    unmatched_classifications: new Map([[2, { ...entry("candidate", "novel"), tp_fp: "tp" as const }]]),
  });
  assert.equal(result.metrics.overall.golden_tp_count, 1);
  assert.equal(result.metrics.overall.grounded_recall, 1);
  assert.equal(result.metrics.overall.matched_tp_count, 1);
  assert.equal(result.metrics.overall.matched_count, 2);
});

test("a golden set emptied by exclusion treats every candidate as unmatched", async () => {
  const onlyCcr: GoldenSet = { ...golden, findings: golden.findings.filter((f) => f.producer.startsWith("ccr:")) };
  const filtered = excludeGoldenProducers(onlyCcr, ["ccr:"]).golden;
  assert.equal(filtered.findings.length, 0);

  const candidate = { ...entry("candidate", "excluded 0"), source: { type: "candidate", alignment: "generated" } };
  const pipeline = await dedup([candidate], filtered);
  const scoring = resolveForScoring(pipeline.correspondences, filtered.findings.length);
  assert.deepEqual([...scoring.unmatched], [0]);

  const result = scorePR({
    pr_key: filtered.pr_key,
    golden: filtered.findings,
    candidate_count: 1,
    matched: scoring.matchedToGolden,
    unmatched: scoring.unmatched,
    covered_golden: scoring.coveredGolden,
    unmatched_classifications: new Map([[0, { ...entry("candidate", "novel"), tp_fp: "tp" as const }]]),
  });
  assert.equal(result.metrics.overall.golden_tp_count, 0);
  assert.equal(result.metrics.overall.grounded_recall, null);
  assert.equal(result.metrics.overall.augmented_precision, 1);
});

test("checkpoint fingerprint changes with producer exclusions and is unchanged without them", () => {
  const base = {
    provider: "provider-a",
    modelId: "model-a",
    classifierPrompt: "classifier",
    matcherPrompt: "matcher",
    prKeys: [golden.pr_key],
    candidates: [{ findings: [] }],
    goldenSets: [golden],
    manifestEntries: [{ title: "Title", body: "Body" }],
  };
  const fingerprint = checkpointFingerprint(base);
  assert.equal(checkpointFingerprint({ ...base, excludedProducers: [] }), fingerprint);

  const excluded = checkpointFingerprint({ ...base, excludedProducers: ["ccr:"] });
  assert.notEqual(excluded, fingerprint);
  assert.notEqual(checkpointFingerprint({ ...base, excludedProducers: ["llm_review:"] }), excluded);
  assert.equal(checkpointFingerprint({ ...base, excludedProducers: ["b", "a"] }), checkpointFingerprint({ ...base, excludedProducers: ["a", "b"] }));
});
