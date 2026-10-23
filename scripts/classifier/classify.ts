/**
 * Core classification logic using the pi SDK.
 *
 * Architecture:
 * - One pi session per PR+SHA (shared context across all findings on the same commit)
 * - Read, grep, find and ls tools only, so the model can explore the repo, read files
 *   and verify claims without changing anything
 * - Full pi resources (extensions, skills, context files) for maximum quality
 *
 * Implements Section 5.3–5.4 of docs/METHODOLOGY.md.
 */

import { mkdirSync } from "fs";
import { join, resolve } from "path";

import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ClassificationResult, ClassifierInput } from "./types.js";
import { toClassifierFinding } from "./types.js";
import {
  buildClassifierUserMessage,
  buildSessionSetupMessage,
  CLASSIFIER_SYSTEM_PROMPT,
} from "./prompts.js";
import { renderJudgeSystemPrompt } from "../eval/prompt-format.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClassifierConfig {
  /** Model ID, e.g. "claude-sonnet-4.6" */
  modelId: string;
  /** Provider name, e.g. "github-copilot", "anthropic" */
  provider: string;
  /** API key (falls back to env vars / auth.json) */
  apiKey?: string;
  /** Directory to persist session logs (default: classifier-output/sessions) */
  sessionDir?: string;
  /** Working directory where the repo is checked out */
  repoDir?: string;
}

/** The judge may look but not touch: file reading and searching only, no shell. */
const CLASSIFIER_TOOLS = ["read", "grep", "find", "ls"];

// ---------------------------------------------------------------------------
// PR Session — one session per PR+SHA, classifies multiple findings
// ---------------------------------------------------------------------------

export interface PRSessionOptions {
  /** PR metadata */
  nwo: string;
  prUrl: string;
  prTitle: string;
  prBody: string;
  diff: string;
  headSha: string;

  /** Findings to classify in this session */
  findings: ClassifierInput[];

  /** Classifier config */
  config: ClassifierConfig;
  signal?: AbortSignal;

  /** Progress callback — receives the session's live usage stats */
  onProgress?: (result: ClassificationResult, index: number, total: number, liveUsage: import("./types.js").UsageStats) => void;
}

export interface PRSessionResult {
  results: ClassificationResult[];
  usage: import("./types.js").UsageStats;
  /** Tool calls the session made, by tool name. */
  tool_calls: Record<string, number>;
}

/**
 * Classify all findings on a single PR within one session.
 *
 * The session is initialized with PR context (diff, title, body, repo access),
 * then each finding is classified in turn. The shared session allows the model
 * to build context and avoid redundant exploration.
 */
export async function classifyPR(opts: PRSessionOptions): Promise<PRSessionResult> {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  if (opts.config.apiKey) {
    await modelRuntime.setRuntimeApiKey(opts.config.provider, opts.config.apiKey);
  }
  const modelRegistry = new ModelRegistry(modelRuntime);

  const model = resolveModel(modelRegistry, opts.config);
  if (!model) {
    const available = modelRegistry.getAvailable();
    const hint = available.length > 0
      ? `Available: ${available.slice(0, 5).map(m => `${m.provider}/${m.id}`).join(", ")}...`
      : "No models with configured auth found. Set your provider's API key environment variable.";
    throw new Error(`No suitable model found.\n${hint}`);
  }

  // Determine working directory — if a repo checkout is available, use it
  const cwd = opts.config?.repoDir ?? process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: renderJudgeSystemPrompt(CLASSIFIER_SYSTEM_PROMPT),
  });
  await loader.reload();

  // Persist sessions to disk so we can review tool calls, prompt exchanges, etc.
  // Each PR gets its own session file, browsable via `pi --resume` or `pi --export`.
  const sessionDir = opts.config?.sessionDir ?? "classifier-output/sessions";
  const resolvedSessionDir = resolve(sessionDir);
  mkdirSync(resolvedSessionDir, { recursive: true });

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "medium",
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, resolvedSessionDir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    }),
    tools: CLASSIFIER_TOOLS,
  });
  const abortSession = () => {
    void session.abort();
  };
  opts.signal?.addEventListener("abort", abortSession, { once: true });
  if (opts.signal?.aborted) abortSession();

  // Log session file location for debugging
  if (session.sessionFile) {
    console.log(`  Session log: ${session.sessionFile}`);
  }

  // Track token usage across the session
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0, elapsed_seconds: 0 };
  const toolCalls: Record<string, number> = {};
  const sessionStart = Date.now();

  // Resolve per-token rates: use the model's own rates, or look up the same
  // model name under a provider that has pricing (e.g. anthropic, bedrock)
  let modelCost = model.cost;
  if (modelCost.input === 0 && modelCost.output === 0) {
    const allModels = modelRegistry.getAll();
    const ref = allModels.find(
      (m) => m.id.includes(model.id) && m.cost.input > 0
    ) ?? allModels.find(
      (m) => m.name === model.name && m.cost.input > 0
    );
    if (ref) modelCost = ref.cost;
  }

  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      const name = String(event.toolName ?? "unknown");
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      return;
    }
    if (event.type === "turn_end") {
      const msg = event.message;
      if (msg?.usage) {
        const input = msg.usage.input ?? 0;
        const output = msg.usage.output ?? 0;
        const cacheRead = msg.usage.cacheRead ?? 0;
        const cacheWrite = msg.usage.cacheWrite ?? 0;
        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cache_read_tokens += cacheRead;
        usage.cache_write_tokens += cacheWrite;

        const cost = msg.usage.cost;
        if (cost && typeof cost === "object" && cost.total > 0) {
          usage.estimated_cost_usd += cost.total;
        } else {
          usage.estimated_cost_usd +=
            (input * modelCost.input +
            output * modelCost.output +
            cacheRead * modelCost.cacheRead +
            cacheWrite * modelCost.cacheWrite) / 1_000_000;
        }
      }
    }
  });

  const results: ClassificationResult[] = [];

  try {
    // Step 1: Set up PR context in the session
    const setupMessage = buildSessionSetupMessage({
      nwo: opts.nwo,
      prUrl: opts.prUrl,
      prTitle: opts.prTitle,
      prBody: opts.prBody,
      diff: opts.diff,
      headSha: opts.headSha,
      findingCount: opts.findings.length,
    });

    await promptAndWait(session, setupMessage);

    // Step 2: Classify each finding in turn
    for (let i = 0; i < opts.findings.length; i++) {
      const finding = opts.findings[i];
      const normalized = toClassifierFinding(finding);
      const userMessage = buildClassifierUserMessage({
        filePath: normalized.filePath,
        startLine: normalized.startLine,
        endLine: normalized.endLine,
        message: normalized.message,
        index: i + 1,
        total: opts.findings.length,
      });

      let responseText = await promptAndCollect(session, userMessage);

      // One retry in total when the answer is not a usable classification:
      // no JSON at all, or JSON missing a required field. A single malformed
      // answer from the judge should not fail the whole pull request; a
      // second one does.
      const retryMessage = (why: string) =>
        `Your previous response was not a valid JSON classification object (${why}). ` +
        "Please respond now with ONLY the JSON object, no other text:\n\n" +
        '{"tp_fp": "...", "tp_fp_justification": "...", "severity": "...", ' +
        '"severity_justification": "...", "category": "...", "category_justification": "...", ' +
        '"scope": "...", "difficulty": "...", "context_required": "..."}';
      let result: ClassificationResult;
      try {
        if (!containsJson(responseText)) throw new Error("no JSON found");
        result = parseClassifierResponse(responseText, normalized.id);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        responseText = await promptAndCollect(session, retryMessage(why));
        result = parseClassifierResponse(responseText, normalized.id);
      }
      results.push(result);

      opts.onProgress?.(result, i, opts.findings.length, usage);
    }
  } finally {
    usage.elapsed_seconds = (Date.now() - sessionStart) / 1000;
    opts.signal?.removeEventListener("abort", abortSession);
    if (opts.signal?.aborted) await session.abort();
    session.dispose();
  }

  return { results, usage, tool_calls: toolCalls };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Send a prompt and wait for the agent to finish (including tool use).
 * Does not collect the response text.
 */
async function promptAndWait(session: any, message: string): Promise<void> {
  await session.prompt(message);
}

/**
 * Send a prompt, wait for completion, and extract the JSON classification
 * from the final assistant response. The model may use tools during
 * processing — we extract JSON from the last assistant text block.
 */
async function promptAndCollect(session: any, message: string): Promise<string> {
  await session.prompt(message);

  // Walk backward through messages to find the last assistant text
  const messages = session.messages;
  let responseText = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && block.text) {
          responseText = block.text + responseText;
        }
      }
      // Only take the last assistant message that has text
      if (responseText) break;
    }
    // Stop if we hit a user message (we've gone past the current turn)
    if (msg.role === "user") break;
  }

  // Check for errors
  const lastMsg = messages[messages.length - 1] as any;
  if (lastMsg?.role === "assistant" && lastMsg.errorMessage) {
    throw new Error(`Model error: ${lastMsg.errorMessage}`);
  }

  return responseText;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export function resolveModel(
  modelRegistry: ModelRegistry,
  config: ClassifierConfig,
) {
  const available = modelRegistry.getAvailable();
  return available.find(
    (m) => m.provider === config.provider && m.id === config.modelId,
  ) ?? null;
}

// ---------------------------------------------------------------------------
// JSON detection helper
// ---------------------------------------------------------------------------

function containsJson(text: string): boolean {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return false;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null && "tp_fp" in parsed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseClassifierResponse(
  raw: string,
  commentId: string
): ClassificationResult {
  // The model may include reasoning before/after the JSON.
  // Extract the JSON object from the response.
  let cleaned = raw.trim();

  // Strip markdown fencing
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // Try to find a JSON object in the text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `Failed to parse classifier response as JSON for comment ${commentId}:\n${raw.slice(0, 1000)}`
    );
  }

  // Validate required fields
  const requiredFields = [
    "tp_fp",
    "tp_fp_justification",
    "severity",
    "category",
    "scope",
    "difficulty",
    "context_required",
  ];

  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(
        `Missing required field "${field}" in classifier response for comment ${commentId}`
      );
    }
  }

  return {
    comment_id: commentId,
    tp_fp: parsed.tp_fp as ClassificationResult["tp_fp"],
    tp_fp_justification: parsed.tp_fp_justification as string,
    severity: parsed.severity as ClassificationResult["severity"],
    severity_justification:
      typeof parsed.severity_justification === "string"
        ? parsed.severity_justification
        : undefined,
    category: parsed.category as ClassificationResult["category"],
    category_justification:
      typeof parsed.category_justification === "string"
        ? parsed.category_justification
        : undefined,
    scope: parsed.scope as ClassificationResult["scope"],
    difficulty: parsed.difficulty as ClassificationResult["difficulty"],
    context_required:
      parsed.context_required as ClassificationResult["context_required"],
  };
}
