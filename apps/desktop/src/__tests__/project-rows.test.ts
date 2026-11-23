import type { FoundRepo, RepoSummary } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  branchText,
  fileStamp,
  opBadgeText,
  repoDecorations,
  syncTexts,
} from '../features/project/project-rows';

const ROOT = '/work/acme';

/** 요약 한 줄 */
function summary(partial: Partial<RepoSummary> & { name: string }): RepoSummary {
  return {
    path: `${ROOT}/${partial.name}`,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
    ...partial,
  };
}

/** 스캔 결과 한 줄 */
function repo(name: string, kind: FoundRepo['kind'] = 'standalone'): FoundRepo {
  return { path: `${ROOT}/${name}`, kind };
}

/** 저장소 이름으로 장식을 찾는다 */
function decoOf(decos: ReturnType<typeof repoDecorations>, name: string) {
  const deco = decos.get(`${ROOT}/${name}`);
  if (!deco) {
    throw new Error(`장식 없음: ${name}`);
  }
  return deco;
}

// W3 간이 트리의 `buildProjectRows` 테스트를 W11 의 행 장식(`repoDecorations`)으로 옮겼다. 루트 행·저장소 행의
// 순서와 들여쓰기는 이제 파일 트리 평탄화(`project-tree-model.test.ts`)가 맡고, 저장소 행에 무엇을 그리는지는
// 그대로 여기서 본다
describe('repoDecorations (PT-02)', () => {
  it('저장소 디렉터리마다 저장소 아이콘과 굵은 이름 장식을 둔다 (경로가 키)', () => {
    const decos = repoDecorations(
      [repo('web'), repo('api'), repo('billing')],
      [summary({ name: 'web' }), summary({ name: 'api' }), summary({ name: 'billing' })],
    );
    expect([...decos.keys()]).toEqual([`${ROOT}/web`, `${ROOT}/api`, `${ROOT}/billing`]);
    for (const deco of decos.values()) {
      expect(deco).toMatchObject({ icon: 'repo', bold: true, branch: 'main' });
    }
  });

  it('브랜치명을 싣고, 0 이 아닌 ahead·behind 만 숫자 먼저 쓴다', () => {
    const decos = repoDecorations(
      [repo('behind'), repo('ahead'), repo('both'), repo('even'), repo('none')],
      [
        summary({ name: 'behind', branch: 'development', ahead: 0, behind: 54 }),
        summary({ name: 'ahead', branch: 'feature/login', ahead: 3, behind: 0 }),
        summary({ name: 'both', branch: 'staging', ahead: 1, behind: 2 }),
        summary({ name: 'even', ahead: 0, behind: 0 }),
        summary({ name: 'none' }),
      ],
    );
    expect(decoOf(decos, 'behind')).toMatchObject({ branch: 'development', sync: ['54↓'] });
    expect(decoOf(decos, 'ahead')).toMatchObject({ branch: 'feature/login', sync: ['3↑'] });
    expect(decoOf(decos, 'both').sync).toEqual(['1↑', '2↓']);
    expect(decoOf(decos, 'even').sync).toEqual([]);
    // 업스트림이 없으면(null) 아무것도 쓰지 않는다
    expect(decoOf(decos, 'none').sync).toEqual([]);
  });

  it('분리 HEAD 는 브랜치 칸에 분리 표기를 쓴다', () => {
    const decos = repoDecorations(
      [repo('detached')],
      [summary({ name: 'detached', branch: null, detached: true })],
    );
    expect(decoOf(decos, 'detached').branch).toBe(S.status.detached);
  });

  it('워크트리·서브모듈 종류와 진행 중 작업을 배지로 싣는다', () => {
    const decos = repoDecorations(
      [repo('plain'), repo('wt', 'worktree'), repo('sub', 'submodule'), repo('rebasing')],
      [
        summary({ name: 'plain' }),
        summary({ name: 'wt', kind: 'worktree' }),
        summary({ name: 'sub', kind: 'submodule', op: 'merge' }),
        summary({ name: 'rebasing', branch: null, detached: true, op: 'rebase', changed: 3 }),
      ],
    );
    expect(decoOf(decos, 'plain').badges).toEqual([]);
    expect(decoOf(decos, 'wt').badges).toEqual([{ tone: 'kind', text: S.folder.kind.worktree }]);
    expect(decoOf(decos, 'sub').badges).toEqual([
      { tone: 'kind', text: S.folder.kind.submodule },
      { tone: 'op', text: S.status.op.merge },
    ]);
    expect(decoOf(decos, 'rebasing')).toMatchObject({
      badges: [{ tone: 'op', text: 'REBASING' }],
      changed: 3,
    });
  });

  it('요약에 실패한 저장소는 사유만 싣고 상태 칸을 비운다', () => {
    const decos = repoDecorations(
      [repo('broken')],
      [summary({ name: 'broken', branch: null, error: 'index file smaller than expected' })],
    );
    const deco = decoOf(decos, 'broken');
    expect(deco).toMatchObject({
      error: 'index file smaller than expected',
      branch: null,
      sync: [],
      changed: 0,
    });
    expect(deco.title).toContain(`${ROOT}/broken`);
    expect(deco.title).toContain(S.project.summaryFailed('index file smaller than expected'));
  });

  it('요약을 아직 못 읽은 저장소도 종류 장식이 붙는다', () => {
    const decos = repoDecorations([repo('pending', 'worktree')], []);
    expect(decoOf(decos, 'pending')).toMatchObject({
      icon: 'repo',
      branch: null,
      sync: [],
      changed: 0,
      error: null,
      badges: [{ tone: 'kind', text: S.folder.kind.worktree }],
    });
  });

  it('툴팁에 경로와 브랜치·ahead·behind 를 싣는다 (좁은 창에서 잘리는 정보)', () => {
    const decos = repoDecorations(
      [repo('web')],
      [summary({ name: 'web', branch: 'staging', ahead: 1, behind: 2 })],
    );
    expect(decoOf(decos, 'web').title).toBe(`${ROOT}/web\nstaging 1↑ 2↓`);
  });

  it('스캔 결과에 없는 요약은 장식을 만들지 않는다 (기준은 스캔 결과다)', () => {
    const decos = repoDecorations([repo('kept')], [summary({ name: 'gone' })]);
    expect([...decos.keys()]).toEqual([`${ROOT}/kept`]);
  });
});

describe('branchText·syncTexts (상태 바와 공유)', () => {
  it('요약이 없거나 실패면 브랜치 칸이 없고, ahead·behind 는 0 이 아닌 것만', () => {
    expect(branchText(undefined)).toBeNull();
    expect(branchText(summary({ name: 'x', error: 'boom' }))).toBeNull();
    expect(branchText(summary({ name: 'x', branch: 'dev' }))).toBe('dev');
    expect(syncTexts({ ahead: 0, behind: 54 })).toEqual(['54↓']);
    expect(syncTexts(undefined)).toEqual([]);
  });
});

describe('opBadgeText', () => {
  it('진행 중 작업 종류를 라벨로 바꾸고 없으면 빈 문자열이다', () => {
    expect(opBadgeText('rebase')).toBe('REBASING');
    expect(opBadgeText('merge')).toBe(S.status.op.merge);
    expect(opBadgeText('cherryPick')).toBe(S.status.op.cherryPick);
    expect(opBadgeText('revert')).toBe(S.status.op.revert);
    expect(opBadgeText('bisect')).toBe(S.status.op.bisect);
    expect(opBadgeText('am')).toBe(S.status.op.am);
    expect(opBadgeText(null)).toBe('');
    expect(opBadgeText(undefined)).toBe('');
  });
});

describe('fileStamp (PT-10)', () => {
  const NOW = new Date(2026, 10, 18, 14, 50).getTime();

  it('`날짜, 크기`. 24시간 안은 상대 시각, 그 밖은 날짜와 시각', () => {
    expect(fileStamp(1_536, NOW - 5 * 60_000, NOW)).toBe('5분 전, 1.5 KB');
    expect(fileStamp(12, NOW - 25 * 60 * 60_000, NOW)).toBe('2026. 11. 17. 오후 1:50, 12 B');
  });

  it('모르는 칸은 뺀다. 둘 다 모르면 null', () => {
    expect(fileStamp(null, NOW - 30_000, NOW)).toBe('방금 전');
    expect(fileStamp(2_048, null, NOW)).toBe('2.0 KB');
    expect(fileStamp(null, null, NOW)).toBeNull();
  });
});
