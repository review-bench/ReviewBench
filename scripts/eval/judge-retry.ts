/**
 * Decides what a failed pull request means for the rest of a judge run.
 *
 * The judge SDK already retries a single model call a few times over a few
 * seconds. That is too short for a provider rate limit or a brief outage, and
 * it can't help when the API key is rejected. This module sorts failures into:
 *
 * - "fatal": every remaining pull request would fail the same way (rejected or
 *   missing API key, expired credentials, exhausted quota, unavailable model).
 *   The run stops and keeps its checkpoint, so fixing the cause and running the
 *   same command again resumes it.
 * - "transient": rate limits, overloaded or unavailable servers, dropped
 *   connections. The pull request is judged again after a backoff.
 * - "permanent": anything else, such as an unusable judge answer or an input
 *   mismatch. It fails that pull request, as before.
 *
 * Judge timeouts are "permanent" here: each one already waited the full budget,
 * and rerunning the command retries them from the checkpoint.
 */

export type JudgeFailureKind = "fatal" | "transient" | "permanent";

const FATAL = new RegExp(
  [
    String.raw`\b401\b`,
    "unauthori[sz]ed",
    String.raw`invalid[ _-]?(x-)?api[ _-]?key`,
    "incorrect api key",
    String.raw`api key (is )?(invalid|expired|not valid|revoked)`,
    String.raw`authentication[ _]?(failed|error)`,
    "no api key",
    String.raw`(token|credentials?|api key) (has |have )?(expired|been revoked)`,
    String.raw`expired (token|credentials?|api key)`,
    "insufficient[ _]quota",
    "exceeded your current quota",
    "credit balance is too low",
    "billing",
    "requested matcher model is unavailable",
    "no suitable model found",
  ].join("|"),
  "i",
);

const TRANSIENT = new RegExp(
  [
    String.raw`\b(403|429|500|502|503|504|529)\b`,
    "rate.?limit",
    "too many requests",
    "overloaded",
    "service.?unavailable",
    "bad gateway",
    "gateway time-?out",
    "server.?error",
    "internal.?error",
    "ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND",
    "socket hang up",
    "fetch failed",
    "network.?error",
    "connection.?(error|reset|refused|lost|closed)",
    "could not resolve host",
    "other side closed",
    "terminated",
  ].join("|"),
  "i",
);

function messages(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    out.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return out;
}

export function classifyJudgeFailure(error: unknown): JudgeFailureKind {
  if (error instanceof Error && error.name === "JudgeTimeout") return "permanent";
  const text = messages(error).join("\n");
  // Checked first: some providers report exhausted quota as HTTP 429.
  if (FATAL.test(text)) return "fatal";
  if (TRANSIENT.test(text)) return "transient";
  return "permanent";
}

/** Retries per pull request after a transient failure. */
export const JUDGE_RETRY_DEFAULT = 3;

/** Delay before the first retry; it doubles each time, up to JUDGE_RETRY_MAX_DELAY_MS. */
export const JUDGE_RETRY_DELAY_MS = Number(process.env.REVIEW_BENCH_JUDGE_RETRY_DELAY_MS ?? 30 * 1000);

export const JUDGE_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Aborted when the run is stopping; a pending wait ends and the last error is thrown. */
  signal?: AbortSignal;
  onRetry?: (retry: number, delayMs: number, error: unknown) => void;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function retryDelayMs(retry: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (retry - 1), maxDelayMs);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Run `attempt`, running it again after each transient failure up to `maxRetries` times. */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const baseDelayMs = opts.baseDelayMs ?? JUDGE_RETRY_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? JUDGE_RETRY_MAX_DELAY_MS;
  const sleep = opts.sleep ?? abortableSleep;
  for (let retry = 1; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (retry > opts.maxRetries || opts.signal?.aborted || classifyJudgeFailure(error) !== "transient") {
        throw error;
      }
      const delayMs = retryDelayMs(retry, baseDelayMs, maxDelayMs);
      opts.onRetry?.(retry, delayMs, error);
      await sleep(delayMs, opts.signal);
      if (opts.signal?.aborted) throw error;
    }
  }
}
