/**
 * term — terminal layer public surface (contract: ./types, ARCHITECTURE D5).
 */

export * from './types'
export * from './ansi'
export { CellGrid, createGrid } from './grid'
export { Renderer } from './renderer'
export { AnsiParser, createInputParser } from './input'
export { TermImpl, createTerm, detectTruecolor } from './term'
