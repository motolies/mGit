import type { DiffDocument, FileDiff } from '@mgit/ipc';

/** 패치 기반 기존 픽스처에 독립된 원문과 조회 revision 을 붙인다. */
export function documentOf(diff: FileDiff | null = null, revision = 'revision-1'): DiffDocument {
  const patch: FileDiff = diff ?? {
    oldPath: 'f.txt',
    newPath: 'f.txt',
    change: { kind: 'modified' },
    binary: null,
    hunks: [],
    truncated: false,
    totalLines: 0,
    nonUtf8: false,
  };
  const old = patch.hunks
    .flatMap((h) => h.lines.filter((l) => l.kind !== 'add').map((l) => l.text))
    .join('\n');
  const next = patch.hunks
    .flatMap((h) => h.lines.filter((l) => l.kind !== 'del').map((l) => l.text))
    .join('\n');
  return {
    diff: patch,
    old: {
      path: patch.oldPath,
      label: 'HEAD',
      content: old,
      lineCount: old ? old.split('\n').length : 0,
    },
    new: {
      path: patch.newPath,
      label: '작업 트리',
      content: next,
      lineCount: next ? next.split('\n').length : 0,
    },
    revision,
    limitReason: null,
  };
}
