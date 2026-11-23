// 저장소 탭 브랜치 트리의 메뉴와 동작 (BT-11, W22). 옛 사이드바(`Sidebar.tsx`)의 다섯 섹션 메뉴·더블클릭·머리 버튼을
// 그대로 옮겼다 — 항목·순서·구분선·하위 메뉴·비활성 조건·확인창 문구가 옛 것과 같다. 구조는 순수 함수가 만들고,
// 실행은 컨테이너가 주입한 동작 묶음(`RepoBranchDeps`: 세션 동작·대화상자·탭 열기·복사)을 부른다.

import { type GraphQuery, remoteBranchName, type SessionId, type WorktreeInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';
import { createWorktreeFlow } from '../worktree/create-worktree';
import type { BranchRowAction } from './BranchTree';
import { REPO_GROUP_IDS, type RepoBranchTarget } from './repo-branch-tree';

/** 메뉴의 비활성 조건과 기본값이 보는 세션 상태 */
export interface RepoBranchMenuState {
  /** 이 세션의 id (격리 병합 탭을 이 탭의 하위로 연다) */
  id: SessionId;
  /** 이 탭의 작업 트리 경로 (지금 연 워크트리) */
  path: string;
  busy: boolean;
  /** 진행 중 작업(merge·rebase 등)이 있는지 */
  inOp: boolean;
  /** 현재 브랜치 이름. 분리 HEAD 면 null */
  headBranch: string | null;
  /** 격리 병합 중인 임시 브랜치. 없으면 null */
  isolatedBranch: string | null;
  /** 그래프 질의 ("이 branch 만 그래프에 표시"가 ref 범위만 바꾼다) */
  graphQuery: GraphQuery;
  /** 폴더가 사라진 워크트리 수 (Worktrees 머리의 정리 단추) */
  prunable: number;
}

/** 메뉴가 부르는 세션 동작 (세션 스토어의 것을 그대로 받는다) */
export type RepoBranchSession = Pick<
  SessionState,
  | 'checkout'
  | 'setGraphQuery'
  | 'openCompare'
  | 'merge'
  | 'openMergePreview'
  | 'openRebasePreview'
  | 'isolatedMerge'
  | 'rebase'
  | 'renameBranch'
  | 'setUpstream'
  | 'deleteBranch'
  | 'fetch'
  | 'push'
  | 'deleteRemoteBranch'
  | 'deleteTag'
  | 'backupRestore'
  | 'backupDelete'
  | 'worktreeRemoveCheck'
  | 'worktreeRemove'
  | 'worktreeLock'
  | 'worktreeUnlock'
  | 'worktreePrune'
  | 'suggestWorktreePath'
  | 'worktreeAdd'
>;

/** 확인·입력 대화상자 (`useDialogs` 의 것) */
export type RepoBranchDialogs = Pick<ReturnType<typeof useDialogs>, 'confirm' | 'prompt'>;

/** 컨테이너가 주입하는 동작 묶음 */
export interface RepoBranchDeps {
  state: RepoBranchMenuState;
  session: RepoBranchSession;
  dialogs: RepoBranchDialogs;
  /** 저장소를 탭으로 연다 (워크트리 열기, 격리 병합 워크트리) */
  openRepositoryAt: (path: string, parent?: SessionId | null) => Promise<SessionId | null>;
  /** 글자를 클립보드에 넣는다 (이름 복사) */
  copyText: (text: string) => void;
}

/** 쓰기를 막는 상태인지: 다른 작업 실행 중이거나 진행 중 작업이 있다 (옛 사이드바의 `disabled`) */
function writeBlocked(state: RepoBranchMenuState): boolean {
  return state.busy || state.inOp;
}

/** 격리 병합 시작 (CF-05): 확인 뒤 임시 워크트리를 이 탭의 하위 탭으로 연다 */
export async function startIsolatedMerge(name: string, deps: RepoBranchDeps): Promise<void> {
  const ok = await deps.dialogs.confirm({
    title: S.preview.isolatedTitle,
    message: S.preview.isolatedConfirm(name),
    confirmLabel: S.preview.isolatedStart,
  });
  if (!ok) {
    return;
  }
  const path = await deps.session.isolatedMerge(name, 'default');
  if (path) {
    await deps.openRepositoryAt(path, deps.state.id);
  }
}

/** 워크트리 삭제 (WT-04): 검사 결과를 보여 주고 확인받는다. 메인 워크트리는 지우지 않는다 */
export async function removeWorktreeFlow(wt: WorktreeInfo, deps: RepoBranchDeps): Promise<void> {
  const check = await deps.session.worktreeRemoveCheck(wt.path);
  if (!check || check.isMain) {
    return;
  }
  const lines: string[] = [];
  if (check.dirty) {
    lines.push(S.worktree.removeDirty);
  }
  const unpushed = check.unpushed ?? null;
  if (unpushed === null) {
    lines.push(S.worktree.removeNoUpstream);
  } else if (unpushed > 0) {
    lines.push(S.worktree.removeUnpushed(unpushed));
  }
  if (lines.length === 0) {
    lines.push(S.worktree.removeClean);
  }
  const v = await deps.dialogs.prompt({
    title: S.worktree.removeTitle(wt.path),
    message: lines.join(' '),
    fields: check.branch
      ? [{ key: 'deleteBranch', label: S.worktree.deleteBranchToo(check.branch), type: 'checkbox' }]
      : [],
    confirmLabel: S.dialog.delete,
  });
  if (v) {
    await deps.session.worktreeRemove(wt.path, check.dirty, bool(v, 'deleteBranch'));
  }
}

/** 로컬 브랜치 메뉴 12개 (옛 사이드바 그대로) */
function localItems(target: Extract<RepoBranchTarget, { kind: 'local' }>, deps: RepoBranchDeps) {
  const { state, session: s, dialogs } = deps;
  const name = target.label.shortName;
  const current = target.label.isCurrent;
  const disabled = writeBlocked(state);
  const needsOther = disabled || current || !state.headBranch;
  const items: MenuItem[] = [
    {
      label: S.menu.checkout,
      disabled: disabled || current,
      onSelect: () => void s.checkout({ kind: 'branch', name }),
    },
    {
      label: S.menu.graphSolo,
      onSelect: () => void s.setGraphQuery({ ...state.graphQuery, revs: { kind: 'solo', name } }),
    },
    {
      label: S.menu.compareWithHead(name),
      disabled: needsOther,
      onSelect: () => void s.openCompare(state.headBranch ?? 'HEAD', name, true),
    },
    {
      label: S.menu.mergeInto(name),
      disabled: needsOther,
      children: [
        { label: 'merge', onSelect: () => void s.merge(name, 'default') },
        { label: S.menu.mergeIntoNoFf, onSelect: () => void s.merge(name, 'noFf') },
        { label: S.menu.mergeIntoFfOnly, onSelect: () => void s.merge(name, 'ffOnly') },
        { label: S.menu.mergeIntoSquash, onSelect: () => void s.merge(name, 'squash') },
      ],
    },
    {
      label: S.menu.mergePreview(name),
      disabled: needsOther,
      onSelect: () => void s.openMergePreview(name),
    },
    {
      label: S.menu.rebasePreview(name),
      disabled: needsOther,
      onSelect: () => void s.openRebasePreview(name),
    },
    {
      label: S.menu.isolatedMerge(name),
      disabled: needsOther || state.isolatedBranch !== null,
      onSelect: () => void startIsolatedMerge(name, deps),
    },
    {
      label: S.menu.rebaseCurrentOnto(name),
      disabled: needsOther,
      onSelect: () => void s.rebase(name, true),
    },
    {
      label: S.menu.rename,
      separator: true,
      disabled: state.busy,
      onSelect: () =>
        void dialogs
          .prompt({
            title: S.dialog.renameBranch,
            fields: [{ key: 'name', label: S.dialog.newName, initial: name, required: true }],
            confirmLabel: S.dialog.rename,
          })
          .then((v) => (v ? s.renameBranch(name, str(v, 'name')) : undefined)),
    },
    {
      label: target.label.upstream ? S.menu.unsetUpstream : S.menu.setUpstream,
      disabled: state.busy,
      onSelect: () => {
        if (target.label.upstream) {
          void s.setUpstream(name, null);
          return;
        }
        void dialogs
          .prompt({
            title: S.dialog.setUpstream,
            fields: [
              {
                key: 'up',
                label: S.dialog.upstreamName,
                initial: `origin/${name}`,
                required: true,
              },
            ],
            confirmLabel: S.dialog.apply,
          })
          .then((v) => (v ? s.setUpstream(name, str(v, 'up')) : undefined));
      },
    },
    {
      label: S.menu.delete,
      danger: true,
      disabled: state.busy || current,
      onSelect: () =>
        void dialogs
          .confirm({
            title: S.dialog.deleteBranch(name),
            message: S.dialog.deleteBranchMessage,
            confirmLabel: S.dialog.delete,
            danger: true,
          })
          .then((ok) => (ok ? s.deleteBranch(name, false) : undefined)),
    },
    {
      label: S.menu.copyName,
      separator: true,
      onSelect: () => deps.copyText(name),
    },
  ];
  return items;
}

/** 원격 이름 그룹 메뉴 4개 (RM-02·04): 이 원격만 fetch, 현재 branch 를 이 원격으로 push (+ 업스트림 지정), 이름 복사 */
function remoteGroupItems(remote: string, deps: RepoBranchDeps): MenuItem[] {
  const { state, session: s } = deps;
  const disabled = writeBlocked(state);
  const noBranch = disabled || !state.headBranch;
  return [
    { label: S.remote.fetchOnly(remote), disabled, onSelect: () => void s.fetch(remote, true) },
    { label: S.remote.pushTo(remote), disabled: noBranch, onSelect: () => void s.push({ remote }) },
    {
      label: S.remote.pushToSetUpstream(remote),
      disabled: noBranch,
      onSelect: () => void s.push({ remote, setUpstream: true }),
    },
    { label: S.menu.copyName, separator: true, onSelect: () => deps.copyText(remote) },
  ];
}

/** 원격 브랜치 메뉴 7개 (옛 사이드바 그대로). 표시·merge·rebase 는 `origin/x`, checkout·원격 삭제는 원격과 브랜치를 나눈다 */
function remoteItems(
  target: Extract<RepoBranchTarget, { kind: 'remote' }>,
  deps: RepoBranchDeps,
): MenuItem[] {
  const { state, session: s, dialogs } = deps;
  const name = remoteBranchName(target.label);
  const short = target.label.shortName;
  const disabled = writeBlocked(state);
  return [
    {
      label: S.menu.checkout,
      disabled,
      onSelect: () => void s.checkout({ kind: 'remoteBranch', remote: target.remote, name }),
    },
    {
      label: S.menu.graphSolo,
      onSelect: () =>
        void s.setGraphQuery({ ...state.graphQuery, revs: { kind: 'solo', name: short } }),
    },
    {
      label: S.menu.compareWithHead(short),
      disabled: disabled || !state.headBranch,
      onSelect: () => void s.openCompare(state.headBranch ?? 'HEAD', short, true),
    },
    {
      label: S.menu.mergeInto(short),
      disabled: disabled || !state.headBranch,
      onSelect: () => void s.merge(short, 'default'),
    },
    {
      label: S.menu.rebaseCurrentOnto(short),
      disabled: disabled || !state.headBranch,
      onSelect: () => void s.rebase(short, true),
    },
    {
      label: S.menu.deleteRemote,
      danger: true,
      separator: true,
      disabled: state.busy,
      onSelect: () =>
        void dialogs
          .confirm({
            title: S.dialog.deleteRemoteBranch(target.remote, name),
            message: S.dialog.deleteRemoteBranchMessage,
            confirmLabel: S.dialog.delete,
            danger: true,
          })
          .then((ok) => (ok ? s.deleteRemoteBranch(target.remote, name) : undefined)),
    },
    { label: S.menu.copyName, separator: true, onSelect: () => deps.copyText(short) },
  ];
}

/** 태그 메뉴 3개 (옛 사이드바 그대로) */
function tagItems(target: Extract<RepoBranchTarget, { kind: 'tag' }>, deps: RepoBranchDeps) {
  const { state, session: s, dialogs } = deps;
  const name = target.label.shortName;
  const items: MenuItem[] = [
    {
      label: S.menu.checkoutDetached,
      disabled: writeBlocked(state),
      onSelect: () => void s.checkout({ kind: 'commit', oid: target.label.target }),
    },
    {
      label: S.menu.delete,
      danger: true,
      disabled: state.busy,
      onSelect: () =>
        void dialogs
          .confirm({
            title: S.dialog.deleteTag(name),
            message: '',
            confirmLabel: S.dialog.delete,
            danger: true,
          })
          .then((ok) => (ok ? s.deleteTag(name) : undefined)),
    },
    { label: S.menu.copyName, separator: true, onSelect: () => deps.copyText(name) },
  ];
  return items;
}

/** 워크트리 메뉴 4개 (옛 사이드바 그대로): 열기, 삭제, 잠금·잠금 해제, 사라진 워크트리 정리 */
function worktreeItems(wt: WorktreeInfo, deps: RepoBranchDeps): MenuItem[] {
  const { state, session: s, dialogs } = deps;
  const current = wt.path === state.path;
  return [
    {
      label: S.worktree.open,
      disabled: current,
      onSelect: () => void deps.openRepositoryAt(wt.path),
    },
    {
      label: S.worktree.remove,
      danger: true,
      separator: true,
      disabled: state.busy || wt.isMain || current,
      onSelect: () => void removeWorktreeFlow(wt, deps),
    },
    wt.locked !== null
      ? {
          label: S.safety.unlock,
          disabled: state.busy,
          onSelect: () => void s.worktreeUnlock(wt.path),
        }
      : {
          label: S.safety.lock,
          disabled: state.busy || wt.isMain,
          onSelect: () =>
            void dialogs
              .prompt({
                title: S.safety.lockTitle,
                fields: [{ key: 'reason', label: S.safety.lockReason }],
                confirmLabel: S.dialog.apply,
              })
              .then((v) => (v ? s.worktreeLock(wt.path, str(v, 'reason') || null) : undefined)),
        },
    { label: S.worktree.prune, disabled: state.busy, onSelect: () => void s.worktreePrune() },
  ];
}

/**
 * Worktrees 그룹 메뉴 (옛 섹션 머리 단추를 키보드로도 닿게): 워크트리 만들기, 사라진 워크트리 정리. 머리 단추와 같은
 * 동작·비활성 조건이다
 */
function worktreeGroupItems(deps: RepoBranchDeps): MenuItem[] {
  const { state, session: s } = deps;
  return [
    {
      label: S.worktree.create,
      disabled: state.busy,
      onSelect: () => void createWorktreeFlow(deps.dialogs, s, null),
    },
    { label: S.worktree.prune, disabled: state.busy, onSelect: () => void s.worktreePrune() },
  ];
}

/** 백업 메뉴 3개 (옛 사이드바 그대로). 현재 브랜치를 되돌리면 hard reset 이라 그 경고를 쓴다 */
function backupItems(target: Extract<RepoBranchTarget, { kind: 'backup' }>, deps: RepoBranchDeps) {
  const { state, session: s, dialogs } = deps;
  const b = target.backup;
  const items: MenuItem[] = [
    {
      label: S.safety.restoreAsBranch,
      disabled: state.busy,
      onSelect: () =>
        void dialogs
          .prompt({
            title: S.safety.restoreTitle,
            fields: [
              {
                key: 'name',
                label: S.safety.restoreName,
                initial: `${b.branch}-backup`,
                required: true,
              },
            ],
            confirmLabel: S.dialog.create,
          })
          .then((v) => (v ? s.backupRestore(b.name, str(v, 'name')) : undefined)),
    },
    {
      label: S.safety.restoreBranch(b.branch),
      disabled: state.busy,
      onSelect: () =>
        void dialogs
          .confirm({
            title: S.safety.restoreBranch(b.branch),
            // 체크아웃된 브랜치만 reset --hard 다. 나머지는 브랜치 포인터만 옮긴다
            message:
              b.branch === state.headBranch
                ? S.dialog.resetHardMessage
                : S.dialog.restoreOtherBranchMessage,
            confirmLabel: S.dialog.apply,
            danger: true,
          })
          .then((ok) => (ok ? s.backupRestore(b.name, null) : undefined)),
    },
    {
      label: S.safety.deleteBackup,
      danger: true,
      separator: true,
      disabled: state.busy,
      onSelect: () => void s.backupDelete(b.name),
    },
  ];
  return items;
}

/**
 * 노드의 우클릭 메뉴 (BT-11). HEAD 행에는 메뉴가 없다 (폴더 트리와 같다). 항목의 구조(라벨·순서·구분선·하위 메뉴·
 * 비활성)는 지금 상태로 정하고, 누르면 동작 묶음을 부른다
 */
export function repoBranchMenu(target: RepoBranchTarget, deps: RepoBranchDeps): MenuItem[] {
  switch (target.kind) {
    case 'head':
      return [];
    case 'local':
      return localItems(target, deps);
    case 'remoteGroup':
      return remoteGroupItems(target.remote, deps);
    case 'remote':
      return remoteItems(target, deps);
    case 'tag':
      return tagItems(target, deps);
    case 'worktreeGroup':
      return worktreeGroupItems(deps);
    case 'worktree':
      return worktreeItems(target.worktree, deps);
    case 'backup':
      return backupItems(target, deps);
  }
}

/**
 * 그룹 행 끝의 단추 (옛 섹션 머리 단추): Worktrees 의 "사라진 워크트리 정리"(폴더가 사라진 워크트리가 있을 때만,
 * 툴팁은 그 수) · "워크트리 만들기…". 다른 노드에는 없다. 행마다 그릴 때 불리므로 노드 id 만 본다
 */
export function repoBranchRowActions(nodeId: string, deps: RepoBranchDeps): BranchRowAction[] {
  if (nodeId !== REPO_GROUP_IDS.worktrees) {
    return [];
  }
  const { state, session: s } = deps;
  return [
    ...(state.prunable > 0
      ? [
          {
            key: 'prune',
            icon: 'prune' as const,
            label: S.worktree.prune,
            title: S.safety.prunable(state.prunable),
            disabled: state.busy,
            onSelect: () => void s.worktreePrune(),
          },
        ]
      : []),
    {
      key: 'create',
      icon: 'add',
      label: S.worktree.create,
      disabled: state.busy,
      onSelect: () => void createWorktreeFlow(deps.dialogs, s, null),
    },
  ];
}

/**
 * 더블클릭·Enter (결정 16번 — checkout 류, 옛 사이드바 그대로): 로컬은 그 브랜치 checkout(현재면 아무것도 안 함),
 * 원격은 원격 브랜치 checkout, 태그는 그 커밋으로 분리 checkout — 셋 다 쓰기를 막는 상태면 아무것도 하지 않는다.
 * 워크트리는 그 워크트리를 탭으로 연다(지금 연 워크트리면 아무것도 안 함). HEAD 행·백업은 아무것도 하지 않는다
 */
export function openRepoBranch(target: RepoBranchTarget, deps: RepoBranchDeps): void {
  const { state, session: s } = deps;
  switch (target.kind) {
    case 'local':
      if (!writeBlocked(state) && !target.label.isCurrent) {
        void s.checkout({ kind: 'branch', name: target.label.shortName });
      }
      return;
    case 'remote':
      if (!writeBlocked(state) && !target.label.isCurrent) {
        // 원격 브랜치 이름은 fullName 기준으로 원격을 뗀다 (원격 이름에 `/` 가 있어도 맞게)
        void s.checkout({
          kind: 'remoteBranch',
          remote: target.remote,
          name: remoteBranchName(target.label),
        });
      }
      return;
    case 'tag':
      if (!writeBlocked(state) && !target.label.isCurrent) {
        void s.checkout({ kind: 'commit', oid: target.label.target });
      }
      return;
    case 'worktree':
      if (target.worktree.path !== state.path) {
        void deps.openRepositoryAt(target.worktree.path);
      }
      return;
    default:
      return;
  }
}
