import { createHash } from "crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function checkpointFingerprint(args: {
  provider: string;
  modelId: string;
  classifierPrompt: string;
  matcherPrompt: string;
  prKeys: string[];
  candidates: unknown[];
  goldenSets: unknown[];
  manifestEntries: unknown[];
  excludedProducers?: readonly string[];
}): string {
  const parts = [
    `${args.provider}/${args.modelId}`,
    hash(args.classifierPrompt),
    hash(args.matcherPrompt),
    hash({
      pr_keys: args.prKeys,
      candidates: args.candidates,
      golden_sets: args.goldenSets,
      manifest_entries: args.manifestEntries,
    }),
  ];
  // Only appended when set, so fingerprints of runs without exclusions are unchanged.
  if (args.excludedProducers?.length) {
    parts.push(`exclude-producer=${hash([...args.excludedProducers].sort())}`);
  }
  return parts.join("|");
}
