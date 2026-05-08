import type { CellCoord } from './cell-at-touch'

export type SelectionState = {
  anchor: CellCoord
  focus: CellCoord
  activeHandle: 'start' | 'end' | null
}

export function isStartBeforeEnd(a: CellCoord, b: CellCoord): boolean {
  if (a.row !== b.row) return a.row < b.row
  return a.col <= b.col
}

export function normalizedRange(s: SelectionState): { start: CellCoord; end: CellCoord } {
  if (isStartBeforeEnd(s.anchor, s.focus)) {
    return { start: s.anchor, end: s.focus }
  }
  return { start: s.focus, end: s.anchor }
}

export function selectionLengthCells(s: SelectionState, cols: number): number {
  const { start, end } = normalizedRange(s)
  if (start.row === end.row) return Math.max(1, end.col - start.col + 1)
  const firstRow = cols - start.col
  const middleRows = Math.max(0, end.row - start.row - 1) * cols
  const lastRow = end.col + 1
  return firstRow + middleRows + lastRow
}

export function selectionEvicted(s: SelectionState): boolean {
  return Math.min(s.anchor.row, s.focus.row) < 0
}

export function decrementRows(s: SelectionState): SelectionState {
  return {
    ...s,
    anchor: { col: s.anchor.col, row: s.anchor.row - 1 },
    focus: { col: s.focus.col, row: s.focus.row - 1 }
  }
}
