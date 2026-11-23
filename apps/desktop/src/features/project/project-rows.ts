import type { FoundRepo, OpKind, RepoSummary } from '@mgit/ipc';
import { formatBytes, formatFileDate, type IconName, S } from '@mgit/ui';
import type { RowStatus } from './file-status';

/** 행 뒤에 붙는 작은 배지 */
export interface ProjectBadge {
  /**
   * 종류(워크트리·서브모듈) / 진행 중 작업·주의할 상태(빨강 굵게) / 지금 걸린 범위(강조색, W25) / 상태 문구(흐린 글자, 테두리
   * 없음 — 서브모듈의 "commit 다름" 등, W25)
   */
  tone: 'kind' | 'op' | 'scope' | 'state';
  text: string;
}

/**
 * 저장소 행의 장식 (PT-02). 트리는 어느 행이 저장소인지 모른다 — 컨테이너가 경로마다 장식을 정해 주입한다.
 * 폴더 탭은 저장소 디렉터리에 저장소 요약을 붙이고, 저장소 탭이 같은 틀로 옮겨 오면(W21) 루트 1개에 그 저장소의
 * 장식을 붙인다
 */
export interface RepoDecoration {
  /** 항목 종류의 아이콘 대신 쓸 아이콘 (저장소 = repo) */
  icon: IconName;
  /** 이름을 굵게 쓸지 */
  bold: boolean;
  /** 브랜치 칸: 브랜치명 또는 분리 HEAD 표기. 요약을 못 읽었으면 null */
  branch: string | null;
  /** 0 이 아닌 ahead·behind 를 숫자 먼저 쓴 것: `3↑`, `54↓` */
  sync: string[];
  badges: ProjectBadge[];
  /** 변경 파일 수 (0 이면 그리지 않는다) */
  changed: number;
  /** 요약 실패 사유 */
  error: string | null;
  /** 툴팁: 경로와, 좁은 창에서 잘릴 수 있는 브랜치·ahead·behind, 요약 실패 사유 */
  title: string;
}

/**
 * 프로젝트 트리의 행 장식 (PT-02·06): 저장소 행은 저장소 장식을 모두 싣고, 그 밖의 행은 상태만 싣는다.
 * 무엇을 붙일지는 컨테이너가 경로마다 정한다
 */
export type RowDecoration = Partial<RepoDecoration> & {
  /** 파일 상태 (이름 색·행 끝 상태 문자). 변경이 없으면 없다 */
  status?: RowStatus | null;
  /**
   * 이름 바로 뒤의 흐린 보조 글자 (항목 행 — 루트 행은 경로를 쓴다). 자리가 모자라면 먼저 줄어든다. 저장소 탭에서 모듈
   * 이름이 디렉터리 이름과 다를 때 `[이름]` 으로 쓴다 (W25)
   */
  detail?: string | null;
  /**
   * 아이콘의 뜻. 주면 아이콘을 이 이름의 그림으로 알린다 (보조 기술이 행 이름의 앞에 읽는다 — 모양만으로 전하는 종류를
   * 글자로도, W25). 주지 않으면 아이콘은 꾸밈이다
   */
  iconLabel?: string;
};

/**
 * 파일 행 이름 뒤의 회색 글자 (PT-10): `날짜, 크기`. 24시간 안에 바뀐 파일의 날짜는 상대 시각이다
 * (`formatFileDate`). 모르는 칸은 뺀다. 둘 다 모르면 null
 */
export function fileStamp(size: number | null, mtimeMs: number | null, now: number): string | null {
  const parts = [
    ...(mtimeMs !== null ? [formatFileDate(mtimeMs, now, S.date)] : []),
    ...(size !== null ? [formatBytes(size)] : []),
  ];
  return parts.length === 0 ? null : parts.join(', ');
}

/** 진행 중 작업의 라벨. 요약은 종류만 알므로 rebase 단계는 쓰지 않는다 */
export function opBadgeText(op: OpKind | null | undefined): string {
  switch (op) {
    case 'merge':
      return S.status.op.merge;
    case 'rebase':
      return S.project.rebasing;
    case 'cherryPick':
      return S.status.op.cherryPick;
    case 'revert':
      return S.status.op.revert;
    case 'bisect':
      return S.status.op.bisect;
    case 'am':
      return S.status.op.am;
    default:
      return '';
  }
}

/** 0 이 아닌 ahead·behind 를 `3↑`·`54↓` 로 (PT-02) */
export function syncTexts(summary: Pick<RepoSummary, 'ahead' | 'behind'> | undefined): string[] {
  const ahead = summary?.ahead ?? 0;
  const behind = summary?.behind ?? 0;
  return [
    ...(ahead > 0 ? [S.project.ahead(ahead)] : []),
    ...(behind > 0 ? [S.project.behind(behind)] : []),
  ];
}

/** 요약의 브랜치 칸: 분리 HEAD 면 그 표기, 요약이 없거나 실패했으면 null */
export function branchText(summary: RepoSummary | undefined): string | null {
  if (summary === undefined || summary.error !== null) {
    return null;
  }
  return summary.detached ? S.status.detached : (summary.branch ?? null);
}

/** 저장소 디렉터리 행의 장식. 요약이 아직 없으면 종류 배지만 싣는다 */
export function repoDecoration(repo: FoundRepo, summary: RepoSummary | undefined): RepoDecoration {
  const error = summary?.error ?? null;
  const opText = opBadgeText(summary?.op);
  const badges: ProjectBadge[] = [
    ...(repo.kind !== 'standalone'
      ? [{ tone: 'kind' as const, text: S.folder.kind[repo.kind] }]
      : []),
    ...(opText !== '' ? [{ tone: 'op' as const, text: opText }] : []),
  ];
  const branch = branchText(summary);
  const sync = error === null ? syncTexts(summary) : [];
  const title = [
    repo.path,
    ...(branch !== null ? [[branch, ...sync].join(' ')] : []),
    ...(error !== null ? [S.project.summaryFailed(error)] : []),
  ].join('\n');
  return {
    icon: 'repo',
    bold: true,
    branch,
    sync,
    badges,
    changed: error === null ? (summary?.changed ?? 0) : 0,
    error,
    title,
  };
}

/**
 * 폴더의 저장소마다 행 장식을 만든다 (절대 경로 → 장식). 저장소 목록(스캔 결과)을 기준으로 하고 요약을 경로로
 * 붙인다 — 요약이 아직 없거나 실패해도 저장소 행은 장식된다. 스캔 결과에 없는 요약은 쓰지 않는다
 */
export function repoDecorations(
  repos: readonly FoundRepo[],
  summaries: readonly RepoSummary[],
): Map<string, RepoDecoration> {
  const byPath = new Map(summaries.map((s) => [s.path, s]));
  return new Map(repos.map((repo) => [repo.path, repoDecoration(repo, byPath.get(repo.path))]));
}
