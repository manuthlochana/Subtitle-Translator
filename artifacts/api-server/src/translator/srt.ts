/**
 * SRT parsing and serialisation.
 *
 * Every parsed block gets a stable internal `key` (its 1-based position) that is
 * used when talking to the model. The original index line and timestamp are
 * kept verbatim and re-attached on export, so the LLM can never alter numbering
 * or timing — structural integrity is enforced by code, not by the prompt alone.
 */

export interface SrtBlock {
  /** Stable internal id (1-based position as string) used in model I/O. */
  key: string;
  /** Original subtitle index line, preserved verbatim. */
  index: string;
  /** Original timestamp line, preserved verbatim. */
  timestamp: string;
  /** Original dialogue text (may contain <i>, ♪, multiple lines). */
  text: string;
}

export class SrtParseError extends Error {}

const TIMESTAMP_RE = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}.*$/;

export function parseSrt(contents: string): SrtBlock[] {
  const normalized = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new SrtParseError("This file is empty. Choose an SRT file with subtitle cues.");

  const rawBlocks = normalized.split(/\n[ \t]*\n+/);
  const blocks: SrtBlock[] = [];

  for (let i = 0; i < rawBlocks.length; i += 1) {
    const lines = rawBlocks[i].split("\n");
    const tsLine = lines.findIndex((line) => TIMESTAMP_RE.test(line));
    if (tsLine === -1) {
      // A block without a timestamp is either stray text or dialogue that
      // contained a blank line. Attach it to the previous block when possible.
      const prev = blocks[blocks.length - 1];
      if (prev && rawBlocks[i].trim()) {
        prev.text = `${prev.text}\n${rawBlocks[i].trimEnd()}`;
        continue;
      }
      if (!rawBlocks[i].trim()) continue;
      throw new SrtParseError(`Block ${i + 1} is malformed: no "00:00:00,000 --> 00:00:00,000" timestamp line was found.`);
    }
    const key = String(blocks.length + 1);
    const indexCandidate = tsLine > 0 ? lines[tsLine - 1].trim() : "";
    const index = /^\d+$/.test(indexCandidate) ? indexCandidate : key;
    const timestamp = lines[tsLine].trim();
    const text = lines.slice(tsLine + 1).join("\n").trimEnd();
    blocks.push({ key, index, timestamp, text });
  }

  if (!blocks.length) throw new SrtParseError("No valid subtitle cues were found.");
  return blocks;
}

/** True when a block has nothing that needs translating (empty, or only symbols/tags). */
export function isUntranslatable(text: string): boolean {
  const stripped = text.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "");
  return !/\p{L}/u.test(stripped);
}

export const UTF8_BOM = "\uFEFF";

/**
 * Serialise blocks to SRT. Uses CRLF line endings and a UTF-8 BOM so that
 * Windows/macOS players (VLC, IINA, MPC-HC, PotPlayer) detect the encoding and
 * render Sinhala without mojibake.
 */
export function serializeSrt(
  blocks: SrtBlock[],
  translations: ReadonlyMap<string, string>,
  options: { includeUntranslated: boolean },
): string {
  const out: string[] = [];
  for (const block of blocks) {
    const translated = translations.get(block.key);
    if (translated === undefined && !options.includeUntranslated) continue;
    const text = (translated ?? block.text).replace(/\r\n?/g, "\n");
    out.push([block.index, block.timestamp, text].join("\n"));
  }
  return UTF8_BOM + out.join("\n\n").replace(/\n/g, "\r\n") + "\r\n";
}
