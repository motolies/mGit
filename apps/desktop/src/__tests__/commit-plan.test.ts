import type { BatchResult, FileState, RepoChanges, RepoSummary, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  clearsMessage,
  commitBlocker,
  commitPlan,
  committedRepos,
  skipSummary,
} from '../features/commit/commit-plan';
import {
  checkedPaths,
  pushChecklist,
  pushPlanLine,
  pushTarget,
} from '../features/folder/FolderBatchBar';

/** 상태 항목 */
function st(path: string, index: FileState, worktree: FileState, conflict = false): StatusEntry {
  return {
    path,
    origPath: null,
    index,
    worktree,
    submodule: null,
    conflict: conflict ? 'bothModified' : null,
    renameScore: null,
  };
}

/** 저장소 하나의 변경 줄 */
function changes(name: string, entries: StatusEntry[]): RepoChanges {
  return {
    path: `/f/${name}`,
    name,
    branch: 'main',
    entries,
    summary: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: entries.filter((e) => e.conflict).length,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 요약 한 줄 */
function summary(name: string, extra: Partial<RepoSummary> = {}): RepoSummary {
  return {
    path: `/f/${name}`,
    name,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 1,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    op: null,
    lastFetch: null,
    error: null,
    ...extra,
  };
}

describe('커밋 대상 (W14 ① 의 규칙: stage 된 것이 있고 충돌·진행 중 작업·요약 실패가 없는 저장소)', () => {
  const CHANGES = [
    changes('auth', [
      st('a', 'added', 'unmodified'),
      st('b', 'modified', 'modified'),
      st('c', 'untracked', 'untracked'),
    ]),
    changes('cat', [st('x', 'modified', 'unmodified'), st('y', 'unmerged', 'unmerged', true)]),
    changes('hot', [st('t', 'unmodified', 'modified')]),
    changes('web', [st('w', 'modified', 'unmodified')]),
    changes('lost', [st('l', 'modified', 'unmodified')]),
    changes('infra', [st('i', 'modified', 'unmodified')]),
    changes('clash', [st('k', 'modified', 'unmodified'), st('z', 'unmerged', 'unmerged', true)]),
  ];
  const SUMMARIES = [
    summary('auth'),
    summary('cat', { op: 'rebase' }),
    summary('hot'),
    summary('web'),
    summary('infra', { error: 'index file smaller than expected' }),
    summary('clash'),
  ];

  it('커밋될 저장소·파일 수와, stage 됐지만 커밋되지 않을 저장소의 사유. stage 된 것이 없는 저장소는 어디에도 없다', () => {
    const plan = commitPlan(CHANGES, SUMMARIES);
    expect(plan.repos).toEqual([
      { path: '/f/auth', name: 'auth', files: 2 },
      { path: '/f/web', name: 'web', files: 1 },
    ]);
    expect(plan.files).toBe(3);
    expect(plan.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['cat', 'inProgress'],
      ['lost', 'unknown'],
      ['infra', 'summaryFailed'],
      ['clash', 'conflict'],
    ]);
    // 사유마다 문구가 있다
    for (const s of plan.skipped) {
      expect(S.commitTool.skip[s.reason]).toBeTruthy();
    }
  });

  it('누를 수 없는 사유: 실행 중 → stage 처리 중 → 대상 없음 → 메시지 빔. 다 되면 null', () => {
    const plan = commitPlan(CHANGES, SUMMARIES);
    const none = commitPlan([], []);
    expect(commitBlocker(plan, 'msg', { running: true, pending: true })).toBe('running');
    expect(commitBlocker(plan, 'msg', { running: false, pending: true })).toBe('pending');
    expect(commitBlocker(none, 'msg', { running: false, pending: false })).toBe('noTargets');
    expect(commitBlocker(plan, '  \n ', { running: false, pending: false })).toBe('noMessage');
    expect(commitBlocker(plan, 'msg', { running: false, pending: false })).toBeNull();
  });

  it('메시지는 대상이 모두 커밋됐을 때만 비우고, 커밋된 저장소만 push 로 넘긴다', () => {
    const result = (rows: BatchResult['results']): BatchResult => ({
      label: '일괄 commit',
      results: rows,
      succeeded: rows.filter((r) => r.ok && !r.skipped).length,
      skipped: rows.filter((r) => r.skipped).length,
      failed: rows.filter((r) => !r.ok).length,
    });
    const ok = { path: '/f/a', name: 'a', ok: true, skipped: null, message: '' };
    const skip = {
      path: '/f/b',
      name: 'b',
      ok: true,
      skipped: '진행 중인 작업이 있음',
      message: '',
    };
    const fail = { path: '/f/c', name: 'c', ok: false, skipped: null, message: 'hook 실패' };
    expect(clearsMessage(result([ok]))).toBe(true);
    expect(clearsMessage(result([ok, skip]))).toBe(false);
    expect(clearsMessage(result([ok, fail]))).toBe(false);
    expect(clearsMessage(result([]))).toBe(false);
    expect(committedRepos(result([ok, skip, fail]))).toEqual(['/f/a']);
  });
});

describe('Push 체크 목록 (W14 사용자 요구)', () => {
  const byName = new Map([
    ['api', summary('api', { ahead: 3 })],
    ['auth', summary('auth', { ahead: null })],
    ['web', summary('web', { ahead: 0 })],
    ['broken', summary('broken', { ahead: 2, error: 'x' })],
    ['ex', summary('ex', { ahead: 5 })],
  ]);
  const of = (path: string) => byName.get(path.replace('/f/', ''));

  it('올라갈 commit 이 있는 저장소만 체크할 수 있고, 제외·업스트림 없음·보낼 것 없음·상태 모름은 사유 줄이다', () => {
    expect(pushTarget('api', of('/f/api'), [])).toEqual({ kind: 'push', commits: 3 });
    expect(pushTarget('ex', of('/f/ex'), ['ex'])).toEqual({
      kind: 'skip',
      why: S.folder.batch.excluded,
    });
    expect(pushTarget('auth', of('/f/auth'), [])).toEqual({
      kind: 'skip',
      why: S.folder.batch.noUpstream,
    });
    expect(pushTarget('web', of('/f/web'), [])).toEqual({
      kind: 'skip',
      why: S.folder.batch.nothingToPush,
    });
    expect(pushTarget('broken', of('/f/broken'), [])).toEqual({ kind: 'unknown' });
    expect(pushTarget('ghost', undefined, [])).toEqual({ kind: 'unknown' });

    const targets = ['api', 'auth', 'web', 'broken', 'ex'].map((name) => ({
      path: `/f/${name}`,
      name,
    }));
    const plan = pushChecklist(targets, of, ['ex']);
    expect(plan.candidates).toEqual([
      { path: '/f/api', label: S.folder.batch.pushCommits('api', 3) },
    ]);
    // W19: 건너뛸 저장소는 사유 줄이 아니라 같은 목록의 꺼진 칸(이름 + 사유)이다
    const b = S.folder.batch;
    expect(plan.skipped).toEqual([
      { path: '/f/auth', name: 'auth', why: b.noUpstream },
      { path: '/f/web', name: 'web', why: b.nothingToPush },
      { path: '/f/broken', name: 'broken', why: b.unknownState },
      { path: '/f/ex', name: 'ex', why: b.excluded },
    ]);
    // 한 목록은 대상 순서를 지킨다. 체크할 수 있는 줄의 글자는 지금처럼 `이름: commit N개`
    expect(plan.rows).toEqual([
      { path: '/f/api', label: pushPlanLine('api', of('/f/api'), ['ex']), why: null },
      { path: '/f/auth', label: 'auth', why: b.noUpstream },
      { path: '/f/web', label: 'web', why: b.nothingToPush },
      { path: '/f/broken', label: 'broken', why: b.unknownState },
      { path: '/f/ex', label: 'ex', why: b.excluded },
    ]);
  });

  it('체크한 저장소만 고른다 (아무것도 체크하지 않으면 빈 목록 — 호출자가 실행하지 않는다)', () => {
    const candidates = [
      { path: '/f/a', label: 'a' },
      { path: '/f/b', label: 'b' },
    ];
    expect(checkedPaths(candidates, { '/f/a': true, '/f/b': false })).toEqual(['/f/a']);
    expect(checkedPaths(candidates, { '/f/a': false, '/f/b': false })).toEqual([]);
  });
});

describe('커밋되지 않을 저장소의 접힌 한 줄 (W19)', () => {
  const t = S.commitTool;
  const one = t.skipLine('catalog-service', t.skip.inProgress);
  const two = t.skipLine('billing-service', t.skip.conflict);

  it('없으면 null, 하나면 그 줄 그대로, 여럿이면 수. 툴팁에는 늘 저장소별 사유가 전부 있다', () => {
    expect(skipSummary([])).toBeNull();
    expect(skipSummary([one])).toEqual({ text: one, detail: `${t.skippedLabel}\n${one}` });
    expect(skipSummary([one, two])).toEqual({
      text: t.skippedSummary(2),
      detail: `${t.skippedLabel}\n${one}\n${two}`,
    });
  });
});
