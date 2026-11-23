// C4: 태그 문서 결과 칸 (`features/tags/tag-results.ts`, TG-12 ②) — 요약, 실패만 남김, 다시 시도할 이름

import type { TagRefResult, TagRefStatus } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { batchResultView, deleteResultView } from '../features/tags/tag-results';
import type { TagDeleteSummary } from '../store/tag-ops';

/** 결과 한 줄 */
const res = (name: string, status: TagRefStatus, message: string | null = null): TagRefResult => ({
  name,
  status,
  message,
  remoteOid: null,
  remoteCommit: null,
});

describe('일괄 push·가져오기 결과', () => {
  it('성공은 세기만 하고, 실패만 남긴다. 일시적 실패(모름·실패)만 다시 시도한다', () => {
    const v = batchResultView(
      'push origin',
      {
        results: [
          res('a', 'pushed'),
          res('b', 'unknown'),
          res('c', 'rejectedExists', 'already exists'),
          res('d', 'failed', 'boom'),
        ],
        error: null,
      },
      ['a', 'b', 'c', 'd'],
    );
    expect(v.summary).toBe(S.tag.result.summary('push origin', 1, 3));
    expect(v.failures.map((f) => [f.name, f.text, f.retryable])).toEqual([
      ['b', S.tag.status.unknown, true],
      ['c', S.tag.status.rejectedExists, false],
      ['d', 'boom', true],
    ]);
    expect(v.retryNames).toEqual(['b', 'd']);
    expect(v.failedNames).toEqual(['b', 'c', 'd']);
    expect(v.error).toBeNull();
  });

  it('명령 전체가 실패하면 그 사유이고 모두 다시 시도할 수 있다', () => {
    const v = batchResultView('fetch origin', { results: [], error: '연결 실패' }, ['a', 'b']);
    expect(v).toMatchObject({
      summary: S.tag.result.summary('fetch origin', 0, 2),
      failures: [],
      error: '연결 실패',
      retryNames: ['a', 'b'],
      failedNames: ['a', 'b'],
    });
  });
});

describe('지울 곳 삭제 결과', () => {
  const base: TagDeleteSummary = {
    names: ['a', 'b', 'c', 'r'],
    scope: { local: true, remotes: ['origin'] },
    remote: {
      origin: [
        res('a', 'deleted'),
        res('b', 'diverged'),
        res('c', 'notRun'),
        res('r', 'alreadyAbsent'),
      ],
    },
    remoteErrors: {},
    localDeleted: ['a'],
    localKept: ['b', 'c'],
    localError: null,
    cancelled: true,
  };

  it('원격 이름을 붙인 사유, 확인 대기는 다시 시도할 수 있고 다름은 아니다. 다 지운 것만 성공으로 센다', () => {
    const v = deleteResultView('삭제', base);
    expect(v.failures.map((f) => [f.name, f.text, f.retryable])).toEqual([
      ['b', S.tag.del.remoteFailed('origin', S.tag.status.diverged), false],
      ['c', S.tag.del.remoteFailed('origin', S.tag.status.notRun), true],
    ]);
    // a 는 로컬·원격 모두, r 은 원격에만 있던 tag 라 원격에서 없음으로 끝
    expect(v.summary).toBe(S.tag.result.summary('삭제', 2, 2));
    expect(v.error).toBe(S.tag.del.cancelled);
    expect(v.retryNames).toEqual(['c']);
  });

  it('원격 명령 전체 실패는 모든 이름을 다시 시도, 로컬 실패면 로컬에 남긴 것을 다시 시도', () => {
    const v = deleteResultView('삭제', {
      ...base,
      names: ['a', 'b'],
      remote: {},
      remoteErrors: { origin: 'auth' },
      localDeleted: [],
      localKept: ['a', 'b'],
      cancelled: false,
    });
    expect(v.error).toBe(S.tag.del.remoteFailed('origin', 'auth'));
    expect(v.retryNames).toEqual(['a', 'b']);
    expect(v.failures.map((f) => [f.name, f.text])).toEqual([
      ['a', S.tag.result.localKept],
      ['b', S.tag.result.localKept],
    ]);
    const local = deleteResultView('삭제', {
      ...base,
      names: ['a'],
      scope: { local: true, remotes: [] },
      remote: {},
      localDeleted: [],
      localKept: ['a'],
      localError: '없는 tag',
      cancelled: false,
    });
    expect(local.error).toBe(S.tag.del.localFailed('없는 tag'));
    expect(local.retryNames).toEqual(['a']);
  });
});
