// Why: deliberately greedy class so paths, URLs, branch names with `=`,
// and Unicode filenames select as one unit on long-press.
const WORD_RE = /[\p{L}\p{N}_./:@~+=?&#%-]/u

export type WordRange = { start: number; end: number }

export function wordBoundaryAt(line: string, col: number): WordRange {
  if (col < 0 || col >= line.length) return { start: col, end: col + 1 }
  if (!WORD_RE.test(line[col]!)) {
    return { start: col, end: col + 1 }
  }
  let start = col
  while (start > 0 && WORD_RE.test(line[start - 1]!)) start--
  let end = col + 1
  while (end < line.length && WORD_RE.test(line[end]!)) end++
  return { start, end }
}
