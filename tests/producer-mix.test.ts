import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProducerMix, producerMixTable } from "../scripts/lib/producer-mix.js";

const findings = [
  { tp_fp: "tp", severity: "high", producer: "a:model-1", source: { type: "a" } },
  { tp_fp: "tp", severity: "low", producer: "a:model-1", source: { type: "a" } },
  { tp_fp: "fp", severity: "medium", producer: "a:model-2", source: { type: "a" } },
  { tp_fp: "tp", severity: "medium", producer: "b:model-1", source: { type: "b" } },
  { tp_fp: "tp", severity: "medium", producer: null, source: null },
];

test("aggregates findings, TPs, and high+medium TPs by source type and producer", () => {
  const mix = aggregateProducerMix(findings);

  assert.equal(mix.findings, 5);
  assert.equal(mix.tps, 4);
  assert.equal(mix.highMediumTps, 3);
  assert.equal(mix.missingProducer, 1);
  assert.equal(mix.missingSourceType, 1);
  assert.deepEqual(mix.bySourceType, [
    { key: "a", findings: 3, tps: 2, highMediumTps: 1 },
    { key: "(unknown)", findings: 1, tps: 1, highMediumTps: 1 },
    { key: "b", findings: 1, tps: 1, highMediumTps: 1 },
  ]);
  assert.deepEqual(mix.byProducer, [
    { key: "a:model-1", findings: 2, tps: 2, highMediumTps: 1 },
    { key: "(unknown)", findings: 1, tps: 1, highMediumTps: 1 },
    { key: "b:model-1", findings: 1, tps: 1, highMediumTps: 1 },
    { key: "a:model-2", findings: 1, tps: 0, highMediumTps: 0 },
  ]);
});

test("renders rates and shares as a Markdown table", () => {
  const mix = aggregateProducerMix(findings);
  const lines = producerMixTable(mix, mix.bySourceType, "Source type").split("\n");

  assert.equal(lines[2], "| `a` | 3 | 2 | 66.7% | 50.0% | 33.3% |");
  assert.equal(lines.at(-1), "| **Total** | **5** | **4** | **80.0%** | **100.0%** | **100.0%** |");
});

test("empty input renders without dividing by zero", () => {
  const mix = aggregateProducerMix([]);
  assert.equal(producerMixTable(mix, mix.bySourceType, "Source type").split("\n").at(-1), "| **Total** | **0** | **0** | **-** | **-** | **-** |");
});
