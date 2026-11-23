import type { RefKind, RefLabel } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REF_LABEL_BUDGET,
  foldRefLabels,
  type RefLabelItem,
  refLabelBudget,
  refLabelItems,
} from '../ref-labels';

/** ref 라벨 하나 */
function label(fullName: string, shortName: string, kind: RefKind, isCurrent = false): RefLabel {
  return {
    fullName,
    shortName,
    kind,
    target: 'a'.repeat(40),
    isCurrent,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    worktreePath: null,
  };
}
const local = (name: string, isCurrent = false) =>
  label(`refs/heads/${name}`, name, { kind: 'localBranch' }, isCurrent);
const remote = (name: string, branch: string) =>
  label(`refs/remotes/${name}/${branch}`, `${name}/${branch}`, {
    kind: 'remoteBranch',
    remote: name,
  });
const tag = (name: string) => label(`refs/tags/${name}`, name, { kind: 'tag', annotated: true });

/** 보이는 글자만 */
const texts = (items: readonly RefLabelItem[]) => items.map((i) => i.text);

describe('ref 라벨 묶기 (LG-03)', () => {
  it('같은 커밋의 로컬 브랜치와 같은 이름의 원격 브랜치를 한 라벨로 묶는다', () => {
    const items = refLabelItems([local('development'), remote('origin', 'development')], false);
    expect(texts(items)).toEqual(['origin & development']);
    expect(items[0]).toMatchObject({ icon: 'branch', tone: 'local', current: false });
    // 툴팁에는 묶인 두 ref 의 전체 이름이 모두 있다
    expect(items[0]?.title).toBe('refs/heads/development\nrefs/remotes/origin/development');
  });

  it('받은 순서와 무관하게 묶는다 (원격이 먼저 와도)', () => {
    const items = refLabelItems([remote('origin', 'main'), local('main')], false);
    expect(texts(items)).toEqual(['origin & main']);
  });

  it('슬래시가 든 브랜치 이름도 원격 이름만 떼고 비교한다', () => {
    const items = refLabelItems(
      [local('feature/login-rate-limit'), remote('origin', 'feature/login-rate-limit')],
      false,
    );
    expect(texts(items)).toEqual(['origin & feature/login-rate-limit']);
  });

  it('이름이 다른 원격 브랜치는 묶지 않고 따로 둔다', () => {
    const items = refLabelItems([local('main'), remote('origin', 'release/1.0')], false);
    expect(texts(items)).toEqual(['main', 'origin/release/1.0']);
    expect(items[1]).toMatchObject({ icon: 'remote', tone: 'remote' });
  });

  it('같은 이름이 여러 원격에 있으면 어느 쪽과도 묶지 않는다 (a & b & x 꼴을 만들지 않는다)', () => {
    const items = refLabelItems(
      [local('development'), remote('origin', 'development'), remote('upstream', 'development')],
      false,
    );
    expect(texts(items)).toEqual(['development', 'origin/development', 'upstream/development']);
  });

  it('짝이 되는 원격이 하나면 묶고, 다른 이름의 원격 브랜치는 따로 남긴다', () => {
    const items = refLabelItems(
      [local('main'), remote('origin', 'main'), remote('upstream', 'stable')],
      false,
    );
    expect(texts(items)).toEqual(['origin & main', 'upstream/stable']);
  });

  it('HEAD 가 가리키는 브랜치는 그 라벨이 HEAD 표시를 겸하고 맨 앞에 온다', () => {
    const items = refLabelItems(
      [local('staging'), local('development', true), remote('origin', 'development')],
      true,
    );
    expect(texts(items)).toEqual(['origin & development', 'staging']);
    expect(items[0]).toMatchObject({ icon: 'head', tone: 'head', current: true });
    // 따로 HEAD 라벨을 더하지 않는다
    expect(texts(items)).not.toContain('HEAD');
  });

  it('분리 HEAD 면 HEAD 라벨을 맨 앞에 따로 둔다', () => {
    const items = refLabelItems([remote('origin', 'release/2026.11')], true);
    expect(texts(items)).toEqual(['HEAD', 'origin/release/2026.11']);
    expect(items[0]).toMatchObject({ icon: 'head', tone: 'head', current: false, dragName: null });
  });

  it('ref 가 없는 HEAD 행도 HEAD 라벨 하나를 갖는다. HEAD 가 아니면 라벨이 없다', () => {
    expect(texts(refLabelItems([], true))).toEqual(['HEAD']);
    expect(refLabelItems([], false)).toEqual([]);
  });

  it('순서는 현재 브랜치 → 로컬 → 묶이지 않은 원격 → 태그', () => {
    const items = refLabelItems(
      [tag('v1.0'), remote('origin', 'hotfix'), local('main', true), local('staging')],
      true,
    );
    expect(texts(items)).toEqual(['main', 'staging', 'origin/hotfix', 'v1.0']);
    expect(items[3]).toMatchObject({ icon: 'tag', tone: 'tag' });
  });

  it('끌 때 넘기는 이름: 묶인 라벨·로컬은 로컬 브랜치, 원격만이면 원격, 태그·HEAD 는 못 끈다 (GRAPH-09)', () => {
    const items = refLabelItems(
      [local('development'), remote('origin', 'development'), remote('origin', 'only'), tag('v1')],
      false,
    );
    expect(items.map((i) => [i.text, i.dragName])).toEqual([
      ['origin & development', 'development'],
      ['origin/only', 'origin/only'],
      ['v1', null],
    ]);
  });
});

describe('ref 라벨 접기 (+N, LG-03)', () => {
  /** 글자만 다른 라벨 */
  const item = (text: string): RefLabelItem => ({
    key: text,
    icon: 'branch',
    tone: 'local',
    text,
    current: false,
    dragName: text,
    title: text,
  });
  /** 접은 결과를 [보이는 글자들, 접힌 개수] 로 */
  const fold = (names: string[], budget: number) => {
    const { shown, hidden } = foldRefLabels(names.map(item), budget);
    return [texts(shown), hidden.length];
  };

  it('예산 안에 다 들면 접지 않는다', () => {
    // 글자 4 + 6 에 라벨마다 아이콘·간격 몫 4 → 18
    expect(fold(['main', 'v1.2.3'], 18)).toEqual([['main', 'v1.2.3'], 0]);
  });

  it('예산을 넘는 라벨부터 뒤는 모두 접는다', () => {
    expect(fold(['main', 'v1.2.3'], 17)).toEqual([['main'], 1]);
    expect(fold(['main', 'staging', 'v1', 'v2'], 20)).toEqual([['main', 'staging'], 2]);
  });

  it('첫 라벨은 예산을 넘어도 남긴다', () => {
    expect(fold(['origin & feature/very-long-branch-name', 'v1'], 5)).toEqual([
      ['origin & feature/very-long-branch-name'],
      1,
    ]);
  });

  it('순서를 지킨다: 뒤에 짧은 라벨이 있어도 중간을 건너뛰어 끼워 넣지 않는다', () => {
    expect(fold(['main', 'feature/a-rather-long-name', 'v1'], 16)).toEqual([['main'], 2]);
  });

  it('한글처럼 폭이 넓은 글자는 두 칸으로 센다', () => {
    // '배포' 는 4칸 + 4 = 8, 'ab' 는 2칸 + 4 = 6
    expect(fold(['배포', 'ab'], 14)).toEqual([['배포', 'ab'], 0]);
    expect(fold(['배포', 'ab'], 13)).toEqual([['배포'], 1]);
  });

  it('라벨이 없으면 빈 결과다', () => {
    expect(foldRefLabels([], 10)).toEqual({ shown: [], hidden: [] });
  });
});

describe('라벨 영역의 예산 (LG-03)', () => {
  it('제목 칸 폭의 절반을 글자 수로 바꾼다', () => {
    // 220px 의 절반 110px ÷ 6.5px
    expect(refLabelBudget(220)).toBe(16);
    expect(refLabelBudget(520)).toBe(40);
  });

  it('폭을 모르면 기본 예산을 쓴다', () => {
    expect(refLabelBudget(0)).toBe(DEFAULT_REF_LABEL_BUDGET);
  });
});
