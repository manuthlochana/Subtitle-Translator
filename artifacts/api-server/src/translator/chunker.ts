/**
 * Smart chunker: decides how many pending blocks go into the next request.
 */

import { CHUNKED_BLOCKS, MEGA_CHUNK_BLOCKS, type ExecutionStrategy } from "./models";
import type { SrtBlock } from "./srt";

/**
 * Output-token budget per request. Leaves headroom under the 65K output cap
 * for model "thinking" tokens and Sinhala's higher token density.
 */
export const OUTPUT_TOKEN_BUDGET = 30_000;

/** Rough token estimate for English input. */
export function estimateInputTokens(blocks: SrtBlock[]): number {
  return Math.ceil(blocks.reduce((sum, b) => sum + b.text.length + 24, 0) / 3.5) + 1_200;
}

/** Rough token estimate for Sinhala JSON output (Sinhala is ~2 chars/token). */
export function estimateOutputTokens(blocks: SrtBlock[]): number {
  return Math.ceil(blocks.reduce((sum, b) => sum + b.text.length * 0.6 + 14, 0));
}

function capByTokens(blocks: SrtBlock[], take: number): number {
  let n = Math.max(1, Math.min(take, blocks.length));
  while (n > 1 && estimateOutputTokens(blocks.slice(0, n)) > OUTPUT_TOKEN_BUDGET) n = Math.floor(n * 0.85);
  return n;
}

/**
 * @param pending     blocks still to translate, in order
 * @param strategy    execution strategy of the active model
 * @param chunkSize   user preference for chunked mode (80–100 recommended)
 * @param shrink      adaptive divisor (>1 after truncation / malformed output)
 */
export function nextChunkSize(pending: SrtBlock[], strategy: ExecutionStrategy, chunkSize: number, shrink = 1): number {
  if (!pending.length) return 0;
  let take: number;
  if (strategy === "chunked") {
    take = Math.max(CHUNKED_BLOCKS.min, Math.min(CHUNKED_BLOCKS.max, chunkSize));
  } else if (pending.length <= MEGA_CHUNK_BLOCKS.singlePassMax && estimateOutputTokens(pending) <= OUTPUT_TOKEN_BUDGET) {
    // Full-SRT single pass: whole remaining episode in one request.
    take = pending.length;
  } else {
    // Mega-chunks: split evenly into 400–600 block requests.
    const parts = Math.ceil(pending.length / MEGA_CHUNK_BLOCKS.max);
    take = Math.max(MEGA_CHUNK_BLOCKS.min, Math.ceil(pending.length / parts));
  }
  take = Math.max(1, Math.floor(take / shrink));
  return capByTokens(pending, take);
}

/** Estimated number of remaining requests for progress display. */
export function estimateRemainingChunks(pending: SrtBlock[], strategy: ExecutionStrategy, chunkSize: number): number {
  let count = 0;
  let rest = pending;
  while (rest.length && count < 10_000) {
    const n = nextChunkSize(rest, strategy, chunkSize);
    rest = rest.slice(n);
    count += 1;
  }
  return count;
}
