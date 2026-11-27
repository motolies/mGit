// 측정용 큰 diff 문서 (반응성 E-1): 패치의 줄 번호·글자가 양쪽 원문과 맞고, 조절값이 없으면 꺼져 있다
import { afterEach, describe, expect, it } from 'vitest';
import { bigDiffDocument, bigDiffKnobs } from '../mock/mock-big-diff';

afterEach(() => {
  localStorage.clear();
});

describe('bigDiffDocument', () => {
  it('패치의 문맥·삭제·추가 줄이 옛·새 원문의 그 줄과 같고 줄 수가 맞는다', () => {
    const doc = bigDiffDocument('src/app.ts', { lines: 3000, hunks: 40 }, 'HEAD', 'LOCAL');
    const old = (doc.old.content ?? '').split('\n').slice(0, -1);
    const next = (doc.new.content ?? '').split('\n').slice(0, -1);
    expect(old).toHaveLength(3000);
    expect(doc.diff.hunks).toHaveLength(40);
    // 변경마다 한 줄을 넣는다
    expect(next).toHaveLength(3040);
    expect(doc.old.lineCount).toBe(old.length);
    expect(doc.new.lineCount).toBe(next.length);
    for (const hunk of doc.diff.hunks) {
      for (const line of hunk.lines) {
        if (line.oldNo != null) expect(old[line.oldNo - 1]).toBe(line.text);
        if (line.newNo != null) expect(next[line.newNo - 1]).toBe(line.text);
      }
      expect(hunk.lines.filter((l) => l.kind !== 'add')).toHaveLength(hunk.oldLines);
      expect(hunk.lines.filter((l) => l.kind !== 'del')).toHaveLength(hunk.newLines);
    }
  });

  it('조절값은 줄 수를 줄 때만 켜지고, 덩어리 수의 기본은 30 이다', () => {
    expect(bigDiffKnobs()).toBeNull();
    localStorage.setItem('mgit.mock.diffLines', '4000');
    expect(bigDiffKnobs()).toEqual({ lines: 4000, hunks: 30, delayMs: 0 });
  });
});
