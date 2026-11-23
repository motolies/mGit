// tag 쓰기의 화면 흐름 (BR-06, TG-01~05): push 메뉴 항목, 지울 곳 대화상자, 원격 tag 가 다를 때의 확인. 브랜치 칸
// 트리(`repo-branch-menu.ts`)와 로그 행 메뉴(`graph-menu.ts`)가 같이 쓰고, 태그 문서(C)도 같은 흐름을 쓴다. 순서·결과
// 알림은 세션 스토어(`pushTags`·`deleteTagsScoped`)가 맡고, 여기는 무엇을 물을지만 정한다.

import { type PromptField, requireChecked, S, shortHash } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { bool, type useDialogs } from '../../components/use-dialogs';
import type { SessionState } from '../../store';
import type {
  DivergedChoice,
  DivergedTag,
  TagDeleteScope,
  TagDeleteSummary,
  TagReplaceItem,
} from '../../store/tag-ops';
import { isChecked, presentOnRemote, type TagReports } from './tag-sync';

/** 흐름이 부르는 세션 동작 */
export type TagSession = Pick<SessionState, 'pushTags' | 'deleteTagsScoped'>;

/** 흐름이 쓰는 대화상자 (`useDialogs` 의 것) */
export type TagDialogs = Pick<
  ReturnType<typeof useDialogs>,
  'confirm' | 'confirmChoice' | 'prompt'
>;

/** 컨테이너(트리·로그·문서)가 넣는 것 */
export interface TagFlowDeps {
  session: TagSession;
  dialogs: TagDialogs;
  /** 등록된 원격 이름 (원격 목록 순서) */
  remotes: readonly string[];
  /** 쓰기 명령이 도는 중 — push·삭제를 끈다 (D16: 진행 중 작업(merge 등)은 보지 않는다) */
  busy: boolean;
  /** 원격별 tag 상태 보고서 (B5). 지울 곳 칸의 해당 개수·경고에 쓴다. 없으면 상태를 모르는 것으로 본다 */
  reports?: TagReports;
  /**
   * 로컬에 있는 tag 인지 (C4: 태그 문서의 선택에는 원격에만 있는 tag 가 섞인다). 없으면 모두 로컬로 본다 — 트리·로그 메뉴는
   * 로컬 tag 만 다룬다
   */
  isLocal?: (name: string) => boolean;
}

/** 지울 곳 대화상자의 로컬 칸 키 */
const LOCAL_KEY = 'local';

/**
 * 원격에 한 번에 보낼 tag 가 이만큼 이상이면 시간이 걸린다고 미리 알린다 (막지 않는다). B4 실측: 일괄 push·원격 삭제는
 * git 이 refspec 수 × 원격 ref 수로 느려진다 — tag 1만 개 저장소에서 1천 개 push 8초, 5만 개 저장소에서 35~43초. 청크로
 * 나눠도 줄지 않는다
 */
export const TAG_BATCH_SLOW_COUNT = 500;

/** 원격에 보낼 tag 수가 시간 안내 기준 이상인지 */
export function isSlowTagBatch(count: number): boolean {
  return count >= TAG_BATCH_SLOW_COUNT;
}

/** 원격 칸 키: 원격 이름 대신 차례를 쓴다 (이름에 `/`·공백이 있어도 칸 id 가 깨지지 않게) */
function remoteKey(index: number): string {
  return `remote${index}`;
}

/**
 * push 항목 (TG-01 ①): 원격이 없으면 꺼진 항목 하나, 하나면 평면 `origin 로 push`, 둘 이상이면 `push ▸` 하위 메뉴에
 * 원격 이름. 실행 중(busy)일 때만 꺼진다
 */
export function tagPushItems(names: readonly string[], deps: TagFlowDeps): MenuItem[] {
  const { remotes, busy, session } = deps;
  const push = (remote: string) => () => void session.pushTags(remote, [...names]);
  const [only] = remotes;
  if (only === undefined) {
    return [{ label: S.tag.pushNoRemote, disabled: true }];
  }
  if (remotes.length === 1) {
    return [{ label: S.remote.pushTo(only), disabled: busy, onSelect: push(only) }];
  }
  return [
    {
      label: S.tag.pushMenu,
      disabled: busy,
      children: remotes.map((remote) => ({ label: remote, onSelect: push(remote) })),
    },
  ];
}

/** tag 하나의 쓰기 항목: push 묶음과 삭제… (트리 메뉴와 로그 행 하위 메뉴가 같이 쓴다) */
export function tagWriteItems(name: string, deps: TagFlowDeps): MenuItem[] {
  return [
    ...tagPushItems([name], deps),
    {
      label: S.menu.delete,
      danger: true,
      disabled: deps.busy,
      onSelect: () => void deleteTagsFlow([name], deps),
    },
  ];
}

/** 원격 하나에 있는 tag 수 (확인한 적이 없으면 null) */
function presentCount(
  reports: TagReports,
  remote: string,
  names: readonly string[],
): number | null {
  if (!isChecked(reports[remote])) {
    return null;
  }
  return names.filter((name) => presentOnRemote(reports[remote], name) === true).length;
}

/**
 * 지울 곳 칸 (TG-03 ①⑥): "지울 곳" 묶음 안에 로컬(기본 체크, 되돌릴 수 있음)과 원격마다 한 칸(기본 빈 칸, 되돌릴 수
 * 없음). 기본이 로컬만인 것은 사용자 결정 1. 원격 칸의 보조 글자는 상태를 알면 `해당 N개`, 모르면 `확인 안 함` 이고,
 * 확인했는데 해당이 0개인 원격은 끄고 그 사유를 쓴다
 */
export function deleteScopeFields(
  remotes: readonly string[],
  names: readonly string[] = [],
  reports: TagReports = {},
  localCount: number = names.length,
): PromptField[] {
  return [
    localCount === 0
      ? {
          // 고른 것이 모두 원격에만 있다 (C4): 로컬 칸은 끄고 사유를 쓴다
          key: LOCAL_KEY,
          label: S.tag.del.local,
          type: 'checkbox',
          disabled: true,
          note: S.tag.del.notLocal,
          group: S.tag.del.scope,
        }
      : {
          key: LOCAL_KEY,
          label: S.tag.del.local,
          type: 'checkbox',
          initial: true,
          note: [S.tag.del.applies(localCount), S.tag.del.localNote].join(' · '),
          group: S.tag.del.scope,
        },
    ...remotes.map((remote, i): PromptField => {
      const count = presentCount(reports, remote, names);
      const base = { key: remoteKey(i), label: remote, type: 'checkbox' as const, initial: false };
      if (count === 0) {
        return { ...base, disabled: true, note: S.tag.del.absent, group: S.tag.del.scope };
      }
      return {
        ...base,
        note: [
          count === null ? S.tag.del.notChecked : S.tag.del.applies(count),
          S.tag.del.remoteNote,
        ].join(' · '),
        group: S.tag.del.scope,
      };
    }),
  ];
}

/**
 * 고른 지울 곳에 따른 경고 (TG-03 ⑥, 막지 않는다). 로컬을 고른 때만:
 * - `comeBack(n)`: 고르지 않은 원격에 아직 있는 tag 가 n 개 — 다음 fetch 때 다시 생길 수 있다 (K2)
 * - `unpushedWarn(n)`: 모든 원격을 확인했고 어디에도 없는 tag 가 n 개 — 지우면 되돌리기로만 되살린다
 * 상태를 아는 원격만 센다. 셀 것이 없으면 null
 */
export function deleteScopeNotice(
  values: Readonly<Record<string, string | boolean>>,
  remotes: readonly string[],
  names: readonly string[],
  reports: TagReports,
): string | null {
  if (values[LOCAL_KEY] !== true) {
    return null;
  }
  const chosen = new Set(remotes.filter((_, i) => values[remoteKey(i)] === true));
  const comeBack = names.filter((name) =>
    remotes.some((r) => !chosen.has(r) && presentOnRemote(reports[r], name) === true),
  ).length;
  const allChecked = remotes.length > 0 && remotes.every((r) => isChecked(reports[r]));
  const unpushed = allChecked
    ? names.filter((name) => remotes.every((r) => presentOnRemote(reports[r], name) === false))
        .length
    : 0;
  const parts = [
    comeBack > 0 ? S.tag.del.comeBack(comeBack) : null,
    unpushed > 0 ? S.tag.del.unpushedWarn(unpushed) : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * 지울 곳 대화상자의 시간 안내 (막지 않는다): 원격을 하나라도 골랐고 원격에 보낼 tag 가 기준(`TAG_BATCH_SLOW_COUNT`) 이상이면
 * 안내 한 줄. 로컬만이면 없다 (로컬 삭제는 한 트랜잭션이라 빠르다)
 */
export function deleteSlowNotice(
  values: Readonly<Record<string, string | boolean>>,
  remotes: readonly string[],
  count: number,
): string | null {
  const remoteChosen = remotes.some((_, i) => values[remoteKey(i)] === true);
  return remoteChosen && isSlowTagBatch(count) ? S.tag.batch.slow : null;
}

/** 지울 곳 대화상자의 값을 지울 곳으로 (원격은 원격 목록 순서) */
export function deleteScopeOf(
  values: Record<string, string | boolean>,
  remotes: readonly string[],
): TagDeleteScope {
  return {
    local: bool(values, LOCAL_KEY),
    remotes: remotes.filter((_, i) => bool(values, remoteKey(i))),
  };
}

/** 이름이 같은 두 tag 의 한 줄: 원격·로컬 commit (같은 commit 이면 tag 객체만 다르다고). 모르는 쪽은 `?` */
export function commitPairLine(
  name: string,
  remoteCommit: string | null,
  localCommit: string | null,
): string {
  const remote = remoteCommit ? shortHash(remoteCommit) : '?';
  if (remoteCommit !== null && remoteCommit === localCommit) {
    return S.tag.differs.itemSameCommit(name, remote);
  }
  return S.tag.differs.item(name, remote, localCommit ? shortHash(localCommit) : '?');
}

/** 다른 tag 한 줄 (확인창) */
export function divergedLine(d: DivergedTag): string {
  return commitPairLine(d.name, d.remoteCommit, d.localCommit);
}

/**
 * 원격 tag 가 로컬과 다를 때 묻는다 (TG-04 ③, 사용자 결정 2): 두 commit 을 보이는 위험 확인. 같은 요청에 다르지 않은
 * tag 가 있으면(`others` > 0) [취소] [다른 tag 는 건너뛰고 삭제] [그래도 원격에서 삭제], 없으면 [취소] [그래도…]
 */
export async function confirmDiverged(
  dialogs: TagDialogs,
  items: readonly DivergedTag[],
  others: number,
): Promise<DivergedChoice> {
  const spec = {
    title: S.tag.differs.title(items[0]?.remote ?? '', items.length),
    message: S.tag.differs.message,
    items: items.map(divergedLine),
    confirmLabel: S.tag.differs.deleteAnyway,
    danger: true,
  };
  if (others === 0) {
    return (await dialogs.confirm(spec)) ? 'all' : 'cancel';
  }
  const choice = await dialogs.confirmChoice({ ...spec, secondaryLabel: S.tag.differs.skip });
  return choice === 'confirm' ? 'all' : choice === 'secondary' ? 'skip' : 'cancel';
}

/**
 * 원격 것으로 맞추기 확인 (C5, TG-15): 일반 확인창에 두 commit. 로컬 tag 를 원격 것으로 바꾸는 가져오기(덮어쓰기)는
 * Undo 할 수 있다
 */
export async function confirmAlignToRemote(
  dialogs: TagDialogs,
  remote: string,
  name: string,
  pair: { remoteCommit: string | null; localCommit: string | null },
): Promise<boolean> {
  return dialogs.confirm({
    title: S.tag.align.toRemoteTitle(name, remote),
    message: S.tag.align.toRemoteMessage,
    items: [commitPairLine(name, pair.remoteCommit, pair.localCommit)],
    confirmLabel: S.tag.align.toRemoteConfirm,
  });
}

/**
 * 로컬 것으로 맞추기 확인 (C5, TG-15·TG-02 둘째 단추): 위험 확인창에 두 commit 과 "이미 받아 간 저장소에는 옛 tag 가
 * 남습니다. 되돌릴 수 없습니다." (취소에 포커스)
 */
export async function confirmAlignToLocal(
  dialogs: TagDialogs,
  remote: string,
  items: readonly TagReplaceItem[],
): Promise<boolean> {
  return dialogs.confirm({
    title: S.tag.align.toLocalTitle(items.length, remote),
    message: S.tag.align.toLocalMessage,
    items: items.map((i) => commitPairLine(i.name, i.remoteCommit, i.localCommit)),
    confirmLabel: S.tag.align.toLocalConfirm,
    danger: true,
  });
}

/**
 * tag 삭제 (TG-03·05). 원격이 없으면 지금까지의 확인창에 되돌리기 안내(TG-03 ⑤), 있으면 지울 곳 대화상자(위험 —
 * 체크 칸 Enter 로 제출하지 않음, 하나도 고르지 않으면 확인 꺼짐, 여럿이면 tag 목록). 원격 상태를 알면 칸마다 해당
 * 개수와 고른 곳에 따른 경고를, 하나도 모르면 설명문에 K2 안내를 보인다 (TG-03 ⑥). 실행은 세션이 하고, 원격 것이
 * 다르면 `confirmDiverged` 로 묻는다
 */
export async function deleteTagsFlow(
  names: readonly string[],
  deps: TagFlowDeps,
  opts: { silent?: boolean } = {},
): Promise<{ summary: TagDeleteSummary; scope: TagDeleteScope } | undefined> {
  const list = [...new Set(names)];
  const [only] = list;
  if (only === undefined) {
    return undefined;
  }
  const { dialogs, session, remotes } = deps;
  const many = list.length > 1;
  if (remotes.length === 0) {
    const ok = await dialogs.confirm({
      title: many ? S.tag.del.titleMany(list.length) : S.dialog.deleteTag(only),
      message: S.tag.del.localUndo,
      items: many ? list : undefined,
      confirmLabel: S.dialog.delete,
      danger: true,
    });
    if (!ok) {
      return undefined;
    }
    const scope: TagDeleteScope = { local: true, remotes: [] };
    const summary = await session.deleteTagsScoped(list, scope, { silent: opts.silent });
    return summary ? { summary, scope } : undefined;
  }
  const reports = deps.reports ?? {};
  const locals = list.filter((name) => deps.isLocal?.(name) ?? true);
  const fields = deleteScopeFields(remotes, list, reports, locals.length);
  const known = remotes.some((r) => isChecked(reports[r]));
  const values = await dialogs.prompt({
    title: many ? S.tag.del.titleMany(list.length) : S.tag.del.title(only),
    message: known ? S.tag.del.message : `${S.tag.del.message} ${S.tag.del.comeBackMaybe}`,
    items: many ? list : undefined,
    fields,
    validate: requireChecked(
      fields.map((f) => f.key),
      S.tag.del.none,
    ),
    notice: (v) =>
      [deleteScopeNotice(v, remotes, locals, reports), deleteSlowNotice(v, remotes, list.length)]
        .filter((line): line is string => line !== null)
        .join(' ') || null,
    confirmLabel: S.dialog.delete,
    danger: true,
  });
  if (!values) {
    return undefined;
  }
  const scope = deleteScopeOf(values, remotes);
  const summary = await session.deleteTagsScoped(list, scope, {
    onDiverged: (items, others) => confirmDiverged(dialogs, items, others),
    silent: opts.silent,
  });
  return summary ? { summary, scope } : undefined;
}
