import type { FileDiff } from '@mgit/ipc';

/** 서브모듈 포인터 diff 에서 (옛 commit, 새 commit) 을 뽑는다. 아니면 null (SUB-04) */
export function subprojectPointers(
  diff: FileDiff | null,
): { old: string | null; new: string } | null {
  if (!diff || diff.hunks.length === 0) {
    return null;
  }
  let oldOid: string | null = null;
  let newOid: string | null = null;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      const m = /^Subproject commit ([0-9a-f]{40,64})/.exec(l.text);
      if (!m?.[1]) {
        return null;
      }
      if (l.kind === 'del') {
        oldOid = m[1];
      } else if (l.kind === 'add') {
        newOid = m[1];
      }
    }
  }
  return newOid ? { old: oldOid, new: newOid } : null;
}
