#!/usr/bin/env npx tsx

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  aggregateProducerMix,
  producerMixTable,
  type ProducerMixFinding,
} from "./lib/producer-mix.js";
import { prKey } from "./lib/types.js";

interface GoldenSet {
  pr_key: string;
  findings: ProducerMixFinding[];
}

interface TestEntry {
  repo: string;
  pr_number: number;
  head: string;
}

const root = resolve(import.meta.dirname, "..");
const goldenDir = resolve(root, "golden");
const testManifestPath = resolve(root, "corpus/test/test.json");

const goldenSets = readdirSync(goldenDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(resolve(goldenDir, name), "utf8")) as GoldenSet);

const testKeys = new Set(
  (JSON.parse(readFileSync(testManifestPath, "utf8")) as TestEntry[]).map(prKey),
);
const testSets = goldenSets.filter((golden) => testKeys.has(golden.pr_key));
if (testSets.length !== testKeys.size) {
  console.error(`Expected ${testKeys.size} test set golden files, found ${testSets.length}.`);
  process.exit(1);
}

function section(title: string, sets: GoldenSet[]): string {
  const mix = aggregateProducerMix(sets.flatMap((golden) => golden.findings));
  return [
    `**${title} (${sets.length} PRs)**`,
    "",
    producerMixTable(mix, mix.bySourceType, "Source type"),
    "",
    producerMixTable(mix, mix.byProducer, "Producer"),
    "",
    `Findings without a producer: ${mix.missingProducer}. Findings without a source type: ${mix.missingSourceType}.`,
  ].join("\n");
}

console.log(
  [section("Full set", goldenSets), "", section("Test set", testSets)].join("\n"),
);
