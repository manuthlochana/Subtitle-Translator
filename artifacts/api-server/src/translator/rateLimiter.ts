/**
 * Per-(API key, model) rate limiter.
 *
 * Enforces three limits before every request:
 *  - minimum spacing between requests (4.5 s for 15 RPM, 12.5 s for 5 RPM, …)
 *  - a 60 s sliding token window (TPM)
 *  - a daily request counter (RPD), reset at midnight Pacific time like the
 *    Gemini API quota
 *
 * State is in-memory and shared by every job using the same key, so two
 * concurrent jobs cannot jointly exceed a model's quota. Keys are stored only
 * as SHA-256 hashes.
 */

import { createHash } from "node:crypto";
import type { ModelProfile } from "./models";

export class QuotaExhaustedError extends Error {
  constructor(public readonly modelId: string, message: string) {
    super(message);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
}

const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
function quotaDay(): string {
  return pacificDay.format(new Date());
}

interface Bucket {
  lastRequestAt: number;
  tokens: Array<{ at: number; tokens: number }>;
  day: string;
  requestsToday: number;
  queue: Promise<void>;
}

const TPM_SAFETY = 0.9;
const buckets = new Map<string, Bucket>();

function bucketFor(keyHash: string, model: ModelProfile): Bucket {
  const id = `${keyHash}:${model.id}`;
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { lastRequestAt: 0, tokens: [], day: quotaDay(), requestsToday: 0, queue: Promise.resolve() };
    buckets.set(id, bucket);
  }
  const today = quotaDay();
  if (bucket.day !== today) {
    bucket.day = today;
    bucket.requestsToday = 0;
  }
  return bucket;
}

export interface Reservation {
  /** Report the real token usage once the response arrives. */
  commit(actualTokens: number): void;
}

/**
 * Waits until a request to `model` is allowed, then reserves the slot.
 * Throws QuotaExhaustedError when the daily request budget is used up.
 */
export async function acquire(
  keyHash: string,
  model: ModelProfile,
  estimatedTokens: number,
  signal: AbortSignal,
  onWait?: (ms: number, reason: string) => void,
): Promise<Reservation> {
  const bucket = bucketFor(keyHash, model);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => (release = resolve));
  const previous = bucket.queue;
  bucket.queue = previous.then(() => turn);
  await previous;
  try {
    if (bucket.requestsToday >= model.rpd) {
      throw new QuotaExhaustedError(model.id, `${model.label} daily quota (${model.rpd} RPD) is used up for this API key.`);
    }

    const spacingWait = bucket.lastRequestAt + model.minIntervalMs - Date.now();
    if (spacingWait > 0) {
      onWait?.(spacingWait, `${model.rpm} RPM pacing`);
      await sleep(spacingWait, signal);
    }

    const budget = model.tpm * TPM_SAFETY;
    const wanted = Math.min(estimatedTokens, budget);
    for (;;) {
      const now = Date.now();
      bucket.tokens = bucket.tokens.filter((t) => now - t.at < 60_000);
      const used = bucket.tokens.reduce((sum, t) => sum + t.tokens, 0);
      if (used + wanted <= budget || !bucket.tokens.length) break;
      const waitMs = 60_000 - (now - bucket.tokens[0].at) + 250;
      onWait?.(waitMs, `${Math.round(model.tpm / 1000)}K TPM window`);
      await sleep(waitMs, signal);
    }

    const entry = { at: Date.now(), tokens: wanted };
    bucket.tokens.push(entry);
    bucket.lastRequestAt = entry.at;
    bucket.requestsToday += 1;
    return {
      commit(actualTokens: number) {
        if (Number.isFinite(actualTokens) && actualTokens > 0) entry.tokens = actualTokens;
      },
    };
  } finally {
    release();
  }
}

/** Marks a model as exhausted for today (e.g. the API reported a per-day quota error). */
export function markExhausted(keyHash: string, model: ModelProfile): void {
  bucketFor(keyHash, model).requestsToday = model.rpd;
}

export function usageSnapshot(keyHash: string, model: ModelProfile): { requestsToday: number; rpd: number } {
  const bucket = bucketFor(keyHash, model);
  return { requestsToday: bucket.requestsToday, rpd: model.rpd };
}
