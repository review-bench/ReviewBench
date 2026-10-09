import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ManifestEntry } from "../lib/types.js";
import { validateCandidate } from "./verify.js";

export function validateFindings(candidate: string, prFile: string): void {
  const pr: ManifestEntry = JSON.parse(readFileSync(prFile, "utf8"));
  if (typeof pr.repo !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(pr.repo) ||
      !Number.isSafeInteger(pr.pr_number) || pr.pr_number < 1 ||
      typeof pr.base !== "string" || !/^[a-f0-9]{40}$/.test(pr.base) ||
      typeof pr.head !== "string" || !/^[a-f0-9]{40}$/.test(pr.head)) {
    throw new Error("PR metadata must contain the frozen repo, PR number, base SHA, and head SHA");
  }
  validateCandidate(candidate, pr);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      candidate: { type: "string" }, pr: { type: "string" },
    } });
    if (!values.candidate || !values.pr) throw new Error("--candidate and --pr are required");
    validateFindings(values.candidate, values.pr);
    console.log("Findings format and frozen PR identity are valid. No judging or inference performed.");
  } catch (error) {
    console.error("Findings validation failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
