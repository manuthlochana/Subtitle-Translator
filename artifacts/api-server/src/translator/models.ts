/**
 * Gemini multi-model registry.
 *
 * Single source of truth for model quotas (RPD / RPM / TPM), the execution
 * strategy each model is best suited for, and the automatic fallback chain.
 * The frontend reads this registry through `GET /api/translate/models`.
 */

export type ModelTier = "high-volume" | "ultra-quality" | "legacy";

/**
 * - `chunked`: 80–100 subtitle blocks per request with a rolling context window.
 * - `full`:    Full-SRT single pass (or 400–600 block mega-chunks when the file
 *              exceeds the safe token window). Used for low-RPD models so that no
 *              daily request is wasted on small chunks.
 */
export type ExecutionStrategy = "chunked" | "full";

/** User-selected execution mode. `auto` uses each model's recommended strategy. */
export type ExecutionMode = "auto" | ExecutionStrategy;

export interface ModelProfile {
  id: string;
  label: string;
  tier: ModelTier;
  /** Short UI description. */
  tagline: string;
  /** Optional UI badge, e.g. "Default", "Legacy / Not Recommended". */
  badge?: string;
  recommended?: boolean;
  legacy?: boolean;
  /** Requests per day. */
  rpd: number;
  /** Requests per minute. */
  rpm: number;
  /** Tokens per minute. */
  tpm: number;
  /** Minimum spacing between two requests to this model (per API key). */
  minIntervalMs: number;
  /** Recommended execution strategy. */
  strategy: ExecutionStrategy;
  /** Ordered fallback models tried after this one fails / is exhausted. */
  fallbacks: string[];
}

export const CHUNKED_BLOCKS = { min: 40, max: 150, default: 90, recommendedMin: 80, recommendedMax: 100 } as const;
export const MEGA_CHUNK_BLOCKS = { min: 400, max: 600, singlePassMax: 900 } as const;

const TIER1_LIMITS = { rpd: 500, rpm: 15, tpm: 250_000, minIntervalMs: 4_500 } as const;
const TIER2_LIMITS = { rpd: 20, rpm: 5, tpm: 250_000, minIntervalMs: 12_500 } as const;

const STABLE_TAIL = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export const MODEL_REGISTRY: readonly ModelProfile[] = [
  // ── Tier 1: High-volume chunking models ────────────────────────────────
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    tier: "high-volume",
    tagline: "Overall #1 for daily runs. Stable 80–100 block chunks with natural Sinhala rhythm.",
    badge: "Default",
    recommended: true,
    ...TIER1_LIMITS,
    strategy: "chunked",
    fallbacks: ["gemini-3.1-flash-lite"],
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    tier: "high-volume",
    tagline: "Official high-volume backup. Takes over automatically on quota / 429 errors.",
    badge: "Backup",
    ...TIER1_LIMITS,
    strategy: "chunked",
    fallbacks: [],
  },
  // ── Tier 2: Ultra-quality full-context models ──────────────────────────
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    tier: "ultra-quality",
    tagline: "#1 linguistic quality. Full-episode context preserves slang, sarcasm and adult humour.",
    badge: "Top Quality",
    recommended: true,
    ...TIER2_LIMITS,
    strategy: "full",
    fallbacks: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash", ...STABLE_TAIL],
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    tier: "ultra-quality",
    tagline: "Primary high-quality backup. Eliminates literal \"Google Translate\" phrasing.",
    badge: "Quality Backup",
    ...TIER2_LIMITS,
    strategy: "full",
    fallbacks: ["gemini-3.6-flash", "gemini-3-flash", ...STABLE_TAIL],
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    tier: "ultra-quality",
    tagline: "Base Gen-3 model. Secondary Tier-2 fallback.",
    ...TIER2_LIMITS,
    strategy: "full",
    fallbacks: ["gemini-3-flash", ...STABLE_TAIL],
  },
  {
    id: "gemini-3-flash",
    label: "Gemini 3 Flash",
    tier: "ultra-quality",
    tagline: "Base Gen-3 model. Secondary Tier-2 fallback.",
    ...TIER2_LIMITS,
    strategy: "full",
    fallbacks: [...STABLE_TAIL],
  },
  // ── Tier 3: Legacy (deprioritised / last resort) ───────────────────────
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    tier: "legacy",
    tagline: "Legacy model. Weaker Sinhala and more script bleeding.",
    badge: "Legacy / Not Recommended",
    legacy: true,
    rpd: 20,
    rpm: 10,
    tpm: 250_000,
    minIntervalMs: 6_500,
    strategy: "full",
    fallbacks: [...STABLE_TAIL],
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tier: "legacy",
    tagline: "Legacy model. Tends toward literal, textbook tone.",
    badge: "Legacy / Literal Tone",
    legacy: true,
    ...TIER2_LIMITS,
    strategy: "full",
    fallbacks: [...STABLE_TAIL],
  },
];

export const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

/**
 * Sampling temperature for Sinhala translation. A low value keeps token
 * selection stable, which avoids fragmented Sinhala glyphs (detached vowel
 * signs, broken conjuncts) and keeps repeated terms/pronouns consistent.
 */
export const SINHALA_TRANSLATION_TEMPERATURE = 0.2;

const BY_ID = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));

export function getModel(id: string): ModelProfile | undefined {
  return BY_ID.get(id);
}

/** Full ordered chain: the selected model followed by its fallbacks (deduplicated). */
export function getFallbackChain(id: string): ModelProfile[] {
  const primary = getModel(id);
  if (!primary) return [];
  const seen = new Set<string>();
  const chain: ModelProfile[] = [];
  for (const modelId of [primary.id, ...primary.fallbacks]) {
    const model = getModel(modelId);
    if (model && !seen.has(model.id)) {
      seen.add(model.id);
      chain.push(model);
    }
  }
  return chain;
}

/**
 * Strategy actually used for a model inside a job. The user's explicit mode only
 * overrides the *primary* model; fallback models always use their native
 * strategy (e.g. falling back from 3.8 Flash to 3.5 Flash Lite automatically
 * switches to 80–100 block chunk mode).
 */
export function resolveStrategy(model: ModelProfile, isPrimary: boolean, mode: ExecutionMode): ExecutionStrategy {
  if (isPrimary && mode !== "auto") return mode;
  return model.strategy;
}
