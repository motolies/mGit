import { IpcClientError } from '../client';
import type {
  FolderBranches,
  FoundRepo,
  FsDirListing,
  GroupInfo,
  GroupListItem,
  GroupMemberInfo,
  GroupPathCheck,
  GroupPathIssue,
  GroupUpdate,
  ReplacePreview,
  ReplaceQuery,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from '../types';
import type { MockFs } from './mock-fs';
import { pick } from './mock-l10n';
import { mockReplacePreview, mockWorkspaceFiles, mockWorkspaceSearch } from './mock-search';
import type { MockFolderData } from './mock-workspace';

/** 그룹 세션 키의 접두 (코어 `GROUP_KEY_PREFIX`) */
export const MOCK_GROUP_KEY_PREFIX = 'mgit-group:';
/** 그룹 이름 길이 상한 (글자) */
const NAME_MAX = 80;
/** 별칭 구성요소 길이 상한 (바이트, 코어 `REL_PATH_COMPONENT_MAX_BYTES`) */
const ALIAS_MAX_BYTES = 255;

/** 목 그룹 멤버 (별칭·저장소 경로) */
export interface MockGroupMember {
  alias: string;
  path: string;
}

/** 목 그룹 정의 (코어 `GroupDef`) */
export interface MockGroupDef {
  id: string;
  name: string;
  members: MockGroupMember[];
  pinned: boolean;
  lastOpenedAt: number;
}

/** 거부 오류 (코어 `Invalid` 흉내) */
function invalid(ko: string, en: string): IpcClientError {
  return new IpcClientError({ kind: 'internal', message: pick(ko, en) });
}

/** 경로의 마지막 이름 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 경로의 상위 폴더 이름 (없으면 빈 문자열) */
function parentName(path: string): string {
  const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return baseName(parent);
}

/** 별칭으로 쓸 수 있는 이름인지 (코어 `valid_alias`: 구성요소 하나, `.`·`..`·`.git`·구분자·NUL 없음, 255바이트) */
export function mockValidAlias(alias: string): boolean {
  return (
    alias !== '' &&
    alias !== '.' &&
    alias !== '..' &&
    alias.toLowerCase() !== '.git' &&
    !/[/\\\0]/.test(alias) &&
    new TextEncoder().encode(alias).length <= ALIAS_MAX_BYTES
  );
}

/** 새 멤버의 별칭 (코어 `assign_alias` 흉내): 폴더 이름 → `이름-상위폴더` → 그 뒤 `-2`, `-3`… 겹침은 대소문자 무시 */
export function mockAssignAlias(taken: readonly string[], path: string): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  const free = (candidate: string) => !lower.has(candidate.toLowerCase());
  const name = baseName(path);
  const base = mockValidAlias(name) ? name : 'repo';
  if (free(base)) return base;
  let stem = base;
  const parent = parentName(path);
  if (mockValidAlias(parent)) {
    stem = `${base}-${parent}`;
    if (free(stem)) return stem;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (free(candidate)) return candidate;
  }
}

/** 한쪽 경로가 다른 쪽 안인지 (구성요소 단위, 같은 경로 제외) */
function nested(a: string, b: string): boolean {
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 그룹 저장소 (코어 `group.rs` 흉내): 정의 목록·경로 확인·만들기·고치기·지우기 */
export interface MockGroupStore {
  list(): GroupListItem[];
  check(group: string | null, paths: readonly string[]): GroupPathCheck[];
  create(name: string, paths: readonly string[]): GroupListItem;
  /** 고친다. 열린 그룹도 고친다 — 세션에 반영하는 일(이벤트)은 목 클라이언트가 한다 (코어 M4 흉내) */
  update(id: string, update: GroupUpdate): GroupListItem;
  remove(id: string, open: boolean): void;
  /** 정의 하나. 없으면 거부 */
  get(id: string): MockGroupDef;
  /** 마지막으로 연 시각을 적는다 */
  touch(id: string, now: number): void;
  /** 열린 그룹의 모습 (멤버 상태 포함) */
  info(id: string): GroupInfo;
}

/**
 * 목 그룹 저장소를 만든다. `repos` 는 목이 아는 저장소들(폴더 장면의 저장소)이고, 멤버 상태·경로 확인은 이것으로 정한다 —
 * 목록에 없는 경로는 디스크에 없다고 본다(`missing`). 폴더는 그 아래의 저장소들로, 저장소 안 경로는 그 저장소로 펼친다
 */
export function createMockGroupStore(
  repos: () => readonly FoundRepo[],
  seed: readonly MockGroupDef[],
): MockGroupStore {
  const groups: MockGroupDef[] = seed.map((g) => ({ ...g, members: [...g.members] }));
  let nextId = groups.length + 1;

  const find = (id: string): MockGroupDef => {
    const def = groups.find((g) => g.id === id);
    if (!def) throw invalid(`그룹을 찾을 수 없습니다: ${id}`, `Group not found: ${id}`);
    return def;
  };
  const memberInfo = (m: MockGroupMember): GroupMemberInfo => {
    const repo = repos().find((r) => r.path === m.path);
    return {
      alias: m.alias,
      path: m.path,
      state: repo ? 'present' : 'missing',
      kind: repo?.kind ?? null,
    };
  };
  const item = (def: MockGroupDef): GroupListItem => ({
    id: def.id,
    name: def.name,
    members: def.members.map(memberInfo),
    pinned: def.pinned,
    lastOpenedAt: def.lastOpenedAt,
  });
  const checkName = (name: string, except: string | null): string => {
    const trimmed = name.trim();
    const count = [...trimmed].length;
    if (count === 0 || count > NAME_MAX) {
      throw invalid(
        `그룹 이름은 1~${NAME_MAX}자여야 합니다`,
        `Group names must be 1–${NAME_MAX} characters`,
      );
    }
    const lower = trimmed.toLowerCase();
    if (groups.some((g) => g.id !== except && g.name.toLowerCase() === lower)) {
      throw invalid(
        `같은 이름의 그룹이 있습니다: ${trimmed}`,
        `A group with this name already exists: ${trimmed}`,
      );
    }
    return trimmed;
  };
  /** 고른 경로 → 후보 저장소 (없으면 거부 이유) */
  const expand = (input: string): FoundRepo[] | GroupPathIssue => {
    const known = repos();
    const exact = known.find((r) => r.path === input);
    if (exact) return [exact];
    const below = known.filter((r) => r.path.startsWith(`${input}/`));
    if (below.length > 0) return below;
    const above = known.find((r) => input.startsWith(`${r.path}/`));
    return above ? [above] : 'missing';
  };
  const check = (existing: readonly MockGroupMember[], inputs: readonly string[]) => {
    const members = [...existing];
    const out: GroupPathCheck[] = [];
    for (const input of inputs) {
      const found = expand(input);
      if (typeof found === 'string') {
        out.push({ input, path: input, kind: null, alias: null, issue: found });
        continue;
      }
      for (const repo of found) {
        const issue: GroupPathIssue | null = members.some((m) => m.path === repo.path)
          ? 'duplicate'
          : members.some((m) => nested(m.path, repo.path))
            ? 'nested'
            : null;
        const alias = issue
          ? null
          : mockAssignAlias(
              members.map((m) => m.alias),
              repo.path,
            );
        if (alias) members.push({ alias, path: repo.path });
        out.push({ input, path: repo.path, kind: repo.kind, alias, issue });
      }
    }
    return { members, checks: out };
  };
  const issueMessage = (c: GroupPathCheck) =>
    invalid(
      `그룹에 넣을 수 없는 경로입니다 (${c.issue}): ${c.path}`,
      `Cannot add this path to the group (${c.issue}): ${c.path}`,
    );

  return {
    list: () =>
      [...groups]
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.lastOpenedAt - a.lastOpenedAt ||
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        )
        .map(item),
    check: (group, paths) => check(group === null ? [] : find(group).members, paths).checks,
    create(name, paths) {
      const trimmed = checkName(name, null);
      const { members, checks } = check([], paths);
      const bad = checks.find((c) => c.issue !== null);
      if (bad) throw issueMessage(bad);
      if (members.length === 0) {
        throw invalid(
          '그룹에는 저장소가 하나 이상 있어야 합니다',
          'A group needs at least one repository',
        );
      }
      const def: MockGroupDef = {
        id: `g${(nextId++).toString(16).padStart(12, '0')}`,
        name: trimmed,
        members,
        pinned: false,
        lastOpenedAt: 0,
      };
      groups.push(def);
      return item(def);
    },
    update(id, update) {
      const def = find(id);
      const name = update.name == null ? null : checkName(update.name, id);
      const members = update.members ?? null;
      if (members) {
        if (members.length === 0) {
          throw invalid(
            '그룹에는 저장소가 하나 이상 있어야 합니다',
            'A group needs at least one repository',
          );
        }
        const seen = new Set<string>();
        members.forEach((m, i) => {
          const lower = m.alias.toLowerCase();
          if (!mockValidAlias(m.alias) || seen.has(lower)) {
            throw invalid(`별칭을 쓸 수 없습니다: ${m.alias}`, `Invalid alias: ${m.alias}`);
          }
          seen.add(lower);
          const kept = def.members.some((d) => d.path === m.path);
          if (!kept && !repos().some((r) => r.path === m.path)) {
            throw invalid(`저장소가 아닙니다: ${m.path}`, `Not a repository: ${m.path}`);
          }
          if (members.some((o, j) => j !== i && (o.path === m.path || nested(o.path, m.path)))) {
            throw invalid(
              `겹치거나 중첩된 저장소입니다: ${m.path}`,
              `Duplicate or nested repository: ${m.path}`,
            );
          }
        });
      }
      if (name !== null) def.name = name;
      if (members) def.members = members.map((m) => ({ alias: m.alias, path: m.path }));
      if (update.pinned != null) def.pinned = update.pinned;
      return item(def);
    },
    remove(id, open) {
      find(id);
      if (open) {
        throw invalid(
          '열려 있는 그룹은 지울 수 없습니다. 그룹 탭을 닫은 뒤 다시 시도하세요',
          'An open group cannot be deleted. Close the group tab and try again',
        );
      }
      groups.splice(
        groups.findIndex((g) => g.id === id),
        1,
      );
    },
    get: find,
    touch(id, now) {
      find(id).lastOpenedAt = now;
    },
    info(id) {
      const def = find(id);
      return { id: def.id, name: def.name, members: def.members.map(memberInfo) };
    },
  };
}

/** 폴더 장면에서 목 그룹 하나를 만든다: 앞 저장소 둘(첫째와 둘째)과 사라진 멤버 하나. 고정돼 있다 */
export function mockGroupSeed(folder: MockFolderData | null, now: number): MockGroupDef[] {
  if (!folder || folder.openFolder.length < 2) return [];
  const [first, second] = folder.openFolder;
  if (!first || !second) return [];
  return [
    {
      id: 'g000000000001',
      name: 'Platform core',
      members: [
        { alias: baseName(first.path), path: first.path },
        { alias: baseName(second.path), path: second.path },
        { alias: 'legacy-tools', path: '/mock/elsewhere/legacy-tools' },
      ],
      pinned: true,
      lastOpenedAt: now,
    },
  ];
}

/** 그룹 세션 키 */
export function mockGroupKey(id: string): string {
  return `${MOCK_GROUP_KEY_PREFIX}${id}`;
}

/**
 * 그룹 세션의 폴더 데이터: 폴더 장면 데이터에서 있는 멤버의 저장소만 남긴 얕은 사본 (경로는 세션 키). 요약·변경·타임라인·
 * 브랜치 목록이 그 저장소들만 본다
 */
export function mockGroupFolderData(folder: MockFolderData, info: GroupInfo): MockFolderData {
  const paths = new Set(info.members.filter((m) => m.state === 'present').map((m) => m.path));
  const keep = <T extends { path: string }>(list: readonly T[]) =>
    list.filter((r) => paths.has(r.path));
  const branches: FolderBranches = {
    repos: keep(folder.folderBranches.repos),
    branches: folder.folderBranches.branches
      .map((b) => ({ ...b, repos: keep(b.repos) }))
      .filter((b) => b.repos.length > 0),
  };
  return {
    ...folder,
    path: mockGroupKey(info.id),
    openFolder: keep(folder.openFolder),
    folderSummaries: keep(folder.folderSummaries),
    folderChanges: keep(folder.folderChanges),
    folderBranches: branches,
    folderTimeline: keep(folder.folderTimeline),
  };
}

/** 그룹 파일 경로가 가리키는 곳: 멤버 루트와 그 기준 나머지, 그 멤버가 지금 있는지 */
export interface MockGroupLocated {
  root: string;
  path: string;
  /** 없는 멤버면 거짓 — 그 아래는 "없음"으로 답한다 */
  present: boolean;
}

/**
 * 그룹 파일 경로 → (멤버 루트, 나머지) (코어 `FsSpace::Group::locate` 흉내). 빈 경로는 맨 위('top'). 경로 전체가 올바른
 * 상대 경로여야 하고(`..`·`.`·빈 구성요소·`.git`·절대 경로 거부) 첫 구성요소가 별칭과 정확히 같아야 한다. 아니면 거부
 */
export function mockGroupLocate(
  members: readonly GroupMemberInfo[],
  path: string,
): MockGroupLocated | 'top' {
  if (path === '') return 'top';
  const parts = path.split('/');
  const bad =
    path.startsWith('/') ||
    path.includes('\0') ||
    parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git');
  const member = bad ? undefined : members.find((m) => m.alias === parts[0]);
  if (!member || member.state === 'notRepo') {
    throw invalid(`파일 경로를 거부했습니다: "${path}"`, `Rejected file path: "${path}"`);
  }
  return { root: member.path, path: parts.slice(1).join('/'), present: member.state === 'present' };
}

/** 그룹 맨 위는 파일도 대상도 아니다 (코어 `into_under` 흉내) */
export function mockGroupTopRejected(): IpcClientError {
  return invalid(
    '파일 경로를 거부했습니다 (그룹 맨 위에는 파일이 없습니다): ""',
    'Rejected file path (The top of a group holds no files): ""',
  );
}

/** 그룹 범위를 멤버 범위로 (코어 `member_scope`): 비었거나 별칭이면 '', `별칭/나머지` 면 나머지, 다른 멤버면 null */
function memberScope(alias: string, scope: string): string | null {
  if (scope === '' || scope === alias) return '';
  return scope.startsWith(`${alias}/`) ? scope.slice(alias.length + 1) : null;
}

/**
 * 그룹 내용 검색 (코어 M3 흉내): 있는 멤버마다 그 루트를 검색해 결과 경로·저장소를 `별칭/…` 로 바꾼다. 범위가 별칭이면 그
 * 멤버만, 초안은 별칭 경로로 받고, 경로 거르기는 별칭 경로로 본다. 결과 줄 상한(2,000)은 멤버들이 나눠 쓴다
 */
export function mockGroupSearch(
  fs: MockFs,
  members: readonly GroupMemberInfo[],
  q: WorkspaceSearchQuery,
): WorkspaceSearchResult {
  const out: WorkspaceSearchResult = { hits: [], skipped: 0, cancelled: false, truncated: false };
  const filter = q.pathFilter.toLowerCase();
  for (const m of members) {
    const scope = m.state === 'present' ? memberScope(m.alias, q.scope) : null;
    if (scope === null) continue;
    const drafts = q.drafts.flatMap((d) =>
      d.path.startsWith(`${m.alias}/`)
        ? [{ path: d.path.slice(m.alias.length + 1), text: d.text }]
        : [],
    );
    const part = mockWorkspaceSearch(fs, m.path, { ...q, scope, drafts, pathFilter: '' });
    out.skipped += part.skipped;
    for (const hit of part.hits) {
      const path = `${m.alias}/${hit.path}`;
      if (!path.toLowerCase().includes(filter)) continue;
      out.hits.push({ ...hit, path, repo: m.alias });
      if (out.hits.length >= 2000) {
        out.truncated = true;
        return out;
      }
    }
  }
  return out;
}

/**
 * 그룹 바꾸기 미리보기 (코어 `workspace_replace_preview` 흉내): 내용 검색처럼 있는 멤버마다 그 루트를 미리보고 결과·제외
 * 경로를 `별칭/…`, 저장소를 별칭으로 바꾼다. 범위가 별칭이면 그 멤버만, 초안·경로 거르기는 별칭 경로로 본다
 */
export function mockGroupReplacePreview(
  fs: MockFs,
  members: readonly GroupMemberInfo[],
  q: ReplaceQuery,
): ReplacePreview {
  const out: ReplacePreview = {
    files: [],
    excluded: [],
    unreadable: 0,
    truncated: false,
    cancelled: false,
  };
  const filter = q.pathFilter.toLowerCase();
  for (const m of members) {
    const scope = m.state === 'present' ? memberScope(m.alias, q.scope) : null;
    if (scope === null) continue;
    const drafts = q.drafts.flatMap((d) =>
      d.startsWith(`${m.alias}/`) ? [d.slice(m.alias.length + 1)] : [],
    );
    // 멤버 루트가 곧 저장소다 (그 아래 파일은 모두 저장소 안)
    const part = mockReplacePreview(fs, m.path, { ...q, scope, drafts, pathFilter: '' }, () => '');
    const shown = (path: string) => `${m.alias}/${path}`;
    out.unreadable += part.unreadable;
    out.files.push(
      ...part.files
        .map((f) => ({ ...f, path: shown(f.path), repo: m.alias }))
        .filter((f) => f.path.toLowerCase().includes(filter)),
    );
    out.excluded.push(
      ...part.excluded
        .map((e) => ({ ...e, path: shown(e.path) }))
        .filter((e) => e.path.toLowerCase().includes(filter)),
    );
  }
  return out;
}

/** 그룹 빠른 열기 목록 (코어 M3 흉내): 있는 멤버의 파일을 `별칭/…` 로 합쳐 정렬하고, 저장소는 멤버 별칭들이다 */
export function mockGroupFiles(
  fs: MockFs,
  members: readonly GroupMemberInfo[],
): { files: string[]; repos: string[]; skipped: number; truncated: boolean } {
  const present = members.filter((m) => m.state === 'present');
  let skipped = 0;
  const files = present
    .flatMap((m) => {
      const part = mockWorkspaceFiles(fs, m.path);
      skipped += part.skipped;
      return part.files.map((f) => `${m.alias}/${f}`);
    })
    .sort();
  return { files, repos: present.map((m) => m.alias).sort(), skipped, truncated: false };
}

/** 그룹 맨 위 나열: 별칭들 (디렉터리, 열 수 없음, 대소문자 무시 이름순) */
export function mockGroupTopListing(
  members: readonly { alias: string }[],
  limit: number | null | undefined,
): FsDirListing {
  const names = members
    .map((m) => m.alias)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : 1));
  const max = Math.max(1, limit ?? 2_000);
  return {
    kind: 'listed',
    entries: names
      .slice(0, max)
      .map((name) => ({ name, kind: 'dir', size: null, mtimeMs: null, openable: false })),
    total: names.length,
    truncated: names.length > max,
    nonUtf8Names: 0,
  };
}
