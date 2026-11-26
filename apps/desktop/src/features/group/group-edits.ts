// 그룹 멤버 고치기의 공용 판단 (MR-13): 그룹 대화상자와 대시보드의 "찾을 수 없음" 줄이 같은 규칙으로 위치를 다시 지정하고
// 멤버를 뺀다. 판정(저장소인지·최상위로 고치기)은 코어의 경로 확인이 한다

import type { IpcClient, RepoKind } from '@mgit/ipc';

/** 그룹 멤버의 별칭·위치 (고치기 요청의 멤버 꼴) */
export interface MemberRef {
  alias: string;
  path: string;
}

/**
 * 고른 폴더가 가리키는 저장소 하나 (위치 다시 지정의 새 위치). 코어 경로 확인이 받아들인 줄이 정확히 하나여야 한다 —
 * 저장소 안의 폴더는 그 최상위로 고쳐지고, 저장소가 아니거나 저장소 여럿을 품은 폴더면 null
 */
export async function locateRepo(
  client: Pick<IpcClient, 'groupCheckPaths'>,
  picked: string,
): Promise<{ path: string; kind: RepoKind | null } | null> {
  const accepted = (await client.groupCheckPaths(null, [picked])).filter((r) => !r.issue);
  const only = accepted.length === 1 ? accepted[0] : undefined;
  return only ? { path: only.path, kind: only.kind ?? null } : null;
}

/** 별칭 `alias` 의 위치를 `path` 로 바꾼 멤버 목록 (다른 멤버와 같은 위치면 null — 중복) */
export function relocated(
  members: readonly MemberRef[],
  alias: string,
  path: string,
): MemberRef[] | null {
  if (members.some((m) => m.alias !== alias && m.path === path)) return null;
  return members.map((m) => (m.alias === alias ? { alias: m.alias, path } : { ...m }));
}

/** 별칭 `alias` 를 뺀 멤버 목록 */
export function without(members: readonly MemberRef[], alias: string): MemberRef[] {
  return members.filter((m) => m.alias !== alias).map((m) => ({ ...m }));
}

/** 별칭 한 칸의 바이트 상한 (코어 `RelPath` 구성요소 상한) */
const ALIAS_MAX_BYTES = 255;

/**
 * 별칭 바꾸기 칸의 문제 (M4): 파일 경로 구성요소 하나로 쓸 수 없으면(비었거나 `/`·`\`·NUL 포함, `.`·`..`·`.git`, 255바이트
 * 초과) `invalid`, 다른 멤버의 별칭과 대소문자 무시로 겹치면 `duplicate`, 괜찮으면 null. 코어 `valid_alias` 와 멤버 검사의
 * 규칙과 같다 (저장할 때 코어가 다시 검사한다)
 */
export function aliasProblem(
  alias: string,
  others: readonly string[],
): 'invalid' | 'duplicate' | null {
  const lower = alias.toLowerCase();
  if (
    alias === '' ||
    alias === '.' ||
    alias === '..' ||
    lower === '.git' ||
    /[/\\\0]/.test(alias) ||
    new TextEncoder().encode(alias).length > ALIAS_MAX_BYTES
  ) {
    return 'invalid';
  }
  return others.some((o) => o.toLowerCase() === lower) ? 'duplicate' : null;
}
