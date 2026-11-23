// 폴더 탭이 쓰는 저장소 세션의 장부와 범위 세션 판정 (W13). 화면·IPC 없이 판단만 하는 순수 함수다 — 앱 스토어가
// 이 결과대로 세션을 열고 놓으며, 훅(`use-session.ts`)이 범위 세션을 고른다.
//
// 용어: "범위 세션" = 지금 화면의 세션 기능(대화상자 등)이 대고 동작하는 세션. 저장소 탭에서는 그 탭의 세션,
// 폴더 탭에서는 활성 저장소의 숨은 세션(열려 있을 때만)이다.

import type { SessionId } from '@mgit/ipc';
import type { PendingHint, SessionState } from './session-store';

/** 폴더 하나가 동시에 잡을 수 있는 가벼운 세션 수 (코어 `LIGHT_SESSIONS_PER_FOLDER` 와 같다) */
export const LIGHT_SESSIONS_PER_FOLDER = 3;

/** 폴더 탭 장부의 항목 하나: 그 폴더가 저장소 하나에 쓰는 세션 */
export interface RepoSessionEntry {
  session: SessionId;
  /**
   * 이 폴더가 잡은 가벼운 세션인지. 거짓이면 저장소 탭의 세션을 빌린 것이다 — 상한에 세지 않고 놓지 않으며,
   * 그 탭이 닫히면 항목도 지운다 (승격된 세션도 여기로 바뀐다)
   */
  held: boolean;
  /** 마지막으로 쓴 시각 (ms). 상한에서 놓을 세션을 고른다 (LRU) */
  usedAt: number;
}

/** 폴더 탭 하나의 장부: 저장소 절대 경로 → 항목 */
export type RepoSessionLedger = Readonly<Record<string, RepoSessionEntry>>;

/** 앱 전체의 장부: 폴더 탭 id → 그 폴더의 장부 */
export type RepoSessionLedgers = Readonly<Record<SessionId, RepoSessionLedger>>;

/**
 * 바쁨 판정이 읽는 세션 상태. `pendingHint` 는 폴더 탭에 보이는 힌트 대화상자(W15)를 셀 때 쓴다 — 없으면 힌트가
 * 없는 것으로 본다
 */
export type BusyFields = Pick<
  SessionState,
  'busy' | 'committing' | 'operations' | 'conflictDrafts' | 'blame' | 'fileHistory'
> &
  Partial<Pick<SessionState, 'pendingHint'>>;

/**
 * 세션에서 지금 도는 것이 있는지: 쓰기(`busy`)·커밋, 끝나지 않은 장시간 명령. 결과(힌트·오류)가 나중에 이 세션에
 * 온다 (W15: 활성 저장소 잠금은 이것과 보이는 대화상자만 본다 — 초안은 결과를 만들지 않는다)
 */
export function sessionInFlight(st: BusyFields): boolean {
  return st.busy || st.committing || Object.values(st.operations).some((op) => !op.done);
}

/**
 * 세션에 놓거나 닫으면 잃는 것이 있는지: 도는 것(`sessionInFlight`)과 미저장 충돌 초안. 재스캔으로 저장소가 빠져도
 * 이런 세션은 놓지 않는다
 */
export function sessionHasWork(st: BusyFields): boolean {
  return sessionInFlight(st) || Object.keys(st.conflictDrafts).length > 0;
}

/**
 * 폴더 탭에서 힌트(`pendingHint`)를 다루는 방식 (W15). 힌트가 거는 동작은 그 힌트를 세운 세션(폴더 탭에서는 숨은
 * 세션)에 대고 실행되므로, 폴더 탭에서 생길 수 있고 그 저장소에 대고 해도 되는 것만 켠다:
 * - `act`: 저장소 탭과 같은 대화상자·동작 (제목에 저장소 이름) — index.lock 지우기, 충돌 마커가 남은 채 계속·저장,
 *   구문 오류가 있어도 저장, 보관한 해결 재적용, commit 할 것이 없다는 안내
 * - `info`: 알리기만 한다 (확인 단추 하나) — hook 거부. 저장소 탭의 재시도(hook 건너뛰고 commit)는 커밋 폼의 동작이라
 *   진행 중 작업의 계속에서 생긴 거부에 걸면 엉뚱한 일을 한다
 * - `off`: 폴더 탭에 보이지 않고 바쁨에도 세지 않는다 — checkout·branch 삭제·push·pull·add·저장소 탭 commit 에서만
 *   생긴다 (폴더 탭은 그 동작을 세션에 걸지 않는다. 같은 저장소의 저장소 탭이 열려 있으면 그 탭이 보인다)
 * 새 힌트 종류를 더하면 여기서 컴파일 오류가 나 결정을 강제한다
 */
export type FolderHintMode = 'act' | 'info' | 'off';

/** 힌트 하나를 폴더 탭에서 다루는 방식 (`FolderHintMode`) */
export function folderHintMode(hint: PendingHint): FolderHintMode {
  switch (hint.kind) {
    case 'indexLock':
    case 'syntaxErrors':
    case 'reapplyResolutions':
    case 'nothingToCommit':
      return 'act';
    case 'conflictMarkers':
      // 재시도가 커밋이면 저장소 탭 커밋 폼의 것이다
      return hint.retry.kind === 'commit' ? 'off' : 'act';
    case 'hookFailed':
      return 'info';
    case 'dirtyWorkTree':
    case 'remoteBranchTaken':
    case 'notFullyMerged':
    case 'branchElsewhere':
    case 'nonFastForward':
    case 'staleInfo':
    case 'tagExists':
    case 'detachedHead':
    case 'noUpstream':
    case 'nestedRepo':
    case 'submoduleUnpushed':
    case 'pushUpstreamMismatch':
      return 'off';
  }
}

/** 폴더 탭에 보일 힌트가 서 있는지 (`off` 가 아닌 힌트) */
export function folderHintPending(st: Pick<BusyFields, 'pendingHint'>): boolean {
  return (
    st.pendingHint !== null &&
    st.pendingHint !== undefined &&
    folderHintMode(st.pendingHint) !== 'off'
  );
}

/**
 * 폴더 탭에서 보이는 세션 대화상자가 열려 있는지: blame·파일 히스토리(W13)와 폴더 탭에 보이는 힌트(W15,
 * `folderHintMode` 가 `off` 가 아닌 것). 화면에 보이지 않는 대화상자 상태를 바쁨으로 세면 사용자가 닫을 수 없어
 * 세션이 영영 바쁜 채로 남는다 — 폴더 탭에 대화상자를 더하는 슬라이스는 여기에도 더한다
 */
export function sessionDialogOpen(st: BusyFields): boolean {
  return st.blame !== null || st.fileHistory !== null || folderHintPending(st);
}

/** 세션이 바쁜지: 작업·초안이 있거나 폴더 탭의 세션 대화상자가 열려 있다. 바쁜 세션은 상한에서 놓지 않는다 */
export function sessionBusy(st: BusyFields): boolean {
  return sessionHasWork(st) || sessionDialogOpen(st);
}

/**
 * 범위 세션이 활성 저장소를 붙잡는지 (W15): 도는 것이 있거나(결과가 나중에 범위 세션에 온다) 폴더 탭에 보이는 세션
 * 대화상자가 열려 있다. 충돌 초안은 세지 않는다 — 초안은 그 세션에 남고 충돌 탭은 장부에서 파생되므로 활성 저장소가
 * 옮겨 가도 사라지는 것이 없다 (초안 때문에 다른 저장소의 충돌 해결·작업 띠를 막지 않게)
 */
export function sessionHoldsScope(st: BusyFields): boolean {
  return sessionInFlight(st) || sessionDialogOpen(st);
}

/** 장부에서 이 폴더가 잡은 세션 수 (빌린 탭 세션은 세지 않는다) */
export function heldCount(ledger: RepoSessionLedger): number {
  return Object.values(ledger).filter((e) => e.held).length;
}

/**
 * 상한에 닿았을 때 놓을 세션의 저장소 경로: 이 폴더가 잡은 것 중 바쁘지 않고 가장 오래 안 쓴 것.
 * 같은 시각이면 경로순으로 정해 결과가 흔들리지 않게 한다. 놓을 수 있는 것이 없으면 null
 */
export function pickEvictable(
  ledger: RepoSessionLedger,
  isBusy: (session: SessionId) => boolean,
): string | null {
  const candidates = Object.entries(ledger)
    .filter(([, e]) => e.held && !isBusy(e.session))
    .sort(([pa, a], [pb, b]) => a.usedAt - b.usedAt || pa.localeCompare(pb));
  return candidates[0]?.[0] ?? null;
}

/**
 * 코어가 알려 준 "이 폴더가 잡은 세션" 목록(`lightSessionLimit` 의 `sessions`)으로 장부를 맞춘다.
 * - 잡았다고 적었는데 코어 목록에 없는 세션: 탭이 있으면 승격된 것(빌림으로 바꾼다), 없으면 닫힌 것(지운다)
 * - 빌렸다고 적었는데 코어 목록에 있으면 잡음으로 바꾼다. 빌린 탭이 이미 없으면 지운다
 * - 코어 목록에 있는데 장부 어디에도 없는 세션은 `orphans` — 프런트가 기록을 잃은 잡음이라 놓아야 한다
 * 돌려주는 `dropped` 는 지운 항목의 세션 (스토어 정리용)
 */
export function reconcileLedger(
  ledger: RepoSessionLedger,
  coreHeld: readonly SessionId[],
  hasTab: (session: SessionId) => boolean,
): { ledger: RepoSessionLedger; orphans: SessionId[]; dropped: SessionId[] } {
  const held = new Set(coreHeld);
  const next: Record<string, RepoSessionEntry> = {};
  const dropped: SessionId[] = [];
  for (const [path, entry] of Object.entries(ledger)) {
    if (held.has(entry.session)) {
      next[path] = entry.held ? entry : { ...entry, held: true };
    } else if (hasTab(entry.session)) {
      next[path] = entry.held ? { ...entry, held: false } : entry;
    } else {
      dropped.push(entry.session);
    }
  }
  const known = new Set(Object.values(next).map((e) => e.session));
  const orphans = coreHeld.filter((id) => !known.has(id));
  return { ledger: next, orphans, dropped };
}

/** 어느 폴더 장부든 이 세션을 가리키는지 (세션 스토어를 남겨야 하는지) */
export function ledgerReferences(ledgers: RepoSessionLedgers, session: SessionId): boolean {
  return Object.values(ledgers).some((ledger) =>
    Object.values(ledger).some((e) => e.session === session),
  );
}

/** 이 세션을 가리키는 (폴더, 저장소 경로) 목록 — 세션 이벤트를 폴더 화면에 잇는다 */
export function foldersUsing(
  ledgers: RepoSessionLedgers,
  session: SessionId,
): { folder: SessionId; repoPath: string }[] {
  return Object.entries(ledgers).flatMap(([folder, ledger]) =>
    Object.entries(ledger)
      .filter(([, e]) => e.session === session)
      .map(([repoPath]) => ({ folder: Number(folder), repoPath })),
  );
}

/** 모든 폴더 장부에서 이 세션을 가리키는 항목을 지운다 (탭을 닫아 세션이 닫힐 때). 바뀐 것이 없으면 그대로 */
export function withoutSession(
  ledgers: RepoSessionLedgers,
  session: SessionId,
): RepoSessionLedgers {
  if (!ledgerReferences(ledgers, session)) {
    return ledgers;
  }
  return Object.fromEntries(
    Object.entries(ledgers).map(([folder, ledger]) => [
      folder,
      Object.fromEntries(Object.entries(ledger).filter(([, e]) => e.session !== session)),
    ]),
  );
}

/** 이 세션을 가리키는 항목을 빌림으로 바꾼다 (탭으로 승격돼 코어가 폴더들의 잡음을 지웠다) */
export function asBorrowed(ledgers: RepoSessionLedgers, session: SessionId): RepoSessionLedgers {
  if (!ledgerReferences(ledgers, session)) {
    return ledgers;
  }
  return Object.fromEntries(
    Object.entries(ledgers).map(([folder, ledger]) => [
      folder,
      Object.fromEntries(
        Object.entries(ledger).map(([path, e]) => [
          path,
          e.session === session && e.held ? { ...e, held: false } : e,
        ]),
      ),
    ]),
  );
}

/** 범위 세션 판정에 필요한 앱 상태 */
export interface ScopeInput {
  /** 활성 탭의 id 와 종류. 탭이 없으면 null */
  tab: { id: SessionId; kind: 'repo' | 'folder' } | null;
  ledgers: RepoSessionLedgers;
  /** 폴더 탭의 활성 저장소 (워크스페이스 스토어). 저장소 탭·없으면 null */
  activeRepo: string | null;
}

/**
 * 범위 세션 id: 저장소 탭이면 그 탭의 세션, 폴더 탭이면 활성 저장소의 숨은 세션(장부에 있을 때만), 그 밖에는 null.
 * 폴더 탭에서 활성 저장소만 바뀌는 것으로는 세션이 생기지 않는다 — 장부는 기능을 요청할 때만 채워진다
 */
export function scopeSessionId(input: ScopeInput): SessionId | null {
  const { tab, ledgers, activeRepo } = input;
  if (tab === null) {
    return null;
  }
  if (tab.kind === 'repo') {
    return tab.id;
  }
  if (activeRepo === null) {
    return null;
  }
  return ledgers[tab.id]?.[activeRepo]?.session ?? null;
}

/**
 * 폴더 탭의 활성 저장소를 다른 저장소로 옮기지 못하게 잠그는지 (계획 5.1): 그 폴더에서 세션을 여는 중이거나,
 * 지금 범위 세션(활성 저장소의 숨은 세션)이 활성 저장소를 붙잡으면(`sessionHoldsScope` — 도는 쓰기·보이는 대화상자)
 * 잠근다. 충돌 초안만 있으면 잠그지 않는다 (W15). 범위 세션이 없으면 `scope` 는 null
 */
export function activeRepoLocked(input: { opening: boolean; scope: BusyFields | null }): boolean {
  return input.opening || (input.scope !== null && sessionHoldsScope(input.scope));
}

/**
 * 이 저장소의 세션 기능을 지금 쓸 수 있는지 (W15 작업 띠의 "상한이라 실행할 수 없음"): 장부에 이미 있거나, 잡은 세션이
 * 상한 밑이거나, 놓을 수 있는 세션이 있으면 참. `keep` 은 놓으면 안 되는 세션(바쁨·보이는 문서의 세션)이다 — 앱 스토어가
 * 세션을 열 때(`ensureRepoSession`) 고르는 규칙과 같다
 */
export function sessionSlotAvailable(
  ledger: RepoSessionLedger,
  repoPath: string,
  keep: (session: SessionId) => boolean,
): boolean {
  if (ledger[repoPath] !== undefined || heldCount(ledger) < LIGHT_SESSIONS_PER_FOLDER) {
    return true;
  }
  return pickEvictable(ledger, keep) !== null;
}

/**
 * 폴더 탭에 지금 보일 힌트의 세션 (W15): 모달이 겹치지 않게 한 번에 하나다. 범위 세션 → 에디터에 보이는 세션 문서의
 * 세션 → 장부의 저장소 경로순으로 고른다. `hasHint` 는 그 세션에 폴더 탭에 보일 힌트가 서 있는지
 * (`folderHintPending`). 없으면 null
 */
export function folderHintSession(
  ledger: RepoSessionLedger,
  hasHint: (session: SessionId) => boolean,
  scope: SessionId | null,
  shown: SessionId | null,
): { repoPath: string; session: SessionId } | null {
  const entries = Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b));
  const find = (session: SessionId | null) =>
    session === null ? undefined : entries.find(([, e]) => e.session === session);
  const first =
    [find(scope), find(shown)].find((hit) => hit !== undefined && hasHint(hit[1].session)) ??
    entries.find(([, e]) => hasHint(e.session));
  return first ? { repoPath: first[0], session: first[1].session } : null;
}

/**
 * 폴더 탭을 닫으면 잃는 것 하나 (WS-21): 함께 닫히는 하위 저장소 탭(그 탭의 초안 경로), 이 폴더가 잡은 숨은 세션의
 * 미저장 충돌 초안, 숨은 세션에서 도는 작업
 */
export type FolderCloseRisk =
  | { kind: 'childTab'; name: string; drafts: string[] }
  | { kind: 'draft'; repoName: string; paths: string[] }
  | { kind: 'running'; repoName: string };

/** 폴더 탭 닫기 판정의 입력 */
export interface FolderCloseInput {
  /** 이 폴더 탭에서 연 하위 저장소 탭 (폴더를 닫으면 함께 닫힌다) */
  children: readonly { name: string; drafts: readonly string[] }[];
  /**
   * 이 폴더가 잡은 숨은 세션 (장부의 `held` 항목 — 폴더를 닫으면 코어가 닫는다). 빌린 탭 세션은 넣지 않는다: 그 탭이
   * 하위 탭이면 `children` 이 세고, 아니면 폴더를 닫아도 남는다
   */
  held: readonly { repoName: string; drafts: readonly string[]; running: boolean }[];
}

/**
 * 폴더 탭을 닫기 전에 확인할 것들 (WS-21, 결정 7번): 하위 저장소 탭이 있으면 그 탭마다, 숨은 세션에 초안이 있거나 작업이
 * 돌면 그 저장소마다 한 줄. 빈 목록이면 확인 없이 닫는다
 */
export function folderCloseRisks(input: FolderCloseInput): FolderCloseRisk[] {
  return [
    ...input.children.map(
      (c): FolderCloseRisk => ({ kind: 'childTab', name: c.name, drafts: [...c.drafts] }),
    ),
    ...input.held.flatMap((h): FolderCloseRisk[] => [
      ...(h.drafts.length > 0
        ? [{ kind: 'draft' as const, repoName: h.repoName, paths: [...h.drafts] }]
        : []),
      ...(h.running ? [{ kind: 'running' as const, repoName: h.repoName }] : []),
    ]),
  ];
}

/**
 * 활성 저장소를 바꾸려 할 때의 결과: 잠겨 있으면 지금 값을 지킨다. 후보가 null 이면("그대로") 지금 값이다.
 * 같은 저장소로는 언제나 된다
 */
export function nextActiveRepo(
  current: string | null,
  candidate: string | null,
  locked: boolean,
): string | null {
  if (candidate === null || candidate === current) {
    return current;
  }
  return locked ? current : candidate;
}
