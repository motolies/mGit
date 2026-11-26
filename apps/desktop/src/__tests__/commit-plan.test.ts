import type { BatchResult, FileState, RepoChanges, RepoSummary, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  clearsMessage,
  commitBlocker,
  commitPlan,
  committedRepos,
  commonPlaceholder,
  ownMessage,
  planFor,
  repoCommitBlocker,
  repoMessagesFor,
  skipSummary,
  targetsSummary,
} from '../features/commit/commit-plan';
import { batchNotice, batchSummary, repoResultState } from '../features/folder/batch-report';
import {
  checkedPaths,
  pushChecklist,
  pushPlanLine,
  pushRemoteKey,
  pushRequest,
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

describe('저장소별 메시지·이 저장소만 커밋', () => {
  const plan = commitPlan(
    [
      changes('auth', [st('a', 'added', 'unmodified'), st('b', 'modified', 'modified')]),
      changes('cat', [st('x', 'modified', 'unmodified')]),
      changes('web', [st('w', 'modified', 'unmodified')]),
    ],
    [summary('auth'), summary('cat', { op: 'rebase' }), summary('web')],
  );
  const idle = { running: false, pending: false };
  const t = S.commitTool;

  it('자기 메시지는 비었거나 공백뿐이면 없는 것이고(공통 메시지), 코어에는 대상 중 자기 메시지가 있는 것만 넘긴다', () => {
    const messages = { '/f/auth': 'docs: auth', '/f/web': ' \n ', '/f/cat': 'x' };
    expect(ownMessage(messages, '/f/auth')).toBe('docs: auth');
    expect(ownMessage(messages, '/f/web')).toBeNull();
    expect(ownMessage(messages, '/f/none')).toBeNull();
    // cat 은 커밋될 저장소가 아니라서 넘기지 않는다
    expect(repoMessagesFor(plan.repos, messages)).toEqual([
      { path: '/f/auth', message: 'docs: auth' },
    ]);
    expect(repoMessagesFor(plan.repos, {})).toEqual([]);
  });

  it('공통 메시지가 비어도 대상 모두에 자기 메시지가 있으면 누를 수 있고, 하나라도 없으면 메시지 빔이다', () => {
    expect(commitBlocker(plan, ' ', idle, { '/f/auth': 'a' })).toBe('noMessage');
    expect(commitBlocker(plan, ' ', idle, { '/f/auth': 'a', '/f/web': 'w' })).toBeNull();
    expect(commitBlocker(plan, 'msg', idle, { '/f/auth': ' ' })).toBeNull();
  });

  it('이 저장소만 커밋: 그 저장소 하나로 좁힌 계획과 사유 (대상이 아니면 커밋되지 않을 사유나 스테이징된 변경 없음)', () => {
    expect(planFor(plan, '/f/web')).toEqual({
      repos: [{ path: '/f/web', name: 'web', files: 1 }],
      files: 1,
      skipped: [],
    });
    expect(planFor(plan, '/f/cat')).toBeNull();
    // 공통 메시지가 비어도 그 저장소에 자기 메시지가 있으면 된다 (다른 대상과 상관없이)
    expect(repoCommitBlocker(plan, '/f/auth', '', idle, { '/f/auth': 'a' })).toBeNull();
    expect(repoCommitBlocker(plan, '/f/web', '', idle, { '/f/auth': 'a' })).toBe(t.noMessage);
    expect(repoCommitBlocker(plan, '/f/cat', 'msg', idle, {})).toBe(t.skip.inProgress);
    expect(repoCommitBlocker(plan, '/f/hot', 'msg', idle, {})).toBe(t.noTargets);
    expect(repoCommitBlocker(plan, '/f/web', 'msg', { running: false, pending: true }, {})).toBe(
      t.pending,
    );
  });

  it('대상 줄은 자기 메시지로 커밋될 저장소 수를 덧붙이고 툴팁에 그 저장소별 제목을 보인다. 빈 칸 안내는 공통 메시지 첫 줄', () => {
    const base = t.targets(2, 3);
    expect(targetsSummary(plan, {})).toEqual({ text: base, detail: base });
    const own = targetsSummary(plan, { '/f/web': '\nfix: web\n\n본문', '/f/cat': 'x' });
    expect(own?.text).toBe(`${base} · ${t.ownMessages(1)}`);
    expect(own?.detail).toBe(
      `${base} · ${t.ownMessages(1)}\n${t.ownMessageLine('web', 'fix: web')}`,
    );
    expect(targetsSummary(commitPlan([], []), {})).toBeNull();
    expect(commonPlaceholder('feat: 공통\n\n본문')).toBe(t.commonMessage('feat: 공통'));
    expect(commonPlaceholder('  ')).toBe(t.commonMessageEmpty);
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

describe('업스트림이 없는 branch 의 일괄 push (사용자 결정 "origin 자동 + 예외만 선택")', () => {
  const b = S.folder.batch;
  const noUpstream = (name: string, remotes: string[] | null, extra: Partial<RepoSummary> = {}) =>
    summary(name, { ahead: null, behind: null, ...(remotes ? { remotes } : {}), ...extra });
  const byName = new Map([
    ['solo', noUpstream('solo', ['fork', 'origin'])],
    ['one', noUpstream('one', ['upstream'])],
    ['many', noUpstream('many', ['team', 'fork'])],
    ['lonely', noUpstream('lonely', [])],
    ['head', noUpstream('head', ['origin'], { branch: null, detached: true })],
    ['unread', noUpstream('unread', null)],
    ['api', summary('api', { ahead: 2 })],
  ]);
  const of = (path: string) => byName.get(path.replace('/f/', ''));

  it('origin 이 있으면 그것으로 게시, 없으면 원격을 고르게 한다 (하나뿐이면 미리 고름). 분리 HEAD·원격 없음은 건너뛴다', () => {
    expect(pushTarget('solo', of('/f/solo'), [])).toEqual({
      kind: 'publish',
      branch: 'main',
      remote: 'origin',
    });
    expect(pushTarget('one', of('/f/one'), [])).toEqual({
      kind: 'choose',
      branch: 'main',
      remotes: ['upstream'],
      initial: 'upstream',
    });
    expect(pushTarget('many', of('/f/many'), [])).toEqual({
      kind: 'choose',
      branch: 'main',
      remotes: ['team', 'fork'],
      initial: null,
    });
    expect(pushTarget('lonely', of('/f/lonely'), [])).toEqual({ kind: 'skip', why: b.noRemotes });
    expect(pushTarget('head', of('/f/head'), [])).toEqual({ kind: 'skip', why: b.detached });
    // 원격 목록을 읽지 못했으면 예전처럼 업스트림 없음
    expect(pushTarget('unread', of('/f/unread'), [])).toEqual({ kind: 'skip', why: b.noUpstream });
    // 제외가 먼저다
    expect(pushTarget('solo', of('/f/solo'), ['solo'])).toEqual({ kind: 'skip', why: b.excluded });
    expect(pushPlanLine('solo', of('/f/solo'), [])).toBe(b.pushPublish('solo', 'origin/main'));
    expect(pushPlanLine('many', of('/f/many'), [])).toBe(b.pushChoose('many', 'main'));
  });

  it('체크 목록: 게시할 줄은 체크할 수 있고, origin 이 없는 줄에는 원격 칸이 붙는다', () => {
    const targets = ['api', 'solo', 'one', 'many', 'lonely', 'head'].map((name) => ({
      path: `/f/${name}`,
      name,
    }));
    const plan = pushChecklist(targets, of, []);
    expect(plan.publishes).toBe(true);
    expect(plan.candidates.map((c) => c.path)).toEqual(['/f/api', '/f/solo', '/f/one', '/f/many']);
    expect(plan.rows).toEqual([
      { path: '/f/api', label: b.pushCommits('api', 2), why: null },
      { path: '/f/solo', label: b.pushPublish('solo', 'origin/main'), why: null },
      {
        path: '/f/one',
        label: b.pushChoose('one', 'main'),
        why: null,
        remote: { repo: 'one', options: ['upstream'], initial: 'upstream' },
      },
      {
        path: '/f/many',
        label: b.pushChoose('many', 'main'),
        why: null,
        remote: { repo: 'many', options: ['team', 'fork'], initial: null },
      },
      { path: '/f/lonely', label: 'lonely', why: b.noRemotes },
      { path: '/f/head', label: 'head', why: b.detached },
    ]);
    // 업스트림이 있는 저장소만이면 안내를 더하지 않는다
    expect(pushChecklist([{ path: '/f/api', name: 'api' }], of, []).publishes).toBe(false);
  });

  it('요청: 체크한 저장소와, 체크하고 원격을 고른 예외 저장소의 선택만 넘긴다 (origin 저장소는 코어가 고른다)', () => {
    const targets = ['api', 'solo', 'one', 'many'].map((name) => ({ path: `/f/${name}`, name }));
    const plan = pushChecklist(targets, of, []);
    const values = {
      '/f/api': true,
      '/f/solo': true,
      '/f/one': true,
      '/f/many': true,
      [pushRemoteKey('/f/one')]: 'upstream',
      [pushRemoteKey('/f/many')]: 'fork',
    };
    expect(pushRequest(plan, values)).toEqual({
      op: {
        kind: 'push',
        newUpstream: {
          remotes: [
            { path: '/f/one', remote: 'upstream' },
            { path: '/f/many', remote: 'fork' },
          ],
        },
      },
      paths: ['/f/api', '/f/solo', '/f/one', '/f/many'],
    });
    // 고르지 않은 줄(빈 값)과 체크를 푼 줄의 선택은 넘기지 않는다. 목록에 없는 값도 넘기지 않는다
    expect(
      pushRequest(plan, {
        ...values,
        '/f/one': false,
        [pushRemoteKey('/f/many')]: '',
      }),
    ).toEqual({
      op: { kind: 'push', newUpstream: { remotes: [] } },
      paths: ['/f/api', '/f/solo', '/f/many'],
    });
    expect(pushRequest(plan, { ...values, [pushRemoteKey('/f/many')]: 'ghost' }).op).toEqual({
      kind: 'push',
      newUpstream: { remotes: [{ path: '/f/one', remote: 'upstream' }] },
    });
  });

  it('결과 요약: 업스트림을 새로 지정한 저장소를 수와 줄로 구분한다', () => {
    const result: BatchResult = {
      label: '일괄 푸시',
      results: [
        { path: '/f/api', name: 'api', ok: true, skipped: null, message: '' },
        {
          path: '/f/solo',
          name: 'solo',
          ok: true,
          skipped: null,
          message: '',
          upstreamSet: 'origin/main',
        },
        { path: '/f/many', name: 'many', ok: true, skipped: '원격을 골라야 합니다', message: '' },
      ],
      succeeded: 2,
      skipped: 1,
      failed: 0,
    };
    expect(batchSummary(result)).toBe(b.resultPublished(2, 1, 1, 0));
    expect(result.results.map(repoResultState)).toEqual([
      b.ok,
      b.upstreamSet('origin/main'),
      `${b.skipped}: 원격을 골라야 합니다`,
    ]);
    expect(batchNotice(result)).toEqual({
      kind: 'success',
      title: '일괄 푸시',
      message: [
        b.resultPublished(2, 1, 1, 0),
        'many: 원격을 골라야 합니다',
        `solo: ${b.upstreamSet('origin/main')}`,
      ].join('\n'),
    });
    expect(b.resultPublished(2, 1, 1, 0)).toBe('성공 2 (업스트림 새로 지정 1) · 건너뜀 1 · 실패 0');
  });
});
