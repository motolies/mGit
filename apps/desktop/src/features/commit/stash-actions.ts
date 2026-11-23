// 저장소 탭 Commit 도구 창 Stash 탭의 동작 (WS-22, W23). 옛 사이드바 스태시 섹션(`Sidebar.tsx`)과 옛 상세
// (`StashDetail`)의 저장 대화상자·우클릭 메뉴·drop 확인창을 그대로 옮겼다 — 항목·순서·구분선·꺼짐 조건·위험 표시·문구가
// 옛 것과 같다. 메뉴와 상세 단추가 같은 함수를 부른다(옛 코드는 drop 확인을 두 곳에 따로 두었다). 구조는 순수 함수가
// 만들고 실행은 컨테이너가 주입한 동작 묶음(`StashDeps`)을 부른다.

import type { StashEntry, StashInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';

/** 꺼짐 조건이 보는 세션 상태 */
export interface StashState {
  /** 다른 작업이 실행 중이다 */
  busy: boolean;
  /** 진행 중 작업(merge·rebase 등)이 있다 */
  inOp: boolean;
}

/** Stash 탭이 부르는 세션 동작 (세션 스토어의 것을 그대로 받는다) */
export type StashSession = Pick<
  SessionState,
  'selectStash' | 'stashPush' | 'stashApply' | 'stashPop' | 'stashDrop'
>;

/** 확인·입력 대화상자 (`useDialogs` 의 것) */
export type StashDialogs = Pick<ReturnType<typeof useDialogs>, 'confirm' | 'prompt'>;

/** 컨테이너가 주입하는 동작 묶음 */
export interface StashDeps {
  state: StashState;
  session: StashSession;
  dialogs: StashDialogs;
  /** pop 이 성공한 뒤: 되살아난 변경을 보게 변경 탭으로 (옛 상세의 `selectWip()` 자리) */
  onPopped: () => void;
  /** drop 이 성공한 뒤 (Stash 탭에 머물며 포커스를 이웃 행으로) */
  onDropped: (entry: StashEntry) => void;
}

/**
 * 보일 스태시 목록: 출처 정보(`listStashes`)가 아직 안 왔으면 refs 의 목록을 출처 없이 보인다 (옛 사이드바와 같은
 * 규칙 — 읽은 목록이 비었고 refs 에 있을 때만 대신한다)
 */
export function stashEntries(stashes: StashEntry[], refStashes: StashInfo[]): StashEntry[] {
  return stashes.length > 0 || refStashes.length === 0
    ? stashes
    : refStashes.map((info) => ({ info, origin: null }));
}

/** 저장(`+`)·apply·pop 을 막는 상태인지: 다른 작업 실행 중이거나 진행 중 작업이 있다 (옛 사이드바의 `disabled`) */
export function stashWriteBlocked(state: StashState): boolean {
  return state.busy || state.inOp;
}

/** 행의 툴팁: 다른 워크트리에서 만든 스태시면 그 경로, 아니면 메시지 (옛 사이드바 그대로) */
export function stashRowTitle(entry: StashEntry): string {
  return entry.origin ? S.sidebar.origin(entry.origin) : entry.info.message;
}

/** stash 저장 대화상자 (ST-01): 메시지·untracked 포함(기본 켜짐)·staged 만. 취소하면 부르지 않는다 */
export async function saveStash(deps: Pick<StashDeps, 'dialogs' | 'session'>): Promise<void> {
  const v = await deps.dialogs.prompt({
    title: S.stash.saveTitle,
    fields: [
      { key: 'message', label: S.stash.message },
      { key: 'untracked', label: S.stash.includeUntracked, type: 'checkbox', initial: true },
      { key: 'staged', label: S.stash.stagedOnly, type: 'checkbox' },
    ],
    confirmLabel: S.dialog.create,
  });
  if (v) {
    await deps.session.stashPush(
      str(v, 'message') || null,
      bool(v, 'untracked'),
      bool(v, 'staged'),
      [],
    );
  }
}

/** drop: 위험 확인창 뒤에만 지운다 (되돌릴 수 없다). 성공하면 `onDropped`. 지웠는지 돌려준다 */
export async function dropStash(
  entry: StashEntry,
  deps: Pick<StashDeps, 'dialogs' | 'session' | 'onDropped'>,
): Promise<boolean> {
  const ok = await deps.dialogs.confirm({
    title: S.stash.dropTitle(S.stash.name(entry.info.index)),
    message: S.stash.dropMessage,
    confirmLabel: S.dialog.delete,
    danger: true,
  });
  if (!ok || !(await deps.session.stashDrop(entry.info.oid))) {
    return false;
  }
  deps.onDropped(entry);
  return true;
}

/** pop: 성공하면 `onPopped` (변경 탭으로). 메뉴와 상세 단추가 같다 */
export async function popStash(
  oid: string,
  deps: Pick<StashDeps, 'session' | 'onPopped'>,
): Promise<void> {
  if (await deps.session.stashPop(oid)) {
    deps.onPopped();
  }
}

/**
 * 스태시 행의 우클릭 메뉴 (옛 사이드바 그대로): 내용 보기 / ─ / apply / pop / drop…(위험). apply·pop 은 쓰기를 막는
 * 상태(실행 중·진행 중 작업)에서, drop 은 실행 중에만 꺼진다
 */
export function stashMenu(entry: StashEntry, deps: StashDeps): MenuItem[] {
  const { oid } = entry.info;
  const blocked = stashWriteBlocked(deps.state);
  return [
    { label: S.stash.show, onSelect: () => void deps.session.selectStash(entry) },
    {
      label: S.stash.apply,
      separator: true,
      disabled: blocked,
      onSelect: () => void deps.session.stashApply(oid),
    },
    { label: S.stash.pop, disabled: blocked, onSelect: () => void popStash(oid, deps) },
    {
      label: S.stash.drop,
      danger: true,
      disabled: deps.state.busy,
      onSelect: () => void dropStash(entry, deps),
    },
  ];
}
