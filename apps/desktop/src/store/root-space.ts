// 탭의 파일 경로 공간 (MR-13 준비, M0b). 트리·편집기·파일 작업은 루트 기준 상대 경로(`/` 구분, 루트 = '')로 항목을
// 가리키고, 저장소 요약·파일 작업 결과·클립보드·외부 열기는 절대 경로를 쓴다. 둘 사이의 변환을 이 계약 하나로 모은다 —
// 폴더·저장소 탭은 디렉터리 하나의 공간(`dirSpace`)이고, 가상 그룹(M2)은 멤버 별칭을 첫 구성요소로 하는 공간이다.

import type { GroupInfo } from '@mgit/ipc';
import { joinRoot, relativeTo } from './fs-path';

/** 가상 그룹 세션의 키 접두. 그룹 탭의 `FolderOpened.path`·`SessionMeta.path` 가 `mgit-group:<id>` 다 (코어와 같은 값) */
export const GROUP_KEY_PREFIX = 'mgit-group:';

/** 세션 키(탭·저장 키)가 가상 그룹의 것인지 */
export function isGroupKey(key: string): boolean {
  return key.startsWith(GROUP_KEY_PREFIX);
}

/** 탭의 파일 경로 공간: 루트 기준 상대 경로와 절대 경로를 잇는다 */
export interface RootSpace {
  /** 세션 키 (탭·편집기 탭·최근 파일의 저장 키). 디렉터리 공간이면 그 디렉터리의 절대 경로다 */
  readonly key: string;
  /** 공간이 디렉터리 하나면 그 절대 경로, 아니면(가상 그룹) null — 외부 앱·터미널로 열 루트가 없다 */
  readonly dir: string | null;
  /** 루트 기준 상대 경로의 절대 경로. 실제 디렉터리가 없는 자리(그룹 맨 위 '')·모르는 별칭이면 null */
  toAbs(rel: string): string | null;
  /** 절대 경로의 루트 기준 상대 경로. 루트 자신이면 '', 공간 밖이면 null */
  toRel(abs: string): string | null;
}

/**
 * 디렉터리 하나의 공간 (폴더 탭·저장소 탭). 변환은 기존 `joinRoot`·`relativeTo` 와 같은 값이다 — 루트 끝 `/` 를 하나로 보고,
 * 이름이 접두로 겹치는 형제(`/a/b` 와 `/a/bc`)를 구분하며, 구분자는 `/` 만 본다
 */
export function dirSpace(dir: string): RootSpace {
  return {
    key: dir,
    dir,
    toAbs: (rel) => joinRoot(dir, rel),
    toRel: (abs) => relativeTo(dir, abs),
  };
}

/** 가상 그룹을 나타내는 글리프 (탭·홈의 그룹 묶음). 글자가 아닌 기호라 다국어 사전에 두지 않는다 */
export const GROUP_GLYPH = '◈';

/** 그룹 세션 키 `mgit-group:<id>` (코어 `group_key`) */
export function groupKey(id: string): string {
  return `${GROUP_KEY_PREFIX}${id}`;
}

/** 그룹 세션 키의 그룹 id. 그룹 키가 아니면 null */
export function groupIdOf(key: string): string | null {
  return isGroupKey(key) ? key.slice(GROUP_KEY_PREFIX.length) : null;
}

/**
 * 가상 그룹의 공간 (MR-13, 코어 `FsSpace::Group` 과 같은 규칙): 첫 구성요소가 멤버 별칭이고 나머지는 그 멤버 루트 기준이다.
 * 그룹 맨 위('')와 모르는 별칭은 실제 디렉터리가 없어 `toAbs` 가 null 이다. `toRel` 은 구성요소 경계로 가장 긴 멤버 루트를
 * 찾는다 — 멤버 루트 자신은 그 별칭('' 이 아니다), 어느 멤버 밖이면 null. 열 루트 디렉터리가 없어 `dir` 은 null 이다
 */
export function groupSpace(group: Pick<GroupInfo, 'id' | 'members'>): RootSpace {
  const members = group.members.map((m) => ({ alias: m.alias, path: m.path }));
  const roots = new Map(members.map((m) => [m.alias, m.path]));
  return {
    key: groupKey(group.id),
    dir: null,
    toAbs(rel) {
      if (rel === '') return null;
      const at = rel.indexOf('/');
      const root = roots.get(at < 0 ? rel : rel.slice(0, at));
      return root === undefined ? null : joinRoot(root, at < 0 ? '' : rel.slice(at + 1));
    },
    toRel(abs) {
      let best: { alias: string; rest: string; depth: number } | null = null;
      for (const m of members) {
        const rest = relativeTo(m.path, abs);
        if (rest !== null && (best === null || m.path.length > best.depth)) {
          best = { alias: m.alias, rest, depth: m.path.length };
        }
      }
      if (best === null) return null;
      return best.rest === '' ? best.alias : `${best.alias}/${best.rest}`;
    },
  };
}
