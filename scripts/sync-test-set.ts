#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface TestEntry {
  repo: string;
  pr_number: number;
  head: string;
}

interface GoldenFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  tp_fp: "tp" | "fp";
  severity: "high" | "medium" | "low";
  category: string;
  scope: string;
  difficulty: string;
  context_required: string;
}

interface GoldenSet {
  pr_key: string;
  findings: GoldenFinding[];
}

interface TestFinding {
  file: string;
  start_line: number;
  end_line: number;
  severity: string;
  category: string;
  message: string;
  scope: string;
  difficulty: string;
  context_required: string;
}

interface TestStats {
  key: string;
  headingKey: string;
  findings: TestFinding[];
  severity: Record<"high" | "medium" | "low", number>;
  categories: string[];
}

const root = resolve(import.meta.dirname, "..");
const testManifestPath = resolve(root, "corpus/test/test.json");
const findingsPath = resolve(root, "corpus/test/findings.json");
const picksPath = resolve(root, "corpus/test/picks.md");
const readmePath = resolve(root, "README.md");
const checkOnly = process.argv.includes("--check");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function prKey(entry: TestEntry): string {
  const repo = entry.repo.replace("https://github.com/", "").replace("/", "_");
  return `${repo}_${entry.pr_number}-${entry.head.slice(0, 8)}`;
}

function headingKey(entry: TestEntry): string {
  return `${entry.repo.replace("https://github.com/", "")}#${entry.pr_number}`;
}

function exportFinding(finding: GoldenFinding): TestFinding {
  return {
    file: finding.file,
    start_line: finding.start_line,
    end_line: finding.end_line,
    severity: finding.severity,
    category: finding.category,
    message: finding.message,
    scope: finding.scope,
    difficulty: finding.difficulty,
    context_required: finding.context_required,
  };
}

function validateGoldenLabels(key: string, golden: GoldenSet): void {
  golden.findings.forEach((finding, index) => {
    if (finding.tp_fp !== "tp" && finding.tp_fp !== "fp") {
      throw new Error(
        `${key}: finding ${index + 1} has invalid tp_fp ${JSON.stringify(finding.tp_fp)}`,
      );
    }
    if (
      finding.severity !== "high" &&
      finding.severity !== "medium" &&
      finding.severity !== "low"
    ) {
      throw new Error(
        `${key}: finding ${index + 1} has invalid severity ${JSON.stringify(finding.severity)}`,
      );
    }
  });
}

function loadStats(): TestStats[] {
  const entries = readJson<TestEntry[]>(testManifestPath);
  return entries.map((entry) => {
    const key = prKey(entry);
    const golden = readJson<GoldenSet>(resolve(root, "golden", `${key}.json`));
    if (golden.pr_key !== key) {
      throw new Error(`${key}: golden pr_key is ${golden.pr_key}`);
    }
    validateGoldenLabels(key, golden);

    const findings = golden.findings
      .filter((finding) => finding.tp_fp === "tp")
      .map(exportFinding);
    if (findings.length === 0) {
      throw new Error(`${key}: test-set PR has no canonical TP findings`);
    }

    const severity = {
      high: findings.filter((finding) => finding.severity === "high").length,
      medium: findings.filter((finding) => finding.severity === "medium").length,
      low: findings.filter((finding) => finding.severity === "low").length,
    };
    if (severity.high === 0 && severity.medium === 0) {
      throw new Error(`${key}: Tier B PR has no medium canonical TP findings`);
    }

    return {
      key,
      headingKey: headingKey(entry),
      findings,
      severity,
      categories: [...new Set(findings.map((finding) => finding.category))].sort(),
    };
  });
}

function renderFindings(stats: TestStats[]): string {
  return `${JSON.stringify(
    Object.fromEntries(stats.map((entry) => [entry.key, entry.findings])),
    null,
    2,
  )}\n`;
}

function replaceRequired(
  text: string,
  pattern: RegExp,
  replacement: string,
  description: string,
): string {
  if (!pattern.test(text)) {
    throw new Error(`Could not update ${description}`);
  }
  return text.replace(pattern, replacement);
}

function updateReadme(readme: string, stats: TestStats[]): string {
  const totals = totalSeverity(stats);
  const total = totals.high + totals.medium + totals.low;
  const percent = (count: number) => `${((count / total) * 100).toFixed(1)}%`;
  const severityTable = [
    "| Severity | Findings | Share |",
    "|---|---:|---:|",
    `| High | ${totals.high} | ${percent(totals.high)} |`,
    `| Medium | ${totals.medium} | ${percent(totals.medium)} |`,
    `| Low | ${totals.low} | ${percent(totals.low)} |`,
    `| **Total** | **${total}** | **100%** |`,
  ].join("\n");

  const withSeverity = replaceRequired(
    readme,
    /\| Severity \| Findings \| Share \|\r?\n\|---\|---:\|---:\|\r?\n\| High \|.*?\r?\n\| Medium \|.*?\r?\n\| Low \|.*?\r?\n\| \*\*Total\*\* \|.*?$/m,
    severityTable,
    "README finding severity table",
  );

  const categoryLabels = new Map([
    ["correctness", "Correctness"],
    ["reliability", "Reliability"],
    ["maintainability", "Maintainability"],
    ["testing", "Testing"],
    ["security", "Security"],
    ["documentation", "Documentation"],
    ["performance", "Performance"],
    ["api-architecture", "API architecture"],
    ["accessibility", "Accessibility"],
  ]);
  const counts = new Map<string, number>();
  for (const entry of stats) {
    for (const finding of entry.findings) {
      counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
    }
  }
  const unexpected = [...counts.keys()].filter((category) => !categoryLabels.has(category));
  if (unexpected.length > 0) {
    throw new Error(`README category labels missing for: ${unexpected.join(", ")}`);
  }
  const categoryCells = [...categoryLabels]
    .filter(([category]) => counts.has(category))
    .map(([category, label]) => [label, counts.get(category)!] as const);
  const categoryRows: string[] = [];
  for (let index = 0; index < categoryCells.length; index += 2) {
    const left = categoryCells[index];
    const right = categoryCells[index + 1];
    categoryRows.push(
      `| ${left[0]} | ${left[1]} | ${right?.[0] ?? ""} | ${right?.[1] ?? ""} |`,
    );
  }
  const categoryTable = [
    "| Category | Findings | Category | Findings |",
    "|---|---:|---|---:|",
    ...categoryRows,
  ].join("\n");

  return replaceRequired(
    withSeverity,
    /\| Category \| Findings \| Category \| Findings \|\r?\n\|---\|---:\|---\|---:\|(?:\r?\n\|.*\|)+/,
    categoryTable,
    "README finding category table",
  );
}

function totalSeverity(stats: TestStats[]) {
  return stats.reduce(
    (total, entry) => ({
      high: total.high + entry.severity.high,
      medium: total.medium + entry.severity.medium,
      low: total.low + entry.severity.low,
    }),
    { high: 0, medium: 0, low: 0 },
  );
}

function categoryCounts(stats: TestStats[]): string {
  const preferredOrder = [
    "correctness",
    "reliability",
    "maintainability",
    "testing",
    "documentation",
    "api-architecture",
    "security",
    "performance",
    "accessibility",
  ];
  const counts = new Map<string, number>();
  for (const entry of stats) {
    for (const category of entry.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([leftCategory, leftCount], [rightCategory, rightCount]) =>
      rightCount - leftCount ||
      preferredOrder.indexOf(leftCategory) - preferredOrder.indexOf(rightCategory) ||
      leftCategory.localeCompare(rightCategory))
    .map(([category, count]) => `${category} (${count})`)
    .join(", ");
}

function updateBlock(block: string, stat: TestStats): string {
  const total = stat.findings.length;
  const summary =
    `- **TP findings**: ${total} ` +
    `(high:${stat.severity.high} med:${stat.severity.medium} low:${stat.severity.low}) ` +
    `— categories: ${stat.categories.join(",")}`;
  return replaceRequired(
    block,
    /^- \*\*TP findings\*\*:.*$/m,
    summary,
    `${stat.headingKey} finding summary`,
  ).trim();
}

function updatePicks(picks: string, stats: TestStats[]): string {
  const picksIndex = picks.indexOf("## Picks");
  if (picksIndex < 0) throw new Error("Could not find picks section");

  let preamble = picks.slice(0, picksIndex);
  const picksBody = picks
    .slice(picksIndex)
    .replace(/^### Tier .*$(?:\r?\n)?/gm, "");
  const blocks = [...picksBody.matchAll(/^#### \[([^\]]+)\].*$(?:\r?\n(?!#### ).*)*/gm)];
  const blockByHeading = new Map(blocks.map((match) => [match[1], match[0]]));
  if (blockByHeading.size !== stats.length) {
    throw new Error(`Expected ${stats.length} pick blocks, found ${blockByHeading.size}`);
  }

  const highCount = stats.filter((entry) => entry.severity.high > 0).length;
  const securityCount = stats.filter((entry) => entry.categories.includes("security")).length;
  preamble = replaceRequired(
    preamble,
    /- \*\*PRs with ≥1 high TP finding\*\*: \d+/,
    `- **PRs with ≥1 high TP finding**: ${highCount}`,
    "high-severity PR count",
  );
  preamble = replaceRequired(
    preamble,
    /- \*\*PRs with ≥1 security TP finding\*\*: \d+/,
    `- **PRs with ≥1 security TP finding**: ${securityCount}`,
    "security PR count",
  );
  preamble = replaceRequired(
    preamble,
    /\*\*Finding categories represented\*\* \(PR count\):.*$/m,
    `**Finding categories represented** (PR count): ${categoryCounts(stats)}`,
    "category counts",
  );

  const renderTier = (entries: TestStats[]) =>
    entries.map((entry) => {
      const block = blockByHeading.get(entry.headingKey);
      if (!block) throw new Error(`Missing picks block for ${entry.headingKey}`);
      return updateBlock(block, entry);
    }).join("\n\n");

  const high = stats.filter((entry) => entry.severity.high > 0);
  const remaining = stats.filter((entry) => entry.severity.high === 0);
  return [
    preamble.trimEnd(),
    "",
    "## Picks",
    "",
    `### Tier A — ≥1 high TP finding (${high.length})`,
    "",
    renderTier(high),
    "",
    `### Tier B — medium TP finding (no high) (${remaining.length})`,
    "",
    renderTier(remaining),
    "",
  ].join("\n");
}

function checkOrWrite(path: string, expected: string): boolean {
  const current = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (current === expected) return false;
  if (checkOnly) {
    console.error(`${relative(root, path)} is out of sync`);
    return true;
  }
  writeFileSync(path, expected);
  console.log(`Updated ${relative(root, path)}`);
  return true;
}

const stats = loadStats();
const changed = [
  checkOrWrite(findingsPath, renderFindings(stats)),
  checkOrWrite(readmePath, updateReadme(readFileSync(readmePath, "utf8"), stats).replace(/\r\n/g, "\n")),
  checkOrWrite(picksPath, updatePicks(readFileSync(picksPath, "utf8"), stats).replace(/\r\n/g, "\n")),
].some(Boolean);

if (checkOnly && changed) {
  console.error("Run `npm run sync:test-set` and commit the regenerated files.");
  process.exit(1);
}

const totals = totalSeverity(stats);
console.log(
  `Test set aligned: ${stats.length} PRs, ` +
  `${totals.high + totals.medium + totals.low} TPs ` +
  `(${totals.high} high / ${totals.medium} medium / ${totals.low} low).`,
);
