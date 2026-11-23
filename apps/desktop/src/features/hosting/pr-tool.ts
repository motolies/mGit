// Pull Requests 도구 창의 구조 (W24, WS-17). 옛 Git 도구 창 왼쪽 칸의 PR/MR 섹션(`PrSection.tsx`)이 그리던 머리 단추의
// 꺼짐 조건·내용 상태 다섯·행 배지·우클릭 메뉴를 그대로 옮겼다 — 항목·순서·구분선·꺼짐 조건·문구가 옛 것과 같다. 구조는
// 순수 함수가 만들고 실행은 컨테이너가 주입한 동작 묶음(`PrDeps`·`PrCreateDeps`)을 부른다 (W22·W23 과 같은 방식)

import type { CreatePr, PrTemplate, PullRequest, RemoteProject, RepoRefs } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import type { useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';
import { checkoutPrWorktreeFlow, createPrFlow } from './pr-flows';

/** 확인·입력 대화상자 (`useDialogs` 의 것 — PR 흐름이 그대로 받는다) */
export type PrDialogs = ReturnType<typeof useDialogs>;

/**
 * 내용 칸의 상태 (옛 섹션의 분기 순서 그대로): 계정 없음 → 오류 → 읽는 중(목록이 빌 때만) → 비어 있음 → 목록. 읽는 중에
 * 목록이 있으면 목록을 그대로 보인다 (새로고침 단추만 꺼진다)
 */
export type PrContent =
  | { kind: 'noAccount' }
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'list' };

/** 지금 그릴 내용 칸의 상태 */
export function prContent(s: {
  project: RemoteProject;
  error: string | null;
  loading: boolean;
  count: number;
}): PrContent {
  if (!s.project.accountId) {
    return { kind: 'noAccount' };
  }
  if (s.error) {
    return { kind: 'error', message: s.error };
  }
  if (s.loading && s.count === 0) {
    return { kind: 'loading' };
  }
  return s.count === 0 ? { kind: 'empty' } : { kind: 'list' };
}

/** 머리의 새로고침 단추가 꺼지는지: 읽는 중 (옛 섹션의 ↻) */
export function prReloadDisabled(loading: boolean): boolean {
  return loading;
}

/** 머리의 만들기 단추가 꺼지는지: 다른 작업이 실행 중이거나 현재 branch 가 없다(분리 HEAD) (옛 섹션의 "만들기…") */
export function prCreateDisabled(s: { busy: boolean; headBranch: string | null }): boolean {
  return s.busy || !s.headBranch;
}

/** 행의 배지 하나 */
export interface PrBadge {
  kind: 'draft' | 'review' | 'checks' | 'conflict';
  text: string;
  /** 툴팁. 검사 배지만 검사 상태 원문(success·failure·pending)을 단다 (옛 섹션 그대로) */
  title?: string;
  /** 색: 성공(승인·검사 성공) / 위험(변경 요청·검사 실패·충돌) / 없음(흐린 글자) */
  tone: 'success' | 'danger' | null;
}

/** 리뷰 상태의 색 (옛 CSS 의 `data-review` 규칙) */
function reviewTone(review: string): PrBadge['tone'] {
  return review === 'approved' ? 'success' : review === 'changes_requested' ? 'danger' : null;
}

/** 검사 상태의 색 (옛 CSS 의 `data-checks` 규칙) */
function checksTone(checks: string): PrBadge['tone'] {
  return checks === 'success' ? 'success' : checks === 'failure' ? 'danger' : null;
}

/**
 * 행의 배지들 (옛 섹션의 순서와 조건 그대로): draft(초안일 때) → 리뷰(리뷰 상태가 있을 때) → 검사(검사 상태가 있을 때,
 * 툴팁 = 원문) → 충돌(`mergeable === false` 일 때만 — 모름(null)은 표시하지 않는다). 작성자는 배지가 아니라 뒤에 따로 쓴다
 */
export function prBadges(pr: PullRequest): PrBadge[] {
  const badges: PrBadge[] = [];
  if (pr.draft) {
    badges.push({ kind: 'draft', text: S.pr.draftBadge, tone: null });
  }
  if (pr.review) {
    badges.push({ kind: 'review', text: S.pr.review(pr.review), tone: reviewTone(pr.review) });
  }
  if (pr.checks) {
    badges.push({
      kind: 'checks',
      text: S.pr.checks(pr.checks),
      title: pr.checks,
      tone: checksTone(pr.checks),
    });
  }
  if (pr.mergeable === false) {
    badges.push({ kind: 'conflict', text: S.pr.conflict, tone: 'danger' });
  }
  return badges;
}

/** 행의 번호 표시 (`#128`). 번호가 없으면 `#` 만 (옛 섹션 그대로) */
export function prNumberLabel(pr: PullRequest): string {
  return `#${pr.number ?? ''}`;
}

/** 행 메뉴·더블클릭이 쓰는 동작 묶음 (컨테이너가 주입한다) */
export interface PrDeps {
  /** 꺼짐 조건과 워크트리 경로의 기본값이 보는 세션 상태 */
  state: { busy: boolean; repoPath: string };
  session: Pick<SessionState, 'checkoutPullRequest'>;
  dialogs: PrDialogs;
  /** 웹 주소를 브라우저로 연다 (앱 스토어의 `openUrl`) */
  openUrl: (url: string) => Promise<void>;
  /** 워크트리로 체크아웃한 뒤 그 워크트리를 탭으로 연다 (앱 스토어의 `openRepositoryAt`) */
  openRepositoryAt: (path: string) => Promise<unknown>;
}

/** PR 을 웹에서 연다: 행 더블클릭·Enter, 메뉴의 "브라우저에서 열기" */
export function openPr(pr: PullRequest, deps: Pick<PrDeps, 'openUrl'>): void {
  void deps.openUrl(pr.webUrl);
}

/**
 * 행의 우클릭 메뉴 (HO-04, 옛 섹션 그대로): branch 로 체크아웃(`checkoutPullRequest(번호, null)`) / 새 워크트리로
 * 체크아웃…(경로를 묻는 흐름) / ─ / 브라우저에서 열기. 앞의 둘은 다른 작업이 실행 중이면 꺼진다
 */
export function prMenu(pr: PullRequest, deps: PrDeps): MenuItem[] {
  const number = pr.number ?? 0;
  return [
    {
      label: S.pr.checkout,
      disabled: deps.state.busy,
      onSelect: () => void deps.session.checkoutPullRequest(number, null),
    },
    {
      label: S.pr.checkoutWorktree,
      disabled: deps.state.busy,
      onSelect: () =>
        void checkoutPrWorktreeFlow(deps.dialogs, {
          repoPath: deps.state.repoPath,
          number,
          checkout: deps.session.checkoutPullRequest,
          openRepositoryAt: deps.openRepositoryAt,
        }),
    },
    { label: S.pr.openWeb, separator: true, onSelect: () => openPr(pr, deps) },
  ];
}

/** 머리의 "만들기…"가 쓰는 동작 묶음 */
export interface PrCreateDeps {
  dialogs: PrDialogs;
  headBranch: string | null;
  refs: RepoRefs;
  /** 원격 프로젝트의 원격 이름 (base 후보를 이 원격의 branch 에서 고른다) */
  remote: string;
  templates: () => Promise<PrTemplate[]>;
  create: (spec: CreatePr) => Promise<PullRequest | null>;
  openUrl: (url: string) => Promise<void>;
  /** 만든 뒤 목록을 다시 읽는다 */
  reload: () => Promise<void>;
}

/** PR/MR 만들기 (HO-03): 옛 흐름(`createPrFlow` — 템플릿 → 입력 → 생성 → 브라우저) 뒤 만들었으면 목록을 다시 읽는다 */
export async function createPr(deps: PrCreateDeps): Promise<void> {
  const pr = await createPrFlow(deps.dialogs, deps);
  if (pr) {
    await deps.reload();
  }
}
