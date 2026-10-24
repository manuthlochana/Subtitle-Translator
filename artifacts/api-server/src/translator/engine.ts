/**
 * Translation engine: drives one SRT translation job end-to-end.
 *
 *   main pass ─▶ sanitize/validate (Layer 2) ─▶ auto-heal micro-retries ─▶ final safety net
 *        │
 *        └─ rolling context window (Layer 3), rate limiter, smart chunker,
 *           exponential backoff on 429/503, automatic model fallback chain.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { CONTEXT_LINES, buildSlidingContext, estimateInputTokens, estimateOutputTokens, estimateRemainingChunks, nextChunkSize } from "./chunker";
import { GeminiError, generateTranslation, type GeminiResult } from "./gemini";
import {
  getFallbackChain,
  getModel,
  resolveStrategy,
  type ExecutionMode,
  type ExecutionStrategy,
  type ModelProfile,
} from "./models";
import {
  REPAIR_SYSTEM_INSTRUCTION,
  TRANSLATION_SYSTEM_INSTRUCTION,
  buildChunkPrompt,
  buildRepairPrompt,
  type ContextBlock,
  type RepairItem,
} from "./prompts";
import { QuotaExhaustedError, acquire, hashKey, markExhausted, sleep, usageSnapshot } from "./rateLimiter";
import {
  checkResponseStructure,
  sanitizeAndValidateSinhalaSRT,
  selfTestSinhalaPreservation,
  stripForeignScripts,
  validateSinhalaBlock,
  type RejectedBlock,
} from "./sanitizer";
import { isUntranslatable, serializeSrt, type SrtBlock } from "./srt";

export type JobState = "queued" | "running" | "paused" | "complete" | "failed" | "cancelled";
export type JobPhase = "translating" | "healing" | "finalizing" | "done";

export interface JobOptions {
  apiKey: string;
  modelId: string;
  mode: ExecutionMode;
  chunkSize: number;
}

interface JobEvent {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

interface ModelSwitch {
  at: number;
  from: string;
  to: string;
  reason: string;
}

class FatalJobError extends Error {}

// Startup regression guard: known-good Sinhala (ZWJ conjuncts, vowel signs, virama) must pass the sanitizer untouched.
const sinhalaSelfTestFailures = selfTestSinhalaPreservation();
if (sinhalaSelfTestFailures.length) {
  logger.error({ failures: sinhalaSelfTestFailures }, "Sinhala sanitizer self-test FAILED — glyphs may be corrupted");
} else {
  logger.info("Sinhala sanitizer self-test passed (ZWJ / vowel signs / virama preserved)");
}

/** Already-translated lines carried into the next chunk as [PREVIOUS_CONTEXT_DO_NOT_TRANSLATE] (3–5). */
const CONTEXT_WINDOW = CONTEXT_LINES.max;
/** Chunk-level attempts when the model merges / drops / duplicates ids or returns the wrong length. */
const STRUCTURE_ATTEMPTS = 3;
const STRUCTURE_BACKOFF_BASE_MS = 3_000;
const STRUCTURE_BACKOFF_CAP_MS = 30_000;
const MAX_RETRIES_PER_MODEL = 3;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 90_000;
const HEAL_ROUNDS = 3;
const HEAL_BATCH = 25;
const MAX_EVENTS = 200;

type CallOutcome =
  | { type: "ok"; result: GeminiResult; model: ModelProfile }
  | { type: "switched" }
  | { type: "split"; reason: string };

export class TranslationJob {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  startedAt?: number;
  finishedAt?: number;
  state: JobState = "queued";
  phase: JobPhase = "translating";
  error?: string;

  private options: JobOptions;
  private keyHash: string;
  private chain: ModelProfile[];
  private chainIndex = 0;
  private controller?: AbortController;
  private pauseRequested = false;
  private resumeWaiters: Array<() => void> = [];
  private running?: Promise<void>;
  private shrink = 1;

  readonly translations = new Map<string, string>();
  private failures = new Map<string, RejectedBlock>();
  private healed = new Set<string>();
  private unresolved = new Set<string>();
  private autoCleaned = new Set<string>();
  private foreignScriptBlocks = 0;
  private parentheticalsStripped = 0;
  private events: JobEvent[] = [];
  private modelSwitches: ModelSwitch[] = [];
  private chunksDone = 0;
  private structureRetries = 0;
  private requests = 0;
  private tokens = { input: 0, output: 0 };
  private currentChunk?: { from: number; to: number; size: number };
  private waiting?: { reason: string; until: number };
  private positionOf = new Map<string, number>();

  constructor(
    readonly fileName: string,
    readonly blocks: SrtBlock[],
    options: JobOptions,
  ) {
    this.options = { ...options };
    this.keyHash = hashKey(options.apiKey);
    this.chain = getFallbackChain(options.modelId);
    blocks.forEach((b, i) => this.positionOf.set(b.key, i));
    for (const block of blocks) {
      if (isUntranslatable(block.text)) this.translations.set(block.key, block.text);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.state = "running";
    this.startedAt ??= Date.now();
    this.finishedAt = undefined;
    this.error = undefined;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
  }

  pause(): void {
    if (this.state !== "running") return;
    this.pauseRequested = true;
    this.state = "paused";
    this.log("info", "Pause requested — the run will hold after the current request.");
  }

  resume(update?: Partial<JobOptions>): void {
    if (update) this.applyOptions(update);
    if (this.state === "paused" && this.running) {
      this.pauseRequested = false;
      this.state = "running";
      this.resumeWaiters.splice(0).forEach((fn) => fn());
      this.log("info", "Resumed.");
      return;
    }
    if (this.state === "failed" || this.state === "cancelled" || (this.state === "paused" && !this.running)) {
      this.pauseRequested = false;
      this.log("info", "Restarting remaining blocks.");
      this.start();
    }
  }

  cancel(): void {
    if (this.state === "complete" || this.state === "cancelled") return;
    this.pauseRequested = false;
    this.resumeWaiters.splice(0).forEach((fn) => fn());
    this.controller?.abort(new Error("Cancelled by user"));
    this.state = "cancelled";
    this.finishedAt = Date.now();
    this.log("warn", "Run cancelled. Translated blocks remain available.");
  }

  get isActive(): boolean {
    return this.running !== undefined;
  }

  private applyOptions(update: Partial<JobOptions>): void {
    if (update.apiKey) {
      this.options.apiKey = update.apiKey;
      this.keyHash = hashKey(update.apiKey);
    }
    if (update.mode) this.options.mode = update.mode;
    if (update.chunkSize) this.options.chunkSize = update.chunkSize;
    if (update.modelId && getModel(update.modelId)) {
      this.options.modelId = update.modelId;
    }
    // Restart the fallback chain from the (possibly new) primary model.
    this.chain = getFallbackChain(this.options.modelId);
    this.chainIndex = 0;
    this.shrink = 1;
  }

  // ── main runner ────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      this.phase = "translating";
      await this.mainPass(signal);
      this.phase = "healing";
      await this.healPass(signal);
      this.phase = "finalizing";
      this.finalSafetyNet();
      this.phase = "done";
      this.state = "complete";
      this.finishedAt = Date.now();
      this.currentChunk = undefined;
      const purity = this.unresolved.size
        ? `${this.unresolved.size} block(s) could not be verified and were scrubbed or kept in English`
        : this.healed.size
          ? `Unicode purity check passed after auto-healing ${this.healed.size} block(s)`
          : "Unicode purity check passed";
      this.log("info", `Translation complete — ${purity}.`);
    } catch (caught) {
      this.waiting = undefined;
      if (signal.aborted) {
        this.state = "cancelled";
      } else {
        this.state = "failed";
        this.error = caught instanceof Error ? caught.message : String(caught);
        this.log("error", this.error);
        if (!(caught instanceof FatalJobError)) logger.error({ err: caught, jobId: this.id }, "Translation job crashed");
      }
      this.finishedAt = Date.now();
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private pendingBlocks(): SrtBlock[] {
    return this.blocks.filter((b) => !this.translations.has(b.key) && !this.failures.has(b.key));
  }

  private async mainPass(signal: AbortSignal): Promise<void> {
    for (;;) {
      await this.holdIfPaused(signal);
      const pending = this.pendingBlocks();
      if (!pending.length) return;

      const model = this.activeModel();
      const strategy = this.strategyFor(model);
      const size = nextChunkSize(pending, strategy, this.options.chunkSize, this.shrink);
      const chunk = pending.slice(0, size);
      this.currentChunk = {
        from: Number(chunk[0].index) || this.positionOf.get(chunk[0].key)! + 1,
        to: Number(chunk[chunk.length - 1].index) || this.positionOf.get(chunk[chunk.length - 1].key)! + 1,
        size: chunk.length,
      };
      const context = this.rollingContext(chunk[0]);
      const outcome = await this.callStrict(
        TRANSLATION_SYSTEM_INSTRUCTION,
        buildChunkPrompt(chunk, context),
        chunk,
        strategy,
        signal,
        "Chunk",
      );

      if (outcome.type === "switched") continue;
      if (outcome.type === "split") {
        if (chunk.length === 1) {
          this.failures.set(chunk[0].key, { block: chunk[0], reasons: [outcome.reason] });
          this.log("warn", `Block ${chunk[0].index}: ${outcome.reason}. Queued for auto-heal.`);
        } else {
          this.shrink *= 2;
          this.log("warn", `${outcome.reason} Splitting into smaller requests (${Math.max(1, Math.floor(chunk.length / 2))} blocks).`);
        }
        continue;
      }

      const accepted = this.ingest(chunk, outcome.result.items, false);
      this.chunksDone += 1;
      if (outcome.result.truncated) {
        this.shrink = Math.min(this.shrink * 2, 64);
        this.log("warn", `Response from ${outcome.model.label} was truncated; kept ${accepted} complete block(s), shrinking the next request.`);
      } else {
        this.shrink = Math.max(1, this.shrink / 2);
      }
      if (strategy === "chunked" && pending.length > chunk.length) {
        this.log("info", `Chunk ${this.chunksDone} done with ${outcome.model.label}: ${accepted}/${chunk.length} blocks accepted.`);
      } else {
        this.log("info", `${chunk.length === pending.length ? "Full-SRT pass" : `Mega-chunk ${this.chunksDone}`} done with ${outcome.model.label}: ${accepted}/${chunk.length} blocks accepted.`);
      }
    }
  }

  /** Layer 2 + bookkeeping. Returns the number of accepted blocks. */
  private ingest(expected: SrtBlock[], items: unknown, isRepair: boolean): number {
    // A truncated response only covers a prefix; validate just the blocks that came back.
    const returnedIds = new Set(
      Array.isArray(items) ? items.map((it) => String((it as { id?: unknown })?.id ?? "").trim()) : [],
    );
    const lastReturned = expected.reduce((last, b, i) => (returnedIds.has(b.key) ? i : last), -1);
    const scope = isRepair || lastReturned === -1 ? expected : expected.slice(0, lastReturned + 1);

    const result = sanitizeAndValidateSinhalaSRT(scope, items);
    this.foreignScriptBlocks += result.stats.foreignScriptBlocks;
    this.parentheticalsStripped += result.stats.parentheticalsStripped;
    for (const [key, text] of result.accepted) {
      this.translations.set(key, text);
      if (this.failures.delete(key) || isRepair) this.healed.add(key);
    }
    for (const rejected of result.rejected) this.failures.set(rejected.block.key, rejected);
    if (result.stats.autoCleaned) {
      for (const block of scope) if (result.accepted.has(block.key) && result.accepted.get(block.key) !== block.text) this.autoCleaned.add(block.key);
    }
    if (result.rejected.length) {
      const foreign = result.rejected.filter((r) => r.reasons.some((x) => x.startsWith("foreign script"))).length;
      this.log(
        "warn",
        `${isRepair ? "Repair" : "Validator"}: ${result.rejected.length} block(s) rejected` +
          (foreign ? ` (${foreign} with foreign-script bleeding)` : "") +
          `${isRepair ? "" : " — queued for auto-heal"}.`,
      );
    }
    return result.accepted.size;
  }

  // ── auto-heal micro-retry ──────────────────────────────────────────────

  private async healPass(signal: AbortSignal): Promise<void> {
    for (let round = 1; round <= HEAL_ROUNDS && this.failures.size; round += 1) {
      const items = [...this.failures.values()].sort(
        (a, b) => this.positionOf.get(a.block.key)! - this.positionOf.get(b.block.key)!,
      );
      this.log("info", `Auto-heal round ${round}: re-requesting ${items.length} corrupted/missing block(s).`);
      for (let i = 0; i < items.length; ) {
        await this.holdIfPaused(signal);
        const batch: RepairItem[] = items.slice(i, i + HEAL_BATCH).map((f) => ({
          block: f.block,
          rejectedOutput: f.rejectedOutput,
          reasons: f.reasons,
        }));
        const blocks = batch.map((b) => b.block);
        this.currentChunk = { from: Number(blocks[0].index) || 0, to: Number(blocks[blocks.length - 1].index) || 0, size: blocks.length };
        const outcome = await this.callStrict(
          REPAIR_SYSTEM_INSTRUCTION,
          buildRepairPrompt(batch, this.neighbourContext(blocks)),
          blocks,
          "chunked",
          signal,
          "Repair",
        );
        if (outcome.type === "switched") continue; // retry same batch with next model
        if (outcome.type === "split") {
          i += batch.length; // try again next round (or fall through to safety net)
          continue;
        }
        this.ingest(blocks, outcome.result.items, true);
        i += batch.length;
      }
    }
  }

  /** Final safety net: the downloaded file must never contain foreign scripts. */
  private finalSafetyNet(): void {
    for (const failure of this.failures.values()) {
      const { block, rejectedOutput } = failure;
      let text = block.text;
      if (rejectedOutput) {
        const scrubbed = stripForeignScripts(validateSinhalaBlock(block.text, rejectedOutput).text);
        const recheck = validateSinhalaBlock(block.text, scrubbed);
        if (!recheck.problems.length) text = recheck.text;
      }
      this.translations.set(block.key, text);
      this.unresolved.add(block.key);
      this.log("warn", `Block ${block.index}: could not be verified after ${HEAL_ROUNDS} heal rounds (${failure.reasons.join("; ")}). ${text === block.text ? "Kept original English." : "Scrubbed foreign characters."}`);
    }
    this.failures.clear();
  }

  // ── model routing ──────────────────────────────────────────────────────

  private activeModel(): ModelProfile {
    while (this.chainIndex < this.chain.length) {
      const model = this.chain[this.chainIndex];
      const usage = usageSnapshot(this.keyHash, model);
      if (usage.requestsToday < usage.rpd) return model;
      this.switchModel(model, `daily quota (${model.rpd} RPD) already used`);
    }
    throw new FatalJobError(
      "Every model in the fallback chain is exhausted or unavailable for this API key. Translated blocks are kept — resume later, pick another model, or use a different key.",
    );
  }

  private strategyFor(model: ModelProfile): ExecutionStrategy {
    return resolveStrategy(model, this.chainIndex === 0, this.options.mode);
  }

  private switchModel(from: ModelProfile, reason: string): void {
    this.chainIndex += 1;
    const next = this.chain[this.chainIndex];
    this.shrink = 1;
    if (!next) {
      this.log("error", `${from.label} unavailable (${reason}); no fallback models left.`);
      return;
    }
    const strategyNote = next.strategy !== this.strategyFor(from) || next.strategy === "chunked" ? ` Switching to ${next.strategy === "chunked" ? "80–100 block chunk" : "full-SRT"} mode.` : "";
    this.modelSwitches.push({ at: Date.now(), from: from.id, to: next.id, reason });
    this.log("warn", `Fallback: ${from.label} → ${next.label} (${reason}).${strategyNote}`);
  }

  private async callWithFallback(
    systemInstruction: string,
    userText: string,
    blocks: SrtBlock[],
    strategy: ExecutionStrategy,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const model = this.activeModel();
    const estimate = estimateInputTokens(blocks) + estimateOutputTokens(blocks);
    const timeoutMs = strategy === "full" ? 10 * 60_000 : 3 * 60_000;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt += 1) {
      await this.holdIfPaused(signal);
      try {
        const reservation = await acquire(this.keyHash, model, estimate, signal, (ms, reason) => {
          this.waiting = { reason, until: Date.now() + ms };
        });
        this.waiting = undefined;
        this.requests += 1;
        const result = await generateTranslation({
          apiKey: this.options.apiKey,
          modelId: model.id,
          systemInstruction,
          userText,
          signal,
          timeoutMs,
        });
        reservation.commit(result.usage.totalTokens);
        this.tokens.input += result.usage.promptTokens;
        this.tokens.output += result.usage.outputTokens;
        return { type: "ok", result, model };
      } catch (caught) {
        this.waiting = undefined;
        if (signal.aborted) throw caught;
        if (caught instanceof QuotaExhaustedError) {
          this.switchModel(model, "daily quota (RPD) reached");
          return { type: "switched" };
        }
        if (!(caught instanceof GeminiError)) throw caught;

        switch (caught.kind) {
          case "auth":
            throw new FatalJobError(`Gemini rejected the API key: ${caught.message}`);
          case "daily_quota":
            markExhausted(this.keyHash, model);
            this.switchModel(model, "daily quota exhausted (429)");
            return { type: "switched" };
          case "model_unavailable":
          case "bad_request":
            this.switchModel(model, caught.message.slice(0, 160));
            return { type: "switched" };
          case "blocked":
          case "truncated":
            return { type: "split", reason: caught.message };
          case "malformed":
            if (attempt === 0) {
              this.log("warn", `${model.label} returned malformed JSON; retrying once.`);
              continue;
            }
            return { type: "split", reason: caught.message };
          default: {
            // rate_limit / overloaded / server / network → exponential backoff, then fallback.
            if (attempt === MAX_RETRIES_PER_MODEL) {
              this.switchModel(model, `still failing after ${MAX_RETRIES_PER_MODEL} retries: ${caught.message.slice(0, 120)}`);
              return { type: "switched" };
            }
            const backoff = Math.min(BACKOFF_CAP_MS, Math.max(caught.retryAfterMs ?? 0, BACKOFF_BASE_MS * 2 ** attempt)) + Math.floor(Math.random() * 1_000);
            const label = caught.kind === "rate_limit" ? "429 rate limit" : caught.kind === "overloaded" ? "503 overloaded" : caught.kind === "network" ? "network error" : `server error ${caught.status ?? ""}`.trim();
            this.log("warn", `${model.label}: ${label}. Backing off ${Math.round(backoff / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES_PER_MODEL}).`);
            this.waiting = { reason: `Backoff after ${label}`, until: Date.now() + backoff };
            await sleep(backoff, signal);
            this.waiting = undefined;
          }
        }
      }
    }
    return { type: "switched" };
  }

  // ── strict structural validation with chunk-level retry ────────────────

  /**
   * Wraps callWithFallback with a STRICT structural check: the response must be an
   * array with exactly one item per requested block and every id must match 1:1.
   * If the model merged lines, dropped an id, duplicated an id or returned the wrong
   * length, the whole chunk is re-requested (exponential backoff, up to
   * STRUCTURE_ATTEMPTS attempts) with a corrective note. Nothing is ever patched by
   * copying a neighbouring line. If all attempts fail, the valid subset is kept and
   * the rest is queued for auto-heal.
   */
  private async callStrict(
    systemInstruction: string,
    userText: string,
    blocks: SrtBlock[],
    strategy: ExecutionStrategy,
    signal: AbortSignal,
    label: string,
  ): Promise<CallOutcome> {
    let lastBad: CallOutcome | undefined;
    let prompt = userText;
    for (let attempt = 1; attempt <= STRUCTURE_ATTEMPTS; attempt += 1) {
      const outcome = await this.callWithFallback(systemInstruction, prompt, blocks, strategy, signal);
      // Non-ok outcomes (model switch / split) and deliberately truncated responses are handled by the callers.
      if (outcome.type !== "ok" || outcome.result.truncated) return outcome;

      const check = checkResponseStructure(blocks, outcome.result.items);
      if (check.ok) return outcome;

      lastBad = outcome;
      this.structureRetries += 1;
      const issues = check.issues.join("; ");
      if (attempt === STRUCTURE_ATTEMPTS) {
        this.log("warn", `${label} failed structural validation ${STRUCTURE_ATTEMPTS}× (${issues}). Keeping the valid blocks; the rest go to auto-heal.`);
        break;
      }
      const backoff = Math.min(STRUCTURE_BACKOFF_CAP_MS, STRUCTURE_BACKOFF_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      this.log("warn", `${label} structural check failed (${issues}). Re-requesting the chunk in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${STRUCTURE_ATTEMPTS}).`);
      prompt = `${userText}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${issues}. Return EXACTLY ${blocks.length} objects, one per input id, the same ids, nothing merged, skipped, split or duplicated.`;
      this.waiting = { reason: "Retrying chunk after structural validation failure", until: Date.now() + backoff };
      await sleep(backoff, signal);
      this.waiting = undefined;
    }
    return lastBad as CallOutcome;
  }

  // ── context windows (Layer 3) ──────────────────────────────────────────

  /** Last 3–5 translated lines before this chunk (see buildSlidingContext in chunker.ts). */
  private rollingContext(first: SrtBlock): ContextBlock[] {
    return buildSlidingContext(this.blocks, this.translations, this.positionOf.get(first.key)!, CONTEXT_WINDOW);
  }

  private neighbourContext(blocks: SrtBlock[]): ContextBlock[] {
    const keys = new Set<number>();
    for (const block of blocks) {
      const pos = this.positionOf.get(block.key)!;
      for (const p of [pos - 2, pos - 1, pos + 1, pos + 2]) if (p >= 0 && p < this.blocks.length) keys.add(p);
    }
    return [...keys]
      .sort((a, b) => a - b)
      .map((p) => this.blocks[p])
      .filter((b) => this.translations.has(b.key) && !this.failures.has(b.key) && !isUntranslatable(b.text))
      .slice(0, 12)
      .map((b) => ({ source: b.text, sinhala: this.translations.get(b.key)! }));
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async holdIfPaused(signal: AbortSignal): Promise<void> {
    while (this.pauseRequested && !signal.aborted) {
      await new Promise<void>((resolve) => {
        this.resumeWaiters.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (signal.aborted) throw signal.reason ?? new Error("Aborted");
  }

  private log(level: JobEvent["level"], message: string): void {
    this.events.push({ at: Date.now(), level, message });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    logger[level]({ jobId: this.id }, message);
  }

  // ── public views ───────────────────────────────────────────────────────

  toSrt(): { content: string; complete: boolean } {
    const complete = this.state === "complete";
    return { content: serializeSrt(this.blocks, this.translations, { includeUntranslated: complete }), complete };
  }

  snapshot() {
    const total = this.blocks.length;
    const translated = this.blocks.reduce((n, b) => n + (this.translations.has(b.key) && !this.failures.has(b.key) ? 1 : 0), 0);
    const model = this.chain[Math.min(this.chainIndex, this.chain.length - 1)];
    const strategy = model ? this.strategyFor(model) : "chunked";
    const pending = this.pendingBlocks();
    const remainingChunks = model && this.phase === "translating" ? estimateRemainingChunks(pending, strategy, this.options.chunkSize) : 0;
    const inFlight = this.state === "running" && this.currentChunk && this.phase === "translating" ? 1 : 0;
    const purityStatus = this.state !== "complete"
      ? this.failures.size ? "healing" : "monitoring"
      : this.unresolved.size ? "issues" : this.healed.size ? "healed" : "passed";

    const recent = this.blocks
      .filter((b) => this.translations.has(b.key) && !isUntranslatable(b.text))
      .slice(-6)
      .reverse()
      .map((b) => ({
        index: b.index,
        timestamp: b.timestamp,
        source: b.text,
        translation: this.translations.get(b.key)!,
        healed: this.healed.has(b.key),
        unresolved: this.unresolved.has(b.key),
      }));

    return {
      id: this.id,
      fileName: this.fileName,
      state: this.state,
      phase: this.phase,
      error: this.error ?? null,
      createdAt: this.createdAt,
      startedAt: this.startedAt ?? null,
      finishedAt: this.finishedAt ?? null,
      totalBlocks: total,
      translatedBlocks: translated,
      progress: total ? Math.round((translated / total) * 100) : 0,
      chunk: {
        completed: this.chunksDone,
        current: this.chunksDone + inFlight,
        estimatedTotal: this.chunksDone + Math.max(remainingChunks, inFlight),
        range: this.currentChunk ?? null,
      },
      primaryModel: this.options.modelId,
      activeModel: model?.id ?? null,
      activeStrategy: strategy,
      mode: this.options.mode,
      chunkSize: this.options.chunkSize,
      modelSwitches: this.modelSwitches,
      waiting: this.waiting && this.waiting.until > Date.now() ? this.waiting : null,
      purity: {
        status: purityStatus,
        foreignScriptBlocks: this.foreignScriptBlocks,
        parentheticalsStripped: this.parentheticalsStripped,
        autoCleaned: this.autoCleaned.size,
        healed: this.healed.size,
        pendingHeal: this.failures.size,
        unresolved: this.unresolved.size,
      },
      requests: this.requests,
      structureRetries: this.structureRetries,
      tokens: this.tokens,
      quota: this.chain.map((m) => ({ modelId: m.id, ...usageSnapshot(this.keyHash, m) })),
      recent,
      events: this.events.slice(-40).reverse(),
    };
  }
}

export type JobSnapshot = ReturnType<TranslationJob["snapshot"]>;
