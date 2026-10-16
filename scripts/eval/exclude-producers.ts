import type { GoldenSet } from "../golden/pipeline.js";

/**
 * Sorted, de-duplicated prefixes. Throws on an empty prefix, which would
 * exclude every finding, and on an option-shaped one, which means the value
 * was missing and the parser consumed the next flag.
 */
export function normalizeProducerPrefixes(prefixes: readonly string[]): string[] {
  for (const prefix of prefixes) {
    if (!prefix || !prefix.trim()) {
      throw new Error("--exclude-producer requires a non-empty producer prefix");
    }
    if (prefix.startsWith("-")) {
      throw new Error(`--exclude-producer requires a producer prefix, got the option ${prefix}`);
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

/**
 * The golden file content to hash: the file as loaded unless an exclusion
 * actually removed a finding, so a no-op exclusion keeps the unfiltered hash.
 */
export function goldenHashText(raw: string, filtered: { golden: GoldenSet; excluded: number } | null): string {
  return filtered && filtered.excluded > 0 ? JSON.stringify(filtered.golden) : raw;
}
