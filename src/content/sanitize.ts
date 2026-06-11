/**
 * sanitize — the §5.4 security boundary between LLM output and the layout
 * engine. LLM text is NEVER parsed for game state; before it may even be
 * *displayed* it passes through this stateful stream sanitizer, which must
 * survive arbitrary hostile text arriving in arbitrary piece boundaries
 * (SSE deltas may split an escape sequence, a tag, anything).
 *
 * Pipeline, per code point:
 *   1. escape machine — ESC-introduced sequences (CSI, OSC, DCS/SOS/PM/APC
 *      strings, two-byte escapes incl. intermediates) and raw C1
 *      introducers are consumed and dropped; runaway sequences are capped
 *      so an unterminated OSC cannot swallow the stream.
 *   2. character filter — whitespace-ish C0 (\n \t \r \v \f) and exotic
 *      Unicode spaces → ' '; other C0/C1/DEL dropped; zero-width chars,
 *      soft hyphen, bidi marks/overrides/isolates, variation selectors and
 *      invisible tag characters dropped (width/ordering trickery).
 *   3. think machine — `<think>…</think>` spans dropped (case-insensitive,
 *      split-safe across pieces; stray closers dropped; a partial tag is
 *      held until it resolves, and flushed as literal text if it never
 *      becomes a tag).
 *   4. whitespace collapse — runs → one ' ', leading run dropped.
 *
 * Pure w.r.t. the outside world: no I/O, no clock, no randomness.
 */

export interface StreamSanitizer {
  /** Feed one piece; returns whatever became safely emittable. */
  push(piece: string): string
  /** End of stream: resolve held state (partial tags become literal). */
  flush(): string
}

const TAG_OPEN = '<think>'
const TAG_CLOSE = '</think>'

// escape-machine states
const GROUND = 0
const ESC = 1
const ESC_INTER = 2
const CSI = 3
const STR = 4
type EscState = typeof GROUND | typeof ESC | typeof ESC_INTER | typeof CSI | typeof STR

const CSI_MAX = 64 // params+intermediates cap before bailing to ground
const STR_MAX = 1024 // OSC/DCS/SOS/PM/APC payload cap
const INTER_MAX = 8

/** '' = drop, ' ' = whitespace, else the char itself. */
function filterChar(cp: number, ch: string): string {
  // whitespace-ish C0 + Unicode spaces / line separators → plain space
  if (cp === 0x0a || cp === 0x09 || cp === 0x0d || cp === 0x0b || cp === 0x0c) return ' '
  if (cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a)) return ' '
  if (cp === 0x2028 || cp === 0x2029 || cp === 0x205f || cp === 0x3000) return ' '
  // remaining C0, DEL, C1
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return ''
  // zero-width + joiners + BOM + soft hyphen + Mongolian vowel separator
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060) return ''
  if (cp === 0xfeff || cp === 0x00ad || cp === 0x180e) return ''
  // bidi marks / embeddings / overrides / isolates
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return ''
  if (cp >= 0x202a && cp <= 0x202e) return ''
  if (cp >= 0x2066 && cp <= 0x2069) return ''
  // variation selectors (incl. supplement) + invisible tag characters
  if (cp >= 0xfe00 && cp <= 0xfe0f) return ''
  if (cp >= 0xe0000 && cp <= 0xe01ef) return ''
  return ch
}

class Sanitizer implements StreamSanitizer {
  private out = ''
  // escape machine
  private esc: EscState = GROUND
  private escLen = 0
  private strEsc = false // saw ESC inside a string sequence (maybe ST)
  // think machine
  private inThink = false
  private thinkTail = '' // rolling window while inside a think span
  private tagBuf = '' // held chars that may still become <think> / </think>
  // whitespace collapse
  private spacePending = false
  private emittedAny = false

  push(piece: string): string {
    for (const ch of piece) {
      let re: string | null = ch
      // single bounded reprocess loop (string-abort hands a char back)
      while (re !== null) re = this.step(re)
    }
    const ready = this.out
    this.out = ''
    return ready
  }

  flush(): string {
    // a partial maybe-tag at end of stream was literal text after all
    if (!this.inThink && this.tagBuf !== '') {
      for (const ch of this.tagBuf) this.collapse(ch)
    }
    this.tagBuf = ''
    this.thinkTail = ''
    this.inThink = false
    this.esc = GROUND
    this.escLen = 0
    this.strEsc = false
    const ready = this.out
    this.out = ''
    return ready
  }

  /** Escape machine. Returns a char to reprocess, or null when consumed. */
  private step(ch: string): string | null {
    const cp = ch.codePointAt(0)!
    switch (this.esc) {
      case GROUND: {
        if (cp === 0x1b) {
          this.esc = ESC
          return null
        }
        if (cp === 0x9b) {
          this.esc = CSI
          this.escLen = 0
          return null
        }
        if (cp === 0x9d || cp === 0x90 || cp === 0x98 || cp === 0x9e || cp === 0x9f) {
          this.esc = STR
          this.escLen = 0
          this.strEsc = false
          return null
        }
        const f = filterChar(cp, ch)
        if (f !== '') this.feed(f)
        return null
      }
      case ESC: {
        if (cp === 0x5b) {
          // '['
          this.esc = CSI
          this.escLen = 0
          return null
        }
        if (cp === 0x5d || cp === 0x50 || cp === 0x58 || cp === 0x5e || cp === 0x5f) {
          // ']' OSC, 'P' DCS, 'X' SOS, '^' PM, '_' APC
          this.esc = STR
          this.escLen = 0
          this.strEsc = false
          return null
        }
        if (cp === 0x1b) return null // ESC ESC → still an escape
        if (cp >= 0x20 && cp <= 0x2f) {
          this.esc = ESC_INTER
          this.escLen = 0
          return null
        }
        this.esc = GROUND // two-char escape (ESC c, ESC 7, …) — dropped
        return null
      }
      case ESC_INTER: {
        if (cp >= 0x20 && cp <= 0x2f) {
          if (++this.escLen > INTER_MAX) this.esc = GROUND
          return null
        }
        this.esc = cp === 0x1b ? ESC : GROUND // final byte dropped
        return null
      }
      case CSI: {
        if (cp === 0x1b) {
          this.esc = ESC // hostile: new escape aborts the CSI
          return null
        }
        if (cp >= 0x40 && cp <= 0x7e) {
          this.esc = GROUND // final byte — sequence complete, dropped
          return null
        }
        // params (0x30–0x3F), intermediates (0x20–0x2F), stray controls:
        // consume, capped so garbage cannot run away
        if (++this.escLen > CSI_MAX) this.esc = GROUND
        return null
      }
      case STR: {
        if (this.strEsc) {
          this.strEsc = false
          if (cp === 0x5c) {
            this.esc = GROUND // ESC \ = ST, string terminated
            return null
          }
          this.esc = ESC // the ESC aborted the string and starts anew
          return ch // reprocess this char in ESC state
        }
        if (cp === 0x07 || cp === 0x9c) {
          this.esc = GROUND // BEL / C1 ST terminators
          return null
        }
        if (cp === 0x1b) {
          this.strEsc = true
          return null
        }
        if (++this.escLen > STR_MAX) this.esc = GROUND // runaway cap
        return null
      }
    }
  }

  /** Think machine over filtered chars. Bounded recursion (≤ tag length). */
  private feed(ch: string): void {
    if (this.inThink) {
      this.thinkTail = (this.thinkTail + ch.toLowerCase()).slice(-TAG_CLOSE.length)
      if (this.thinkTail.endsWith(TAG_CLOSE)) {
        this.inThink = false
        this.thinkTail = ''
      }
      return
    }
    if (this.tagBuf !== '') {
      this.tagBuf += ch
      const low = this.tagBuf.toLowerCase()
      if (low === TAG_OPEN) {
        this.inThink = true
        this.tagBuf = ''
        return
      }
      if (low === TAG_CLOSE) {
        this.tagBuf = '' // stray closer: drop the tag, keep surroundings
        return
      }
      if (TAG_OPEN.startsWith(low) || TAG_CLOSE.startsWith(low)) return // still maybe a tag
      // diverged — the held '<' was literal; re-scan the rest
      const rest = this.tagBuf.slice(1)
      this.tagBuf = ''
      this.collapse('<')
      for (const r of rest) this.feed(r)
      return
    }
    if (ch === '<') {
      this.tagBuf = '<'
      return
    }
    this.collapse(ch)
  }

  /** Whitespace collapse: runs → single space, leading run dropped. */
  private collapse(ch: string): void {
    if (ch === ' ') {
      this.spacePending = true
      return
    }
    if (this.spacePending) {
      if (this.emittedAny) this.out += ' '
      this.spacePending = false
    }
    this.out += ch
    this.emittedAny = true
  }
}

export function createSanitizer(): StreamSanitizer {
  return new Sanitizer()
}

/** One-shot convenience over the streaming sanitizer. */
export function sanitizeText(text: string): string {
  const s = createSanitizer()
  return s.push(text) + s.flush()
}
