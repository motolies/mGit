// 태그 문서 목록의 순수 함수 (C3a, TG-10): 행 만들기(로컬 tag + 고른 원격의 "원격에만"), 상태 필터·개수, 검색, 정렬,
// 일괄 단추의 해당 여부, 기본 원격, 키보드·클릭 선택. 화면(`TagsDoc`)은 이 결과를 그리기만 한다.

import type { LocalTag, RefLabel, RemoteInfo, TagSyncReport, TagSyncState } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { TagFilter, TagSortKey, TagsViewState } from '../../store/workspace-store';
import { isChecked, tagStateOn } from './tag-sync';

/** 목록 한 줄 */
export interface TagRow {
  name: string;
  /** 로컬에 있는지 (원격에만 있는 줄은 거짓) */
  local: boolean;
  /** 로컬 tag 가 annotated 인지. 원격에만 있으면 null */
  annotated: boolean | null;
  /** 로컬 쪽 commit (벗긴 것). 원격에만 있으면 null */
  localCommit: string | null;
  /** 원격 쪽 commit. 모르거나 원격에 없으면 null */
  remoteCommit: string | null;
  /** 원격 ref 가 가리키는 객체 (다를 때 "로컬 것으로 맞추기"의 lease 기준, C5). 보고서 항목에 없으면 null */
  remoteObject: string | null;
  /** 고른 원격에서의 상태. 그 원격을 확인한 적이 없으면 null */
  state: TagSyncState | null;
  /** 날짜 (epoch 초, annotated 는 tag 날짜, 경량은 commit 날짜). 목록을 아직 못 읽었거나 원격에만 있으면 null */
  date: number | null;
  /** annotated tag 의 제목. 경량·원격에만이면 null */
  tagSubject: string | null;
  /** 가리키는 commit 의 제목. 모르면 null */
  commitSubject: string | null;
  /** annotated tag 를 만든 이. 경량·원격에만이면 null */
  tagger: string | null;
}

/** 필터 단추 순서 (전체가 먼저) */
export const TAG_FILTERS: readonly TagFilter[] = [
  'all',
  'localOnly',
  'remoteOnly',
  'same',
  'diverged',
];

/**
 * 행을 만든다: 로컬 tag 마다 한 줄(고른 원격에서의 상태), 확인했으면 원격에만 있는 tag 마다 한 줄. 원격 commit 은 항목에
 * 있으면 그것, "같음"이면 로컬 commit 과 같다. 로컬 tag 목록(`tagList`, C3b)이 있으면 종류·날짜·제목·만든 이를 채운다
 */
export function buildTagRows(
  labels: readonly RefLabel[],
  report: TagSyncReport | undefined,
  tagList: readonly LocalTag[] | null = null,
): TagRow[] {
  const entries = new Map((report?.entries ?? []).map((e) => [e.name, e]));
  const details = new Map((tagList ?? []).map((t) => [t.name, t]));
  const rows: TagRow[] = [];
  for (const l of labels) {
    if (l.kind.kind !== 'tag') {
      continue;
    }
    const state = tagStateOn(report, l.shortName);
    const entry = entries.get(l.shortName);
    const detail = details.get(l.shortName);
    rows.push({
      name: l.shortName,
      local: true,
      annotated: detail?.annotated ?? l.kind.annotated,
      localCommit: l.target,
      remoteCommit: entry?.remoteCommit ?? (state?.kind === 'same' ? l.target : null),
      remoteObject: entry?.remoteObject ?? null,
      state,
      date: detail?.date ?? null,
      tagSubject: detail?.tagSubject ?? null,
      commitSubject: detail?.commitSubject ?? null,
      tagger: detail?.tagger ?? null,
    });
  }
  if (isChecked(report)) {
    // 방금 가져와 로컬에 생겼는데 보고서가 아직 옛 값(원격에만)인 이름은 로컬 줄 하나만 둔다 (이름은 목록의 키다)
    const local = new Set(rows.map((r) => r.name));
    for (const e of report.entries) {
      if (e.state.kind === 'remoteOnly' && !local.has(e.name)) {
        rows.push({
          name: e.name,
          local: false,
          annotated: null,
          localCommit: null,
          remoteCommit: e.remoteCommit ?? e.remoteObject ?? null,
          remoteObject: e.remoteObject ?? null,
          state: e.state,
          date: null,
          tagSubject: null,
          commitSubject: null,
          tagger: null,
        });
      }
    }
  }
  return rows;
}

/** 행이 드는 상태 필터 (전체 말고). 확인 전·알 수 없음이면 null — 전체에만 든다 */
export function tagFilterOf(row: TagRow): Exclude<TagFilter, 'all'> | null {
  switch (row.state?.kind) {
    case 'localOnly':
    case 'remoteOnly':
    case 'same':
    case 'diverged':
      return row.state.kind;
    default:
      return null;
  }
}

/** 필터 단추마다의 개수 (검색과 상관없이 전체 줄 기준) */
export function tagFilterCounts(rows: readonly TagRow[]): Record<TagFilter, number> {
  const counts: Record<TagFilter, number> = {
    all: rows.length,
    localOnly: 0,
    remoteOnly: 0,
    same: 0,
    diverged: 0,
  };
  for (const row of rows) {
    const key = tagFilterOf(row);
    if (key) {
      counts[key] += 1;
    }
  }
  return counts;
}

/** 상태 정렬 순서: 할 일이 있는 것(로컬에만·다름·원격에만)이 먼저, 같음·확인 전이 뒤 */
const STATE_ORDER: Record<string, number> = {
  localOnly: 0,
  diverged: 1,
  remoteOnly: 2,
  unknown: 3,
  same: 4,
  none: 5,
};

/** 이름 비교: 숫자 마디를 수로 견준다 (`v2.10` 이 `v2.9` 보다 뒤) */
function compareName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * 정렬 (원본은 그대로 둔다). 상태·날짜 정렬 안에서는 이름 역순 (새 버전이 위로). 날짜를 모르는 줄은 방향과 상관없이
 * 뒤로 간다
 */
export function sortTagRows(
  rows: readonly TagRow[],
  sort: { key: TagSortKey; desc: boolean },
): TagRow[] {
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'date') {
      if (a.date === null || b.date === null) {
        return Number(a.date === null) - Number(b.date === null) || -compareName(a.name, b.name);
      }
      return dir * (a.date - b.date) || -compareName(a.name, b.name);
    }
    if (sort.key === 'state') {
      const sa = STATE_ORDER[a.state?.kind ?? 'none'] ?? 5;
      const sb = STATE_ORDER[b.state?.kind ?? 'none'] ?? 5;
      return dir * (sa - sb) || -compareName(a.name, b.name);
    }
    return dir * compareName(a.name, b.name);
  });
}

/** 보일 줄: 상태 필터 → 이름 검색(부분 일치, 대소문자 무시) → 정렬 */
export function visibleTagRows(
  rows: readonly TagRow[],
  view: Pick<TagsViewState, 'filter' | 'search' | 'sort'>,
): TagRow[] {
  const q = view.search.trim().toLowerCase();
  const kept = rows.filter(
    (row) =>
      (view.filter === 'all' || tagFilterOf(row) === view.filter) &&
      (q === '' || row.name.toLowerCase().includes(q)),
  );
  return sortTagRows(kept, view.sort);
}

/** 줄 툴팁 (TG-10 ④): tag 제목(경량이면 commit 제목)과 만든 이. 모르면 이름 */
export function tagRowTitle(row: TagRow): string {
  return [
    row.name,
    row.tagSubject ?? row.commitSubject,
    row.tagger ? S.tag.doc.tagger(row.tagger) : null,
  ]
    .filter((line): line is string => line !== null && line !== '')
    .join('\n');
}

/** push 할 수 있는 줄 (TG-12 ①): 로컬에 있고 원격에 없거나 모른다 */
export function canPushTag(row: TagRow): boolean {
  return (
    row.local &&
    (row.state === null || row.state.kind === 'localOnly' || row.state.kind === 'unknown')
  );
}

/** 가져올 수 있는 줄 (TG-12 ①): 원격에만 있다 */
export function canFetchTag(row: TagRow): boolean {
  return row.state?.kind === 'remoteOnly';
}

/** 지울 수 있는 줄 (TG-12 ①): 로컬이나 원격에 있다 — 목록의 모든 줄 */
export function canDeleteTag(row: TagRow): boolean {
  return row.local || row.state?.kind === 'remoteOnly';
}

/**
 * 처음 비교할 원격 (TG-10 ②, D17): 현재 branch 업스트림의 원격 → origin → 첫 원격. 원격이 없으면 null. 업스트림은
 * `origin/main`·`refs/remotes/origin/main` 꼴이고, 이름에 `/` 가 있는 원격도 가장 긴 이름부터 맞춘다
 */
export function defaultTagRemote(
  remotes: readonly Pick<RemoteInfo, 'name'>[],
  upstream: string | null | undefined,
): string | null {
  const names = remotes.map((r) => r.name);
  const up = (upstream ?? '').replace(/^refs\/remotes\//, '');
  const byUpstream = [...names]
    .sort((a, b) => b.length - a.length)
    .find((name) => up.startsWith(`${name}/`));
  return byUpstream ?? (names.includes('origin') ? 'origin' : (names[0] ?? null));
}

/** 선택 상태 (커서·고른 것·범위 기준) */
export type TagSelection = Pick<TagsViewState, 'cursor' | 'selected' | 'anchor'>;

/** 키 입력 하나 (React·DOM 이벤트 공용) */
export interface TagListKey {
  key: string;
  shiftKey: boolean;
  /** 주 수정키 (macOS ⌘, 그 밖 Ctrl) */
  mod: boolean;
}

/** 키가 한 일: 선택을 바꾼다 / Enter(로그에서 보기) / 행 메뉴 / 아무것도 안 함 */
export type TagListCommand =
  | { kind: 'select'; next: TagSelection }
  | { kind: 'enter' }
  | { kind: 'menu' }
  | null;

/** 두 이름 사이(양 끝 포함)의 이름들. 한쪽이 보이지 않으면 끝 쪽만 */
function rangeOf(names: readonly string[], from: string | null, to: string): string[] {
  const a = from === null ? -1 : names.indexOf(from);
  const b = names.indexOf(to);
  if (a < 0 || b < 0) {
    return [to];
  }
  return names.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * 목록의 키보드 (TG-10 ⑤, 다중 선택 listbox): ↑↓·Home·End 는 커서만 옮기고(선택은 그대로), ⇧ 와 함께면 기준부터
 * 커서까지를 고른다. Space 는 커서 줄의 선택을 뒤집고, ⌘A 는 보이는 줄 전부, Esc 는 선택을 비운다. Enter 는 로그에서
 * 보기, ⇧F10·메뉴 키는 행 메뉴. `names` 는 보이는 줄의 이름(화면 순서)
 */
export function tagListKey(
  e: TagListKey,
  names: readonly string[],
  sel: TagSelection,
): TagListCommand {
  const at = sel.cursor === null ? -1 : names.indexOf(sel.cursor);
  const last = names.length - 1;
  const moveTo = (index: number): TagListCommand => {
    const name = names[Math.min(last, Math.max(0, index))];
    if (name === undefined) {
      return null;
    }
    if (e.shiftKey) {
      const anchor = sel.anchor ?? sel.cursor ?? name;
      return {
        kind: 'select',
        next: { cursor: name, anchor, selected: rangeOf(names, anchor, name) },
      };
    }
    return { kind: 'select', next: { cursor: name, anchor: name, selected: sel.selected } };
  };
  switch (e.key) {
    case 'ArrowDown':
      return moveTo(at < 0 ? 0 : at + 1);
    case 'ArrowUp':
      return moveTo(at < 0 ? 0 : at - 1);
    case 'Home':
      return moveTo(0);
    case 'End':
      return moveTo(last);
    case ' ': {
      const name = sel.cursor ?? names[0];
      if (name === undefined) {
        return null;
      }
      const selected = sel.selected.includes(name)
        ? sel.selected.filter((n) => n !== name)
        : [...sel.selected, name];
      return { kind: 'select', next: { cursor: name, anchor: name, selected } };
    }
    case 'Escape':
      return sel.selected.length > 0 ? { kind: 'select', next: { ...sel, selected: [] } } : null;
    case 'Enter':
      return at < 0 ? null : { kind: 'enter' };
    case 'ContextMenu':
      return { kind: 'menu' };
    case 'F10':
      return e.shiftKey ? { kind: 'menu' } : null;
    default:
      if (e.mod && (e.key === 'a' || e.key === 'A')) {
        return {
          kind: 'select',
          next: {
            cursor: sel.cursor ?? names[0] ?? null,
            anchor: sel.anchor,
            selected: [...names],
          },
        };
      }
      return null;
  }
}

/**
 * 줄 클릭 (TG-10 ⑤): 그 줄 하나만 고른다. ⌘(Ctrl)-클릭은 그 줄의 선택을 뒤집고, ⇧-클릭은 기준부터 그 줄까지를 고른다
 */
export function tagListClick(
  name: string,
  mods: { shiftKey: boolean; mod: boolean },
  names: readonly string[],
  sel: TagSelection,
): TagSelection {
  if (mods.shiftKey) {
    const anchor = sel.anchor ?? sel.cursor ?? name;
    return { cursor: name, anchor, selected: rangeOf(names, anchor, name) };
  }
  if (mods.mod) {
    const selected = sel.selected.includes(name)
      ? sel.selected.filter((n) => n !== name)
      : [...sel.selected, name];
    return { cursor: name, anchor: name, selected };
  }
  return { cursor: name, anchor: name, selected: [name] };
}
