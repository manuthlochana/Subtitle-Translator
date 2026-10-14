/**
 * Layer 1 of the 3-layer defence: prompts.
 *
 * SYSTEM_PROMPT is the battle-tested localisation instruction. The OUTPUT
 * CONTRACT is appended separately: the engine sends each block as {id, text}
 * and re-attaches the original index/timestamp itself, so structure is
 * guaranteed by code even if the model misbehaves.
 */

import type { SrtBlock } from "./srt";

export const SYSTEM_PROMPT = `You are an elite localization specialist and native Sinhala screenwriter. Your task is to translate English SRT subtitle blocks into 100% natural, spoken Sri Lankan Sinhala (කතා කරන ස්වභාවික සිංහල).

CRITICAL TRANSLATION & LINGUISTIC RULES:
1. NATURAL SPOKEN SINHALA ONLY: Never translate word-for-word (No Google Translate style). Translate the *intent, emotion, and subtext*. Use authentic Sri Lankan colloquial phrasing (e.g., use "මොන මඟුලක්ද", "පිස්සුද", "සිරාවටම", "ආතල්", "චාටර්" where contextually appropriate for youth/casual shows).
2. SLANG, SARCASM & ADULT HUMOR: Preserve the exact tone of the characters. If the source contains profanity, sexual humor, or teen/college slang, adapt it naturally into raw, authentic spoken Sinhala without censoring or making it sound like a textbook.
3. ZERO FOREIGN SCRIPTS (STRICT UNICODE LOCK): You are strictly forbidden from outputting ANY characters from Tamil, Telugu, Bengali, Malayalam, Kannada, Hindi, Georgian, Burmese, Arabic, or Amharic scripts. Every single translated word must be written exclusively in Sinhala Unicode (U+0D80 to U+0DFF).
4. LOAN WORDS & ENGLISH TERMS: When keeping common English words used in Sinhala speech (e.g., "practice", "serious", "party", "college", "roommate", "senator"), transliterate them directly into Sinhala script (ප්රැක්ටිස්, සීරියස්, පාටි, කොලේජ්, රූම් මේට්). NEVER write the English word in another script and NEVER add parenthetical explanations like "ප්රැක්ටිස් (පුහුණුව)".
5. NO PARENTHESES OR TRANSLATOR NOTES: Do not add brackets \`()\` explaining words. Output ONLY the dialogue.
6. SRT STRUCTURAL INTEGRITY: 
   - Keep the exact Subtitle Index numbers and Timestamps (\`00:00:00,000 --> 00:00:00,000\`) 100% identical to the input.
   - Preserve HTML tags like \`<i>\`, \`</i>\`, and music symbols \`♪\`.
   - Maintain the exact number of subtitle blocks. Do not merge or skip blocks.`;

export const OUTPUT_CONTRACT = `OUTPUT FORMAT (MACHINE-VALIDATED):
- Subtitle index numbers and timestamps are locked by the system. You receive each subtitle block as a JSON object {"id": "<block id>", "text": "<English dialogue>"}.
- Return ONLY a JSON array with exactly one object per input block, in the same order: [{"id": "<same id>", "text": "<Sinhala dialogue>"}].
- Never change, merge, skip, or invent ids. Keep line breaks (\\n) inside a block where they help readability.
- Every response is scanned character-by-character. Any non-Sinhala script or parenthetical note causes the block to be rejected and re-requested.`;

export const TRANSLATION_SYSTEM_INSTRUCTION = `${SYSTEM_PROMPT}\n\n${OUTPUT_CONTRACT}`;

export const REPAIR_SYSTEM_INSTRUCTION = `${SYSTEM_PROMPT}

${OUTPUT_CONTRACT}

REPAIR MODE — STRICT:
The blocks you receive were REJECTED by an automated Unicode/quality validator. For each block:
- Re-translate from the ENGLISH SOURCE. Do not patch or reuse the rejected output.
- Use ONLY Sinhala Unicode letters (U+0D80–U+0DFF) for words, plus the punctuation, digits, HTML tags and ♪ symbols already present in the source.
- Transliterate English loan words and names into Sinhala script. Never output Tamil, Telugu, Kannada, Malayalam, Bengali, Hindi/Devanagari, Georgian, Burmese, Amharic or Arabic characters.
- No brackets or translator notes unless the English source itself contains brackets.
- Never leave a block in English.`;

/** Gemini structured-output schema: array of {id, text}. */
export const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      text: { type: "STRING" },
    },
    required: ["id", "text"],
    propertyOrdering: ["id", "text"],
  },
} as const;

export interface ContextBlock {
  source: string;
  sinhala: string;
}

/**
 * Builds the user turn for a translation chunk. `context` implements Layer 3:
 * the last few translated blocks from the previous chunk are supplied as
 * READ-ONLY context so pronouns (ඔයා / උඹ / තමුසේ / එයා), gender and running
 * jokes stay consistent across chunk boundaries.
 */
export function buildChunkPrompt(blocks: SrtBlock[], context: ContextBlock[]): string {
  const parts: string[] = [];
  if (context.length) {
    parts.push(
      "READ-ONLY CONTEXT — the previous subtitle blocks, already translated. Use them ONLY to keep speaker voice, pronouns (ඔයා/උඹ/තමුසේ/එයා), gender and running jokes consistent. Do NOT translate or output them again:",
      JSON.stringify(context),
      "",
    );
  }
  parts.push(
    `TRANSLATE THESE ${blocks.length} SUBTITLE BLOCKS. Return exactly ${blocks.length} objects with the same ids, in the same order:`,
    JSON.stringify(blocks.map((b) => ({ id: b.key, text: b.text }))),
  );
  return parts.join("\n");
}

export interface RepairItem {
  block: SrtBlock;
  rejectedOutput?: string;
  reasons: string[];
}

export function buildRepairPrompt(items: RepairItem[], context: ContextBlock[]): string {
  const parts: string[] = [];
  if (context.length) {
    parts.push(
      "READ-ONLY CONTEXT — nearby blocks that already passed validation (do NOT output them):",
      JSON.stringify(context),
      "",
    );
  }
  parts.push(
    "REJECTED BLOCKS (reason and rejected output shown for reference only — do not reuse it):",
    JSON.stringify(
      items.map((item) => ({
        id: item.block.key,
        reason: item.reasons.join("; "),
        rejected: item.rejectedOutput ?? null,
      })),
    ),
    "",
    `RE-TRANSLATE THESE ${items.length} BLOCKS FROM THE ENGLISH SOURCE. Return exactly ${items.length} objects with the same ids:`,
    JSON.stringify(items.map((item) => ({ id: item.block.key, text: item.block.text }))),
  );
  return parts.join("\n");
}
