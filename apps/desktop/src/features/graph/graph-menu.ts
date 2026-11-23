import type { GraphRow } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';
import { rangeRowCount } from '../../store/squash-range';
import { branchNameField } from '../branch/branch-name';
import { tagWriteItems } from '../tags/tag-flows';
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
  | 'range'
  | 'prepareSquashRange'
  | 'squashRange'
  | 'commitMessageOf'
  | 'pushTags'
  | 'deleteTagsScoped'
  | 'tagReports'
  | 'busy'
  | 'op'
> & {
  headBranch: string | null;
  /** 등록된 원격 이름 (tag 하위 메뉴의 push 대상·지울 곳 칸) */
  remoteNames: readonly string[];
};

/** 확인·입력 대화상자 (`useDialogs` 의 것). 둘째 선택지는 tag 삭제의 "다를 때" 확인이 쓴다 */
type Dialogs = Pick<ReturnType<typeof useDialogs>, 'confirm' | 'confirmChoice' | 'prompt'>;

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

/**
 * 범위를 하나로 합치기 (MRG-07): 스토어가 범위를 검사하고 메시지 초안(오래된 것부터 빈 줄로 이음)을 만들면 메시지 하나만
 * 받아 실행한다. 검사에서 막히면 스토어가 사유를 오류 줄에 두고 대화상자를 열지 않는다
 */
async function squashRangeFlow(a: GraphMenuActions, d: Dialogs): Promise<void> {
  const prep = await a.prepareSquashRange();
  const oldest = prep?.range[0];
  const newest = prep?.range[prep.range.length - 1];
  if (!prep || !oldest || !newest) {
    return;
  }
  const v = await d.prompt({
    title: S.rebase.squashRangeTitle(prep.range.length),
    message: S.rebase.squashRangeMessage(shortHash(oldest.oid), shortHash(newest.oid)),
    fields: [
      {
        key: 'message',
        label: S.rebase.message,
        type: 'textarea',
        initial: prep.draft,
        required: true,
      },
    ],
    confirmLabel: S.rebase.squashRangeRun,
  });
  if (v) {
    await a.squashRange(prep, str(v, 'message'));
  }
}

/**
 * 범위 합치기 항목: 범위를 고른 상태에서 범위 안의 행을 우클릭할 때만 보인다 (N = 칠한 줄 수). 켜짐은 메시지 수정과 같은
 * 규칙(바쁘지 않음·진행 중 작업 없음·분리된 HEAD 아님·현재 branch 에서 닿는 행)에 2개 이상·merge 행 아님·범위 diff 를 다
 * 읽음을 더한다. 범위 전체의 merge·이어짐은 실행 전 검사(`prepareSquashRange`)가 사유와 함께 막는다
 */
function squashRangeItem(
  row: GraphRow,
  a: GraphMenuActions,
  d: Dialogs,
  canRewrite: boolean,
): MenuItem | null {
  const range = a.range;
  if (!range || row.row < range.from || row.row > range.to) {
    return null;
  }
  const n = rangeRowCount(range);
  return {
    label: S.menu.squashRange(n),
    disabled: !canRewrite || range.loading || n < 2 || row.parents.length > 1,
    onSelect: () => void squashRangeFlow(a, d),
  };
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
            branchNameField({ key: 'name', label: S.dialog.branchName, required: true }),
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
  // 이 행의 tag 마다 `tag v1 ▸` 하위 메뉴 (TG-01 ①): push·삭제를 브랜치 칸 트리와 같은 흐름으로
  const tags = row.refs.filter((l) => l.kind.kind === 'tag');
  tags.forEach((l, i) => {
    items.push({
      label: S.tag.logItem(l.shortName),
      separator: i === 0,
      children: tagWriteItems(l.shortName, {
        session: a,
        dialogs: d,
        remotes: a.remoteNames,
        busy: a.busy,
        reports: a.tagReports,
      }),
    });
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
  const squashRange = squashRangeItem(row, a, d, canRewrite);
  if (squashRange) {
    items.push(squashRange);
  }
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
