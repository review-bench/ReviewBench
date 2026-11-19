import assert from "node:assert/strict";
import test from "node:test";

import { parseMatcherResponse } from "../scripts/eval/matcher.js";

test("matcher rejects unparsable responses instead of fabricating no matches", () => {
  assert.throws(
    () => parseMatcherResponse("I could not produce JSON.", 1, 1),
    /invalid JSON response/,
  );
});

test("matcher rejects incomplete responses", () => {
  assert.throws(
    () => parseMatcherResponse(
      JSON.stringify({
        candidateFindings: [{ index: 0, matchedGoldenIndices: [] }],
      }),
      2,
      1,
    ),
    /omitted candidate findings/,
  );
});

test("matcher accepts one valid entry per candidate", () => {
  assert.deepEqual(
    parseMatcherResponse(
      JSON.stringify({
        candidateFindings: [
          { index: 1, matchedGoldenIndices: [] },
          { index: 0, matchedGoldenIndices: [0] },
        ],
      }),
      2,
      1,
    ),
    [
      { candidate_index: 0, matched_golden_indices: [0] },
      { candidate_index: 1, matched_golden_indices: [] },
    ],
  );
});

test("a matcher answer with JavaScript-style escapes such as \\` keeps its matches", () => {
  // review-bench/ReviewBench#73: a judge escaped the backticks of a template literal, and JSON rejects \`.
  const answer = JSON.stringify({
    reasoning: "Both flag `document.getElementById(`field-${name}`)` returning null.",
    candidateFindings: [{ index: 0, matchedGoldenIndices: [1] }, { index: 1, matchedGoldenIndices: [] }],
  }).replaceAll("`", "\\`");
  assert.throws(() => JSON.parse(answer), /Bad escaped character/);
  for (const response of [answer, `Here is the mapping:\n${answer}`]) {
    assert.deepEqual(
      parseMatcherResponse(response, 2, 2).map((c) => c.matched_golden_indices),
      [[1], []],
    );
  }
});

test("only backslashes inside strings are repaired, so malformed indices like [1\\0] are still rejected", () => {
  // Removing that backslash would read [1\0] as [10], a real index once there are 11 golden findings.
  const answer = '{"reasoning": "close \\` call", "candidateFindings": [{"index": 0, "matchedGoldenIndices": [1\\0]}]}';
  assert.throws(() => parseMatcherResponse(answer, 1, 11), /invalid JSON response/);
});
