import { describe, it, expect } from 'vitest'
import { wordBoundaryAt } from './word-boundary'

describe('wordBoundaryAt', () => {
  it('selects a plain word in the middle of a line', () => {
    const line = 'hello world today'
    const { start, end } = wordBoundaryAt(line, 8)
    expect(line.slice(start, end)).toBe('world')
  })

  it('selects a path with slashes as one unit', () => {
    const line = '  /usr/local/bin/foo  '
    const { start, end } = wordBoundaryAt(line, 6)
    expect(line.slice(start, end)).toBe('/usr/local/bin/foo')
  })

  it('selects a URL with query string', () => {
    const line = 'see https://example.com/p?x=1 ok'
    const { start, end } = wordBoundaryAt(line, 10)
    expect(line.slice(start, end)).toBe('https://example.com/p?x=1')
  })

  it('selects a git short hash', () => {
    const line = 'commit a3f2b1c is ready'
    const { start, end } = wordBoundaryAt(line, 8)
    expect(line.slice(start, end)).toBe('a3f2b1c')
  })

  it('keeps ~/path together', () => {
    const line = 'cd ~/code/repo'
    const { start, end } = wordBoundaryAt(line, 4)
    expect(line.slice(start, end)).toBe('~/code/repo')
  })

  it('keeps user@host:path together', () => {
    const line = 'ssh ada@host:/etc'
    const { start, end } = wordBoundaryAt(line, 6)
    expect(line.slice(start, end)).toBe('ada@host:/etc')
  })

  it('keeps Unicode filenames', () => {
    const line = 'open résumé.pdf now'
    const { start, end } = wordBoundaryAt(line, 7)
    expect(line.slice(start, end)).toBe('résumé.pdf')
  })

  it('keeps KEY=value together', () => {
    const line = 'env FOO=bar set'
    const { start, end } = wordBoundaryAt(line, 5)
    expect(line.slice(start, end)).toBe('FOO=bar')
  })

  it('falls back to single cell on whitespace', () => {
    const line = 'a   b'
    const { start, end } = wordBoundaryAt(line, 2)
    expect(end - start).toBe(1)
  })

  it('falls back to single cell beyond line end', () => {
    const line = 'short'
    const { start, end } = wordBoundaryAt(line, 100)
    expect(end - start).toBe(1)
  })

  it('selects single character at line edge', () => {
    const line = 'a b'
    const { start, end } = wordBoundaryAt(line, 0)
    expect(line.slice(start, end)).toBe('a')
  })
})
