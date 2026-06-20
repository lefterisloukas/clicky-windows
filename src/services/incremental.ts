// Incremental text processing shared across the streaming pipeline.
//
// Three concerns live here so the main-process orchestrator (companion.ts) and
// the TTS providers can reuse one implementation:
//
//  - `splitText`               : split a full string into <=maxChars chunks on
//                                sentence boundaries (used by the TTS providers
//                                for the non-streaming `speak()` path).
//  - `IncrementalPointExtractor`: emit each complete `[POINT:x,y:label:screenN]`
//                                tag exactly once as text streams in, buffering
//                                a trailing partial tag across chunk boundaries.
//  - `IncrementalSentenceExtractor`: strip POINT tags and emit completed
//                                sentences as text streams in, so TTS can speak
//                                the first sentence while the rest is generating.

/** Sentence-boundary separators, in priority order, shared by every splitter. */
const SENTENCE_SEPARATORS = [". ", "! ", "? ", ".\n", "!\n", "?\n"];

/**
 * Split `text` into chunks no longer than `maxChars`, preferring sentence
 * boundaries, then a comma, then a space, and finally a hard cut. Whitespace is
 * trimmed at chunk boundaries. Mirrors the logic previously duplicated in
 * kokoro.ts / openai.ts.
 */
export function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let breakAt = -1;
    const searchRange = remaining.substring(0, maxChars);

    for (const sep of SENTENCE_SEPARATORS) {
      const idx = searchRange.lastIndexOf(sep);
      if (idx > breakAt) breakAt = idx + sep.length;
    }
    if (breakAt <= 0) {
      const commaIdx = searchRange.lastIndexOf(", ");
      if (commaIdx > 0) breakAt = commaIdx + 2;
    }
    if (breakAt <= 0) {
      const spaceIdx = searchRange.lastIndexOf(" ");
      if (spaceIdx > 0) breakAt = spaceIdx + 1;
    }
    if (breakAt <= 0) breakAt = maxChars;

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/** A POINT tag parsed out of model text, still in image-pixel space. */
export interface RawPointTag {
  x: number;
  y: number;
  label: string;
  screen: number;
}

// Complete POINT tag. The label class excludes `]` (as well as `:`) so a `]`
// in surrounding prose can never be swallowed into a label, which would let a
// malformed match consume far too much text.
const POINT_TAG = /\[POINT:(\d+),(\d+):([^:\]]+):screen(\d+)\]/g;

/**
 * Feed streamed text fragments in via `push`; receive each complete POINT tag
 * exactly once. A tag split across two network chunks (e.g. `[POINT:120,3` then
 * `0:Save:screen0]`) is held in the internal buffer until it closes.
 */
export class IncrementalPointExtractor {
  private buf = "";

  push(chunk: string): RawPointTag[] {
    this.buf += chunk;
    const out: RawPointTag[] = [];

    POINT_TAG.lastIndex = 0;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = POINT_TAG.exec(this.buf)) !== null) {
      out.push({
        x: parseInt(m[1], 10),
        y: parseInt(m[2], 10),
        label: m[3],
        screen: parseInt(m[4], 10),
      });
      lastEnd = POINT_TAG.lastIndex;
    }

    // Retain only the tail that could still grow into a tag: everything from the
    // last unmatched `[` onward. Anything before it is settled prose we can drop
    // so the buffer stays bounded on long replies.
    const tail = this.buf.slice(lastEnd);
    const open = tail.lastIndexOf("[");
    this.buf = open >= 0 ? tail.slice(open) : "";

    return out;
  }
}

// Strips ANY complete POINT tag (loose label class — we only need to remove it
// from spoken text, not parse it). Used by the sentence extractor.
const ANY_POINT_TAG = /\[POINT:[^\]]*\]/g;

// Match a trailing, not-yet-closed `[...` so we can defer stripping it until the
// closing `]` arrives in a later chunk.
const TRAILING_OPEN = /\[[^\]]*$/;

/**
 * Feed streamed text fragments in via `push`; receive completed sentences with
 * POINT tags removed, suitable for handing to TTS. Call `flush` at end-of-stream
 * to retrieve any trailing fragment that never hit a sentence boundary.
 */
export class IncrementalSentenceExtractor {
  // Raw tail that may contain a partially-received POINT tag. Held back from
  // stripping until the tag closes (or the stream ends).
  private raw = "";
  // Stripped, spoken-ready text awaiting a sentence boundary.
  private spoken = "";

  constructor(private readonly maxChars = 180) {}

  push(chunk: string): string[] {
    this.raw += chunk;

    // Only strip up to the start of any trailing unclosed tag; keep that partial
    // buffered so a `:` or boundary char inside a half-received tag can't leak
    // into spoken text or split a sentence early.
    const openMatch = this.raw.match(TRAILING_OPEN);
    const safeUpTo = openMatch ? openMatch.index! : this.raw.length;
    const ready = this.raw.slice(0, safeUpTo).replace(ANY_POINT_TAG, "");
    this.raw = this.raw.slice(safeUpTo);
    this.spoken += ready;

    const out: string[] = [];
    let idx: number;
    while ((idx = this.nextBoundary(this.spoken)) >= 0) {
      const sentence = this.spoken.slice(0, idx).trim();
      if (sentence) out.push(sentence);
      this.spoken = this.spoken.slice(idx);
    }

    // Safety valve: a very long run with no boundary still flushes a chunk so
    // TTS never stalls waiting for punctuation and stays within Kokoro context.
    if (this.spoken.length > this.maxChars) {
      const [first] = splitText(this.spoken, this.maxChars);
      if (first && first.length < this.spoken.length) {
        out.push(first.trim());
        this.spoken = this.spoken.slice(first.length);
      }
    }

    return out;
  }

  /** Return the remaining spoken fragment (tags stripped) and reset. */
  flush(): string | null {
    const rest = (this.raw.replace(ANY_POINT_TAG, "") + this.spoken).trim();
    this.raw = "";
    this.spoken = "";
    return rest || null;
  }

  /** Index just past the first sentence separator in `s`, or -1 if none. */
  private nextBoundary(s: string): number {
    let best = -1;
    for (const sep of SENTENCE_SEPARATORS) {
      const idx = s.indexOf(sep);
      if (idx >= 0 && (best < 0 || idx + sep.length < best)) {
        best = idx + sep.length;
      }
    }
    return best;
  }
}
