/**
 * Minimal Gemini REST client with error classification.
 */

import { RESPONSE_SCHEMA } from "./prompts";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiErrorKind =
  | "rate_limit" // 429 per-minute quota → backoff, then fallback
  | "daily_quota" // 429 per-day quota → switch model immediately
  | "overloaded" // 503 → backoff, then fallback
  | "server" // 500/502/504 → backoff, then fallback
  | "network" // fetch failure / timeout → backoff, then fallback
  | "model_unavailable" // 404 / unsupported → switch model immediately
  | "auth" // invalid key / permission → fatal
  | "bad_request" // other 400 → switch model
  | "blocked" // safety block → split chunk
  | "truncated" // MAX_TOKENS with nothing salvageable → split chunk
  | "malformed"; // unparseable JSON → retry / split chunk

export class GeminiError extends Error {
  constructor(
    public readonly kind: GeminiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "server" || this.kind === "network";
  }
}

export interface GeminiResult {
  items: unknown;
  /** True when the response hit MAX_TOKENS and only a salvaged prefix was returned. */
  truncated: boolean;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number };
}

const SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

function parseRetryDelay(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const delay = (d as { retryDelay?: unknown })?.retryDelay;
    if (typeof delay === "string") {
      const secs = Number.parseFloat(delay);
      if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
    }
  }
  return undefined;
}

function isPerDayQuota(details: unknown, message: string): boolean {
  if (/per\s*day|daily/i.test(message)) return true;
  if (!Array.isArray(details)) return false;
  return details.some((d) =>
    (d as { violations?: Array<{ quotaId?: string; quotaMetric?: string }> })?.violations?.some((v) =>
      /PerDay/i.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`),
    ),
  );
}

function classifyHttpError(status: number, body: string): GeminiError {
  let message = body.slice(0, 300);
  let details: unknown;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; details?: unknown } };
    message = parsed.error?.message ?? message;
    details = parsed.error?.details;
  } catch {
    /* non-JSON error body */
  }
  const short = `HTTP ${status}: ${message}`.slice(0, 400);
  if (status === 429) {
    return isPerDayQuota(details, message)
      ? new GeminiError("daily_quota", short, status, parseRetryDelay(details))
      : new GeminiError("rate_limit", short, status, parseRetryDelay(details));
  }
  if (status === 503) return new GeminiError("overloaded", short, status);
  if (status >= 500) return new GeminiError("server", short, status);
  if (status === 404) return new GeminiError("model_unavailable", short, status);
  if (status === 401 || (status === 400 && /api key/i.test(message))) return new GeminiError("auth", short, status);
  if (status === 403) {
    return /model/i.test(message) ? new GeminiError("model_unavailable", short, status) : new GeminiError("auth", short, status);
  }
  if (status === 400 && /not (found|supported)|unsupported model|does not exist/i.test(message)) {
    return new GeminiError("model_unavailable", short, status);
  }
  return new GeminiError("bad_request", short, status);
}

/** Recovers the complete objects from a JSON array cut off mid-stream. */
export function salvageJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(`${text.slice(start, end + 1)}]`);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* keep trimming */
    }
  }
  return undefined;
}

function parseJsonText(text: string): unknown {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

export async function generateTranslation(options: {
  apiKey: string;
  modelId: string;
  systemInstruction: string;
  userText: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<GeminiResult> {
  const { apiKey, modelId, systemInstruction, userText, signal, timeoutMs } = options;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      signal: requestSignal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        safetySettings: SAFETY_OFF,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 65_536,
        },
      }),
    });
  } catch (caught) {
    if (signal.aborted) throw caught;
    const timedOut = caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError");
    throw new GeminiError("network", timedOut ? `Request timed out after ${Math.round(timeoutMs / 1000)}s` : `Network error: ${(caught as Error).message}`);
  }

  if (!response.ok) throw classifyHttpError(response.status, await response.text().catch(() => ""));

  const payload = (await response.json().catch(() => null)) as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  } | null;
  if (!payload) throw new GeminiError("malformed", "Response body was not valid JSON.");

  if (payload.promptFeedback?.blockReason) {
    throw new GeminiError("blocked", `Prompt blocked by safety filter (${payload.promptFeedback.blockReason}).`);
  }
  const candidate = payload.candidates?.[0];
  const finishReason = candidate?.finishReason ?? "STOP";
  if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finishReason)) {
    throw new GeminiError("blocked", `Response blocked (${finishReason}).`);
  }

  const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
  const meta = payload.usageMetadata ?? {};
  const usage = {
    promptTokens: meta.promptTokenCount ?? 0,
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    totalTokens: meta.totalTokenCount ?? 0,
  };

  if (!text) {
    throw new GeminiError(finishReason === "MAX_TOKENS" ? "truncated" : "malformed", `Empty response (finishReason=${finishReason}).`);
  }

  if (finishReason === "MAX_TOKENS") {
    const salvaged = salvageJsonArray(text);
    if (!salvaged?.length) throw new GeminiError("truncated", "Output hit the token limit before any complete block was returned.");
    return { items: salvaged, truncated: true, usage };
  }

  try {
    return { items: parseJsonText(text), truncated: false, usage };
  } catch {
    const salvaged = salvageJsonArray(text);
    if (salvaged?.length) return { items: salvaged, truncated: true, usage };
    throw new GeminiError("malformed", "Model returned malformed JSON.");
  }
}
