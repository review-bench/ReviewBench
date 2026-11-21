import assert from "node:assert/strict";
import test from "node:test";

import { JudgeTimeout } from "../scripts/eval/judge-call.js";
import { classifyJudgeFailure, retryDelayMs, retryTransient } from "../scripts/eval/judge-retry.js";

test("rejected, expired or missing credentials and exhausted quota stop the run", () => {
  for (const message of [
    'Model error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    "Model error: 401 Incorrect API key provided: sk-...abcd",
    "Model error: API key expired. Please renew the API key.",
    'Authentication failed for "anthropic". Credentials may have expired or network is unavailable.',
    "No API key found for openai.",
    "Model error: 429 You exceeded your current quota, please check your plan and billing details.",
    "Model error: 400 Your credit balance is too low to access the Anthropic API.",
    "Requested matcher model is unavailable: openai/gpt-nope",
    "No suitable model found.\nNo models with configured auth found.",
  ]) {
    assert.equal(classifyJudgeFailure(new Error(message)), "fatal", message);
  }
});

test("rate limits, overload and dropped connections are retried", () => {
  for (const message of [
    "Model error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    'Model error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "Model error: 503 Service Unavailable",
    "Model error: 403 Forbidden",
    "Model error: fetch failed",
    "Model error: read ECONNRESET",
    "Command failed: git fetch\nfatal: unable to access: Could not resolve host: github.com",
  ]) {
    assert.equal(classifyJudgeFailure(new Error(message)), "transient", message);
  }
});

test("unusable answers, input mismatches and timeouts are not retried", () => {
  assert.equal(classifyJudgeFailure(new Error("matcher returned invalid JSON response")), "permanent");
  assert.equal(classifyJudgeFailure(new Error("a/b#1: manifest PR identity does not match golden")), "permanent");
  assert.equal(classifyJudgeFailure(new JudgeTimeout("a/b#1: matcher x/y", 600_000)), "permanent");
});

test("the cause chain is inspected", () => {
  const error = new Error("classification failed", { cause: new Error("Model error: 401 Unauthorized") });
  assert.equal(classifyJudgeFailure(error), "fatal");
});

test("retry delays double up to the cap", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelayMs(n, 30_000, 100_000)), [30_000, 60_000, 100_000, 100_000]);
});

test("retryTransient retries transient failures, then succeeds", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryTransient(
    async () => {
      calls++;
      if (calls < 3) throw new Error("Model error: 429 Too Many Requests");
      return "ok";
    },
    { maxRetries: 3, baseDelayMs: 10, sleep: async (ms) => { waits.push(ms); } },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("retryTransient gives up after maxRetries", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        calls++;
        throw new Error("Model error: 503 Service Unavailable");
      },
      { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    ),
    /503/,
  );
  assert.equal(calls, 3);
});

test("retryTransient does not retry fatal or permanent failures", async () => {
  for (const message of ["Model error: 401 invalid x-api-key", "matcher returned invalid JSON response"]) {
    let calls = 0;
    await assert.rejects(
      retryTransient(
        async () => {
          calls++;
          throw new Error(message);
        },
        { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} },
      ),
    );
    assert.equal(calls, 1, message);
  }
});

test("retryTransient stops waiting when the run is stopping", async () => {
  const stop = new AbortController();
  let calls = 0;
  const started = Date.now();
  const pending = retryTransient(
    async () => {
      calls++;
      throw new Error("Model error: 429 rate limit");
    },
    { maxRetries: 3, baseDelayMs: 60_000, signal: stop.signal },
  );
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(pending, /429/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5_000);
});
