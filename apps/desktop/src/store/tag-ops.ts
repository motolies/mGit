// tag 원격 작업의 순서와 결과 정리 (BR-06, TG-01~05). 세션 스토어가 `run` 으로 감싸 부르고, 화면 흐름(`tag-flows.ts`)이
// 확인창 답을 넣는다. IPC 는 주입받아 이 파일은 순수 로직만 둔다 — 순서·일부 실패·다를 때 답의 처리를 따로 시험한다.
// 원격 tag 보고서를 값으로 견주는 함수(`sameTagReport`)도 둔다 (스토어가 같은 보고서로 상태를 바꾸지 않게).

import {
  type TagDeleteItem,
  type TagLookupError,
  type TagRefResult,
  type TagRefStatus,
  type TagSyncEntry,
  type TagSyncReport,
  type TagSyncState,
  toIpcError,
} from '@mgit/ipc';
import { S } from '@mgit/ui';

/** 원하는 결과에 이르렀는지 (코어 `TagRefStatus::is_success` 와 같다). 그 밖(앞으로 생길 상태 포함)은 "처리되지 않음" */
export function isTagSuccess(status: TagRefStatus): boolean {
  return (
    status === 'pushed' ||
    status === 'upToDate' ||
    status === 'deleted' ||
    status === 'alreadyAbsent' ||
    status === 'fetched'
  );
}

/**
 * 가져오기가 원격에 없는 이름 때문에 통째로 멈췄는지 (TG-11 ④): git 은 이름 하나라도 원격에 없으면 아무것도 받지 않고
 * `couldn't find remote ref` 로 끝난다. 코어는 git 문구를 영어로 받는다
 */
export function isMissingRemoteRef(error: unknown): boolean {
  const err = toIpcError(error);
  return err.kind === 'gitFailed' && /couldn't find remote ref/.test(err.stderr);
}

/** 성공이 아닌 결과 하나의 사유 (오류 줄·결과 목록). 서버 거부는 서버가 준 사유, 실패는 git 원문 */
export function tagResultText(r: TagRefResult): string {
  switch (r.status) {
    case 'rejectedRemote':
      return S.error.remoteRejected(r.message ?? '');
    case 'diverged':
      return S.tag.status.diverged;
    case 'rejectedExists':
      return S.tag.status.rejectedExists;
    case 'rejectedStale':
      return S.tag.status.rejectedStale;
    case 'failed':
      return r.message ? r.message : S.tag.status.failed;
    case 'unknown':
      return S.tag.status.unknown;
    case 'notRun':
      // 같은 호출의 다른 tag 가 달라 확인을 기다리느라 실행하지 않았다 (C2a) — 실패가 아니다
      return S.tag.status.notRun;
    default:
      return S.tag.status.notProcessed;
  }
}

/** 성공이 아닌 결과들을 `v1 (사유), v2 (사유)` 한 줄로 */
export function tagFailureList(results: readonly TagRefResult[]): string {
  return results
    .filter((r) => !isTagSuccess(r.status))
    .map((r) => `${r.name} (${tagResultText(r)})`)
    .join(', ');
}

/** 이름이 같은 tag 의 두 commit (이름 충돌 안내, TG-02 B). 없으면 null */
export interface TagCommitPair {
  name: string;
  local: string | null;
  remote: string | null;
  /** 원격 ref 가 가리키는 객체 — "로컬 것으로 덮어쓰기"(C5)의 lease 기준. 모르면 null */
  remoteObject: string | null;
}

/** 원격 tag 를 로컬 것으로 덮어쓸 것 하나 (C5, TG-15): lease 기준과 확인창의 두 commit */
export interface TagReplaceItem {
  name: string;
  expectedRemote: string;
  remoteCommit: string | null;
  localCommit: string | null;
}

/** 원격 tag 가 로컬과 달라 지우지 않은 것 하나 (확인창에 두 commit 을 보인다, TG-04 ③) */
export interface DivergedTag {
  remote: string;
  name: string;
  /** 원격 ref 가 가리키는 객체 — "그래도 삭제" 때 `expectedRemote` 로 넘긴다 */
  remoteOid: string | null;
  /** 원격 쪽 commit */
  remoteCommit: string | null;
  /** 로컬 쪽 commit (라벨의 target). 로컬에 없으면 null */
  localCommit: string | null;
}

/** 다를 때 확인창의 답: 그래도 원격에서 삭제 / 다른 tag 는 건너뛰고 삭제 / 취소 */
export type DivergedChoice = 'all' | 'skip' | 'cancel';

/**
 * 다를 때 묻는 함수. `others` 는 같은 요청에서 다르지 않은 tag 수 — 0 이면 건너뛸 것이 없어 두 갈래로 묻는다.
 * 묻는 동안 세션은 busy 로 남는다
 */
export type DivergedAsk = (items: DivergedTag[], others: number) => Promise<DivergedChoice>;

/** 지울 곳: 로컬 여부와 고른 원격들 (TG-03) */
export interface TagDeleteScope {
  local: boolean;
  remotes: readonly string[];
}

/** 지울 곳 삭제의 결과 (TG-05) */
export interface TagDeleteSummary {
  /** 요청한 tag (중복 없이 요청 순서) */
  names: string[];
  scope: TagDeleteScope;
  /** 원격마다 tag 별 마지막 결과. 명령 전체가 실패한 원격은 없다 */
  remote: Record<string, TagRefResult[]>;
  /** 원격마다 명령 전체가 실패한 사유 (인증·연결·등록되지 않은 원격) */
  remoteErrors: Record<string, string>;
  /** 로컬에서 지운 tag */
  localDeleted: string[];
  /** 로컬을 골랐지만 지우지 않은 tag (원격에서 다 지우지 못했거나 취소·로컬 실패) */
  localKept: string[];
  localError: string | null;
  /** 다를 때 확인창에서 취소했다 — 그 뒤의 원격·로컬은 건드리지 않았다 */
  cancelled: boolean;
}

/** `runTagDelete` 가 부르는 것 (세션 스토어가 IPC·라벨·확인창을 넣는다) */
export interface TagDeleteDeps {
  deleteRemote: (remote: string, items: TagDeleteItem[]) => Promise<TagRefResult[]>;
  deleteLocal: (names: string[]) => Promise<void>;
  /** 로컬 tag 의 commit (확인창의 로컬 쪽) */
  localCommit: (name: string) => string | null;
  /** 다를 때 묻는다. 없으면 취소로 본다 (묻지 않고 원격 것을 지우지 않는다) */
  onDiverged?: DivergedAsk;
  /**
   * 로컬에 있는 tag 인지 (C4: 문서의 선택에는 원격에만 있는 tag 가 섞일 수 있다). 없으면 모두 로컬로 본다. 로컬에 없는
   * tag 는 로컬 삭제 대상이 아니고 "로컬에 남김"으로도 세지 않는다
   */
  isLocal?: (name: string) => boolean;
  /** 명령 전체 실패의 안내 문구 */
  describe: (e: unknown) => string;
}

/** 앞 결과에 뒤 결과를 이름별로 덮는다 (요청 순서 유지) */
function overlay(first: readonly TagRefResult[], second: readonly TagRefResult[]): TagRefResult[] {
  const byName = new Map(second.map((r) => [r.name, r]));
  return first.map((r) => byName.get(r.name) ?? r);
}

/**
 * 원격 하나에서 지운다. 다른 tag 가 나오면 묻고, 답에 따라 다시 부른다:
 * - 그래도: 성공하지 못한 것을 다시 (다른 것은 그때 받은 `remoteOid` 를 `expectedRemote` 로)
 * - 건너뛰기: 다른 것을 뺀 나머지 중 성공하지 못한 것을 다시
 * - 취소: 다시 부르지 않는다
 * 코어가 다른 것이 있을 때 나머지를 지우든(지금) 아무것도 지우지 않든(`notRun`, H2) 같게 동작한다 — 성공한 것은 다시
 * 부르지 않고, 성공하지 못한 것만 다시 부른다. 명령 전체가 실패하면 던진다 (두 번째 호출이면 첫 결과와 함께)
 */
async function deleteOnRemote(
  remote: string,
  names: readonly string[],
  deps: TagDeleteDeps,
): Promise<{ results: TagRefResult[]; cancelled: boolean; error: string | null }> {
  const first = await deps.deleteRemote(
    remote,
    names.map((name) => ({ name })),
  );
  const diverged = first.filter((r) => r.status === 'diverged');
  if (diverged.length === 0) {
    return { results: first, cancelled: false, error: null };
  }
  const items: DivergedTag[] = diverged.map((r) => ({
    remote,
    name: r.name,
    remoteOid: r.remoteOid ?? null,
    remoteCommit: r.remoteCommit ?? null,
    localCommit: deps.localCommit(r.name),
  }));
  const choice = deps.onDiverged
    ? await deps.onDiverged(items, names.length - diverged.length)
    : 'cancel';
  if (choice === 'cancel') {
    return { results: first, cancelled: true, error: null };
  }
  const expected = new Map(diverged.map((r) => [r.name, r.remoteOid ?? null]));
  const retry: TagDeleteItem[] = first
    .filter((r) => !isTagSuccess(r.status))
    .filter((r) => choice === 'all' || r.status !== 'diverged')
    .map((r) =>
      expected.has(r.name)
        ? { name: r.name, expectedRemote: expected.get(r.name) ?? null }
        : { name: r.name },
    );
  if (retry.length === 0) {
    return { results: first, cancelled: false, error: null };
  }
  try {
    const second = await deps.deleteRemote(remote, retry);
    return { results: overlay(first, second), cancelled: false, error: null };
  } catch (e) {
    return { results: first, cancelled: false, error: deps.describe(e) };
  }
}

/**
 * 지울 곳 삭제 (TG-05): 고른 원격들을 차례로 먼저 처리하고, 모든 고른 원격에서 `deleted`·`alreadyAbsent` 인 tag 만
 * 로컬에서 지운다 (한 트랜잭션). 한 원격이 통째로 실패해도 다음 원격으로 간다 — 그 원격의 tag 는 로컬에 남는다.
 * 다를 때 취소하면 그 자리에서 멈춘다 (남은 원격·로컬은 건드리지 않는다). 던지지 않는다 — 원격 명령·확인창의 오류는 그
 * 원격의 실패(`remoteErrors`)로, 로컬 오류는 `localError` 로 남긴다
 */
export async function runTagDelete(
  names: readonly string[],
  scope: TagDeleteScope,
  deps: TagDeleteDeps,
): Promise<TagDeleteSummary> {
  const list = [...new Set(names)];
  const summary: TagDeleteSummary = {
    names: list,
    scope,
    remote: {},
    remoteErrors: {},
    localDeleted: [],
    localKept: [],
    localError: null,
    cancelled: false,
  };
  for (const remote of scope.remotes) {
    try {
      const done = await deleteOnRemote(remote, list, deps);
      summary.remote[remote] = done.results;
      if (done.error !== null) {
        summary.remoteErrors[remote] = done.error;
      }
      if (done.cancelled) {
        summary.cancelled = true;
        break;
      }
    } catch (e) {
      summary.remoteErrors[remote] = deps.describe(e);
    }
  }
  if (!scope.local) {
    return summary;
  }
  if (summary.cancelled) {
    summary.localKept = list.filter((name) => deps.isLocal?.(name) ?? true);
    return summary;
  }
  const locals = list.filter((name) => deps.isLocal?.(name) ?? true);
  const removable = locals.filter((name) =>
    scope.remotes.every((remote) => {
      const r = summary.remote[remote]?.find((x) => x.name === name);
      return r !== undefined && isTagSuccess(r.status);
    }),
  );
  summary.localKept = locals.filter((name) => !removable.includes(name));
  if (removable.length > 0) {
    try {
      await deps.deleteLocal(removable);
      summary.localDeleted = removable;
    } catch (e) {
      summary.localError = deps.describe(e);
      summary.localKept = locals;
    }
  }
  return summary;
}

/** 고른 곳에서 다 지웠는지: 원격마다 모두 성공, 로컬을 골랐으면 모두 지움, 취소·오류 없음 */
export function tagDeleteComplete(s: TagDeleteSummary): boolean {
  return (
    !s.cancelled &&
    s.localError === null &&
    s.localKept.length === 0 &&
    s.scope.remotes.every(
      (remote) =>
        s.remoteErrors[remote] === undefined &&
        (s.remote[remote] ?? []).length > 0 &&
        (s.remote[remote] ?? []).every((r) => isTagSuccess(r.status)),
    )
  );
}

/** 무엇이라도 바뀌었는지 (원격에서 지움·로컬에서 지움). 취소했는데 바뀐 것이 없으면 알리지 않는다 */
export function tagDeleteChangedAnything(s: TagDeleteSummary): boolean {
  return (
    s.localDeleted.length > 0 ||
    Object.values(s.remote).some((results) => results.some((r) => r.status === 'deleted'))
  );
}

/** 지운 곳 이름 (`로컬 · origin`) */
export function tagDeletePlaces(scope: TagDeleteScope): string {
  return [...(scope.local ? [S.tag.del.local] : []), ...scope.remotes].join(' · ');
}

/** 다 지우지 못했을 때 오류 줄 한 줄: 원격별 실패, 취소, 로컬에 남긴 것, 로컬 실패 */
export function tagDeleteProblems(s: TagDeleteSummary): string {
  const parts: string[] = [];
  for (const remote of s.scope.remotes) {
    const error = s.remoteErrors[remote];
    const failures = tagFailureList(s.remote[remote] ?? []);
    if (failures !== '') {
      parts.push(S.tag.del.remoteFailed(remote, failures));
    }
    if (error !== undefined) {
      parts.push(S.tag.del.remoteFailed(remote, error));
    }
  }
  if (s.cancelled) {
    parts.push(S.tag.del.cancelled);
  }
  if (s.localError !== null) {
    parts.push(S.tag.del.localFailed(s.localError));
  }
  if (s.localKept.length > 0) {
    parts.push(S.tag.del.localKept(s.localKept.join(', ')));
  }
  return parts.join(' · ');
}

/** 태그 문서 일괄 작업 하나 (C4·C5): push · 가져오기(덮어쓰기 포함) · 로컬 것으로 덮어쓰기 */
export type TagBatchOp =
  | { kind: 'push'; remote: string; names: string[] }
  | { kind: 'fetch'; remote: string; names: string[]; overwrite: boolean }
  | { kind: 'replace'; remote: string; items: { name: string; expectedRemote: string }[] };

/** 일괄 작업 결과: tag 별 결과, 명령 전체가 실패했으면 그 안내 (결과 칸이 보인다) */
export interface TagBatchOutcome {
  results: TagRefResult[];
  error: string | null;
}

/** 다시 시도할 만한 결과인지: 일시적 실패(모름·실패)와 확인 대기. 거부(이름 충돌·서버 거부·다름·바뀜)는 아니다 */
export function isTagRetryable(status: TagRefStatus): boolean {
  return status === 'unknown' || status === 'failed' || status === 'notRun';
}

/** 마지막 조회 실패 두 개가 같은지 (없음은 null·undefined 모두) */
function sameLookupError(a: TagLookupError | null, b: TagLookupError | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.kind === b.kind && a.at === b.at && a.message === b.message)
  );
}

/** 상태 두 개가 같은지 (다름은 `sameCommit` 까지) */
function sameSyncState(a: TagSyncState, b: TagSyncState): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== 'diverged' || (b.kind === 'diverged' && a.sameCommit === b.sameCommit))
  );
}

/** 항목 두 개가 같은지 (oid 가 없음은 null·undefined 모두) */
function sameSyncEntry(a: TagSyncEntry, b: TagSyncEntry | undefined): boolean {
  return (
    b !== undefined &&
    a.name === b.name &&
    sameSyncState(a.state, b.state) &&
    (a.localObject ?? null) === (b.localObject ?? null) &&
    (a.localCommit ?? null) === (b.localCommit ?? null) &&
    (a.remoteObject ?? null) === (b.remoteObject ?? null) &&
    (a.remoteCommit ?? null) === (b.remoteCommit ?? null)
  );
}

/**
 * 원격 tag 보고서 두 개가 값으로 같은지: 확인 시각·오래됨·마지막 실패·push 주소 다름·개수·항목(이름순이라 차례대로).
 * 다시 받기(네트워크 없음)는 ref 가 바뀔 때마다 오지만 tag 가 그대로면 같은 값이다 — 그때 상태를 바꾸지 않아 tag 수천
 * 개의 트리를 다시 그리지 않는다. 다른 곳이 먼저 나오면 바로 끝나고, 같을 때도 항목 수에 비례한다 (조회·비교보다 싸다)
 */
export function sameTagReport(a: TagSyncReport, b: TagSyncReport): boolean {
  if (a === b) {
    return true;
  }
  const ca = a.counts;
  const cb = b.counts;
  return (
    a.remote === b.remote &&
    (a.checkedAt ?? null) === (b.checkedAt ?? null) &&
    a.stale === b.stale &&
    a.pushUrlDiffers === b.pushUrlDiffers &&
    sameLookupError(a.lastError ?? null, b.lastError ?? null) &&
    ca.localOnly === cb.localOnly &&
    ca.remoteOnly === cb.remoteOnly &&
    ca.same === cb.same &&
    ca.diverged === cb.diverged &&
    ca.unknown === cb.unknown &&
    a.entries.length === b.entries.length &&
    a.entries.every((e, i) => sameSyncEntry(e, b.entries[i]))
  );
}
