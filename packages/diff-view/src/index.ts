export {
  type DiffActions,
  type DiffMode,
  type DiffNavigation,
  DiffView,
  type DiffViewProps,
} from './DiffView';
export { highlightHunk, parserFor, plainSpans, tokenize } from './highlight';
export {
  buildContextRows,
  buildDocumentRows,
  buildRows,
  buildSplitRows,
  buildUnifiedRows,
  type DiffRow,
  hunkHeader,
  type LineRef,
  pairChanges,
  sourceLines,
} from './rows';
export {
  changeLineIndices,
  lineKey,
  parseLineKey,
  rangeKeys,
  selectionFromKeys,
} from './selection';
export { type HighlightMap, useHighlight } from './use-highlight';
export {
  applyRanges,
  changeRanges,
  type HighlightMode,
  type Piece,
  type Range,
  type Span,
  wordRanges,
} from './word-diff';
