import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type FavoriteOverrides,
  isDefaultFavorite,
  isFavorite,
  NO_FAVORITE_OVERRIDES,
  PREF_BRANCH_FAVORITES,
  parseFavoriteOverrides,
  readFavoriteOverrides,
  setFavorite,
  toggleFavorite,
  useBranchFavorites,
  writeFavoriteOverrides,
} from '../features/branches/branch-favorites';

const MAIN = 'refs/heads/main';
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const FEATURE = 'refs/heads/feature/x';

/** 저장된 원본 값 */
const stored = () => JSON.parse(localStorage.getItem(PREF_BRANCH_FAVORITES) ?? 'null');

beforeEach(() => {
  localStorage.clear();
});

describe('기본 즐겨찾기 (BT-04)', () => {
  it('로컬 main·master 와 그 원격 짝이 기본 즐겨찾기다 (원격 이름 무관)', () => {
    for (const name of [
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'refs/remotes/upstream/main',
    ]) {
      expect(isDefaultFavorite(name), name).toBe(true);
    }
  });

  it('이름이 비슷할 뿐인 ref 와 브랜치가 아닌 ref 는 기본 즐겨찾기가 아니다', () => {
    for (const name of [
      'refs/heads/main2',
      'refs/heads/feature/main',
      'refs/remotes/origin/feature/main',
      'refs/remotes/main',
      'refs/tags/main',
      'main',
    ]) {
      expect(isDefaultFavorite(name), name).toBe(false);
    }
  });
});

describe('즐겨찾기 판정과 토글 (BT-04)', () => {
  it('아무것도 바꾸지 않았으면 기본 즐겨찾기만 켜져 있다', () => {
    expect(isFavorite(NO_FAVORITE_OVERRIDES, MAIN)).toBe(true);
    expect(isFavorite(NO_FAVORITE_OVERRIDES, ORIGIN_MAIN)).toBe(true);
    expect(isFavorite(NO_FAVORITE_OVERRIDES, FEATURE)).toBe(false);
  });

  it('기본이 아닌 브랜치를 켜면 on 에 남고, 다시 끄면 기록에서 사라진다', () => {
    const on = toggleFavorite(NO_FAVORITE_OVERRIDES, FEATURE);
    expect(on).toEqual({ on: [FEATURE], off: [] });
    expect(isFavorite(on, FEATURE)).toBe(true);
    expect(toggleFavorite(on, FEATURE)).toEqual(NO_FAVORITE_OVERRIDES);
  });

  it('기본 즐겨찾기를 끄면 off 에 남아 꺼진 채로 있고, 다시 켜면 기록에서 사라진다', () => {
    const off = toggleFavorite(NO_FAVORITE_OVERRIDES, MAIN);
    expect(off).toEqual({ on: [], off: [MAIN] });
    expect(isFavorite(off, MAIN)).toBe(false);
    // 짝인 원격 브랜치는 따로다
    expect(isFavorite(off, ORIGIN_MAIN)).toBe(true);
    expect(toggleFavorite(off, MAIN)).toEqual(NO_FAVORITE_OVERRIDES);
  });

  it('이미 그 상태면 바꾸지 않고, 겹친 기록은 하나로 정리한다', () => {
    expect(setFavorite(NO_FAVORITE_OVERRIDES, MAIN, true)).toEqual(NO_FAVORITE_OVERRIDES);
    expect(setFavorite(NO_FAVORITE_OVERRIDES, FEATURE, false)).toEqual(NO_FAVORITE_OVERRIDES);
    const messy: FavoriteOverrides = { on: [FEATURE, FEATURE], off: [FEATURE] };
    expect(setFavorite(messy, FEATURE, true)).toEqual({ on: [FEATURE], off: [] });
  });

  it('입력을 바꾸지 않는다', () => {
    const before: FavoriteOverrides = { on: [FEATURE], off: [] };
    toggleFavorite(before, MAIN);
    expect(before).toEqual({ on: [FEATURE], off: [] });
  });
});

describe('즐겨찾기 저장 (BT-04)', () => {
  it('루트 경로별로 저장하고 다시 읽으면 같은 값이다', () => {
    const value: FavoriteOverrides = { on: [FEATURE], off: [MAIN] };
    writeFavoriteOverrides('/work/acme', value);
    writeFavoriteOverrides('/work/other', { on: [], off: [ORIGIN_MAIN] });
    expect(readFavoriteOverrides('/work/acme')).toEqual(value);
    expect(readFavoriteOverrides('/work/other')).toEqual({ on: [], off: [ORIGIN_MAIN] });
    expect(readFavoriteOverrides('/work/none')).toEqual(NO_FAVORITE_OVERRIDES);
    expect(stored()).toEqual({
      '/work/acme': { on: [FEATURE], off: [MAIN] },
      '/work/other': { on: [], off: [ORIGIN_MAIN] },
    });
  });

  it('기본 상태로 돌아간 루트는 저장값에서 지운다', () => {
    writeFavoriteOverrides('/work/acme', { on: [FEATURE], off: [] });
    writeFavoriteOverrides('/work/other', { on: [], off: [MAIN] });
    writeFavoriteOverrides('/work/acme', NO_FAVORITE_OVERRIDES);
    expect(stored()).toEqual({ '/work/other': { on: [], off: [MAIN] } });
  });

  it('모양이 다르거나 모르는 값은 버린다', () => {
    expect(parseFavoriteOverrides(undefined)).toEqual(NO_FAVORITE_OVERRIDES);
    expect(parseFavoriteOverrides(null)).toEqual(NO_FAVORITE_OVERRIDES);
    expect(parseFavoriteOverrides('main')).toEqual(NO_FAVORITE_OVERRIDES);
    expect(parseFavoriteOverrides([MAIN])).toEqual(NO_FAVORITE_OVERRIDES);
    expect(parseFavoriteOverrides({ on: 'x', off: null })).toEqual(NO_FAVORITE_OVERRIDES);
    expect(parseFavoriteOverrides({ on: [FEATURE, 3, null], off: [MAIN, {}], extra: 1 })).toEqual({
      on: [FEATURE],
      off: [MAIN],
    });
  });

  it('저장값 전체가 깨져 있어도 기본 상태로 읽는다', () => {
    localStorage.setItem(PREF_BRANCH_FAVORITES, '{깨진 값');
    expect(readFavoriteOverrides('/work/acme')).toEqual(NO_FAVORITE_OVERRIDES);
    localStorage.setItem(PREF_BRANCH_FAVORITES, '"문자열"');
    expect(readFavoriteOverrides('/work/acme')).toEqual(NO_FAVORITE_OVERRIDES);
    localStorage.setItem(PREF_BRANCH_FAVORITES, JSON.stringify({ '/work/acme': 'x' }));
    expect(readFavoriteOverrides('/work/acme')).toEqual(NO_FAVORITE_OVERRIDES);
  });
});

describe('useBranchFavorites', () => {
  it('바꾸면 곧바로 저장하고, 다시 마운트하면 저장한 값에서 시작한다', () => {
    const first = renderHook(() => useBranchFavorites('/work/acme'));
    expect(first.result.current[0]).toEqual(NO_FAVORITE_OVERRIDES);
    act(() => first.result.current[1]([FEATURE], true));
    act(() => first.result.current[1]([MAIN, ORIGIN_MAIN], false));
    expect(first.result.current[0]).toEqual({ on: [FEATURE], off: [MAIN, ORIGIN_MAIN] });
    expect(stored()).toEqual({ '/work/acme': { on: [FEATURE], off: [MAIN, ORIGIN_MAIN] } });
    first.unmount();

    const again = renderHook(() => useBranchFavorites('/work/acme'));
    expect(again.result.current[0]).toEqual({ on: [FEATURE], off: [MAIN, ORIGIN_MAIN] });
  });

  it('루트가 바뀌면 그 루트의 값을 읽고, 루트가 없으면 바꾸지 않는다', () => {
    writeFavoriteOverrides('/work/other', { on: [], off: [MAIN] });
    const hook = renderHook(({ root }: { root: string | null }) => useBranchFavorites(root), {
      initialProps: { root: '/work/acme' as string | null },
    });
    act(() => hook.result.current[1]([FEATURE], true));
    hook.rerender({ root: '/work/other' });
    expect(hook.result.current[0]).toEqual({ on: [], off: [MAIN] });
    hook.rerender({ root: '/work/acme' });
    expect(hook.result.current[0]).toEqual({ on: [FEATURE], off: [] });

    hook.rerender({ root: null });
    expect(hook.result.current[0]).toEqual(NO_FAVORITE_OVERRIDES);
    act(() => hook.result.current[1]([FEATURE], true));
    expect(hook.result.current[0]).toEqual(NO_FAVORITE_OVERRIDES);
    expect(Object.keys(stored()).sort()).toEqual(['/work/acme', '/work/other']);
  });
});
