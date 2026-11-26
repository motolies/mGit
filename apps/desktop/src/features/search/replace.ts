import type {
  ReplaceChoice,
  ReplaceFilePreview,
  ReplaceLine,
  ReplaceOutcome,
  ReplacePreview,
  ReplaceSkipReason,
  ReplaceUndo,
  ReplaceUndoOutcome,
} from '@mgit/ipc';

/**
 * 미리보기에서 뺀 것: 체크를 끈 파일과, 파일마다 체크를 끈 일치 순번. 처음에는 모두 바꾼다 (둘 다 빈 값)
 */
export interface ReplaceSelection {
  files: ReadonlySet<string>;
  matches: ReadonlyMap<string, ReadonlySet<number>>;
}

/** 아무것도 빼지 않은 선택 */
export const EMPTY_SELECTION: ReplaceSelection = { files: new Set(), matches: new Map() };

/** 파일 체크를 뒤집는다 */
export function toggleFile(selection: ReplaceSelection, path: string): ReplaceSelection {
  const files = new Set(selection.files);
  if (!files.delete(path)) files.add(path);
  return { ...selection, files };
}

/** 일치 하나의 체크를 뒤집는다 */
export function toggleMatch(
  selection: ReplaceSelection,
  path: string,
  index: number,
): ReplaceSelection {
  const off = new Set(selection.matches.get(path));
  if (!off.delete(index)) off.add(index);
  const matches = new Map(selection.matches);
  if (off.size > 0) matches.set(path, off);
  else matches.delete(path);
  return { ...selection, matches };
}

/** 이 파일에서 실제로 바꿀 일치 수: 체크를 끈 파일은 0, 아니면 전체에서 끈 일치를 뺀 수 (보이지 않는 일치는 늘 바꾼다) */
export function selectedMatches(file: ReplaceFilePreview, selection: ReplaceSelection): number {
  if (selection.files.has(file.path)) return 0;
  return file.matches - (selection.matches.get(file.path)?.size ?? 0);
}

/** 적용할 파일 수와 바꿀 일치 수 */
export function selectionTotals(
  preview: ReplacePreview,
  selection: ReplaceSelection,
): { files: number; matches: number } {
  let files = 0;
  let matches = 0;
  for (const file of preview.files) {
    const n = selectedMatches(file, selection);
    if (n > 0) {
      files++;
      matches += n;
    }
  }
  return { files, matches };
}

/** 적용 요청의 파일 목록: 바꿀 일치가 남은 파일만, 끈 일치 순번과 미리보기 revision 을 함께 보낸다 */
export function replaceChoices(
  preview: ReplacePreview,
  selection: ReplaceSelection,
): ReplaceChoice[] {
  return preview.files
    .filter((file) => selectedMatches(file, selection) > 0)
    .map((file) => ({
      path: file.path,
      revision: file.revision,
      excluded: [...(selection.matches.get(file.path) ?? [])].sort((a, b) => a - b),
    }));
}

/**
 * 적용 직전 초안 확인: 미리본 뒤 편집기에 저장하지 않은 변경이 생긴 파일은 보내지 않고 `draft` 로 건너뛴 결과를 만든다
 * (코어로 보내면 초안을 무시하고 디스크를 바꾸게 된다)
 */
export function holdDrafts(
  choices: readonly ReplaceChoice[],
  drafts: readonly string[],
): { send: ReplaceChoice[]; held: ReplaceOutcome[] } {
  const dirty = new Set(drafts);
  return {
    send: choices.filter((c) => !dirty.has(c.path)),
    held: choices
      .filter((c) => dirty.has(c.path))
      .map((c) => ({ kind: 'skipped', path: c.path, reason: 'draft' as ReplaceSkipReason })),
  };
}

/** 줄 미리보기의 한 조각: 그대로·지워지는 글자·들어가는 글자 */
export interface ReplaceSegment {
  text: string;
  kind: 'same' | 'del' | 'ins';
  /** 일치 조각이면 그 일치 순번 */
  index?: number;
}

/**
 * 줄 하나의 바꾸기 전·후 조각. 전은 모든 일치를 `del` 로, 후는 체크한 일치만 바꿔 `ins` 로 보인다 (끈 일치는 원문
 * 그대로 `same`)
 */
export function lineSegments(
  line: ReplaceLine,
  off: ReadonlySet<number> | undefined,
): { before: ReplaceSegment[]; after: ReplaceSegment[] } {
  const before: ReplaceSegment[] = [];
  const after: ReplaceSegment[] = [];
  let last = 0;
  for (const m of line.matches) {
    const same = line.text.slice(last, m.start);
    if (same) {
      before.push({ text: same, kind: 'same' });
      after.push({ text: same, kind: 'same' });
    }
    const found = line.text.slice(m.start, m.end);
    before.push({ text: found, kind: 'del', index: m.index });
    if (off?.has(m.index)) after.push({ text: found, kind: 'same', index: m.index });
    else if (m.replacement) after.push({ text: m.replacement, kind: 'ins', index: m.index });
    last = m.end;
  }
  const rest = line.text.slice(last);
  if (rest) {
    before.push({ text: rest, kind: 'same' });
    after.push({ text: rest, kind: 'same' });
  }
  return { before, after };
}

/** 적용 결과 요약: 바꾼 파일·일치 수, 건너뛴 파일(사유)·실패한 파일(메시지), 되돌리기 요청 */
export function replaceReport(outcomes: readonly ReplaceOutcome[]): {
  files: number;
  matches: number;
  skipped: Extract<ReplaceOutcome, { kind: 'skipped' }>[];
  failed: Extract<ReplaceOutcome, { kind: 'failed' }>[];
  undo: ReplaceUndo[];
} {
  const undo: ReplaceUndo[] = [];
  const skipped: Extract<ReplaceOutcome, { kind: 'skipped' }>[] = [];
  const failed: Extract<ReplaceOutcome, { kind: 'failed' }>[] = [];
  let matches = 0;
  for (const o of outcomes) {
    if (o.kind === 'applied') {
      matches += o.replaced;
      undo.push({ path: o.path, backup: o.backup, revision: o.revision });
    } else if (o.kind === 'skipped') skipped.push(o);
    else failed.push(o);
  }
  return { files: undo.length, matches, skipped, failed, undo };
}

/** 되돌리기 결과 요약: 되돌린 수, 바꾼 뒤 또 바뀌어 건너뛴 경로, 실패 */
export function undoReport(outcomes: readonly ReplaceUndoOutcome[]): {
  restored: number;
  changed: string[];
  failed: Extract<ReplaceUndoOutcome, { kind: 'failed' }>[];
} {
  return {
    restored: outcomes.filter((o) => o.kind === 'restored').length,
    changed: outcomes.filter((o) => o.kind === 'skipped').map((o) => o.path),
    failed: outcomes.filter((o) => o.kind === 'failed'),
  };
}
