export interface ProducerMixFinding {
  tp_fp?: string | null;
  severity?: string | null;
  producer?: string | null;
  source?: { type?: string | null } | null;
}

export interface ProducerMixRow {
  key: string;
  findings: number;
  tps: number;
  highMediumTps: number;
}

export interface ProducerMix {
  findings: number;
  tps: number;
  highMediumTps: number;
  missingProducer: number;
  missingSourceType: number;
  bySourceType: ProducerMixRow[];
  byProducer: ProducerMixRow[];
}

export const UNKNOWN_KEY = "(unknown)";

function addTo(rows: Map<string, ProducerMixRow>, key: string, tp: boolean, highMedium: boolean): void {
  let row = rows.get(key);
  if (!row) {
    row = { key, findings: 0, tps: 0, highMediumTps: 0 };
    rows.set(key, row);
  }
  row.findings += 1;
  if (tp) row.tps += 1;
  if (tp && highMedium) row.highMediumTps += 1;
}

function sortRows(rows: Map<string, ProducerMixRow>): ProducerMixRow[] {
  return [...rows.values()].sort((a, b) => b.tps - a.tps || b.findings - a.findings || a.key.localeCompare(b.key));
}

export function aggregateProducerMix(findings: Iterable<ProducerMixFinding>): ProducerMix {
  const bySourceType = new Map<string, ProducerMixRow>();
  const byProducer = new Map<string, ProducerMixRow>();
  const mix = { findings: 0, tps: 0, highMediumTps: 0, missingProducer: 0, missingSourceType: 0 };

  for (const finding of findings) {
    const tp = finding.tp_fp === "tp";
    const highMedium = finding.severity === "high" || finding.severity === "medium";
    const producer = finding.producer || null;
    const sourceType = finding.source?.type || null;

    mix.findings += 1;
    if (tp) mix.tps += 1;
    if (tp && highMedium) mix.highMediumTps += 1;
    if (!producer) mix.missingProducer += 1;
    if (!sourceType) mix.missingSourceType += 1;

    addTo(bySourceType, sourceType ?? UNKNOWN_KEY, tp, highMedium);
    addTo(byProducer, producer ?? UNKNOWN_KEY, tp, highMedium);
  }

  return { ...mix, bySourceType: sortRows(bySourceType), byProducer: sortRows(byProducer) };
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? "-" : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function producerMixTable(mix: ProducerMix, rows: ProducerMixRow[], label: string): string {
  const lines = [
    `| ${label} | Findings | TPs | TP rate | Share of TPs | Share of high+medium TPs |`,
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.key}\` | ${row.findings} | ${row.tps} | ${percent(row.tps, row.findings)} | ${percent(row.tps, mix.tps)} | ${percent(row.highMediumTps, mix.highMediumTps)} |`,
    );
  }
  lines.push(
    `| **Total** | **${mix.findings}** | **${mix.tps}** | **${percent(mix.tps, mix.findings)}** | **${percent(mix.tps, mix.tps)}** | **${percent(mix.highMediumTps, mix.highMediumTps)}** |`,
  );
  return lines.join("\n");
}
