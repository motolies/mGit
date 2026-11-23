import { useCallback, useState } from 'react';
import { readPref, writePref } from '../../store/prefs';
import { LOCAL_REF_PREFIX, REMOTE_REF_PREFIX } from './branch-tree-model';

/**
 * 즐겨찾기 저장 키 (BT-04, 앱 전역 1벌). 값은 `{ [루트 경로]: { on: string[], off: string[] } }` —
 * 루트(폴더·저장소)마다 "기본값에서 달라진 것"만 전체 ref 이름으로 적는다
 */
export const PREF_BRANCH_FAVORITES = 'mgit.branchFavorites';

/** 한 루트의 즐겨찾기: 기본값에서 달라진 것 */
export interface FavoriteOverrides {
  /** 사용자가 켠 것 (기본 즐겨찾기가 아닌 ref) */
  readonly on: readonly string[];
  /** 사용자가 끈 기본 즐겨찾기 */
  readonly off: readonly string[];
}

/** 아무것도 바꾸지 않은 상태 (기본 즐겨찾기만) */
export const NO_FAVORITE_OVERRIDES: FavoriteOverrides = { on: [], off: [] };

/** 기본으로 즐겨찾기인 브랜치 이름 */
const DEFAULT_FAVORITE_BRANCHES: readonly string[] = ['main', 'master'];

/** 기본 즐겨찾기인지: 로컬 `main`·`master` 와 그 원격 짝 (`<원격>/main`, `<원격>/master`, 원격 이름 무관) */
export function isDefaultFavorite(fullName: string): boolean {
  if (fullName.startsWith(LOCAL_REF_PREFIX)) {
    return DEFAULT_FAVORITE_BRANCHES.includes(fullName.slice(LOCAL_REF_PREFIX.length));
  }
  if (fullName.startsWith(REMOTE_REF_PREFIX)) {
    const rest = fullName.slice(REMOTE_REF_PREFIX.length);
    const slash = rest.indexOf('/');
    return slash > 0 && DEFAULT_FAVORITE_BRANCHES.includes(rest.slice(slash + 1));
  }
  return false;
}

/** 즐겨찾기인지: 사용자가 끈 것이 먼저, 그다음 켠 것과 기본값 */
export function isFavorite(overrides: FavoriteOverrides, fullName: string): boolean {
  if (overrides.off.includes(fullName)) {
    return false;
  }
  return overrides.on.includes(fullName) || isDefaultFavorite(fullName);
}

/**
 * 즐겨찾기를 켜거나 끈 새 상태. 기본값과 같아지면 기록에서 지운다 —
 * 기본 즐겨찾기를 끄면 `off` 에 남고, 다시 켜면 사라진다
 */
export function setFavorite(
  overrides: FavoriteOverrides,
  fullName: string,
  favorite: boolean,
): FavoriteOverrides {
  const on = overrides.on.filter((name) => name !== fullName);
  const off = overrides.off.filter((name) => name !== fullName);
  if (favorite === isDefaultFavorite(fullName)) {
    return { on, off };
  }
  return favorite ? { on: [...on, fullName], off } : { on, off: [...off, fullName] };
}

/** 즐겨찾기를 뒤집은 새 상태 */
export function toggleFavorite(overrides: FavoriteOverrides, fullName: string): FavoriteOverrides {
  return setFavorite(overrides, fullName, !isFavorite(overrides, fullName));
}

/** 문자열만 남긴 목록. 배열이 아니면 빈 목록 */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 저장된 값을 읽는다. 모양이 다르거나 모르는 값이면 버리고 기본 상태로 둔다 */
export function parseFavoriteOverrides(raw: unknown): FavoriteOverrides {
  if (typeof raw !== 'object' || raw === null) {
    return NO_FAVORITE_OVERRIDES;
  }
  const { on, off } = raw as { on?: unknown; off?: unknown };
  return { on: stringList(on), off: stringList(off) };
}

/** 저장된 전체 값 (루트 경로 → 그 루트의 값) */
function readAll(): Record<string, unknown> {
  return readPref<Record<string, unknown>>(PREF_BRANCH_FAVORITES, {});
}

/** 한 루트의 즐겨찾기를 읽는다 */
export function readFavoriteOverrides(root: string): FavoriteOverrides {
  return parseFavoriteOverrides(readAll()[root]);
}

/** 한 루트의 즐겨찾기를 저장한다. 다른 루트의 값은 그대로 두고, 기본 상태로 돌아간 루트는 지운다 */
export function writeFavoriteOverrides(root: string, overrides: FavoriteOverrides): void {
  const all = { ...readAll() };
  if (overrides.on.length === 0 && overrides.off.length === 0) {
    delete all[root];
  } else {
    all[root] = { on: [...overrides.on], off: [...overrides.off] };
  }
  writePref(PREF_BRANCH_FAVORITES, all);
}

/** 루트와 그 루트에서 읽은 즐겨찾기 */
interface Loaded {
  root: string | null;
  overrides: FavoriteOverrides;
}

/** 루트의 저장된 즐겨찾기를 읽는다. 루트가 없으면 기본 상태 */
function load(root: string | null): Loaded {
  return { root, overrides: root === null ? NO_FAVORITE_OVERRIDES : readFavoriteOverrides(root) };
}

/**
 * 한 루트(폴더·저장소 경로)의 즐겨찾기를 읽고 바꾼다. 바꾸면 곧바로 저장한다.
 * 돌려주는 것은 `[지금 상태, 여러 ref 를 한꺼번에 켜거나 끄는 함수]` — 판정은 `isFavorite` 로 한다
 */
export function useBranchFavorites(
  root: string | null,
): [FavoriteOverrides, (fullNames: readonly string[], favorite: boolean) => void] {
  const [loaded, setLoaded] = useState<Loaded>(() => load(root));
  // 루트가 바뀌면(다른 탭) 그 루트의 값을 다시 읽는다. 렌더 중에 맞춰 한 번 더 그리지 않게 한다
  const current = loaded.root === root ? loaded : load(root);
  if (current !== loaded) {
    setLoaded(current);
  }

  /**
   * ref 들의 즐겨찾기를 켜거나 끄고 저장한다. 루트와 지금 값이 같으면 같은 함수다 — 받은 쪽(memo 한 트리)이 다시
   * 그려지지 않게 (W22)
   */
  const overrides = current.overrides;
  const setFavorites = useCallback(
    (fullNames: readonly string[], favorite: boolean) => {
      if (root === null) {
        return;
      }
      const next = fullNames.reduce(
        (acc, fullName) => setFavorite(acc, fullName, favorite),
        overrides,
      );
      writeFavoriteOverrides(root, next);
      setLoaded({ root, overrides: next });
    },
    [root, overrides],
  );

  return [overrides, setFavorites];
}
