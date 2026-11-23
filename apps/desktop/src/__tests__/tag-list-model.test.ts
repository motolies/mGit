// C3a: 태그 문서 목록의 순수 함수 (`features/tags/tag-list-model.ts`, TG-10·12) — 행·필터·정렬·해당 여부·기본 원격·
// 키보드와 클릭 선택

import type { LocalTag, RefLabel, TagSyncEntry, TagSyncReport, TagSyncState } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  buildTagRows,
  canDeleteTag,
  canFetchTag,
  canPushTag,
  defaultTagRemote,
  sortTagRows,
  type TagRow,
  tagFilterCounts,
  tagListClick,
  tagListKey,
  tagRowTitle,
  visibleTagRows,
} from '../features/tags/tag-list-model';
import { INITIAL_TAGS_VIEW } from '../store/workspace-store';

const C = (n: number) => String(n).repeat(40).slice(0, 40);

/** 로컬 tag 라벨 */
const tag = (name: string, annotated: boolean, target: string): RefLabel =>
  ({
    fullName: `refs/tags/${name}`,
    shortName: name,
    kind: { kind: 'tag', annotated },
    target,
    isCurrent: false,
    upstreamGone: false,
  }) as RefLabel;

/** 보고서 항목 */
const entry = (
  name: string,
  state: TagSyncState,
  remoteCommit: string | null = null,
): TagSyncEntry => ({
  name,
  state,
  localObject: null,
  localCommit: null,
  remoteObject: null,
  remoteCommit,
});

const LABELS: RefLabel[] = [
  tag('v2.4.0', true, C(1)),
  tag('v2.3.1', true, C(2)),
  tag('v2.3.0', false, C(3)),
  tag('v2.10.0', false, C(4)),
  {
    ...tag('main', false, C(5)),
    fullName: 'refs/heads/main',
    kind: { kind: 'localBranch' },
  } as RefLabel,
];

const REPORT: TagSyncReport = {
  remote: 'origin',
  checkedAt: 1_000,
  stale: false,
  lastError: null,
  counts: { localOnly: 1, remoteOnly: 1, same: 2, diverged: 1, unknown: 0 },
  entries: [
    entry('v1.9.0', { kind: 'remoteOnly' }, C(9)),
    entry('v2.3.1', { kind: 'diverged', sameCommit: false }, C(8)),
    entry('v2.4.0', { kind: 'localOnly' }),
  ],
  pushUrlDiffers: false,
};

const names = (rows: readonly TagRow[]) => rows.map((r) => r.name);

describe('행 만들기 (TG-10 ④)', () => {
  it('로컬 tag 마다 한 줄(branch 는 빼고), 확인했으면 원격에만 있는 줄을 더한다. 같음이면 원격 commit = 로컬 commit', () => {
    const rows = buildTagRows(LABELS, REPORT);
    expect(
      rows.map((r) => [r.name, r.local, r.annotated, r.localCommit, r.remoteCommit, r.state?.kind]),
    ).toEqual([
      ['v2.4.0', true, true, C(1), null, 'localOnly'],
      ['v2.3.1', true, true, C(2), C(8), 'diverged'],
      ['v2.3.0', true, false, C(3), C(3), 'same'],
      ['v2.10.0', true, false, C(4), C(4), 'same'],
      ['v1.9.0', false, null, null, C(9), 'remoteOnly'],
    ]);
  });

  it('보고서가 아직 원격에만이라고 하는 이름이 로컬에 생겼으면(방금 가져옴) 로컬 줄 하나만 둔다', () => {
    const rows = buildTagRows([...LABELS, tag('v1.9.0', false, C(9))], REPORT);
    expect(rows.filter((r) => r.name === 'v1.9.0').map((r) => r.local)).toEqual([true]);
  });

  it('확인 전이면 상태가 없고 원격에만 있는 줄도 없다', () => {
    const rows = buildTagRows(LABELS, { ...REPORT, checkedAt: null });
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['v2.4.0', null],
      ['v2.3.1', null],
      ['v2.3.0', null],
      ['v2.10.0', null],
    ]);
    expect(buildTagRows(LABELS, undefined)).toHaveLength(4);
  });
});

describe('필터·검색·정렬 (TG-10 ③)', () => {
  const rows = buildTagRows(LABELS, REPORT);

  it('필터 단추마다 개수 (전체는 모든 줄)', () => {
    expect(tagFilterCounts(rows)).toEqual({
      all: 5,
      localOnly: 1,
      remoteOnly: 1,
      same: 2,
      diverged: 1,
    });
  });

  it('기본은 이름 역순이고 숫자 마디를 수로 견준다 (v2.10.0 이 맨 위)', () => {
    expect(names(visibleTagRows(rows, INITIAL_TAGS_VIEW))).toEqual([
      'v2.10.0',
      'v2.4.0',
      'v2.3.1',
      'v2.3.0',
      'v1.9.0',
    ]);
    expect(names(sortTagRows(rows, { key: 'name', desc: false }))[0]).toBe('v1.9.0');
  });

  it('상태 정렬은 할 일이 있는 것(로컬에만·다름·원격에만)이 먼저, 같은 상태 안에서는 이름 역순', () => {
    expect(names(sortTagRows(rows, { key: 'state', desc: false }))).toEqual([
      'v2.4.0',
      'v2.3.1',
      'v1.9.0',
      'v2.10.0',
      'v2.3.0',
    ]);
  });

  it('상태 필터와 이름 검색(부분 일치, 대소문자 무시)을 함께 건다', () => {
    const view = { ...INITIAL_TAGS_VIEW, filter: 'same' as const };
    expect(names(visibleTagRows(rows, view))).toEqual(['v2.10.0', 'v2.3.0']);
    expect(names(visibleTagRows(rows, { ...view, search: ' V2.3 ' }))).toEqual(['v2.3.0']);
    expect(names(visibleTagRows(rows, { ...INITIAL_TAGS_VIEW, search: 'nothing' }))).toEqual([]);
  });
});

describe('일괄 단추의 해당 여부 (TG-12 ①)', () => {
  it('push = 로컬에만·모름, 가져오기 = 원격에만, 삭제 = 로컬이나 원격에 있음', () => {
    const rows = Object.fromEntries(buildTagRows(LABELS, REPORT).map((r) => [r.name, r]));
    const unknown = buildTagRows(LABELS, undefined)[0] as TagRow;
    const flags = (r: TagRow | undefined) =>
      r ? [canPushTag(r), canFetchTag(r), canDeleteTag(r)] : null;
    expect(flags(rows['v2.4.0'])).toEqual([true, false, true]);
    expect(flags(rows['v2.3.1'])).toEqual([false, false, true]);
    expect(flags(rows['v1.9.0'])).toEqual([false, true, true]);
    expect(flags(unknown)).toEqual([true, false, true]);
  });
});

describe('기본 원격 (TG-10 ②, D17)', () => {
  const remotes = (...n: string[]) => n.map((name) => ({ name }));

  it('업스트림의 원격 → origin → 첫 원격. 원격 이름에 / 가 있어도 가장 긴 이름부터 맞춘다', () => {
    expect(defaultTagRemote(remotes('origin', 'upstream'), 'upstream/main')).toBe('upstream');
    expect(defaultTagRemote(remotes('origin', 'upstream'), 'refs/remotes/upstream/main')).toBe(
      'upstream',
    );
    expect(defaultTagRemote(remotes('fork', 'fork/team'), 'fork/team/main')).toBe('fork/team');
    expect(defaultTagRemote(remotes('a', 'origin'), null)).toBe('origin');
    expect(defaultTagRemote(remotes('a', 'b'), 'gone/main')).toBe('a');
    expect(defaultTagRemote([], 'origin/main')).toBeNull();
  });
});

describe('키보드·클릭 선택 (TG-10 ⑤)', () => {
  const list = ['a', 'b', 'c', 'd'];
  const sel = (cursor: string | null, selected: string[] = [], anchor: string | null = cursor) => ({
    cursor,
    selected,
    anchor,
  });
  const key = (k: string, mods: { shift?: boolean; mod?: boolean } = {}) => ({
    key: k,
    shiftKey: mods.shift ?? false,
    mod: mods.mod ?? false,
  });

  it('↑↓·Home·End 는 커서만 옮기고 선택은 그대로. 커서가 없으면 첫 줄부터, 끝에서 멈춘다', () => {
    expect(tagListKey(key('ArrowDown'), list, sel(null))).toEqual({
      kind: 'select',
      next: sel('a'),
    });
    expect(tagListKey(key('ArrowDown'), list, sel('b', ['a']))).toEqual({
      kind: 'select',
      next: sel('c', ['a']),
    });
    expect(tagListKey(key('ArrowDown'), list, sel('d'))).toEqual({
      kind: 'select',
      next: sel('d'),
    });
    expect(tagListKey(key('End'), list, sel('a'))).toEqual({ kind: 'select', next: sel('d') });
    expect(tagListKey(key('Home'), list, sel('c'))).toEqual({ kind: 'select', next: sel('a') });
  });

  it('⇧↑↓ 는 기준부터 커서까지를 고르고 기준은 그대로', () => {
    const step = tagListKey(key('ArrowDown', { shift: true }), list, sel('b', ['b'], 'b'));
    expect(step).toEqual({
      kind: 'select',
      next: { cursor: 'c', anchor: 'b', selected: ['b', 'c'] },
    });
    const back = tagListKey(key('ArrowUp', { shift: true }), list, {
      cursor: 'b',
      anchor: 'c',
      selected: [],
    });
    expect(back).toEqual({
      kind: 'select',
      next: { cursor: 'a', anchor: 'c', selected: ['a', 'b', 'c'] },
    });
  });

  it('Space 는 커서 줄을 뒤집고, ⌘A 는 보이는 줄 전부, Esc 는 선택을 비운다 (비었으면 아무것도 안 함)', () => {
    expect(tagListKey(key(' '), list, sel('b', ['a']))).toEqual({
      kind: 'select',
      next: sel('b', ['a', 'b']),
    });
    expect(tagListKey(key(' '), list, sel('b', ['a', 'b']))).toEqual({
      kind: 'select',
      next: sel('b', ['a']),
    });
    expect(tagListKey(key('a', { mod: true }), list, sel('b'))).toEqual({
      kind: 'select',
      next: { cursor: 'b', anchor: 'b', selected: list },
    });
    expect(tagListKey(key('Escape'), list, sel('b', ['a']))).toEqual({
      kind: 'select',
      next: sel('b', []),
    });
    expect(tagListKey(key('Escape'), list, sel('b'))).toBeNull();
  });

  it('Enter 는 커서가 있을 때 로그에서 보기, ⇧F10·메뉴 키는 행 메뉴, 그 밖의 키는 아무것도 안 함', () => {
    expect(tagListKey(key('Enter'), list, sel('b'))).toEqual({ kind: 'enter' });
    expect(tagListKey(key('Enter'), list, sel(null))).toBeNull();
    expect(tagListKey(key('F10', { shift: true }), list, sel('b'))).toEqual({ kind: 'menu' });
    expect(tagListKey(key('ContextMenu'), list, sel('b'))).toEqual({ kind: 'menu' });
    expect(tagListKey(key('F10'), list, sel('b'))).toBeNull();
    expect(tagListKey(key('x'), list, sel('b'))).toBeNull();
  });

  it('클릭은 그 줄만, ⌘-클릭은 뒤집기, ⇧-클릭은 기준부터 그 줄까지', () => {
    expect(tagListClick('c', { shiftKey: false, mod: false }, list, sel('a', ['a', 'b']))).toEqual(
      sel('c', ['c']),
    );
    expect(tagListClick('c', { shiftKey: false, mod: true }, list, sel('a', ['a']))).toEqual(
      sel('c', ['a', 'c']),
    );
    expect(tagListClick('d', { shiftKey: true, mod: false }, list, sel('b', ['b'], 'b'))).toEqual({
      cursor: 'd',
      anchor: 'b',
      selected: ['b', 'c', 'd'],
    });
  });
});

describe('로컬 tag 목록 열 (C3b, TG-10 ④)', () => {
  const LIST: LocalTag[] = [
    {
      name: 'v2.4.0',
      annotated: true,
      object: 'f'.repeat(40),
      commit: C(1),
      date: 300,
      commitSubject: 'feat: x',
      tagSubject: 'Release v2.4.0',
      tagger: 'Kim <k@x>',
    },
    {
      name: 'v2.3.0',
      annotated: false,
      object: C(3),
      commit: C(3),
      date: 100,
      commitSubject: 'fix: y',
      tagSubject: null,
      tagger: null,
    },
  ];

  it('목록이 있으면 날짜·제목·만든 이를 채우고, 툴팁은 tag 제목(경량은 commit 제목)과 만든 이', () => {
    const rows = Object.fromEntries(buildTagRows(LABELS, REPORT, LIST).map((r) => [r.name, r]));
    expect(rows['v2.4.0']).toMatchObject({
      date: 300,
      tagSubject: 'Release v2.4.0',
      tagger: 'Kim <k@x>',
    });
    expect(tagRowTitle(rows['v2.4.0'] as TagRow)).toBe(
      ['v2.4.0', 'Release v2.4.0', S.tag.doc.tagger('Kim <k@x>')].join('\n'),
    );
    expect(tagRowTitle(rows['v2.3.0'] as TagRow)).toBe('v2.3.0\nfix: y');
    // 목록에 없는 줄(원격에만·못 읽음)은 이름만
    expect(rows['v2.10.0']?.date).toBeNull();
    expect(tagRowTitle(rows['v1.9.0'] as TagRow)).toBe('v1.9.0');
  });

  it('날짜 정렬: 최신이 위(기본), 바꾸면 오래된 것이 위. 날짜를 모르는 줄은 방향과 상관없이 뒤', () => {
    const rows = buildTagRows(LABELS, REPORT, LIST);
    expect(names(sortTagRows(rows, { key: 'date', desc: true })).slice(0, 2)).toEqual([
      'v2.4.0',
      'v2.3.0',
    ]);
    const asc = names(sortTagRows(rows, { key: 'date', desc: false }));
    expect(asc.slice(0, 2)).toEqual(['v2.3.0', 'v2.4.0']);
    expect(asc.slice(2)).toEqual(['v2.10.0', 'v2.3.1', 'v1.9.0']);
  });
});
