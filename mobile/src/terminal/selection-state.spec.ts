import { describe, it, expect } from 'vitest'
import {
  decrementRows,
  isStartBeforeEnd,
  normalizedRange,
  selectionEvicted,
  selectionLengthCells,
  type SelectionState
} from './selection-state'

const cell = (col: number, row: number) => ({ col, row })

describe('selection-state', () => {
  it('isStartBeforeEnd handles same-row, different-row', () => {
    expect(isStartBeforeEnd(cell(2, 0), cell(5, 0))).toBe(true)
    expect(isStartBeforeEnd(cell(5, 0), cell(2, 0))).toBe(false)
    expect(isStartBeforeEnd(cell(0, 1), cell(0, 0))).toBe(false)
    expect(isStartBeforeEnd(cell(0, 0), cell(0, 1))).toBe(true)
  })

  it('normalizedRange swaps when anchor is after focus', () => {
    const s: SelectionState = {
      anchor: cell(10, 5),
      focus: cell(2, 5),
      activeHandle: null
    }
    const { start, end } = normalizedRange(s)
    expect(start).toEqual(cell(2, 5))
    expect(end).toEqual(cell(10, 5))
  })

  it('selectionLengthCells single row', () => {
    const s: SelectionState = {
      anchor: cell(2, 0),
      focus: cell(7, 0),
      activeHandle: null
    }
    expect(selectionLengthCells(s, 80)).toBe(6)
  })

  it('selectionLengthCells across rows', () => {
    const s: SelectionState = {
      anchor: cell(70, 0),
      focus: cell(5, 2),
      activeHandle: null
    }
    expect(selectionLengthCells(s, 80)).toBe(10 + 80 + 6)
  })

  it('selectionEvicted detects negative anchor', () => {
    expect(selectionEvicted({ anchor: cell(0, -1), focus: cell(0, 5), activeHandle: null })).toBe(
      true
    )
  })

  it('selectionEvicted detects negative focus while anchor survives', () => {
    expect(selectionEvicted({ anchor: cell(0, 5), focus: cell(0, -1), activeHandle: null })).toBe(
      true
    )
  })

  it('decrementRows reduces both endpoints', () => {
    const s: SelectionState = {
      anchor: cell(2, 5),
      focus: cell(8, 7),
      activeHandle: null
    }
    const next = decrementRows(s)
    expect(next.anchor).toEqual(cell(2, 4))
    expect(next.focus).toEqual(cell(8, 6))
  })
})
