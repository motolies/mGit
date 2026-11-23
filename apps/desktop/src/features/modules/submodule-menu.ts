// 서브모듈의 메뉴와 입력 흐름 (SUB-05·06·08). 옛 사이드바(`features/sidebar/`)에서 W25 에 옮겼다 — 로직은 그대로이고, 이제
// 저장소 탭 Project 트리의 서브모듈 디렉터리 행 메뉴와 머리의 모듈·서브모듈 메뉴가 부른다.

import type { SubmoduleInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';

type Dialogs = ReturnType<typeof useDialogs>;

/** 서브모듈 메뉴가 쓰는 스토어 조각 */
export type SubmoduleActions = Pick<
  SessionState,
  | 'busy'
  | 'submoduleUpdateRemote'
  | 'submoduleSetBranch'
  | 'submoduleRemove'
  | 'submoduleAdd'
  | 'submoduleSync'
  | 'submoduleBatch'
>;

/** 서브모듈 한 항목의 우클릭 메뉴 (SUB-05·06) */
export function submoduleItems(
  sm: SubmoduleInfo,
  a: SubmoduleActions,
  d: Dialogs,
  open: () => void,
): MenuItem[] {
  const t = S.submodule;
  return [
    { label: t.open, onSelect: open },
    {
      label: t.updateRemote,
      disabled: a.busy || sm.status === 'notInitialized',
      onSelect: () => void a.submoduleUpdateRemote(sm.path, 'merge'),
    },
    {
      label: t.setBranch,
      disabled: a.busy,
      onSelect: () =>
        void d
          .prompt({
            title: t.setBranchTitle(sm.path),
            message: t.setBranchHint,
            fields: [{ key: 'branch', label: t.branch }],
            confirmLabel: S.dialog.apply,
          })
          .then((v) => (v ? a.submoduleSetBranch(sm.path, str(v, 'branch') || null) : undefined)),
    },
    {
      label: t.remove,
      separator: true,
      danger: true,
      disabled: a.busy,
      onSelect: () =>
        void d
          .confirm({
            title: t.removeTitle(sm.path),
            message: t.removeMessage,
            confirmLabel: t.removeConfirm,
            danger: true,
          })
          .then((ok) => (ok ? a.submoduleRemove(sm.path) : undefined)),
    },
  ];
}

/** 서브모듈 추가 입력 (SUB-05) */
export async function promptSubmoduleAdd(a: SubmoduleActions, d: Dialogs): Promise<void> {
  const t = S.submodule;
  const v = await d.prompt({
    title: t.addTitle,
    fields: [
      { key: 'url', label: t.url, required: true },
      { key: 'path', label: t.path, required: true },
      { key: 'branch', label: t.branch },
    ],
    confirmLabel: S.dialog.create,
  });
  if (v) {
    await a.submoduleAdd(str(v, 'url').trim(), str(v, 'path').trim(), str(v, 'branch') || null);
  }
}

/** 서브모듈 일괄 작업 선택 (SUB-08) */
export async function promptSubmoduleBatch(a: SubmoduleActions, d: Dialogs): Promise<void> {
  const t = S.submodule;
  const v = await d.prompt({
    title: t.batchTitle,
    fields: [
      {
        key: 'op',
        label: t.batchOp,
        type: 'select',
        initial: 'fetch',
        options: [
          { value: 'fetch', label: 'fetch' },
          { value: 'pull', label: 'pull' },
          { value: 'push', label: 'push' },
        ],
      },
      { key: 'prune', label: t.batchPrune, type: 'checkbox', initial: true },
    ],
    confirmLabel: S.dnd.run,
  });
  if (!v) {
    return;
  }
  const op = str(v, 'op');
  await a.submoduleBatch(
    op === 'fetch'
      ? { kind: 'fetch', prune: bool(v, 'prune') }
      : op === 'pull'
        ? { kind: 'pull' }
        : { kind: 'push' },
    [],
  );
}

/** 모듈 직접 추가 입력 (MOD-03 — 옛 모듈 섹션 머리의 "＋"): 경로(필수)·이름, 둘 다 앞뒤 공백을 떼어 넘긴다 */
export async function promptModuleAdd(
  add: (name: string, path: string) => Promise<void>,
  d: Dialogs,
): Promise<void> {
  const t = S.modules;
  const v = await d.prompt({
    title: t.addTitle,
    fields: [
      { key: 'path', label: t.path, required: true },
      { key: 'name', label: t.name },
    ],
    confirmLabel: S.dialog.create,
  });
  if (v) {
    await add(str(v, 'name').trim(), str(v, 'path').trim());
  }
}
