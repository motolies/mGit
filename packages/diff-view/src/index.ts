export { type DiffActions, type DiffMode, DiffView, type DiffViewProps } from './DiffView';
export { highlightHunk, parserFor, plainSpans, tokenize } from './highlight';
export {
  buildRows,
  buildSplitRows,
  buildUnifiedRows,
  type DiffRow,
  hunkHeader,
  type LineRef,
  pairChanges,
} from './rows';
export {
  changeLineIndices,
  lineKey,
  parseLineKey,
  rangeKeys,
  selectionFromKeys,
} from './selection';
export { type HighlightMap, useHighlight } from './use-highlight';
export { applyRanges, type Piece, type Range, type Span, wordRanges } from './word-diff';
