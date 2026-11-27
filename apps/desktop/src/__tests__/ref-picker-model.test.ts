// 비교 화면 ref 선택 칸의 순수 모델 (F4): 값 보이기·묶음 순서·검색·상한
import type { HeadState, RefLabel } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import {
  describeRef,
  filterRefSections,
  looksLikeRevision,
  refSections,
  splitRefName,
} from '../features/history/ref-picker-model';

/** 전체 이름에서 짧은 이름을 만든다 (`refs/heads/`·`refs/remotes/`·`refs/tags/` 를 뗀다) */
function short(fullName: string): string {
  return fullName.replace(/^refs\/(heads|remotes|tags)\//, '').replace(/^refs\//, '');
}

/** 시험용 ref 라벨 */
function label(fullName: string, current = false): RefLabel {
  const kind: RefLabel['kind'] = fullName.startsWith('refs/heads/')
    ? { kind: 'localBranch' }
    : fullName.startsWith('refs/remotes/')
      ? { kind: 'remoteBranch', remote: short(fullName).split('/')[0] ?? '' }
      : fullName.startsWith('refs/tags/')
        ? { kind: 'tag', annotated: false }
        : { kind: 'stash' };
  return {
    fullName,
    shortName: short(fullName),
    kind,
    target: 'a'.repeat(40),
    isCurrent: current,
    upstreamGone: false,
  };
}

const attached: HeadState = { state: 'attached', branch: 'main', oid: 'b'.repeat(40) };
const refs = {
  head: attached,
  labels: [
    label('refs/heads/zeta'),
    label('refs/heads/main', true),
    label('refs/heads/feat/multirepo-editor-batch1'),
    label('refs/remotes/origin/main'),
    label('refs/remotes/origin/feat/x'),
    label('refs/tags/v1.0.0'),
    label('refs/tags/v2.0.0'),
    label('refs/stash'),
  ],
};
const local = { value: '@LOCAL', label: '현재 로컬 내용', detail: '저장하지 않은 변경 포함' };

describe('describeRef', () => {
  it('특수 값·전체 이름·접두·HEAD 를 종류와 짧은 이름으로 보인다', () => {
    expect(describeRef('@LOCAL', refs, local)).toMatchObject({
      kind: 'workingTree',
      name: '현재 로컬 내용',
    });
    expect(describeRef('refs/heads/zeta', refs)).toMatchObject({
      kind: 'local',
      name: 'zeta',
      title: 'refs/heads/zeta',
      mono: false,
    });
    expect(describeRef('refs/heads/main', refs)).toMatchObject({ kind: 'head', current: true });
    expect(describeRef('refs/remotes/origin/main', refs)).toMatchObject({
      kind: 'remote',
      name: 'origin/main',
    });
    expect(describeRef('refs/tags/v1.0.0', refs)).toMatchObject({ kind: 'tag', name: 'v1.0.0' });
    expect(describeRef('refs/heads/gone', refs)).toMatchObject({
      kind: 'local',
      name: 'gone',
      title: 'refs/heads/gone',
    });
    expect(describeRef('HEAD', refs)).toMatchObject({ kind: 'head', name: 'HEAD', detail: 'main' });
    expect(
      describeRef('HEAD', { ...refs, head: { state: 'detached', oid: 'c'.repeat(40) } }),
    ).toMatchObject({ detail: 'cccccccc' });
  });

  it('짧은 이름은 그 ref 로, 브랜치·태그가 같은 이름이면 태그를 고르고 알린다', () => {
    expect(describeRef('zeta', refs)).toMatchObject({ kind: 'local', title: 'refs/heads/zeta' });
    expect(describeRef('zeta', refs).ambiguous).toBeUndefined();
    const twin = { ...refs, labels: [...refs.labels, label('refs/tags/zeta')] };
    const d = describeRef('zeta', twin);
    expect(d.kind).toBe('tag');
    expect(d.ambiguous).toBe('refs/tags/zeta');
    expect(d.title).toContain('refs/tags/zeta');
  });

  it('해시는 8자 고정폭, 그 밖의 식은 입력한 그대로 고정폭으로 보인다', () => {
    expect(describeRef('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', refs)).toMatchObject({
      kind: 'commit',
      name: 'a1b2c3d4',
      mono: true,
    });
    expect(describeRef('abc1234', refs)).toMatchObject({ kind: 'commit', name: 'abc1234' });
    expect(describeRef('HEAD~3', refs)).toMatchObject({
      kind: 'expression',
      name: 'HEAD~3',
      mono: true,
    });
  });

  it('ref 목록이 비어 있으면 전체 이름의 접두로 종류를 어림한다', () => {
    const empty = { head: attached, labels: [] };
    expect(describeRef('refs/remotes/origin/main', empty)).toMatchObject({
      kind: 'remote',
      name: 'origin/main',
    });
    expect(describeRef('main', empty)).toMatchObject({ kind: 'expression' });
  });
});

describe('refSections', () => {
  it('특수 줄 → 로컬(현재 먼저, 이름순) → 원격(이름순) → 태그(역순), stash 는 빠진다', () => {
    const sections = refSections(refs, local);
    expect(sections.map((s) => [s.id, s.options.map((o) => o.value)])).toEqual([
      ['special', ['@LOCAL', 'HEAD']],
      ['local', ['refs/heads/main', 'refs/heads/feat/multirepo-editor-batch1', 'refs/heads/zeta']],
      ['remote', ['refs/remotes/origin/feat/x', 'refs/remotes/origin/main']],
      ['tags', ['refs/tags/v2.0.0', 'refs/tags/v1.0.0']],
    ]);
    expect(sections.flatMap((s) => s.options).some((o) => o.value === 'refs/stash')).toBe(false);
  });

  it('현재 로컬 내용은 줄 때만, HEAD 는 커밋이 있을 때만 둔다', () => {
    const unborn = { head: { state: 'unborn', branch: 'main' } as HeadState, labels: [] };
    expect(refSections(unborn)[0]?.options).toEqual([]);
    expect(refSections(refs)[0]?.options.map((o) => o.value)).toEqual(['HEAD']);
  });
});

describe('filterRefSections', () => {
  const sections = refSections(refs, local);

  it('묶음을 유지하고 부분 일치를 퍼지 일치보다 앞에 두며 빈 묶음은 뺀다', () => {
    const many = refSections({
      head: attached,
      labels: [label('refs/heads/m-a-i-n'), label('refs/heads/main-2'), label('refs/tags/v1')],
    });
    const result = filterRefSections(many, 'main');
    expect(result.sections.map((s) => s.id)).toEqual(['local']);
    expect(result.sections[0]?.options.map((o) => o.value)).toEqual([
      'refs/heads/main-2',
      'refs/heads/m-a-i-n',
    ]);
  });

  it('refs/ 로 시작하는 검색어는 전체 이름을 본다', () => {
    const result = filterRefSections(sections, 'refs/remotes/');
    expect(result.sections.map((s) => s.id)).toEqual(['remote']);
  });

  it('정확히 같은 이름이 있으면 "입력한 값 사용" 줄이 없고, 식이면 맨 위, 아니면 맨 아래다', () => {
    expect(filterRefSections(sections, 'zeta').typed).toBeNull();
    expect(filterRefSections(sections, 'refs/heads/zeta').typed).toBeNull();
    expect(filterRefSections(sections, 'HEAD').typed).toBeNull();
    expect(filterRefSections(sections, 'HEAD~3').typed).toEqual({ text: 'HEAD~3', first: true });
    expect(filterRefSections(sections, 'abc1234').typed).toEqual({ text: 'abc1234', first: true });
    expect(filterRefSections(sections, 'zet').typed).toEqual({ text: 'zet', first: false });
    expect(filterRefSections(sections, '  ').typed).toBeNull();
  });

  it('묶음 합쳐 200개까지만 남기고 나머지 수를 센다', () => {
    const big = refSections({
      head: attached,
      labels: Array.from({ length: 300 }, (_, i) =>
        label(`refs/heads/b-${String(i).padStart(3, '0')}`),
      ),
    });
    const result = filterRefSections(big, '');
    expect(result.sections.flatMap((s) => s.options)).toHaveLength(200);
    expect(result.hidden).toBe(101);
  });
});

describe('이름 나누기와 식 판정', () => {
  it('마지막 / 에서 나누고 / 가 없으면 하나로 둔다', () => {
    expect(splitRefName('origin/feat/multirepo-editor-batch1')).toEqual({
      head: 'origin/feat/',
      tail: 'multirepo-editor-batch1',
    });
    expect(splitRefName('main')).toEqual({ head: 'main', tail: '' });
    expect(splitRefName('a/')).toEqual({ head: 'a/', tail: '' });
  });

  it('해시와 ~ ^ @ : 가 든 식을 커밋·식으로 본다', () => {
    for (const text of ['abc1234', 'HEAD~3', 'main^2', 'main@{1}', 'HEAD:path'])
      expect(looksLikeRevision(text)).toBe(true);
    for (const text of ['main', 'feat/x', 'abc12', 'release-1.0'])
      expect(looksLikeRevision(text)).toBe(false);
  });
});
