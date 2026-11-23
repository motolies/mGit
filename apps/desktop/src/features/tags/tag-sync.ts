// 원격 tag 상태 보고서(`TagSyncReport`, 원격별)를 화면이 쓰는 모양으로 바꾸는 순수 함수 (BR-06, TG-03 ⑥·TG-09).
// 브랜치 칸 트리(행 suffix·배지·묶음 요약), 지울 곳 대화상자(칸별 해당 개수·경고), 태그 문서(C)가 함께 쓴다.
// 보고서의 항목은 "같음"이 아닌 것만 오므로, 확인한 원격에 항목이 없는 로컬 tag 는 "같음"이다.

import type { TagLookupErrorKind, TagSyncEntry, TagSyncReport, TagSyncState } from '@mgit/ipc';
import { formatTime, S } from '@mgit/ui';

/** 원격 이름 → 보고서 (세션 스토어 `tagReports`) */
export type TagReports = Readonly<Record<string, TagSyncReport>>;

/** 보고서마다 이름 → 항목 표 (같은 보고서 객체면 다시 만들지 않는다 — tag 수천 개에서 행마다 찾지 않게) */
const entryIndex = new WeakMap<TagSyncReport, Map<string, TagSyncEntry>>();

/** 보고서의 이름 → 항목 표 */
function entriesOf(report: TagSyncReport): Map<string, TagSyncEntry> {
  let index = entryIndex.get(report);
  if (!index) {
    index = new Map(report.entries.map((e) => [e.name, e]));
    entryIndex.set(report, index);
  }
  return index;
}

/** 확인한 적이 있는 보고서인지 (`checkedAt` 이 있다) */
export function isChecked(report: TagSyncReport | undefined): report is TagSyncReport {
  return report !== undefined && report.checkedAt !== null && report.checkedAt !== undefined;
}

/** 원격 하나에서 이 로컬 tag 의 상태. 그 원격을 확인한 적이 없으면 null (항목이 없으면 "같음") */
export function tagStateOn(report: TagSyncReport | undefined, name: string): TagSyncState | null {
  if (!isChecked(report)) {
    return null;
  }
  return entriesOf(report).get(name)?.state ?? { kind: 'same' };
}

/** 원격에 그 tag 가 있다고 볼 수 있는지 (같음·다름·알 수 없음). 확인 안 했으면 null */
export function presentOnRemote(report: TagSyncReport | undefined, name: string): boolean | null {
  const state = tagStateOn(report, name);
  return state === null ? null : state.kind !== 'localOnly';
}

/** 상태 한 낱말 (툴팁·지울 곳). 확인 안 했으면 "확인 안 함" */
export function tagStateText(state: TagSyncState | null): string {
  if (state === null) {
    return S.tag.state.notChecked;
  }
  switch (state.kind) {
    case 'localOnly':
      return S.tag.state.localOnly;
    case 'remoteOnly':
      return S.tag.state.remoteOnly;
    case 'same':
      return S.tag.state.same;
    case 'diverged':
      return state.sameCommit ? S.tag.state.divergedSameCommit : S.tag.state.diverged;
    case 'unknown':
      return S.tag.state.unknown;
  }
}

/**
 * 로컬 tag 하나를 원격들과 견준 결과 (트리 행). 행을 그릴 때마다 tag 수천 개에 대해 부르므로 표시 판정만 담는다 —
 * 툴팁의 원격별 줄은 필요할 때 `localTagSyncLines` 로 만든다
 */
export interface LocalTagSync {
  /** 확인한 원격이 하나 이상이고 그 모두에 없다 (suffix `push 안 됨`) */
  unpushed: boolean;
  /** 확인한 원격 하나라도 다르다 (배지 `⚠ 다름`) */
  differs: boolean;
}

/**
 * 로컬 tag 하나의 원격 상태 (TG-09 ①, D18: 원격들을 합친다). 확인한 원격이 하나도 없으면 null — 아무것도 보이지
 * 않는다. 문자열을 만들지 않는다 (트리 다시 그리기 비용)
 */
export function localTagSync(
  reports: TagReports,
  remotes: readonly string[],
  name: string,
): LocalTagSync | null {
  let checked = 0;
  let localOnly = 0;
  let differs = false;
  for (const remote of remotes) {
    const state = tagStateOn(reports[remote], name);
    if (state === null) {
      continue;
    }
    checked += 1;
    localOnly += state.kind === 'localOnly' ? 1 : 0;
    differs ||= state.kind === 'diverged';
  }
  return checked === 0 ? null : { unpushed: localOnly === checked, differs };
}

/**
 * 툴팁의 원격별 한 줄 (원격 목록 순서, 확인 안 한 원격 포함). 행 툴팁이 필요할 때(hover·키보드 커서)만 부른다.
 * 확인한 원격이 하나도 없으면 null
 */
export function localTagSyncLines(
  reports: TagReports,
  remotes: readonly string[],
  name: string,
): string[] | null {
  const states = remotes.map((remote) => ({ remote, state: tagStateOn(reports[remote], name) }));
  if (states.every((s) => s.state === null)) {
    return null;
  }
  return states.map((s) => S.tag.state.line(s.remote, tagStateText(s.state)));
}

/** 묶음 머리 요약의 재료 (TG-09 ②) */
export interface TagGroupSync {
  /** 확인한 모든 원격에 없는 로컬 tag 수 */
  unpushed: number;
  /** 확인한 원격 어디엔가에만 있는 tag 이름 수 (원격끼리 겹치면 한 번) */
  remoteOnly: number;
  /** 확인한 원격 하나라도 다른 로컬 tag 수 */
  differs: number;
  /** 가장 오래된 확인 시각 (확인한 원격이 없으면 null) */
  checkedAt: number | null;
  /** 오래된 보고서가 있다 */
  stale: boolean;
  /** 마지막 확인이 실패한 종류 (원격 목록 순서, 겹치면 한 번) */
  failures: TagLookupErrorKind[];
}

/** 묶음 요약 재료. 확인한 원격도, 실패한 확인도 없으면 null */
export function tagGroupSync(
  reports: TagReports,
  remotes: readonly string[],
  localNames: readonly string[],
): TagGroupSync | null {
  const present = remotes.map((r) => reports[r]).filter((r) => r !== undefined);
  const checked = present.filter(isChecked);
  const failures = [...new Set(present.flatMap((r) => (r.lastError ? [r.lastError.kind] : [])))];
  if (checked.length === 0 && failures.length === 0) {
    return null;
  }
  let unpushed = 0;
  let differs = 0;
  for (const name of localNames) {
    const sync = localTagSync(reports, remotes, name);
    unpushed += sync?.unpushed ? 1 : 0;
    differs += sync?.differs ? 1 : 0;
  }
  const remoteOnly = new Set(
    checked.flatMap((r) =>
      r.entries.filter((e) => e.state.kind === 'remoteOnly').map((e) => e.name),
    ),
  );
  const times = checked.map((r) => r.checkedAt ?? 0);
  return {
    unpushed,
    remoteOnly: remoteOnly.size,
    differs,
    checkedAt: times.length > 0 ? Math.min(...times) : null,
    stale: checked.some((r) => r.stale),
    failures,
  };
}

/**
 * 묶음 머리 요약 한 줄 (TG-09 ②): `push 안 됨 2 · 원격에만 3 · 다름 1 · 14:02 · 오래됨`. 0 인 개수는 빼고, 모두 0 이면
 * `원격과 같음`. 확인 중이면 앞에 `확인 중…`, 실패가 있으면 뒤에 그 종류. 보일 것이 없으면 빈 문자열
 */
export function tagGroupSummary(sync: TagGroupSync | null, checking: boolean): string {
  const parts: string[] = checking ? [S.tag.tree.checking] : [];
  if (sync) {
    if (sync.checkedAt !== null) {
      const counts = [
        sync.unpushed > 0 ? S.tag.tree.summaryUnpushed(sync.unpushed) : null,
        sync.remoteOnly > 0 ? S.tag.tree.summaryRemoteOnly(sync.remoteOnly) : null,
        sync.differs > 0 ? S.tag.tree.summaryDiffers(sync.differs) : null,
      ].filter((p): p is string => p !== null);
      parts.push(...(counts.length > 0 ? counts : [S.tag.tree.summarySame]));
      parts.push(formatTime(sync.checkedAt));
      if (sync.stale) {
        parts.push(S.tag.tree.stale);
      }
    }
    parts.push(...sync.failures.map((kind) => S.tag.check.failed[kind]));
  }
  return parts.join(' · ');
}
