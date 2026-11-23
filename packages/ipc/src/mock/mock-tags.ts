// tag 관리 목 (BR-06, TG-01~18). 코어 `tags.rs` 의 동작을 장면 데이터 위에서 흉내 낸다: 로컬 tag 객체 표와 원격별 tag 표를
// 두고, push·원격 삭제·로컬 삭제가 그 표를 실제로 바꾼다. 결과 상태·문구·op 라벨은 코어와 같게 만든다.
//
// 실패 주입은 `globalThis.__mgitMockTagFail` (부를 때마다 읽는다 — Playwright `page.evaluate` 나 개발 도구에서 켜고 끈다).
// 형식은 `MockTagFail` 을 본다

import type {
  GraphRow,
  LocalTag,
  RefLabel,
  RemoteInfo,
  RemoteTag,
  TagDeleteItem,
  TagLeaseItem,
  TagLookupError,
  TagRefResult,
  TagRefStatus,
  TagSyncCounts,
  TagSyncEntry,
  TagSyncReport,
  TagSyncState,
} from '../types';
import { oidOf } from './mock-graph-source';
import { pick } from './mock-l10n';

/** 목 원격 tag 하나 (`ls-remote --tags` 의 `refs/tags/<n>`·`refs/tags/<n>^{}` 두 줄을 합친 것, 코어 `RemoteTag`) */
export interface MockRemoteTag {
  name: string;
  /** ref 가 가리키는 객체 (annotated 면 tag 객체) — lease·비교 기준 */
  object: string;
  /** annotated 면 벗긴 commit, 경량이면 null */
  peeled: string | null;
}

/** 원격 하나를 "원격 확인"한 기록 (코어 캐시의 확인 시각·마지막 실패 흉내) */
export interface MockTagCheck {
  /** 마지막으로 성공한 확인 시각 (epoch 밀리초). 실패만 있었으면 null */
  checkedAt: number | null;
  lastError: TagLookupError | null;
}

/** 목 tag 상태: 로컬 tag 객체와 원격별 tag 표, 원격 확인 기록. 쓰기(push·삭제)·확인이 바꾼다 */
export interface MockTagData {
  /** 로컬 tag 이름 → 그 ref 가 가리키는 객체 (annotated 면 합성 tag 객체, 경량이면 commit) */
  local: Record<string, string>;
  /** 원격 이름 → 그 원격의 tag 표 */
  remotes: Record<string, MockRemoteTag[]>;
  /**
   * 원격 이름 → 확인 기록. 목에는 바깥 변경이 없으므로 확인한 뒤의 보고서는 늘 지금 원격 표로 만든다 — 코어가 앱의
   * push·삭제 결과로 캐시를 고치는 것과 같은 결과다
   */
  checks: Record<string, MockTagCheck>;
}

/**
 * 목 tag 실패 주입 (`globalThis.__mgitMockTagFail`). 원격 목록 자리는 `true` 면 모든 원격, 배열이면 그 원격들이다.
 * 예: `__mgitMockTagFail = { deleteRemote: ['upstream'] }` — upstream 의 원격 삭제만 서버가 거부한다
 */
export interface MockTagFail {
  /** 이 원격의 원격 삭제를 서버가 거부한다 (`rejectedRemote`, 사유 `pre-receive hook declined`). 로컬은 그대로 남는다 */
  deleteRemote?: boolean | string[];
  /** push 하면 이름 충돌(`rejectedExists`, `already exists`)로 거부되는 tag (원격 표와 무관하게). 장면의 v2.3.1 은 주입 없이도 origin 에서 충돌한다 */
  pushExists?: string[];
  /** 원격 삭제에서 원격 것이 달라졌다고(`diverged`) 답할 tag. `expectedRemote` 로 다시 부르면 지운다 */
  diverged?: string[];
  /** 이 원격과의 연결이 인증에서 실패한다 — 명령 전체가 `gitFailed`(hint `authFailed`)로 거부된다. 원격 확인은 `lastError`(auth) */
  auth?: boolean | string[];
  /**
   * 이 원격의 조회가 연결 실패한다 (오프라인 흉내): 원격 확인은 이전 값을 두고 `lastError`(network) 를 남기고, 단일 조회와
   * 원격 삭제(실행 직전 조회)는 `gitFailed` 로 거부된다
   */
  lookup?: boolean | string[];
  /** 이 원격의 보고서를 오래됨(`stale`)으로 보인다 (목에는 바깥 변경이 없어 스스로는 오래되지 않는다) */
  stale?: boolean | string[];
}

/** 실패 주입을 읽는다 (없거나 객체가 아니면 빈 값) */
export function readMockTagFail(): MockTagFail {
  const raw = (globalThis as { __mgitMockTagFail?: unknown }).__mgitMockTagFail;
  return typeof raw === 'object' && raw !== null ? (raw as MockTagFail) : {};
}

/** 원격 목록 자리(`true`·배열)가 이 원격을 가리키는지 */
export function failsFor(target: boolean | string[] | undefined, remote: string): boolean {
  return target === true || (Array.isArray(target) && target.includes(remote));
}

/** 합성 tag 객체 oid 의 행 번호 기준 (그래프·스태시 oid 와 겹치지 않게) */
const TAG_OID_BASE = 6_000_000;

/**
 * 저장소 장면의 tag 상태를 만든다 (TG-08 상태 다섯 가지가 다 보이게). `tags` 는 [이름, 그래프 행, annotated]
 * - origin: v2.4.0 없음(로컬에만), v2.3.1 다른 commit(다름 — push 하면 이름 충돌), v2.3.0 같음,
 *   v2.2.0 같은 commit 다른 객체(원격은 경량), 원격에만 v2.5.0-rc.1(annotated)·v1.9.0
 * - upstream: v2.3.0·v2.2.0 같음, 나머지 없음, 원격에만 v3.0.0-alpha.1
 * 장면에 그 tag 가 없으면 그 줄은 만들지 않는다
 */
export function repoTagData(
  tags: readonly (readonly [string, number, boolean])[],
  oidAt: (row: number) => string,
  seed: number,
): MockTagData {
  const local: Record<string, string> = {};
  const peeled: Record<string, string | null> = {};
  tags.forEach(([name, row, annotated], i) => {
    local[name] = annotated ? oidOf(TAG_OID_BASE + i, seed) : oidAt(row);
    peeled[name] = annotated ? oidAt(row) : null;
  });
  /** 로컬과 같은 원격 tag */
  const same = (name: string): MockRemoteTag[] =>
    local[name] === undefined
      ? []
      : [{ name, object: local[name] ?? '', peeled: peeled[name] ?? null }];
  /** 로컬과 같은 commit 을 가리키는 경량 원격 tag (로컬이 annotated 면 객체가 다르다) */
  const lightweightAt = (name: string): MockRemoteTag[] => {
    const commit = peeled[name] ?? local[name];
    return commit === undefined ? [] : [{ name, object: commit, peeled: null }];
  };
  return {
    local,
    checks: {},
    remotes: {
      origin: [
        ...(local['v2.3.1'] === undefined
          ? []
          : [{ name: 'v2.3.1', object: oidOf(TAG_OID_BASE + 100, seed), peeled: oidAt(97) }]),
        ...same('v2.3.0'),
        ...lightweightAt('v2.2.0'),
        { name: 'v2.5.0-rc.1', object: oidOf(TAG_OID_BASE + 101, seed), peeled: oidAt(2) },
        { name: 'v1.9.0', object: oidAt(400), peeled: null },
      ],
      upstream: [
        ...same('v2.3.0'),
        ...same('v2.2.0'),
        { name: 'v3.0.0-alpha.1', object: oidAt(8), peeled: null },
      ],
    },
  };
}

/** 코어 `check_tag_name` 흉내: refspec 을 깨거나 옵션으로 읽힐 이름이면 거부 문구, 아니면 null */
export function mockTagNameError(name: string): string | null {
  const bad =
    name === '' ||
    name.startsWith('-') ||
    name.includes('..') ||
    name.includes('@{') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    // 공백·제어 문자와 refspec·glob·revision 문자
    /[\s\p{Cc}:*?[\\^~]/u.test(name);
  return bad ? pick(`잘못된 tag 이름: "${name}"`, `Invalid tag name: "${name}"`) : null;
}

/** 등록되지 않은 원격 (코어 `messages::unknown_remote`) */
export function mockUnknownRemote(remote: string): string {
  return pick(`원격이 없습니다: ${remote}`, `No such remote: ${remote}`);
}

/** 로컬에 없는 tag (코어 `messages::tag_not_found`) */
export function mockTagNotFound(name: string): string {
  return pick(`tag 가 없습니다: ${name}`, `No such tag: ${name}`);
}

/** op 끝 요약 (코어 `messages::tag_results_failed`). 모두 성공이면 빈 문자열 */
export function mockTagOpMessage(results: readonly TagRefResult[]): string {
  const failed = results.filter((r) => !isTagSuccess(r.status)).length;
  return failed === 0
    ? ''
    : pick(
        `tag ${results.length}개 중 ${failed}개가 처리되지 않았습니다`,
        `Tags not processed: ${failed} of ${results.length}`,
      );
}

/** 원하는 결과에 이르렀는지 (코어 `TagRefStatus::is_success`) */
export function isTagSuccess(status: TagRefStatus): boolean {
  return (
    status === 'pushed' ||
    status === 'upToDate' ||
    status === 'deleted' ||
    status === 'alreadyAbsent' ||
    status === 'fetched'
  );
}

/** op 라벨 뒤의 tag 목록: `v1` / `v1 v2 v3 (+N)` (셸 `names_label`) */
export function mockTagNamesLabel(names: readonly string[]): string {
  const head = names.slice(0, 3).join(' ');
  return names.length > 3 ? `${head} (+${names.length - 3})` : head;
}

/** 중복을 빼고 순서를 지킨다 */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** 결과 한 줄 */
function result(
  name: string,
  status: TagRefStatus,
  extra: { message?: string | null; remote?: MockRemoteTag | undefined } = {},
): TagRefResult {
  return {
    name,
    status,
    message: extra.message ?? null,
    remoteOid: extra.remote?.object ?? null,
    remoteCommit: extra.remote ? (extra.remote.peeled ?? extra.remote.object) : null,
  };
}

/** 로컬 tag 의 벗긴 commit (라벨의 target). 라벨이 없으면 null */
function localPeeled(labels: readonly RefLabel[], name: string): string | null {
  return labels.find((l) => l.fullName === `refs/tags/${name}`)?.target ?? null;
}

/**
 * tag push 흉내 (코어 `push_tags`). 원격에 없으면 올리고(`pushed`), 같은 객체면 `upToDate`, 다른 객체면 이름 충돌
 * (`rejectedExists`). 로컬에 없는 이름은 `failed`. 원격 표를 바꾼다. 이름·원격 검사는 호출자가 한다
 */
export function mockPushTags(
  data: MockTagData,
  labels: readonly RefLabel[],
  remote: string,
  names: readonly string[],
  fail: MockTagFail,
): TagRefResult[] {
  data.remotes[remote] ??= [];
  const table = data.remotes[remote];
  return unique(names).map((name) => {
    const object = data.local[name];
    if (object === undefined) {
      return result(name, 'failed', {
        message: `src refspec refs/tags/${name} does not match any`,
      });
    }
    const current = table.find((t) => t.name === name);
    if (fail.pushExists?.includes(name) || (current && current.object !== object)) {
      return result(name, 'rejectedExists', { message: 'already exists' });
    }
    if (current) {
      return result(name, 'upToDate');
    }
    const peeled = localPeeled(labels, name);
    table.push({ name, object, peeled: peeled === object ? null : peeled });
    return result(name, 'pushed');
  });
}

/**
 * 원격 tag 삭제 흉내 (코어 `delete_remote_tags`, 확인 전에는 아무것도 지우지 않음):
 * - `expectedRemote` 없이 원격 객체가 로컬과 다른(또는 `diverged` 주입) 항목이 하나라도 있으면 원격 표를 바꾸지 않고 그 항목은
 *   `diverged`(원격 값 포함), 나머지는 `notRun`
 * - 아니면 원격에 없으면 `alreadyAbsent`, `expectedRemote` 가 지금 원격과 다르면 `rejectedStale`, 서버 거부 주입이면
 *   `rejectedRemote`, 나머지는 지우고 `deleted`(원격 값 포함)
 * 로컬에 없는 tag(원격에만)는 비교하지 않는다
 */
export function mockDeleteRemoteTags(
  data: MockTagData,
  remote: string,
  items: readonly TagDeleteItem[],
  fail: MockTagFail,
): TagRefResult[] {
  data.remotes[remote] ??= [];
  const table = data.remotes[remote];
  const seen = new Set<string>();
  const list = items.filter((item) => {
    if (seen.has(item.name)) {
      return false;
    }
    seen.add(item.name);
    return true;
  });
  /** 확인되지 않은 다름: 기대값 없이 로컬과 다르거나 주입된 것 (원격에 있을 때만) */
  const unconfirmed = (item: TagDeleteItem): boolean => {
    const current = table.find((t) => t.name === item.name);
    if (!current || (item.expectedRemote ?? null) !== null) {
      return false;
    }
    const local = data.local[item.name];
    return (
      fail.diverged?.includes(item.name) === true ||
      (local !== undefined && local !== current.object)
    );
  };
  if (list.some(unconfirmed)) {
    return list.map((item) => {
      const current = table.find((t) => t.name === item.name);
      return result(item.name, unconfirmed(item) ? 'diverged' : 'notRun', { remote: current });
    });
  }
  const out: TagRefResult[] = [];
  for (const item of list) {
    const current = table.find((t) => t.name === item.name);
    if (!current) {
      out.push(result(item.name, 'alreadyAbsent'));
      continue;
    }
    const expected = item.expectedRemote ?? null;
    if (expected !== null && expected !== current.object) {
      out.push(
        result(item.name, 'rejectedStale', {
          message: pick(
            '확인한 뒤 원격 tag 가 바뀌었습니다. 다시 확인하세요',
            'The remote tag changed after it was checked. Check again',
          ),
          remote: current,
        }),
      );
      continue;
    }
    if (failsFor(fail.deleteRemote, remote)) {
      out.push(
        result(item.name, 'rejectedRemote', {
          message: 'pre-receive hook declined',
          remote: current,
        }),
      );
      continue;
    }
    table.splice(table.indexOf(current), 1);
    out.push(result(item.name, 'deleted', { remote: current }));
  }
  return out;
}

/**
 * 로컬 tag 삭제 흉내 (코어 `delete_local_tags`, 한 트랜잭션): 하나라도 없으면 아무것도 지우지 않고 그 이름의 거부 문구를
 * 던진다. 지웠으면 남은 라벨을 돌려주고 로컬 객체 표를 바꾼다
 */
export function mockDeleteLocalTags(
  data: MockTagData,
  labels: readonly RefLabel[],
  names: readonly string[],
): RefLabel[] {
  const list = unique(names);
  for (const name of list) {
    const bad = mockTagNameError(name);
    if (bad) {
      throw new Error(bad);
    }
    if (data.local[name] === undefined) {
      throw new Error(mockTagNotFound(name));
    }
  }
  for (const name of list) {
    delete data.local[name];
  }
  const gone = new Set(list.map((n) => `refs/tags/${n}`));
  return labels.filter((l) => !gone.has(l.fullName));
}

/** 로컬 삭제 undo 라벨 (코어 `delete_label`): `tag -d v1` / `tag -d v1 v2 v3 (+N)` */
export function mockTagDeleteLabel(names: readonly string[]): string {
  return `tag -d ${mockTagNamesLabel(unique(names))}`;
}

/** 합성 tag 의 행 번호 기준 (장면 tag 와 겹치지 않게) */
const SYNTH_OID_BASE = TAG_OID_BASE + 10_000;

/**
 * `VITE_MGIT_MOCK_TAGS=N` 의 합성 tag: [이름, 그래프 행, annotated]. 이름은 `v3.<i/100>.<i%100>`, 짝수 번째가 annotated,
 * 행은 그래프에 고루 흩는다
 */
export function syntheticTags(n: number, rows: number): [string, number, boolean][] {
  const count = Math.max(0, Math.floor(n));
  const span = Math.max(1, rows);
  return Array.from({ length: count }, (_, i) => [
    `v3.${Math.floor(i / 100)}.${i % 100}`,
    (i * 7 + 3) % span,
    i % 2 === 0,
  ]);
}

/**
 * 합성 tag 를 tag 상태에 더한다 (`i % 5` 로 origin 상태를 고르게 섞는다): 0 로컬에만, 1·4 같음, 2 다른 commit,
 * 3 같은 commit 다른 객체. upstream 은 세 개 중 하나만 같다. origin 에 원격에만 있는 tag 를 N/10 개 더한다
 */
export function addSyntheticTags(
  data: MockTagData,
  tags: readonly (readonly [string, number, boolean])[],
  oidAt: (row: number) => string,
  seed: number,
): void {
  data.remotes.origin ??= [];
  data.remotes.upstream ??= [];
  const origin = data.remotes.origin;
  const upstream = data.remotes.upstream;
  tags.forEach(([name, row, annotated], i) => {
    const commit = oidAt(row);
    const object = annotated ? oidOf(SYNTH_OID_BASE + i, seed) : commit;
    data.local[name] = object;
    const same: MockRemoteTag = { name, object, peeled: annotated ? commit : null };
    switch (i % 5) {
      case 0:
        break;
      case 2:
        // 바로 앞(없으면 뒤) 행의 commit — 그래프 끝에서 같은 행으로 겹치지 않게
        origin.push({ name, object: oidAt(row > 0 ? row - 1 : row + 1), peeled: null });
        break;
      case 3:
        origin.push(
          annotated
            ? { name, object: commit, peeled: null }
            : { name, object: oidOf(SYNTH_OID_BASE + 50_000 + i, seed), peeled: commit },
        );
        break;
      default:
        origin.push(same);
    }
    if (i % 3 === 0) {
      upstream.push(same);
    }
  });
  for (let i = 0; i < Math.floor(tags.length / 10); i++) {
    origin.push({ name: `v4.0.${i}`, object: oidAt(i * 11), peeled: null });
  }
}

/** 상태 하나를 센다 */
function bumpCount(counts: TagSyncCounts, state: TagSyncState): void {
  switch (state.kind) {
    case 'localOnly':
      counts.localOnly += 1;
      return;
    case 'remoteOnly':
      counts.remoteOnly += 1;
      return;
    case 'same':
      counts.same += 1;
      return;
    case 'diverged':
      counts.diverged += 1;
      return;
    case 'unknown':
      counts.unknown += 1;
      return;
  }
}

/** 빈 보고서 (확인 전) */
export function emptyTagReport(remote: string, pushUrlDiffers = false): TagSyncReport {
  return {
    remote,
    checkedAt: null,
    stale: false,
    lastError: null,
    counts: { localOnly: 0, remoteOnly: 0, same: 0, diverged: 0, unknown: 0 },
    entries: [],
    pushUrlDiffers,
  };
}

/**
 * 원격 tag 상태 보고서 흉내 (코어 `remote_tags` + `compare_tags`): 확인한 적이 없으면 빈 보고서(+ 마지막 실패), 아니면
 * 로컬 tag(라벨의 commit, 객체 표)와 지금 원격 표를 비교해 개수와 "같음"이 아닌 항목(이름순)을 싣는다
 */
export function mockTagReport(
  data: MockTagData,
  labels: readonly RefLabel[],
  info: RemoteInfo,
  fail: MockTagFail,
): TagSyncReport {
  const report = emptyTagReport(info.name, info.pushUrl !== null && info.pushUrl !== info.fetchUrl);
  const check = data.checks[info.name];
  report.lastError = check?.lastError ?? null;
  if (!check || check.checkedAt === null) {
    return report;
  }
  report.checkedAt = check.checkedAt;
  report.stale = failsFor(fail.stale, info.name);
  const remote = new Map((data.remotes[info.name] ?? []).map((t) => [t.name, t]));
  const entries: TagSyncEntry[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (label.kind.kind !== 'tag') {
      continue;
    }
    const name = label.shortName;
    seen.add(name);
    const object = data.local[name] ?? label.target;
    const r = remote.get(name);
    const state: TagSyncState = !r
      ? { kind: 'localOnly' }
      : r.object === object
        ? { kind: 'same' }
        : { kind: 'diverged', sameCommit: (r.peeled ?? r.object) === label.target };
    bumpCount(report.counts, state);
    if (state.kind !== 'same') {
      entries.push({
        name,
        state,
        localObject: object,
        localCommit: label.target,
        remoteObject: r?.object ?? null,
        remoteCommit: r ? (r.peeled ?? r.object) : null,
      });
    }
  }
  for (const r of remote.values()) {
    if (seen.has(r.name)) {
      continue;
    }
    bumpCount(report.counts, { kind: 'remoteOnly' });
    entries.push({
      name: r.name,
      state: { kind: 'remoteOnly' },
      localObject: null,
      localCommit: null,
      remoteObject: r.object,
      remoteCommit: r.peeled ?? r.object,
    });
  }
  report.entries = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return report;
}

/** 원격 확인 흉내: 성공이면 확인 시각을 남기고 실패 기록을 지운다, 실패면 이전 값을 두고 실패를 남긴다 */
export function recordMockTagCheck(
  data: MockTagData,
  remote: string,
  error: TagLookupError | null,
  now: number = Date.now(),
): void {
  const prev = data.checks[remote];
  data.checks[remote] =
    error === null
      ? { checkedAt: now, lastError: null }
      : { checkedAt: prev?.checkedAt ?? null, lastError: error };
}

/** 조회 실패 주입이 이 원격에 걸려 있으면 그 실패, 아니면 null (인증이 먼저) */
export function mockLookupError(fail: MockTagFail, remote: string): TagLookupError | null {
  if (failsFor(fail.auth, remote)) {
    return {
      kind: 'auth',
      at: Date.now(),
      message: `fatal: Authentication failed for '${remote}'`,
    };
  }
  if (failsFor(fail.lookup, remote)) {
    return {
      kind: 'network',
      at: Date.now(),
      message: `fatal: unable to access '${remote}': Could not resolve host`,
    };
  }
  return null;
}

/** 단일 조회 흉내 (코어 `lookup_remote_tags`): 원격에 있는 것만 요청 순서대로 */
export function mockLookupRemoteTags(
  data: MockTagData,
  remote: string,
  names: readonly string[],
): RemoteTag[] {
  const table = new Map((data.remotes[remote] ?? []).map((t) => [t.name, t]));
  return unique(names).flatMap((name) => {
    const t = table.get(name);
    return t ? [{ name: t.name, object: t.object, peeled: t.peeled }] : [];
  });
}

/** 원격을 고르지 않았을 때의 비교 대상 (코어 `tag_default_remote`): 업스트림의 원격 → origin → 첫 원격 */
export function mockDefaultTagRemote(
  labels: readonly RefLabel[],
  remotes: readonly RemoteInfo[],
): string | null {
  const names = remotes.map((r) => r.name);
  const upstream = labels.find((l) => l.isCurrent)?.upstream ?? null;
  const fromUpstream = upstream
    ? names
        .filter((n) => upstream.startsWith(`refs/remotes/${n}/`) || upstream.startsWith(`${n}/`))
        .sort((a, b) => b.length - a.length)[0]
    : undefined;
  return fromUpstream ?? (names.includes('origin') ? 'origin' : (names[0] ?? null));
}

/** 목이 흉내 내는 git 명령 전체 실패 (호출자가 `gitFailed` 로 바꾼다). `message` 는 stderr 한 줄 */
export class MockGitFailure extends Error {}

/** 목 tag 라벨 (장면 라벨과 같은 모양) */
function tagLabelOf(name: string, target: string, annotated: boolean): RefLabel {
  return {
    fullName: `refs/tags/${name}`,
    shortName: name,
    kind: { kind: 'tag', annotated },
    target,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    worktreePath: null,
  };
}

/**
 * 가져오기 흉내 (코어 `fetch_tags`): 원격에 없는 이름이 하나라도 있으면 git 처럼 전체를 멈춘다(`MockGitFailure`). 로컬에
 * 없거나 덮어쓰기면 받고(`fetched`), 같으면 `upToDate`, 로컬에 다른 tag 가 있으면 `rejectedExists`(원격 객체). 받은 것이
 * 있으면 바뀐 라벨을, 없으면 null 을 돌려준다
 */
export function mockFetchTags(
  data: MockTagData,
  labels: readonly RefLabel[],
  remote: string,
  names: readonly string[],
  overwrite: boolean,
): { results: TagRefResult[]; labels: RefLabel[] | null } {
  const table = new Map((data.remotes[remote] ?? []).map((t) => [t.name, t]));
  const list = unique(names);
  const missing = list.find((n) => !table.has(n));
  if (missing !== undefined) {
    throw new MockGitFailure(`fatal: couldn't find remote ref refs/tags/${missing}`);
  }
  let next: RefLabel[] = [...labels];
  let changed = false;
  const results = list.map((name) => {
    const r = table.get(name) as MockRemoteTag;
    const local = data.local[name];
    if (local === r.object) {
      return result(name, 'upToDate', { remote: r });
    }
    if (local !== undefined && !overwrite) {
      return {
        ...result(name, 'rejectedExists', { message: 'would clobber existing tag' }),
        remoteOid: r.object,
      };
    }
    data.local[name] = r.object;
    next = [
      ...next.filter((l) => l.fullName !== `refs/tags/${name}`),
      tagLabelOf(name, r.peeled ?? r.object, r.peeled !== null),
    ];
    changed = true;
    return result(name, 'fetched', { remote: r });
  });
  return { results, labels: changed ? next : null };
}

/** 가져오기 op 라벨 (셸 `fetch_tags`): `fetch <r> v1 v2 v3 (+N)`, 덮어쓰기면 `fetch <r> +v1` */
export function mockFetchLabel(
  remote: string,
  names: readonly string[],
  overwrite: boolean,
): string {
  return `fetch ${remote} ${overwrite ? '+' : ''}${mockTagNamesLabel(unique(names))}`;
}

/**
 * 로컬 tag 목록 흉내 (코어 `tag_list`): 라벨과 그래프 행으로 만든다 — commit 제목·시각은 그 행의 것, annotated 는 tag 제목
 * `Release <이름>`·tagger(행의 작성자)·시각(commit 한 시간 뒤). 이름순
 */
export function mockTagList(
  data: MockTagData,
  labels: readonly RefLabel[],
  rows: readonly GraphRow[],
): LocalTag[] {
  const byOid = new Map(rows.map((r) => [r.oid, r]));
  return labels
    .flatMap((l): LocalTag[] => {
      if (l.kind.kind !== 'tag') {
        return [];
      }
      const annotated = l.kind.annotated;
      const row = byOid.get(l.target);
      return [
        {
          name: l.shortName,
          annotated,
          object: data.local[l.shortName] ?? l.target,
          commit: l.target,
          date: row ? row.commitTime + (annotated ? 3_600 : 0) : null,
          commitSubject: row?.subject ?? '',
          tagSubject: annotated ? `Release ${l.shortName}` : null,
          tagger: annotated && row ? `${row.authorName} <${row.authorEmail}>` : null,
        },
      ];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 로컬 것으로 덮어쓰기 흉내 (코어 `replace_remote_tags`, lease push 한 번): 지금 원격이 `expectedRemote` 가 아니면(없어도)
 * `rejectedStale`(원격 그대로), 로컬에 없으면 `failed`, 이미 같으면 `upToDate`, 아니면 원격 값을 로컬 것으로 바꾸고
 * `pushed`. 원격 표를 바꾼다
 */
export function mockReplaceRemoteTags(
  data: MockTagData,
  labels: readonly RefLabel[],
  remote: string,
  items: readonly TagLeaseItem[],
): TagRefResult[] {
  data.remotes[remote] ??= [];
  const table = data.remotes[remote];
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (seen.has(item.name)) {
      return [];
    }
    seen.add(item.name);
    const current = table.find((t) => t.name === item.name);
    if (!current || current.object !== item.expectedRemote) {
      return [result(item.name, 'rejectedStale', { message: 'stale info', remote: current })];
    }
    const object = data.local[item.name];
    if (object === undefined) {
      return [
        result(item.name, 'failed', {
          message: `src refspec refs/tags/${item.name} does not match any`,
        }),
      ];
    }
    if (current.object === object) {
      return [result(item.name, 'upToDate')];
    }
    const peeled = localPeeled(labels, item.name);
    current.object = object;
    current.peeled = peeled === object ? null : peeled;
    return [result(item.name, 'pushed')];
  });
}
