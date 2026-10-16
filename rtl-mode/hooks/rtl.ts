// Display-only bidi rewriting for markdown text that holds Hebrew.
//
// Each line with Hebrew in it takes its direction from the letters outside
// quotes, code spans and links. A Hebrew line opens with RLM + RLE and its
// English code spans are wrapped LRE...PDF; an English line opens with
// LRM + LRE and its Hebrew quotes (inside the quote marks) and other Hebrew
// runs are wrapped RLE...PDF. The marks go after the line's markdown prefix
// and nothing closes the line's own embedding.

export const RLM = '‏'
export const LRM = '‎'
export const LRE = '‪'
export const RLE = '‫'
export const PDF = '‬'

const HEBREW = /\p{Script=Hebrew}/u
const HEBREW_LETTER = /[א-תװ-ײיִ-ﭏ]/u
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/u
const HEBREW_OR_DIGIT = /[\p{Script=Hebrew}\p{N}]/u
const WORD = /[\p{L}\p{N}]/u
const TRAILING_PUNCTUATION = /[.,;:!?…]/u

// Indent, blockquote marks, then a heading, bullet (with a task box) or number.
const PREFIX =
  /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LINK = /^!?\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"]*")?\)/
const AUTOLINK = /^<(?:https?|mailto|file):[^>\s]+>/
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>()]+/

const QUOTE_CLOSERS: Record<string, string> = {
  '"': '"',
  '“': '”“',
  '”': '”',
  '„': '“”',
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; inner: string }
  | { kind: 'link'; text: string }
  | { kind: 'quote'; open: string; inner: string; close: string }

type Counts = { hebrew: number; latin: number }

function count(text: string): Counts {
  let hebrew = 0
  let latin = 0
  for (const c of text) {
    if (HEBREW_LETTER.test(c)) hebrew += 1
    else if (LATIN_LETTER.test(c)) latin += 1
  }
  return { hebrew, latin }
}

function isHebrewMajority(text: string): boolean {
  const { hebrew, latin } = count(text)
  return hebrew > latin
}

function isWord(c: string | undefined): boolean {
  return c !== undefined && WORD.test(c)
}

function runLength(text: string, at: number, c: string): number {
  let n = 0
  while (text[at + n] === c) n += 1
  return n
}

// The end (exclusive) of a code span opening at `at`, or -1.
function codeSpanEnd(text: string, at: number): number {
  const n = runLength(text, at, '`')
  let j = at + n
  while (j < text.length) {
    if (text[j] === '`') {
      const m = runLength(text, j, '`')
      if (m === n) return j + m
      j += m
    } else {
      j += 1
    }
  }
  return -1
}

// The index of the closing quote mark for one opening at `at`, or -1. A mark
// between two letters (gershayim, as in צה"ל) neither opens nor closes.
function quoteEnd(text: string, at: number): number {
  const closers = QUOTE_CLOSERS[text[at] ?? '']
  if (!closers || isWord(text[at - 1])) return -1
  if (text[at + 1] === undefined || /\s/.test(text[at + 1]!)) return -1
  for (let j = at + 2; j < text.length; j += 1) {
    if (text[j] === '`') return -1
    if (closers.includes(text[j]!) && !isWord(text[j + 1]) && !/\s/.test(text[j - 1]!)) {
      return j
    }
  }
  return -1
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let plain = ''
  const flush = () => {
    if (plain) tokens.push({ kind: 'text', text: plain })
    plain = ''
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '`') {
      const end = codeSpanEnd(text, i)
      if (end === -1) {
        const n = runLength(text, i, '`')
        plain += text.slice(i, i + n)
        i += n
        continue
      }
      const span = text.slice(i, end)
      const ticks = runLength(text, i, '`')
      flush()
      tokens.push({ kind: 'code', text: span, inner: span.slice(ticks, -ticks) })
      i = end
      continue
    }
    const rest = text.slice(i)
    const link =
      c === '[' || c === '!'
        ? LINK.exec(rest)
        : c === '<'
          ? AUTOLINK.exec(rest)
          : !isWord(text[i - 1])
            ? BARE_URL.exec(rest)
            : null
    if (link) {
      flush()
      tokens.push({ kind: 'link', text: link[0] })
      i += link[0].length
      continue
    }
    const close = quoteEnd(text, i)
    if (close !== -1) {
      flush()
      tokens.push({
        kind: 'quote',
        open: c,
        inner: text.slice(i + 1, close),
        close: text[close]!,
      })
      i = close + 1
      continue
    }
    plain += c
    i += 1
  }
  flush()
  return tokens
}

function tokenText(token: Token): string {
  return token.kind === 'quote' ? token.open + token.inner + token.close : token.text
}

// Wraps each Hebrew run of English-line text in RLE...PDF: from a Hebrew
// letter to its last Hebrew letter or digit before the next Latin letter,
// with the punctuation that ends it.
function wrapHebrewRuns(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    let start = i
    while (start < text.length && !HEBREW_LETTER.test(text[start]!)) start += 1
    if (start === text.length) {
      out += text.slice(i)
      break
    }
    let stop = start
    while (stop < text.length && !LATIN_LETTER.test(text[stop]!)) stop += 1
    let end = stop
    while (end > start && !HEBREW_OR_DIGIT.test(text[end - 1]!)) end -= 1
    while (end < stop && TRAILING_PUNCTUATION.test(text[end]!)) end += 1
    out += text.slice(i, start) + RLE + text.slice(start, end) + PDF
    i = end
  }
  return out
}

function isEnglishCode(inner: string): boolean {
  const { hebrew, latin } = count(inner)
  return hebrew === 0 || latin > hebrew
}

function firstStrongIsHebrew(text: string): boolean {
  for (const c of text) {
    if (HEBREW_LETTER.test(c)) return true
    if (LATIN_LETTER.test(c)) return false
  }
  return false
}

export function isRtlLine(content: string): boolean {
  const tokens = tokenize(content)
  let { hebrew, latin } = count(
    tokens.map(t => (t.kind === 'text' ? t.text : '')).join(''),
  )
  if (hebrew === 0 && latin === 0) ({ hebrew, latin } = count(content))
  if (hebrew !== latin) return hebrew > latin
  return firstStrongIsHebrew(content)
}

// One line's content, its markdown prefix already taken off.
export function rtlContent(content: string): string {
  if (!HEBREW.test(content)) return content
  const tokens = tokenize(content)
  if (isRtlLine(content)) {
    return (
      RLM +
      RLE +
      tokens
        .map(t =>
          t.kind === 'code' && isEnglishCode(t.inner) ? LRE + t.text + PDF : tokenText(t),
        )
        .join('')
    )
  }
  return (
    LRM +
    LRE +
    tokens
      .map(t => {
        if (t.kind === 'quote' && isHebrewMajority(t.inner)) {
          return t.open + RLE + t.inner + PDF + t.close
        }
        if (t.kind === 'text') return wrapHebrewRuns(t.text)
        return tokenText(t)
      })
      .join('')
  )
}

// Splits a table row at its unescaped pipes outside code spans and rewrites
// each cell on its own.
function rtlTableRow(line: string): string {
  const cells: string[] = []
  let cell = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === '\\' && i + 1 < line.length) {
      cell += line.slice(i, i + 2)
      i += 2
    } else if (c === '`') {
      const end = codeSpanEnd(line, i)
      const n = end === -1 ? runLength(line, i, '`') : end - i
      cell += line.slice(i, i + n)
      i += n
    } else if (c === '|') {
      cells.push(cell)
      cell = ''
      i += 1
    } else {
      cell += c
      i += 1
    }
  }
  cells.push(cell)
  return cells
    .map(one => {
      const [, lead = '', core = '', trail = ''] = /^(\s*)(.*?)(\s*)$/su.exec(one) ?? []
      return lead + rtlContent(core) + trail
    })
    .join('|')
}

export function rtlText(text: string): string {
  if (!HEBREW.test(text)) return text
  let fence: string | null = null
  return text
    .split('\n')
    .map(line => {
      const opener = FENCE.exec(line)
      if (fence !== null) {
        const closer = opener?.[1]
        if (
          closer &&
          closer[0] === fence[0] &&
          closer.length >= fence.length &&
          line.trim() === closer
        ) {
          fence = null
        }
        return line
      }
      if (opener) {
        fence = opener[1]!
        return line
      }
      if (!HEBREW.test(line)) return line
      if (/^\s*\|/.test(line)) return rtlTableRow(line)
      const prefix = PREFIX.exec(line)?.[0] ?? ''
      const content = line.slice(prefix.length)
      if (!content.trim()) return line
      return prefix + rtlContent(content)
    })
    .join('\n')
}

export const GUIDANCE = [
  'RTL display mode is on: the person reads this conversation in a terminal that lays out Hebrew right to left.',
  'When you answer in Hebrew: open every line (headings, list items and table cells included) with a Hebrew word; put a space on both sides of every English word; never join English to Hebrew with a hyphen (write "ב JSON", not "ב-JSON"); and put every command, path, file name and code identifier in backticks.',
  'When you answer in English: write as usual, and put any Hebrew inside quotation marks.',
].join('\n')
