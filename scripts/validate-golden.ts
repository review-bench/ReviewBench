#!/usr/bin/env npx tsx

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface GoldenFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
}

interface GoldenSet {
  findings: GoldenFinding[];
}

const root = resolve(import.meta.dirname, "..");
const goldenDir = resolve(root, "golden");
const errors: string[] = [];

for (const file of readdirSync(goldenDir).filter((name) => name.endsWith(".json")).sort()) {
  const golden = JSON.parse(
    readFileSync(resolve(goldenDir, file), "utf8"),
  ) as GoldenSet;
  const seen = new Map<string, number>();

  golden.findings.forEach((finding, index) => {
    const identity = JSON.stringify([
      finding.file,
      finding.start_line,
      finding.end_line,
      finding.message,
    ]);
    const firstIndex = seen.get(identity);
    if (firstIndex !== undefined) {
      errors.push(
        `${file}: findings ${firstIndex + 1} and ${index + 1} have the same file, range, and message`,
      );
      return;
    }
    seen.set(identity, index);
  });
}

if (errors.length > 0) {
  console.error("Golden validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Golden validation passed: no exact duplicate finding identities.");
