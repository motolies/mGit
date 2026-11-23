// 로그 행의 ref 라벨 (LG-03). 행의 ref 목록을 "그릴 라벨"로 바꾸는 순수 함수들이다:
// 같은 커밋의 로컬 브랜치와 원격 짝을 한 라벨로 묶고, 자리가 모자라면 뒤쪽 라벨을 +N 으로 접는다.

import { type RefLabel, remoteBranchName } from '@mgit/ipc';
import { type IconName, S } from '@mgit/ui';

/** 아이콘 색을 고르는 종류. `--ref-head`·`--ref-local`·`--ref-remote`·`--ref-tag` 토큰에 대응한다 */
export type RefLabelTone = 'head' | 'local' | 'remote' | 'tag';

/** 로그 행에 그릴 라벨 하나 */
export interface RefLabelItem {
  /** 행 안에서 안정된 키 (대표 ref 의 전체 이름) */
  key: string;
  icon: IconName;
  tone: RefLabelTone;
  /** 보이는 글자: `development`, `origin & development`, `origin/x`, `v1.0`, `HEAD` */
  text: string;
  /** HEAD 가 가리키는 현재 브랜치의 라벨. 이 라벨이 HEAD 표시를 겸한다 */
  current: boolean;
  /** 끌어서 다른 행에 놓을 때 넘기는 ref 이름 (GRAPH-09). 브랜치가 아니면 null */
  dragName: string | null;
  /** 툴팁: 이 라벨에 묶인 ref 의 전체 이름 (줄마다 하나) */
  title: string;
}

/**
 * 행의 ref 들을 그릴 라벨로 바꾼다.
 * - 로컬 브랜치와 이름이 같은 원격 브랜치가 **원격 하나에만** 있으면 `origin & development` 로 묶는다.
 *   같은 이름이 여러 원격에 있으면 어느 쪽과도 묶지 않고 모두 따로 둔다 (`a & b & x` 꼴은 만들지 않는다).
 * - HEAD 가 브랜치를 가리키면 그 브랜치 라벨이 HEAD 표시를 겸하고, 분리 HEAD 면 `HEAD` 라벨을 따로 둔다.
 * - 순서: HEAD(현재 브랜치) → 로컬 → 묶이지 않은 원격 → 태그·그 밖. 같은 종류 안에서는 받은 순서다.
 * - 묶인 라벨을 끌면 로컬 브랜치를 끄는 것이다. 원격만 있는 라벨은 원격 브랜치를 끈다.
 */
export function refLabelItems(refs: readonly RefLabel[], isHead: boolean): RefLabelItem[] {
  // 대부분의 행은 ref 가 없다. 스크롤할 때마다 행마다 불리므로 바로 끝낸다
  if (refs.length === 0 && !isHead) {
    return [];
  }
  const locals = refs.filter((l) => l.kind.kind === 'localBranch');
  const remotes = refs.filter((l) => l.kind.kind === 'remoteBranch');
  const rest = refs.filter((l) => l.kind.kind !== 'localBranch' && l.kind.kind !== 'remoteBranch');
  const paired = new Set<string>();
  const current: RefLabelItem[] = [];
  const others: RefLabelItem[] = [];

  for (const local of locals) {
    const mates = remotes.filter((r) => remoteBranchName(r) === local.shortName);
    const mate = mates.length === 1 ? mates[0] : undefined;
    const remote = mate?.kind.kind === 'remoteBranch' ? mate.kind.remote : null;
    if (mate) {
      paired.add(mate.fullName);
    }
    (local.isCurrent ? current : others).push({
      key: local.fullName,
      icon: local.isCurrent ? 'head' : 'branch',
      tone: local.isCurrent ? 'head' : 'local',
      text: remote === null ? local.shortName : S.graph.refs.paired(remote, local.shortName),
      current: local.isCurrent,
      dragName: local.shortName,
      title: mate ? `${local.fullName}\n${mate.fullName}` : local.fullName,
    });
  }
  for (const remote of remotes) {
    if (!paired.has(remote.fullName)) {
      others.push({
        key: remote.fullName,
        icon: 'remote',
        tone: 'remote',
        text: remote.shortName,
        current: false,
        dragName: remote.shortName,
        title: remote.fullName,
      });
    }
  }
  for (const label of rest) {
    others.push({
      key: label.fullName,
      icon: 'tag',
      tone: 'tag',
      text: label.shortName,
      current: false,
      dragName: null,
      title: label.fullName,
    });
  }
  if (isHead && current.length === 0) {
    current.push({
      key: 'HEAD',
      icon: 'head',
      tone: 'head',
      text: S.graph.headBadge,
      current: false,
      dragName: null,
      title: S.graph.headBadge,
    });
  }
  return [...current, ...others];
}

/** 라벨 글자 하나의 평균 폭 (px, 12px 글꼴 기준 어림값) */
const LABEL_CHAR_PX = 6.5;
/** 라벨 하나의 글자 밖 폭(아이콘·간격)을 글자 수로 친 값 */
const LABEL_CHROME_CHARS = 4;
/** 제목 칸 폭을 아직 모를 때 쓰는 글자 수 예산 */
export const DEFAULT_REF_LABEL_BUDGET = 40;

/** 폭이 넓은 글자(한글·한자 등)는 두 칸으로 센 글자 수 */
function textWidthChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  }
  return n;
}

/**
 * 제목 칸 폭(px)에서 라벨 영역의 글자 수 예산을 낸다. 라벨 영역의 상한은 제목 칸의 절반이다.
 * 실제 글자 폭을 재지 않는 어림값이라, 넘치는 경우는 CSS(영역 상한 + 말줄임)가 막는다
 */
export function refLabelBudget(subjectWidth: number): number {
  return subjectWidth > 0 ? Math.floor(subjectWidth / 2 / LABEL_CHAR_PX) : DEFAULT_REF_LABEL_BUDGET;
}

/** 접은 결과: 보이는 라벨과 `+N` 뒤로 접힌 라벨 */
export interface FoldedRefLabels {
  shown: RefLabelItem[];
  hidden: RefLabelItem[];
}

/**
 * 글자 수 예산 안에 드는 앞쪽 라벨만 남기고 나머지를 접는다. 첫 라벨은 예산을 넘어도 남긴다
 * (라벨이 있는 행에서 아무것도 안 보이는 일은 없다). 순서를 지키려고 중간 라벨을 건너뛰지 않는다
 */
export function foldRefLabels(items: readonly RefLabelItem[], budget: number): FoldedRefLabels {
  let used = 0;
  let count = 0;
  for (const item of items) {
    used += textWidthChars(item.text) + LABEL_CHROME_CHARS;
    if (count > 0 && used > budget) {
      break;
    }
    count += 1;
  }
  return { shown: items.slice(0, count), hidden: items.slice(count) };
}
