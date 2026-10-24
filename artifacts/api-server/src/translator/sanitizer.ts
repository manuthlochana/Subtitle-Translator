/**
 * Layer 2 of the 3-layer defence: post-processing sanitizer & script validator.
 *
 * Every LLM response passes through `sanitizeAndValidateSinhalaSRT` before any
 * block is accepted. Blocks that contain foreign-script characters, are
 * missing, or are left untranslated are rejected and handed to the auto-heal
 * micro-retry loop in the engine.
 */

import type { SrtBlock } from "./srt";

/** Forbidden Unicode blocks known to bleed into Sinhala output. */
export const FORBIDDEN_SCRIPTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Tamil", re: /[\u0B80-\u0BFF]/u },
  { name: "Telugu", re: /[\u0C00-\u0C7F]/u },
  { name: "Kannada", re: /[\u0C80-\u0CFF]/u },
  { name: "Malayalam", re: /[\u0D00-\u0D7F]/u },
  { name: "Bengali", re: /[\u0980-\u09FF]/u },
  { name: "Devanagari", re: /[\u0900-\u097F]/u },
  { name: "Georgian", re: /[\u10A0-\u10FF]/u },
  { name: "Myanmar", re: /[\u1000-\u109F]/u },
  { name: "Ethiopic", re: /[\u1200-\u137F]/u },
  { name: "Arabic", re: /[\u0600-\u06FF]/u },
];

const FORBIDDEN_ANY = /[\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0980-\u09FF\u0900-\u097F\u10A0-\u10FF\u1000-\u109F\u1200-\u137F\u0600-\u06FF]/u;
const FORBIDDEN_ANY_G = new RegExp(FORBIDDEN_ANY.source, "gu");

/**
 * Sinhala Unicode block U+0D80–U+0DFF: letters, anusvara/visarga, virama (හල් කිරීම),
 * vowel signs (පිලි / ඇලපිලි …), Sinhala digits and punctuation. NOTHING in this
 * range may ever be removed or altered by the cleaning code below.
 */
const SINHALA_RANGE = "\\u0D80-\\u0DFF";
/** Joiners are REQUIRED by Sinhala for conjuncts (ක්‍ර, ශ්‍රී, ක්‍ය …). They must never be stripped. */
const JOINERS = "\\u200C\\u200D";
/** Dependent signs that must stay attached to a preceding base letter: ං ඃ ් ා ැ ෑ ි ී ු ූ ෘ ෙ ේ ෛ ො ෝ ෞ ෟ ෲ ෳ */
const DEPENDENT_SIGNS = "\\u0D82\\u0D83\\u0DCA\\u0DCF-\\u0DDF\\u0DF2\\u0DF3";

const SINHALA_CHAR = new RegExp(`[${SINHALA_RANGE}]`, "u");
const SINHALA_CHAR_G = new RegExp(`[${SINHALA_RANGE}]`, "gu");
const SINHALA_ONLY_WORDS = new RegExp(`^[${SINHALA_RANGE}${JOINERS}\\s.,!?'"’‘“”…\\-–—]+$`, "u");
/** A dependent sign with no base letter before it (start of text, or after a non-Sinhala character / whitespace). */
const ORPHAN_SIGN = new RegExp(`(?:^|[^${SINHALA_RANGE}${JOINERS}])[${DEPENDENT_SIGNS}]`, "u");
/** Any letter/mark that is not Sinhala, Latin, or script-neutral (Common/Inherited — this includes ZWJ/ZWNJ). */
const OTHER_SCRIPT_LETTER = /(?![\p{Script=Sinhala}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{M}]/u;
const OTHER_SCRIPT_LETTER_G = new RegExp(OTHER_SCRIPT_LETTER.source, "gu");

/**
 * Invisible characters to drop. Deliberately excludes U+200C (ZWNJ) and
 * U+200D (ZWJ): Sinhala needs them, and removing them detaches/corrupts conjuncts.
 * (Zero-width space U+200B, word joiner U+2060, BOM U+FEFF, soft hyphen and bidi
 * controls are safe to drop.)
 */
const INVISIBLES = /[\u200B\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/gu;
/** C0 control characters except \n (and tab). Never touches the Sinhala block. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

const LEAKED_TIMESTAMP = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}.*$/;
const HAS_BRACKETS = /[()（）[\]]/u;
/** `<word> (<gloss>)` — captures the token before the parentheses and the parenthetical content. */
const PAREN_AFTER_WORD = /([^\s()（）]+)\s*[(（]\s*([^()（）]*?)\s*[)）]/gu;
const ANY_PAREN_GROUP = /\s*[(（][^()（）]*[)）]/gu;

export interface LineCheck {
  text: string;
  /** Problems that make the block unacceptable (triggers auto-heal). */
  problems: string[];
  /** Non-fatal automatic fixes applied. */
  fixes: string[];
  foreignScripts: string[];
}

export function detectForeignScripts(text: string): string[] {
  const found = new Set<string>();
  for (const { name, re } of FORBIDDEN_SCRIPTS) if (re.test(text)) found.add(name);
  if (!found.size) {
    const match = text.match(OTHER_SCRIPT_LETTER);
    if (match) found.add(`Other script (U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
  }
  return [...found];
}

/** Last-resort scrub used only when auto-heal is exhausted. */
export function stripForeignScripts(text: string): string {
  return text.replace(FORBIDDEN_ANY_G, "").replace(OTHER_SCRIPT_LETTER_G, "").replace(/[ \t]{2,}/g, " ").trim();
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Removes parenthetical hallucinations when the English source has no brackets:
 *   `সিরিয়ස් (බරපතල)`      → `බරපතල`        (foreign word + Sinhala gloss: keep the Sinhala)
 *   `practice (ප්රැක්ටිස්)`  → `ප්රැක්ටිස්`     (English word + Sinhala: keep the Sinhala)
 *   `ප්රැක්ටිස් (පුහුණුව)`  → `ප්රැක්ටිස්`     (Sinhala word + Sinhala gloss: keep the word)
 *   `සීරියස් (serious)`      → `සීරියස්`       (any other note: drop it)
 */
function stripParentheticals(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(PAREN_AFTER_WORD, (whole, word: string, inner: string) => {
    count += 1;
    const wordIsSinhala = SINHALA_CHAR.test(word) && !FORBIDDEN_ANY.test(word) && !/[A-Za-z]/.test(word);
    const innerIsSinhala = inner.length > 0 && SINHALA_ONLY_WORDS.test(inner);
    if (!wordIsSinhala && innerIsSinhala) return inner;
    return word;
  });
  out = out.replace(ANY_PAREN_GROUP, () => {
    count += 1;
    return "";
  });
  return { text: out, count };
}

function preserveMarkup(source: string, output: string, fixes: string[]): string {
  let text = output;
  const src = source.trim();
  if (src.startsWith("<i>") && src.endsWith("</i>") && !text.includes("<i>")) {
    text = `<i>${text}</i>`;
    fixes.push("restored <i> tags");
  }
  const opens = countOf(text, "<i>");
  const closes = countOf(text, "</i>");
  if (opens > closes) {
    text += "</i>".repeat(opens - closes);
    fixes.push("balanced <i> tags");
  }
  if (src.includes("♪") && !text.includes("♪")) {
    if (src.replace(/^<i>/, "").trimStart().startsWith("♪")) text = text.replace(/^(<i>)?/, (m) => `${m}♪ `);
    if (src.replace(/<\/i>$/, "").trimEnd().endsWith("♪")) text = text.replace(/(<\/i>)?$/, (m) => ` ♪${m}`);
    fixes.push("restored ♪ symbols");
  }
  return text;
}

/** Sanitises and validates a single translated subtitle block. */
export function validateSinhalaBlock(source: string, raw: string): LineCheck {
  const problems: string[] = [];
  const fixes: string[] = [];

  let text = raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(INVISIBLES, "").replace(CONTROL_CHARS, "");
  // Drop leaked SRT structure (index / timestamp lines) the model may echo back.
  const lines = text.split("\n").filter((line, i) => {
    if (LEAKED_TIMESTAMP.test(line)) return false;
    // A bare-number first line is only a leaked SRT index if that number is NOT part of the source dialogue.
    if (i === 0 && /^\s*\d+\s*$/.test(line) && !source.includes(line.trim())) return false;
    return true;
  });
  text = lines.map((l) => l.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " ")).join("\n").trim();

  if (!HAS_BRACKETS.test(source) && HAS_BRACKETS.test(text)) {
    const stripped = stripParentheticals(text);
    if (stripped.count) {
      text = stripped.text.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?…])/g, "$1").trim();
      fixes.push(`stripped ${stripped.count} parenthetical note${stripped.count === 1 ? "" : "s"}`);
    }
  }

  const foreignScripts = detectForeignScripts(text);
  if (foreignScripts.length) problems.push(`foreign script detected: ${foreignScripts.join(", ")}`);

  // Dependent vowel signs / virama must always follow a base consonant; a detached one means the glyph is corrupted.
  if (ORPHAN_SIGN.test(text.replace(/<[^>]+>/g, ""))) problems.push("detached Sinhala vowel sign (corrupted glyph)");

  const sourceLetters = source.replace(/<[^>]+>/g, "").match(/\p{L}/gu)?.length ?? 0;
  const plain = text.replace(/<[^>]+>/g, "");
  if (!plain.trim()) {
    problems.push("empty translation");
  } else if (sourceLetters > 0) {
    const sinhala = plain.match(SINHALA_CHAR_G)?.length ?? 0;
    const latin = plain.match(/[A-Za-z]/g)?.length ?? 0;
    if (sinhala === 0) problems.push("not translated (no Sinhala text)");
    else if (latin > sinhala) problems.push("mostly untranslated English");
  }

  if (!problems.length) text = preserveMarkup(source, text, fixes);
  return { text, problems, fixes, foreignScripts };
}

export interface RejectedBlock {
  block: SrtBlock;
  rejectedOutput?: string;
  reasons: string[];
}

export interface SanitizeResult {
  accepted: Map<string, string>;
  rejected: RejectedBlock[];
  stats: {
    autoCleaned: number;
    parentheticalsStripped: number;
    foreignScriptBlocks: number;
    missing: number;
    unexpectedIds: number;
  };
}

/** Normalises a model-provided id (integer or numeric string) to the internal string key. */
export function normaliseId(id: unknown): string | undefined {
  if (typeof id === "number" && Number.isFinite(id)) return String(Math.trunc(id));
  if (typeof id === "string" && /^\s*\d+\s*$/.test(id)) return String(Number(id.trim()));
  return undefined;
}

export interface StructureCheck {
  ok: boolean;
  issues: string[];
}

/**
 * Strict structural validation of a model response BEFORE any block is accepted:
 *  - it is a JSON array whose length equals the number of requested blocks
 *  - every id is one of the requested ids, appears exactly once (1:1), none omitted
 * A failure means the model merged, split, dropped or duplicated lines and the
 * whole chunk must be re-requested (never patched by copying neighbouring lines).
 */
export function checkResponseStructure(expected: SrtBlock[], raw: unknown): StructureCheck {
  if (!Array.isArray(raw)) return { ok: false, issues: ["response is not a JSON array"] };
  const issues: string[] = [];
  if (raw.length !== expected.length) {
    issues.push(`length mismatch: expected ${expected.length} items, got ${raw.length}`);
  }

  const expectedIds = new Set(expected.map((b) => b.key));
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unexpected: string[] = [];
  let invalid = 0;
  for (const item of raw) {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const id = normaliseId(rec?.id);
    if (id === undefined || typeof rec?.text !== "string") {
      invalid += 1;
    } else if (!expectedIds.has(id)) {
      unexpected.push(id);
    } else if (seen.has(id)) {
      duplicate.push(id);
    } else {
      seen.add(id);
    }
  }
  const missing = expected.filter((b) => !seen.has(b.key)).map((b) => b.key);
  const sample = (ids: string[]) => `${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ` … (+${ids.length - 6})` : ""}`;
  if (invalid) issues.push(`${invalid} item(s) without a valid {id, text}`);
  if (missing.length) issues.push(`missing id(s): ${sample(missing)}`);
  if (duplicate.length) issues.push(`duplicate id(s): ${sample(duplicate)}`);
  if (unexpected.length) issues.push(`unexpected id(s): ${sample(unexpected)}`);
  return { ok: issues.length === 0, issues };
}

/**
 * Validates a whole model response against the blocks that were requested.
 * Accepts only blocks that are present, pure Sinhala, and actually translated.
 */
export function sanitizeAndValidateSinhalaSRT(expected: SrtBlock[], raw: unknown): SanitizeResult {
  const result: SanitizeResult = {
    accepted: new Map(),
    rejected: [],
    stats: { autoCleaned: 0, parentheticalsStripped: 0, foreignScriptBlocks: 0, missing: 0, unexpectedIds: 0 },
  };

  const byId = new Map<string, string>();
  const expectedIds = new Set(expected.map((b) => b.key));
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = normaliseId(rec.id);
      const text = typeof rec.text === "string" ? rec.text : typeof rec.translatedText === "string" ? rec.translatedText : undefined;
      if (id === undefined || text === undefined) continue;
      if (!expectedIds.has(id)) {
        result.stats.unexpectedIds += 1;
        continue;
      }
      if (!byId.has(id)) byId.set(id, text);
    }
  }

  let previous: { source: string; text: string } | undefined;
  for (const block of expected) {
    const output = byId.get(block.key);
    if (output === undefined) {
      result.stats.missing += 1;
      result.rejected.push({ block, reasons: [Array.isArray(raw) ? "missing from model output" : "malformed model response"] });
      previous = undefined;
      continue;
    }
    const check = validateSinhalaBlock(block.text, output);
    if (check.fixes.length) result.stats.autoCleaned += 1;
    if (check.fixes.some((f) => f.startsWith("stripped"))) result.stats.parentheticalsStripped += 1;
    if (check.foreignScripts.length) result.stats.foreignScriptBlocks += 1;

    // A block must never just repeat its neighbour's translation (the signature of merged/shifted lines).
    if (
      !check.problems.length &&
      previous &&
      previous.source.trim() !== block.text.trim() &&
      check.text.length > 8 &&
      previous.text === check.text
    ) {
      check.problems.push("duplicates the previous block's translation");
    }

    if (check.problems.length) {
      // Keep `previous` = last ACCEPTED block, so a run of repeated lines is rejected as a whole.
      result.rejected.push({ block, rejectedOutput: output, reasons: check.problems });
    } else {
      result.accepted.set(block.key, check.text);
      previous = { source: block.text, text: check.text };
    }
  }
  return result;
}

/**
 * Regression self-test: runs known-good Sinhala (conjuncts with ZWJ, dependent
 * vowel signs, virama, loan words, digits) through the sanitizer and reports
 * any character that was stripped, altered or detached. Returns failure messages
 * (empty array = all good).
 */
export function selfTestSinhalaPreservation(): string[] {
  const samples: Array<[string, string]> = [
    ["Sri Lanka", "ශ්\u200Dරී ලංකාව"],
    ["Cricket", "ක්\u200Dරිකට් ගහමු"],
    ["Rakaransaya and yansaya", "ප්\u200Dරශ්නය තියෙන්නේ ක්\u200Dෂණිකව"],
    ["Vowel signs", "කියන්න බැහැ, දැන් මේක පිළිගන්න ඕනේ, ඒක ගොඩක් ලස්සනයි"],
    ["Loan words", "ප්රැක්ටිස්, සීරියස්, පාටි, කොලේජ්, රූම් මේට්, සෙනෙටර්"],
    ["It costs $75", "ඩොලර් 75ක් වැය වෙනවා"],
    ["<i>Hey</i>", "<i>ඔයා ඇත්තටම හිතනවාද?</i>"],
  ];
  const failures: string[] = [];
  for (const [source, sinhala] of samples) {
    const { text, problems } = validateSinhalaBlock(source, sinhala);
    const original = sinhala.normalize("NFC");
    if (problems.length) failures.push(`"${sinhala}" rejected: ${problems.join("; ")}`);
    if (text !== original) failures.push(`"${sinhala}" altered to "${text}"`);
    if ((text.match(SINHALA_CHAR_G)?.length ?? 0) !== (original.match(SINHALA_CHAR_G)?.length ?? 0)) {
      failures.push(`"${sinhala}" lost Sinhala characters`);
    }
    if ((text.match(/\u200D/g)?.length ?? 0) !== (original.match(/\u200D/g)?.length ?? 0)) {
      failures.push(`"${sinhala}" lost ZWJ characters`);
    }
  }
  const orphan = validateSinhalaBlock("Test", "\u0DD2 කියන්නේ මොකක්ද");
  if (!orphan.problems.some((p) => p.includes("detached"))) failures.push("detached vowel sign was not detected");
  return failures;
}
