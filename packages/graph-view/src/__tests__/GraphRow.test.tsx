import type { GraphRow, RefKind, RefLabel } from '@mgit/ipc';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRAPH_COLUMNS, GraphRowView, type GraphRowViewProps } from '../GraphRow';
import { REF_DRAG_TYPE } from '../ref-drag';

afterEach(cleanup);

const OID = 'ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901';
/** 상대 날짜의 기준 시각 (로컬 2026-11-18 14:50) */
const NOW = new Date(2026, 10, 18, 14, 50).getTime();

/** ref 라벨 하나 */
function label(fullName: string, shortName: string, kind: RefKind, isCurrent = false): RefLabel {
  return {
    fullName,
    shortName,
    kind,
    target: OID,
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

/** 그래프 행 하나 */
function graphRow(partial: Partial<GraphRow> = {}): GraphRow {
  return {
    row: 0,
    oid: OID,
    parents: [],
    authorName: '한도윤',
    authorEmail: 'doyun.han@example.com',
    authorTime: (NOW - 7 * 60_000) / 1000,
    commitTime: (NOW - 7 * 60_000) / 1000,
    subject: 'feat: 주문 목록에 기간 필터 추가',
    lane: 0,
    color: 0,
    refs: [],
    isHead: false,
    inHead: true,
    repo: null,
    ...partial,
  };
}

/** 행 하나를 그린다 */
function renderRow(props: Partial<GraphRowViewProps> & { row: GraphRow }) {
  const view = render(
    <GraphRowView
      index={props.row.row}
      graphColumnWidth={60}
      rowHeight={24}
      offsetTop={0}
      selected={false}
      now={NOW}
      {...props}
    />,
  );
  const el = view.container.querySelector<HTMLElement>(`[data-row="${props.row.row}"]`);
  if (!el) {
    throw new Error('행이 그려지지 않았습니다');
  }
  return { ...view, el };
}

/** 끌어 놓기에 쓰는 가짜 dataTransfer */
function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
    effectAllowed: 'none',
    dropEffect: 'none',
  };
}

/** 글자가 `text` 인 라벨 요소 (끌 수 있는지는 draggable 속성으로 본다) */
function labelOf(root: HTMLElement, text: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('[data-tone]')].find((el) =>
    el.textContent?.endsWith(text),
  );
  if (!found) {
    throw new Error(`라벨이 없습니다: ${text}`);
  }
  return found;
}

describe('로그 행의 칸 (LG-01)', () => {
  it('제목 → 작성자 → 날짜 → 해시 순서이고, 해시는 8자, 날짜는 상대 표현이다', () => {
    const { el } = renderRow({ row: graphRow() });
    const cells = [...el.children].map((c) => c.textContent);
    // 맨 앞은 그래프 자리(빈 칸)
    expect(cells).toEqual(['', 'feat: 주문 목록에 기간 필터 추가', '한도윤', '7분 전', 'ba53f33a']);
    // 전체 해시는 툴팁에 있다
    expect(el.lastElementChild?.getAttribute('title')).toBe(OID);
  });

  it('저장소 띠는 그래프 앞의 첫 칸이고, 이름 글자는 시킬 때만 쓴다 (LG-02)', () => {
    const columns = { ...DEFAULT_GRAPH_COLUMNS, repo: true };
    const repoOf = () => ({ name: 'api-gateway', color: 3 });
    const named = renderRow({ row: graphRow({ repo: 0 }), columns, repoOf, showRepoName: true });
    const strip = named.el.firstElementChild as HTMLElement;
    expect(strip.textContent).toBe('api-gateway');
    // 색은 데이터가 준 번호의 레인 토큰이다 (LF-09)
    expect(strip.style.getPropertyValue('--repo-color')).toBe('var(--graph-lane-3)');
    cleanup();

    const plain = renderRow({ row: graphRow({ repo: 0 }), columns, repoOf, showRepoName: false });
    const quiet = plain.el.firstElementChild as HTMLElement;
    expect(quiet.textContent).toBe('');
    // 글자가 없는 행에서도 툴팁으로는 저장소를 알 수 있다
    expect(quiet.getAttribute('title')).toBe('api-gateway');
    expect(quiet.style.getPropertyValue('--repo-color')).toBe('var(--graph-lane-3)');
  });

  it('띠 열을 켜지 않으면 띠 칸이 없다 (단일 저장소)', () => {
    const { el } = renderRow({
      row: graphRow({ repo: 0 }),
      repoOf: () => ({ name: 'api-gateway', color: 3 }),
      showRepoName: true,
    });
    expect(el.children).toHaveLength(5);
    expect(el.textContent).not.toContain('api-gateway');
  });
});

describe('로그 행의 ref 라벨 (LG-03)', () => {
  it('제목 뒤(칸의 오른쪽)에 놓이고 로컬·원격 짝은 한 라벨이다', () => {
    const { el } = renderRow({
      row: graphRow({ refs: [local('development'), remote('origin', 'development')] }),
    });
    const message = el.children[1] as HTMLElement;
    expect(message.firstElementChild?.textContent).toBe('feat: 주문 목록에 기간 필터 추가');
    expect(message.lastElementChild?.textContent).toBe('origin & development');
    expect(el.querySelectorAll('[data-tone]')).toHaveLength(1);
  });

  it('현재 브랜치 라벨은 HEAD 를 겸한다: 아이콘은 숨은 장식이라 글자로도 HEAD 를 남긴다', () => {
    const { el } = renderRow({
      row: graphRow({ isHead: true, refs: [local('main', true), remote('origin', 'main')] }),
    });
    const head = labelOf(el, 'origin & main');
    expect(head.getAttribute('data-tone')).toBe('head');
    expect(head.textContent).toBe('HEAD origin & main');
    expect(head.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('예산을 넘는 라벨은 +N 으로 접고 툴팁에 전체를 보인다', () => {
    const { el } = renderRow({
      row: graphRow({ refs: [local('main'), local('staging'), tag('v1.0'), tag('v1.1')] }),
      labelBudget: 20,
    });
    expect([...el.querySelectorAll('[data-tone]')].map((l) => l.textContent)).toEqual([
      'main',
      'staging',
    ]);
    const more = [...el.querySelectorAll('span')].find((s) => s.textContent === '+2');
    expect(more?.getAttribute('title')).toBe('main\nstaging\nv1.0\nv1.1');
  });
});

describe('브랜치 라벨 끌어 놓기 (GRAPH-09)', () => {
  it('묶인 라벨을 끌면 로컬 브랜치 이름이 실린다', () => {
    const { el } = renderRow({
      row: graphRow({ refs: [local('development'), remote('origin', 'development')] }),
    });
    const dragged = labelOf(el, 'origin & development');
    expect(dragged.getAttribute('draggable')).toBe('true');
    const dt = transfer();
    fireEvent.dragStart(dragged, { dataTransfer: dt });
    expect(dt.data.get(REF_DRAG_TYPE)).toBe('development');
    expect(dt.data.get('text/plain')).toBe('development');
    expect(dt.effectAllowed).toBe('link');
  });

  it('원격만 있는 라벨을 끌면 원격 브랜치 이름이 실린다', () => {
    const { el } = renderRow({ row: graphRow({ refs: [remote('origin', 'release/1.0')] }) });
    const dt = transfer();
    fireEvent.dragStart(labelOf(el, 'origin/release/1.0'), { dataTransfer: dt });
    expect(dt.data.get(REF_DRAG_TYPE)).toBe('origin/release/1.0');
  });

  it('태그와 분리 HEAD 라벨은 끌 수 없다', () => {
    const { el } = renderRow({ row: graphRow({ isHead: true, refs: [tag('v1.0')] }) });
    for (const text of ['HEAD', 'v1.0']) {
      const target = labelOf(el, text);
      expect(target.getAttribute('draggable')).toBe('false');
      const dt = transfer();
      fireEvent.dragStart(target, { dataTransfer: dt });
      expect(dt.data.size).toBe(0);
    }
  });

  it('끌어 온 브랜치를 다른 행에 놓으면 그 이름과 놓인 행을 알린다', () => {
    const onDropRef = vi.fn();
    const source = renderRow({
      row: graphRow({ refs: [local('development'), remote('origin', 'development')] }),
    });
    const dt = transfer();
    fireEvent.dragStart(labelOf(source.el, 'origin & development'), { dataTransfer: dt });
    cleanup();

    const targetRow = graphRow({ row: 7, oid: 'c'.repeat(40) });
    const target = renderRow({ row: targetRow, onDropRef });
    // 브랜치를 끌고 있을 때만 놓을 수 있는 자리로 표시한다
    expect(fireEvent.dragOver(target.el, { dataTransfer: dt })).toBe(false);
    expect(fireEvent.dragOver(target.el, { dataTransfer: transfer() })).toBe(true);
    fireEvent.drop(target.el, { dataTransfer: dt });
    expect(onDropRef).toHaveBeenCalledTimes(1);
    expect(onDropRef).toHaveBeenCalledWith('development', targetRow);
  });

  it('놓기를 받지 않는 그래프(통합 타임라인)에서는 놓아도 아무 일이 없다', () => {
    const { el } = renderRow({ row: graphRow() });
    const dt = transfer();
    dt.setData(REF_DRAG_TYPE, 'development');
    expect(fireEvent.dragOver(el, { dataTransfer: dt })).toBe(true);
    expect(fireEvent.drop(el, { dataTransfer: dt })).toBe(true);
  });
});
