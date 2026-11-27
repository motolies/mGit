// 비교 화면 ref 선택 칸(`RefPicker`)의 순수 모델 (F4): 값 하나를 어떻게 보일지, 목록을 어떤 묶음·순서로 둘지, 검색어로
// 어떻게 거를지. store 를 import 하지 않는다 — "현재 로컬 내용" 값(`LOCAL`)은 부르는 쪽이 인자로 준다
import type { HeadState, RefLabel } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { rankMatches } from '../../components/fuzzy-match';

/** 칸이 보이는 값의 종류. 아이콘 모양·색과 접근성 이름의 종류 글자가 이것으로 정해진다 */
export type RefPickKind =
  | 'local'
  | 'remote'
  | 'tag'
  | 'head'
  | 'commit'
  | 'expression'
  | 'workingTree';

/** "현재 로컬 내용" 같은 특수 값 (대상(B) 칸만). `value` 는 `onCommit` 으로 돌려줄 값이다 */
export interface RefPickerLocal {
  value: string;
  label: string;
  detail: string;
}

/** 칸이 읽는 ref 재료: 라벨 전부와 HEAD (`RepoRefs` 의 두 필드) */
export interface RefPickerRefs {
  head: HeadState;
  labels: readonly RefLabel[];
}

/** 값 하나를 보이는 방법 (닫힌 칸·목록 항목 공용) */
export interface RefDescription {
  kind: RefPickKind;
  /** 보이는 이름 (짧은 이름·해시 8자·입력한 식) */
  name: string;
  /** 이름 뒤 흐린 글자 (HEAD 의 브랜치 이름 등) */
  detail?: string;
  /** 툴팁 (전체 이름 등) */
  title: string;
  /** 해시·식은 고정폭 글꼴로 보인다 */
  mono: boolean;
  /** 현재 브랜치 (굵게, `head` 아이콘) */
  current: boolean;
  /** 짧은 이름이 여러 ref 와 같을 때 git 이 쓰는 ref 의 전체 이름 (경고 표시) */
  ambiguous?: string;
}

/** 목록 항목 하나 */
export interface RefOption {
  /** 고르면 `onCommit` 으로 줄 값 (ref 는 전체 이름) */
  value: string;
  description: RefDescription;
  /** 검색이 보는 글자 (짧은 이름, 특수 줄은 보이는 글자) */
  search: string;
  /** `refs/` 로 시작하는 검색어가 보는 전체 이름. 특수 줄은 없다 */
  fullName?: string;
}

/** 목록의 묶음 (머리 없는 특수 줄 묶음, 로컬·원격 브랜치, 태그) */
export interface RefSection {
  id: 'special' | 'local' | 'remote' | 'tags';
  /** 묶음 머리 글자. 특수 줄 묶음은 머리가 없다 */
  title: string | null;
  options: RefOption[];
}

/** 거른 목록 */
export interface FilteredRefs {
  sections: RefSection[];
  /** 상한에 걸려 그리지 않은 항목 수 */
  hidden: number;
  /** "입력한 값 사용" 줄. 검색어가 어떤 항목과도 정확히 같지 않을 때만 있다 (`first` 면 맨 위) */
  typed: { text: string; first: boolean } | null;
}

/** 목록에 한 번에 그리는 항목 수 상한 (묶음 합계) */
export const REF_PICKER_LIMIT = 200;

/** 7~64 자리 16진수 (커밋 해시, SHA-256 저장소 포함) */
const HASH = /^[0-9a-f]{7,64}$/i;

/** 커밋 해시이거나 rev 식(`~ ^ @ :` 포함)처럼 보이는지. 그러면 "입력한 값 사용" 줄을 맨 위에 둔다 */
export function looksLikeRevision(text: string): boolean {
  return HASH.test(text) || /[~^@:]/.test(text);
}

/**
 * 가운데 말줄임을 위해 이름을 마지막 `/` 에서 나눈다: 앞부분(`head`, 먼저 줄어든다, `/` 포함)과 끝부분(`tail`, 마지막에
 * 줄어든다). `/` 가 없으면 끝부분이 비고 이름 전체가 앞부분이다 (끝 말줄임 하나)
 */
export function splitRefName(name: string): { head: string; tail: string } {
  const at = name.lastIndexOf('/');
  if (at <= 0 || at === name.length - 1) return { head: name, tail: '' };
  return { head: name.slice(0, at + 1), tail: name.slice(at + 1) };
}

/** ref 라벨의 종류 (stash 는 목록에 넣지 않는다) */
function labelKind(label: RefLabel): RefPickKind | null {
  switch (label.kind.kind) {
    case 'localBranch':
      return label.isCurrent ? 'head' : 'local';
    case 'remoteBranch':
      return 'remote';
    case 'tag':
      return 'tag';
    case 'stash':
      return null;
  }
}

/** ref 라벨을 보이는 방법 */
function labelDescription(label: RefLabel, kind: RefPickKind): RefDescription {
  return {
    kind,
    name: label.shortName,
    title: label.fullName,
    mono: false,
    current: label.isCurrent && label.kind.kind === 'localBranch',
  };
}

/** HEAD 의 흐린 글자: 붙은 브랜치 이름, 분리 상태면 해시 8자 */
function headDetail(head: HeadState): string {
  return head.state === 'detached' ? shortHash(head.oid) : head.branch;
}

/** git 이 짧은 이름을 해석하는 순서 (gitrevisions: 태그 > 로컬 브랜치 > 원격 브랜치) */
const SHORT_NAME_PRIORITY: Record<RefLabel['kind']['kind'], number> = {
  tag: 0,
  localBranch: 1,
  remoteBranch: 2,
  stash: 3,
};

/** 전체 이름 접두로 종류를 어림한다 (목록에 없는 ref, 세션이 아직 없을 때) */
const PREFIX_KIND: readonly [string, RefPickKind][] = [
  ['refs/heads/', 'local'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

/**
 * 값 하나를 어떻게 보일지 정한다. 위에서부터: 특수 값(현재 로컬 내용) → 목록의 전체 이름 → `refs/…` 접두 → `HEAD` →
 * 목록의 짧은 이름(여러 개면 git 우선순위로 고르고 경고) → 커밋 해시 → 그 밖의 식
 */
export function describeRef(
  value: string,
  refs: RefPickerRefs,
  local?: RefPickerLocal,
): RefDescription {
  const t = S.comparison.refPicker;
  if (local && value === local.value) {
    return {
      kind: 'workingTree',
      name: local.label,
      title: `${local.label} · ${local.detail}`,
      mono: false,
      current: false,
    };
  }
  const labels = refs.labels.filter((label) => label.kind.kind !== 'stash');
  const exact = labels.find((label) => label.fullName === value);
  if (exact) {
    return labelDescription(exact, labelKind(exact) ?? 'local');
  }
  for (const [prefix, kind] of PREFIX_KIND) {
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return { kind, name: value.slice(prefix.length), title: value, mono: false, current: false };
    }
  }
  if (value === 'HEAD') {
    const detail = headDetail(refs.head);
    return {
      kind: 'head',
      name: 'HEAD',
      detail,
      title: t.headTitle(detail),
      mono: false,
      current: false,
    };
  }
  const same = labels
    .filter((label) => label.shortName === value)
    .sort((a, b) => SHORT_NAME_PRIORITY[a.kind.kind] - SHORT_NAME_PRIORITY[b.kind.kind]);
  const chosen = same[0];
  if (chosen) {
    const description = labelDescription(chosen, labelKind(chosen) ?? 'local');
    return same.length > 1
      ? { ...description, title: t.ambiguous(chosen.fullName), ambiguous: chosen.fullName }
      : description;
  }
  if (HASH.test(value)) {
    return { kind: 'commit', name: shortHash(value), title: value, mono: true, current: false };
  }
  return {
    kind: 'expression',
    name: value,
    title: t.typedTitle(value),
    mono: true,
    current: false,
  };
}

/** 이름순 비교 (트리와 같은 `localeCompare`) */
function byShortName(a: RefLabel, b: RefLabel): number {
  return a.shortName.localeCompare(b.shortName);
}

/** ref 라벨을 목록 항목으로 */
function labelOption(label: RefLabel): RefOption {
  return {
    value: label.fullName,
    description: labelDescription(label, labelKind(label) ?? 'local'),
    search: label.shortName,
    fullName: label.fullName,
  };
}

/**
 * 목록의 묶음과 순서: (특수 줄) 현재 로컬 내용(`local` 을 줄 때만) → HEAD(커밋이 있을 때만) / 로컬 브랜치(현재 먼저, 다음
 * 이름순) / 원격 브랜치(짧은 이름순) / 태그(이름 역순). stash 는 넣지 않는다 (직접 입력으로는 쓸 수 있다)
 */
export function refSections(refs: RefPickerRefs, local?: RefPickerLocal): RefSection[] {
  const t = S.comparison.refPicker;
  const special: RefOption[] = [];
  if (local) {
    special.push({
      value: local.value,
      description: describeRef(local.value, refs, local),
      search: local.label,
    });
  }
  if (refs.head.state !== 'unborn') {
    special.push({ value: 'HEAD', description: describeRef('HEAD', refs), search: 'HEAD' });
  }
  const localBranches = refs.labels
    .filter((label) => label.kind.kind === 'localBranch')
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || byShortName(a, b));
  const remotes = refs.labels
    .filter((label) => label.kind.kind === 'remoteBranch')
    .sort(byShortName);
  const tags = refs.labels
    .filter((label) => label.kind.kind === 'tag')
    .sort(byShortName)
    .reverse();
  return [
    { id: 'special', title: null, options: special },
    { id: 'local', title: t.sections.local, options: localBranches.map(labelOption) },
    { id: 'remote', title: t.sections.remote, options: remotes.map(labelOption) },
    { id: 'tags', title: t.sections.tags, options: tags.map(labelOption) },
  ];
}

/**
 * 검색어로 거른다. 묶음을 유지하고 묶음 안에서 부분 일치 먼저 → 퍼지 일치 뒤. 검색어가 `refs/` 로 시작하면 전체 이름을
 * 본다. 묶음 합쳐 `limit` 개까지만 남기고 나머지 수를 `hidden` 에 센다. 빈 묶음은 뺀다. 검색어(trim)가 어떤 항목의 짧은
 * 이름·전체 이름과도 정확히 같지 않으면 "입력한 값 사용" 줄을 붙인다 (해시·식처럼 보이면 맨 위)
 */
export function filterRefSections(
  sections: readonly RefSection[],
  query: string,
  limit = REF_PICKER_LIMIT,
): FilteredRefs {
  const q = query.trim();
  const full = q.startsWith('refs/');
  let room = limit;
  let hidden = 0;
  const out: RefSection[] = [];
  for (const section of sections) {
    const matched =
      q === ''
        ? section.options
        : rankMatches(section.options, q, (o) => (full ? (o.fullName ?? o.search) : o.search));
    const shown = matched.slice(0, Math.max(0, room));
    room -= shown.length;
    hidden += matched.length - shown.length;
    if (shown.length > 0) out.push({ ...section, options: shown });
  }
  const exact =
    q === '' ||
    sections.some((section) =>
      section.options.some((o) => o.search === q || o.fullName === q || o.value === q),
    );
  return {
    sections: out,
    hidden,
    typed: exact ? null : { text: q, first: looksLikeRevision(q) },
  };
}
