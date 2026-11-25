import type { DiffDocument, FileDiff } from '../types';

/** 목 패치에 있는 줄과 번호를 원문으로 확장해 전체 파일 화면도 같은 장면을 표시한다. */
export function mockDiffDocument(
  patch: FileDiff | null,
  oldLabel = 'HEAD',
  newLabel = 'Working tree',
): DiffDocument {
  const diff: FileDiff = patch ?? {
    oldPath: null,
    newPath: null,
    change: { kind: 'modified' },
    binary: null,
    hunks: [],
    truncated: false,
    totalLines: 0,
    nonUtf8: false,
  };
  const old: string[] = [];
  const next: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo != null) old[line.oldNo - 1] = line.text;
      if (line.newNo != null) next[line.newNo - 1] = line.text;
    }
  }
  const text = (lines: string[]) =>
    lines.length ? `${Array.from(lines, (line) => line ?? '').join('\n')}\n` : '';
  return {
    diff,
    old: { path: diff.oldPath, label: oldLabel, content: text(old), lineCount: old.length },
    new: { path: diff.newPath, label: newLabel, content: text(next), lineCount: next.length },
    revision: `mock:${diff.newPath ?? diff.oldPath ?? ''}`,
    limitReason: null,
  };
}
