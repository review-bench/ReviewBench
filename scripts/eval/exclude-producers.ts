import type { GoldenSet } from "../golden/pipeline.js";

/** Sorted, de-duplicated prefixes; throws on an empty prefix, which would exclude every finding. */
export function normalizeProducerPrefixes(prefixes: readonly string[]): string[] {
  for (const prefix of prefixes) {
    if (!prefix || !prefix.trim()) {
      throw new Error("--exclude-producer requires a non-empty producer prefix");
    }
  }
  return [...new Set(prefixes)].sort();
}

export function isExcludedProducer(producer: unknown, prefixes: readonly string[]): boolean {
  return typeof producer === "string" && prefixes.some((prefix) => producer.startsWith(prefix));
}

/**
 * Drops golden findings whose producer starts with any prefix. Indices into the
 * returned findings array are the indices every later stage (matcher, scorer,
 * details output) uses.
 */
export function excludeGoldenProducers(
  golden: GoldenSet,
  prefixes: readonly string[],
): { golden: GoldenSet; excluded: number } {
  if (prefixes.length === 0 || !Array.isArray(golden.findings)) return { golden, excluded: 0 };
  const findings = golden.findings.filter((finding) => !isExcludedProducer(finding.producer, prefixes));
  return {
    golden: { ...golden, findings },
    excluded: golden.findings.length - findings.length,
  };
}
