/**
 * LLM-based finding matcher.
 *
 * Compares candidate findings against golden findings to determine
 * which refer to the same underlying issue. Implements METHODOLOGY.md §6.2.
 *
 * Key design:
 * - File-scoped: only compares findings in the same file
 * - Chunked: groups of up to CHUNK_SIZE findings compared at a time
 * - Many-to-many: a candidate can match multiple golden findings and vice versa
 * - Uses pi SDK for LLM access
 */

import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "path";

import type { Finding } from "../lib/types.js";
import type { RawCorrespondence } from "../lib/match-types.js";
import {
  renderMatcherFinding,
  renderJudgeSystemPrompt,
} from "./prompt-format.js";

const CHUNK_SIZE = 10;

export const MATCHER_SYSTEM_PROMPT = `You evaluate whether two sets of code review findings are about the same underlying issues.

All findings are assumed to be correct. A finding can sometimes describe multiple issues.

In your considerations you may consider things like (for each finding):
- What specific underlying issue does the finding describe.
- What would the simplest possible fix be. Ignore any suggestions in the finding, and only consider the underlying issue.
- Where should that fix be implemented. Are there multiple equivalent potential fixes.
- Are other locations relevant to this instance of the issue.

Two findings match if fixing one would fix (or substantially address) the other. They do NOT match if they happen to be at the same location but describe different issues.

Think carefully about the findings, and whether they are about the same underlying issue or not.

Your reply MUST be a single valid JSON object with the following structure:
{
  "reasoning": "A short explanation of your analysis of the findings and whether they match.",
  "candidateFindings": [
    { "index": 0, "matchedGoldenIndices": [1] },
    { "index": 1, "matchedGoldenIndices": [] }
  ]
}

Rules:
- "candidateFindings" must have one entry per candidate finding, in order, with 0-based indices.
- "matchedGoldenIndices" lists the 0-based golden finding indices this candidate is about the same underlying issue as. Empty array means no match.
- Output ONLY the JSON object. No markdown fences, no extra text.`;

function buildMatcherPrompt(
  candidateFindings: Finding[],
  goldenFindings: Finding[],
  codeSnippet: string | null,
): string {
  const candidateList = candidateFindings
    .map((f, i) => renderMatcherFinding("candidate", f, i))
    .join("\n");

  const goldenList = goldenFindings
    .map((f, i) => renderMatcherFinding("golden", f, i))
    .join("\n");

  let prompt = "";

  if (codeSnippet) {
    prompt += `## Code context\n\n\`\`\`\n${codeSnippet}\n\`\`\`\n\n`;
  }

  prompt += `## Candidate findings\n${candidateList}\n\n`;
  prompt += `## Golden findings\n${goldenList}`;

  return prompt;
}

export function resolveModel(
  modelRegistry: ModelRegistry,
  provider: string,
  modelId: string,
) {
  const available = modelRegistry.getAvailable();
  return available.find((m) => m.provider === provider && m.id === modelId) ?? null;
}

interface MatcherResponse {
  reasoning?: string;
  candidateFindings: Array<{
    index: number;
    matchedGoldenIndices?: number[];
  }>;
}

function extractJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseMatcherResponse(
  responseText: string,
  candidateCount: number,
  goldenCount: number,
): RawCorrespondence[] {
  const parsed = extractJson(responseText) as Partial<MatcherResponse> | null;

  if (!parsed || !Array.isArray(parsed.candidateFindings)) {
    throw new Error("matcher returned invalid JSON response");
  }

  const correspondences: RawCorrespondence[] = [];
  const seen = new Set<number>();

  for (const entry of parsed.candidateFindings) {
    if (
      !entry ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      entry.index >= candidateCount ||
      seen.has(entry.index) ||
      !Array.isArray(entry.matchedGoldenIndices)
    ) {
      throw new Error("matcher returned invalid candidate finding entries");
    }
    seen.add(entry.index);

    const matched = entry.matchedGoldenIndices.map((gi) => {
      if (!Number.isInteger(gi) || gi < 0 || gi >= goldenCount) {
        throw new Error("matcher returned invalid golden finding indices");
      }
      return gi;
    });

    correspondences.push({
      candidate_index: entry.index,
      matched_golden_indices: matched,
    });
  }

  if (seen.size !== candidateCount) {
    throw new Error("matcher response omitted candidate findings");
  }

  return correspondences.sort((a, b) => a.candidate_index - b.candidate_index);
}

/**
 * Match a chunk of candidate findings against a chunk of golden findings.
 */
async function matchChunk(
  candidates: Finding[],
  goldens: Finding[],
  candidateOffset: number,
  codeSnippet: string | null,
  session: any,
): Promise<RawCorrespondence[]> {
  if (candidates.length === 0 || goldens.length === 0) {
    return candidates.map((_, i) => ({
      candidate_index: candidateOffset + i,
      matched_golden_indices: [],
    }));
  }

  const userPrompt = buildMatcherPrompt(candidates, goldens, codeSnippet);

  await session.prompt(userPrompt);

  // Extract response text
  const messages = session.messages;
  let responseText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && block.text) {
          responseText = block.text;
          break;
        }
      }
      if (responseText) break;
    }
    if (msg.role === "user") break;
  }

  const localCorrespondences = parseMatcherResponse(
    responseText,
    candidates.length,
    goldens.length,
  );

  // Remap candidate indices to global indices
  return localCorrespondences.map((c) => ({
    candidate_index: candidateOffset + c.candidate_index,
    matched_golden_indices: c.matched_golden_indices,
  }));
}

export interface MatcherConfig {
  provider: string;
  modelId: string;
  signal?: AbortSignal;
}

export interface MatcherStats {
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface MatchResult {
  correspondences: RawCorrespondence[];
  stats: MatcherStats;
}

/**
 * Match all candidate findings against all golden findings for a single PR.
 *
 * Groups by file, chunks within each file, runs the LLM matcher on
 * each chunk pair, and merges the results.
 */
export async function matchFindings(
  candidateFindings: Finding[],
  goldenFindings: Finding[],
  config: MatcherConfig,
): Promise<MatchResult> {
  const emptyStats: MatcherStats = { llm_calls: 0, input_tokens: 0, output_tokens: 0 };

  if (candidateFindings.length === 0) return { correspondences: [], stats: emptyStats };
  if (goldenFindings.length === 0) {
    return {
      correspondences: candidateFindings.map((_, i) => ({
        candidate_index: i,
        matched_golden_indices: [],
      })),
      stats: emptyStats,
    };
  }

  // Group by file
  const candidatesByFile = new Map<string, { finding: Finding; globalIndex: number }[]>();
  const goldensByFile = new Map<string, { finding: Finding; globalIndex: number }[]>();

  candidateFindings.forEach((f, i) => {
    const list = candidatesByFile.get(f.file) ?? [];
    list.push({ finding: f, globalIndex: i });
    candidatesByFile.set(f.file, list);
  });

  goldenFindings.forEach((f, i) => {
    const list = goldensByFile.get(f.file) ?? [];
    list.push({ finding: f, globalIndex: i });
    goldensByFile.set(f.file, list);
  });

  // Create a single session for all matching
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const model = resolveModel(modelRegistry, config.provider, config.modelId);

  if (!model) {
    throw new Error(`Requested matcher model is unavailable: ${config.provider}/${config.modelId}`);
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    systemPrompt: renderJudgeSystemPrompt(MATCHER_SYSTEM_PROMPT),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel: "low",
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    noTools: "all",
  });

  const stats: MatcherStats = { llm_calls: 0, input_tokens: 0, output_tokens: 0 };
  const abortSession = () => {
    void session.abort();
  };
  config.signal?.addEventListener("abort", abortSession, { once: true });
  if (config.signal?.aborted) abortSession();

  session.subscribe((event: any) => {
    if (event.type === "turn_end" && event.message?.usage) {
      stats.input_tokens += event.message.usage.input ?? 0;
      stats.output_tokens += event.message.usage.output ?? 0;
    }
  });

  const allCorrespondences: RawCorrespondence[] = candidateFindings.map((_, i) => ({
    candidate_index: i,
    matched_golden_indices: [],
  }));

  try {
    // For each file that has both candidate and golden findings
    const allFiles = new Set([
      ...candidatesByFile.keys(),
      ...goldensByFile.keys(),
    ]);

    for (const file of allFiles) {
      const fileCandidates = candidatesByFile.get(file) ?? [];
      const fileGoldens = goldensByFile.get(file) ?? [];

      if (fileCandidates.length === 0 || fileGoldens.length === 0) continue;

      // Chunk and compare cross-product
      for (let ci = 0; ci < fileCandidates.length; ci += CHUNK_SIZE) {
        const candidateChunk = fileCandidates.slice(ci, ci + CHUNK_SIZE);

        for (let gi = 0; gi < fileGoldens.length; gi += CHUNK_SIZE) {
          const goldenChunk = fileGoldens.slice(gi, gi + CHUNK_SIZE);

          const chunkResults = await matchChunk(
            candidateChunk.map((c) => c.finding),
            goldenChunk.map((g) => g.finding),
            0,
            null,
            session,
          );
          stats.llm_calls++;

          // Map local indices back to global
          for (const cr of chunkResults) {
            const globalCandidateIdx = candidateChunk[cr.candidate_index]?.globalIndex;
            if (globalCandidateIdx === undefined) continue;

            const globalGoldenIndices = cr.matched_golden_indices
              .map((li) => goldenChunk[li]?.globalIndex)
              .filter((gi): gi is number => gi !== undefined);

            const existing = allCorrespondences[globalCandidateIdx];
            existing.matched_golden_indices.push(
              ...globalGoldenIndices.filter(
                (gi) => !existing.matched_golden_indices.includes(gi),
              ),
            );
          }
        }
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", abortSession);
    if (config.signal?.aborted) await session.abort();
    session.dispose();
  }

  return { correspondences: allCorrespondences, stats };
}
