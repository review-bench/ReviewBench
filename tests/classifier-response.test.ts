import assert from "node:assert/strict";
import test from "node:test";

import { containsJson, parseClassifierResponse } from "../scripts/classifier/classify.js";

const validResponse = {
  tp_fp: "tp",
  tp_fp_justification: "The finding is valid.",
  severity: "medium",
  category: "correctness",
  scope: "introduced-by-pr",
  difficulty: "medium",
  context_required: "diff-only",
};

test("classifier response accepts omitted severity and category justifications", () => {
  const result = parseClassifierResponse(JSON.stringify(validResponse), "finding-0");

  assert.equal(result.severity, "medium");
  assert.equal(result.category, "correctness");
  assert.equal(result.severity_justification, undefined);
  assert.equal(result.category_justification, undefined);
});

test("classifier response preserves supplied severity and category justifications", () => {
  const result = parseClassifierResponse(JSON.stringify({
    ...validResponse,
    severity_justification: "Material but localized impact.",
    category_justification: "The defect changes runtime behavior.",
  }), "finding-0");

  assert.equal(result.severity_justification, "Material but localized impact.");
  assert.equal(result.category_justification, "The defect changes runtime behavior.");
});

test("classifier response still rejects a missing scoring label", () => {
  const { category: _category, ...missingCategory } = validResponse;

  assert.throws(
    () => parseClassifierResponse(JSON.stringify(missingCategory), "finding-0"),
    /Missing required field "category"/,
  );
});

test("classifier response reads JavaScript-style escapes such as \\` as the character", () => {
  // review-bench/ReviewBench#73: a judge escaped the backticks of a template literal in its justification.
  const justification = "router.tsx looks up `document.getElementById(`field-${name}`)`, so the deep link silently does nothing.";
  const raw = JSON.stringify({ ...validResponse, tp_fp_justification: justification }).replaceAll("`", "\\`");
  assert.throws(() => JSON.parse(raw), /Bad escaped character/);
  for (const response of [raw, `Reasoning first.\n${raw}\nDone.`]) {
    assert.equal(parseClassifierResponse(response, "finding-8").tp_fp_justification, justification);
  }
});

test("classifier response keeps valid escapes next to an invalid one, and still rejects JSON broken otherwise", () => {
  // Raw JSON text for the justification: an escaped backslash, quotes, \u, \n, \t and \/, plus the invalid \$.
  const raw = JSON.stringify({ ...validResponse, tp_fp_justification: "PLACEHOLDER" }).replace('"PLACEHOLDER"', String.raw`"a\\b \"q\" \u00e9\n\t \$x \/"`);
  assert.equal(parseClassifierResponse(raw, "finding-0").tp_fp_justification, 'a\\b "q" é\n\t $x /');

  assert.throws(
    () => parseClassifierResponse(`{"tp_fp": "tp", "tp_fp_justification": "\\\` unterminated}`, "finding-0"),
    /Failed to parse classifier response as JSON for comment finding-0/,
  );
});

test("a first answer with JavaScript-style escapes counts as JSON, so it doesn't use the judge's one retry", () => {
  // classifyPR retries only when containsJson rejects the first answer; in #73 that retry repeated the escape.
  const raw = JSON.stringify({ ...validResponse, tp_fp_justification: "looks up `document.getElementById(`field-${name}`)`" }).replaceAll("`", "\\`");
  for (const response of [raw, `Reasoning first.\n${raw}\nDone.`]) assert.equal(containsJson(response), true);
  for (const response of ["No JSON here.", '{"severity": "low"}', '{"tp_fp": "tp", "tp_fp_justification": "\\` unterminated}']) assert.equal(containsJson(response), false, response);
});
