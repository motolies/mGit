import type { GraphRow } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, str } from '../../components/use-dialogs';
import type { SessionState } from '../../store';
import { createWorktreeFlow } from '../worktree/create-worktree';

/** 그래프 컨텍스트 메뉴에 필요한 스토어 조각 */
export type GraphMenuActions = Pick<
  SessionState,
  | 'checkout'
  | 'createBranch'
  | 'createTag'
  | 'cherryPick'
  | 'revert'
  | 'reset'
  | 'rebase'
  | 'merge'
  | 'suggestWorktreePath'
  | 'worktreeAdd'
  | 'selectRange'
  | 'selectedCommit'
  | 'signingInfo'
  | 'openRebasePlan'
  | 'openMergePreview'
  | 'openRebasePreview'
  | 'openRemergeDiff'
  | 'rewordCommit'
  | 'squashIntoParent'
  | 'commitMessageOf'
  | 'busy'
  | 'op'
> & { headBranch: string | null };

interface Dialogs {
  confirm: (spec: {
    title: string;
    message: string;
    items?: readonly string[];
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  prompt: (spec: {
    title: string;
    message?: string;
    fields: readonly {
      key: string;
      label: string;
      type?: 'text' | 'textarea' | 'checkbox';
      placeholder?: string;
      initial?: string | boolean;
      required?: boolean;
    }[];
    confirmLabel?: string;
  }) => Promise<Record<string, string | boolean> | null>;
}

/** 커밋 메시지 고치기: 입력란을 메시지 전체로 채운다. 코어는 메시지를 통째로 바꾸므로 제목만 주면 본문이 사라진다 */
async function rewordFlow(oid: string, a: GraphMenuActions, d: Dialogs): Promise<void> {
  const message = await a.commitMessageOf(oid);
  if (message === null) {
    return;
  }
  const v = await d.prompt({
    title: S.menu.reword,
    message: shortHash(oid),
    fields: [
      {
        key: 'message',
        label: S.rebase.message,
        type: 'textarea',
        initial: message.trimEnd(),
        required: true,
      },
    ],
    confirmLabel: S.dialog.apply,
  });
  if (v) {
    await a.rewordCommit(oid, str(v, 'message'));
  }
}

/** 그래프 행 우클릭 메뉴 (GRAPH-05). 행에 로컬 브랜치 라벨이 있으면 그 브랜치 작업도 넣는다 */
export function graphMenuItems(row: GraphRow, a: GraphMenuActions, d: Dialogs): MenuItem[] {
  const oid = row.oid;
  const short = shortHash(oid);
  const disabled = a.busy || a.op !== null;
  // HEAD 에서 닿지 않는 커밋의 이력은 현재 브랜치에서 고칠 수 없다
  const canRewrite = !disabled && a.headBranch !== null && row.inHead;
  const localBranches = row.refs.filter((l) => l.kind.kind === 'localBranch' && !l.isCurrent);
  const items: MenuItem[] = [];

  for (const l of localBranches) {
    items.push({
      label: `${S.menu.checkout} ${l.shortName}`,
      disabled,
      onSelect: () => void a.checkout({ kind: 'branch', name: l.shortName }),
    });
  }
  items.push({
    label: S.menu.checkoutDetached,
    disabled,
    onSelect: () => void a.checkout({ kind: 'commit', oid }),
  });
  items.push({
    label: S.menu.createBranchHere,
    separator: true,
    disabled: a.busy,
    onSelect: () =>
      void d
        .prompt({
          title: S.dialog.createBranch,
          fields: [
            { key: 'name', label: S.dialog.branchName, required: true },
            { key: 'checkout', label: S.dialog.checkoutAfter, type: 'checkbox', initial: true },
          ],
          confirmLabel: S.dialog.create,
        })
        .then((v) => (v ? a.createBranch(str(v, 'name'), oid, bool(v, 'checkout')) : undefined)),
  });
  items.push({
    label: S.menu.createTagHere,
    disabled: a.busy,
    onSelect: () =>
      void d
        .prompt({
          title: S.dialog.createTag,
          fields: [
            { key: 'name', label: S.dialog.tagName, required: true },
            { key: 'message', label: S.dialog.tagMessage, type: 'textarea' },
            {
              key: 'sign',
              label: S.dialog.tagSign,
              type: 'checkbox',
              initial: a.signingInfo?.tagSign ?? false,
            },
          ],
          confirmLabel: S.dialog.create,
        })
        .then((v) =>
          v
            ? a.createTag(str(v, 'name'), oid, str(v, 'message') || null, bool(v, 'sign'))
            : undefined,
        ),
  });
  items.push({
    label: S.menu.createWorktreeHere,
    disabled: a.busy,
    onSelect: () => void createWorktreeFlow(d, a, oid),
  });

  for (const l of localBranches) {
    items.push({
      label: S.menu.mergeInto(l.shortName),
      separator: true,
      disabled: disabled || !a.headBranch,
      children: [
        {
          label: S.menu.mergePreview(l.shortName),
          onSelect: () => void a.openMergePreview(l.shortName),
        },
        { label: 'merge', onSelect: () => void a.merge(l.shortName, 'default') },
        { label: S.menu.mergeIntoNoFf, onSelect: () => void a.merge(l.shortName, 'noFf') },
        { label: S.menu.mergeIntoFfOnly, onSelect: () => void a.merge(l.shortName, 'ffOnly') },
        { label: S.menu.mergeIntoSquash, onSelect: () => void a.merge(l.shortName, 'squash') },
      ],
    });
  }
  items.push({
    label: S.menu.rebaseOnto,
    separator: localBranches.length === 0,
    disabled: disabled || !a.headBranch,
    onSelect: () => void a.rebase(oid, true),
  });
  if (row.parents.length > 1) {
    items.push({
      label: S.menu.remergeDiff,
      onSelect: () => void a.openRemergeDiff(oid),
    });
  }
  items.push({
    label: S.menu.rebasePreviewHere,
    disabled: disabled || !a.headBranch,
    onSelect: () => void a.openRebasePreview(oid),
  });
  items.push({
    label: S.menu.cherryPick,
    separator: true,
    disabled,
    onSelect: () => void a.cherryPick([oid]),
  });
  items.push({ label: S.menu.revert, disabled, onSelect: () => void a.revert([oid]) });
  items.push({
    label: S.menu.selectRange,
    separator: true,
    disabled: !a.selectedCommit || a.selectedCommit === oid,
    onSelect: () => void a.selectRange(row),
  });
  items.push({
    label: S.menu.rebaseInteractive,
    separator: true,
    disabled: disabled || !a.headBranch,
    onSelect: () => void a.openRebasePlan(oid),
  });
  items.push({
    label: S.menu.reword,
    disabled: !canRewrite,
    onSelect: () => void rewordFlow(oid, a, d),
  });
  items.push({
    label: S.menu.squashIntoParent,
    disabled: !canRewrite || row.parents.length !== 1,
    onSelect: () =>
      void d
        .confirm({
          title: S.menu.squashIntoParentTitle(short),
          message: S.menu.squashIntoParentMessage,
          confirmLabel: S.dialog.apply,
          danger: true,
        })
        .then((ok) => (ok ? a.squashIntoParent(oid) : undefined)),
  });
  items.push({
    label: S.menu.reset,
    disabled,
    children: [
      { label: S.menu.resetSoft, onSelect: () => void a.reset(oid, 'soft') },
      { label: S.menu.resetMixed, onSelect: () => void a.reset(oid, 'mixed') },
      {
        label: S.menu.resetHard,
        danger: true,
        onSelect: () =>
          void d
            .confirm({
              title: S.dialog.resetHard(short),
              message: S.dialog.resetHardMessage,
              confirmLabel: S.menu.reset,
              danger: true,
            })
            .then((ok) => (ok ? a.reset(oid, 'hard') : undefined)),
      },
    ],
  });
  items.push({
    label: S.menu.copyHash,
    separator: true,
    onSelect: () => void navigator.clipboard.writeText(oid).catch(() => {}),
  });
  return items;
}
