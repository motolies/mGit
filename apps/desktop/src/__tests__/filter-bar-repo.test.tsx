import type { GraphQuery } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterBar, type FilterBarProps } from '../features/filter-bar/FilterBar';
import { withRevs, withText } from '../features/filter-bar/filter-model';
import { DEFAULT_GRAPH_QUERY } from '../store';

// 공용 필터 바에 W26 이 더한 선택 props (저장소 탭이 쓴다): 경로 범위 드롭다운, branch 의 "목록에 없는 ref" 묶음과
// "ref 이름 입력…", 보기 옵션의 점, 도구 단추, 잠금. 주지 않으면 지금 그대로다 (폴더 시험 `filter-bar-view` 가 지킨다)

const Q: GraphQuery = DEFAULT_GRAPH_QUERY;

/** 필터 바를 스토어처럼 감싼다: 적용한 질의를 바로 반영하고 기록한다 */
function Harness({
  initial,
  calls,
  props,
}: {
  initial: GraphQuery;
  calls: GraphQuery[];
  props: Partial<FilterBarProps>;
}) {
  const [query, setQuery] = useState(initial);
  return (
    <FilterBar
      query={query}
      onQueryChange={(q) => {
        calls.push(q);
        setQuery(q);
      }}
      capabilities={{ repoScope: false, pathScope: true }}
      branches={{
        options: [
          { name: 'main', remote: false, current: true },
          { name: 'origin/main', remote: true, current: false },
        ],
        headAvailable: true,
        missingSection: S.filterBar.otherRefs,
      }}
      authors={{ state: 'ready', list: null, error: null, load: () => {} }}
      textError={null}
      onTextEdit={() => {}}
      {...props}
    />
  );
}

/** 그리고 기록을 돌려준다 */
function setup(initial: GraphQuery = Q, props: Partial<FilterBarProps> = {}) {
  const calls: GraphQuery[] = [];
  render(<Harness initial={initial} calls={calls} props={props} />);
  return { calls, last: () => calls.at(-1) };
}

/** 드롭다운 단추 (요약 글자로 시작하는 이름) */
const dropButton = (name: string) =>
  screen
    .getAllByRole<HTMLButtonElement>('button')
    .find(
      (b) => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent?.startsWith(name),
    ) as HTMLButtonElement;
const popover = () => screen.queryByRole('dialog');
const esc = () =>
  act(() => {
    fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
  });

afterEach(cleanup);

describe('경로 범위 드롭다운 (옛 경로 입력, W26)', () => {
  it('쉼표로 여럿을 적고 Enter 로 적용·닫는다 (앞뒤 공백·빈 항목 버림). 단추는 "경로: 첫 값 +N", × 로 전부 푼다', () => {
    const { calls, last } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.path)));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: S.filterBar.path });
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe(S.graph.filter.pathPlaceholder);
    expect(popover()?.textContent).toContain(S.filterBar.pathNote);
    act(() => fireEvent.change(input, { target: { value: ' src ,  docs, ' } }));
    // 한글 조합 중의 Enter 는 입력기 몫
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    });
    expect(calls).toHaveLength(0);
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(popover()).toBeNull();
    expect(last()?.pathScope).toEqual(['src', 'docs']);
    expect(dropButton(S.filterBar.path).textContent).toBe('경로: src +1');
    expect(dropButton(S.filterBar.path).title).toBe('경로: src, docs');
    // 다시 열면 입력란이 지금 값이다. 바꾸지 않고 닫으면 부르지 않는다
    act(() => fireEvent.click(dropButton(S.filterBar.path)));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: S.filterBar.path }).value).toBe(
      'src, docs',
    );
    esc();
    expect(calls).toHaveLength(1);
    // × = 전부 풀기
    act(() =>
      fireEvent.click(
        screen.getByRole('button', { name: S.filterBar.clearCondition('경로: src +1') }),
      ),
    );
    expect(last()?.pathScope).toEqual([]);
  });

  it('입력을 고친 채 바깥을 눌러 닫아도 적용한다 (다른 드롭다운의 "닫기 = 적용"과 같다). 빈 입력 = 범위 없음', () => {
    const { last } = setup({ ...Q, pathScope: ['src'] });
    act(() => fireEvent.click(dropButton(S.filterBar.path)));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: S.filterBar.path });
    act(() => fireEvent.change(input, { target: { value: '' } }));
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(last()?.pathScope).toEqual([]);
  });

  it('보일 이름: 모듈 범위로 건 경로는 모듈 이름과 경로 툴팁. 능력 플래그가 없으면(폴더) 경로 드롭다운이 없다', () => {
    setup(
      { ...Q, pathScope: ['src/features/cart'] },
      {
        describePath: (p) => ({ label: 'cart', title: S.filterBar.pathModule(p) }),
      },
    );
    expect(dropButton(S.filterBar.path).textContent).toBe('경로: cart');
    expect(dropButton(S.filterBar.path).title).toBe(
      `경로: ${S.filterBar.pathModule('src/features/cart')}`,
    );
    cleanup();
    setup(Q, { capabilities: { repoScope: false } });
    expect(dropButton(S.filterBar.path)).toBeUndefined();
  });
});

describe('branch 드롭다운의 저장소 탭 몫 (W26)', () => {
  it('목록에 없는 이름(태그 등)은 "목록에 없는 ref" 묶음으로 맨 앞에 보이고 풀 수 있다', () => {
    const { last } = setup(withRevs(Q, { kind: 'solo', name: 'v1.0' }));
    expect(dropButton(S.filterBar.branch).textContent).toBe('브랜치: v1.0');
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const list = within(popover() as HTMLElement);
    expect(list.getByText(S.filterBar.otherRefs)).toBeTruthy();
    const options = list.getAllByRole('option');
    expect(options[0]?.textContent).toBe('v1.0');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.click(options[0] as HTMLElement));
    esc();
    expect(last()?.revs).toEqual({ kind: 'all' });
  });

  it('"ref 이름 입력…": 팝오버를 닫고(초안은 적용하지 않는다) 그때의 초안을 적용할 순서로 넘긴다. 포커스는 단추로', () => {
    const onEdit = vi.fn();
    const { calls } = setup(withRevs(Q, { kind: 'solo', name: 'v1.0' }), {
      branches: {
        options: [
          { name: 'main', remote: false, current: true },
          { name: 'origin/main', remote: true, current: false },
        ],
        headAvailable: true,
        missingSection: S.filterBar.otherRefs,
        custom: { label: S.filterBar.customRefs, onEdit },
      },
    });
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const list = within(popover() as HTMLElement);
    act(() =>
      fireEvent.click(
        list.getAllByRole('option').find((o) => o.textContent === 'origin/main') as HTMLElement,
      ),
    );
    act(() => fireEvent.click(list.getByRole('button', { name: S.filterBar.customRefs })));
    expect(popover()).toBeNull();
    expect(onEdit).toHaveBeenCalledWith(['v1.0', 'origin/main']);
    expect(calls).toHaveLength(0);
    expect(document.activeElement).toBe(dropButton(S.filterBar.branch));
    // 다음에 열고 닫으면 다시 "닫기 = 적용"이다
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    act(() =>
      fireEvent.click(
        within(popover() as HTMLElement)
          .getAllByRole('option')
          .find((o) => o.textContent?.startsWith('main')) as HTMLElement,
      ),
    );
    esc();
    expect(calls.at(-1)?.revs).toEqual({ kind: 'branches', names: ['v1.0', 'main'] });
  });

  it('열 때 목록을 새로 읽게 한다 (onOpen)', () => {
    const onOpen = vi.fn();
    setup(Q, {
      branches: { options: [], headAvailable: false, onOpen },
    });
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('보기 옵션의 점·도구 단추 (W26)', () => {
  it('기본값이 아닌 보기 옵션이 있으면 단추에 점(data-changed)과 이름·툴팁에 그 옵션들', () => {
    setup(Q, {
      viewOptions: [{ kind: 'item', label: 'x', onSelect: () => {} }],
      viewOptionsChanged: ['날짜순', '머지 제외'],
    });
    const button = screen.getByRole('button', {
      name: S.filterBar.viewOptionsChanged('날짜순 · 머지 제외'),
    });
    expect(button.getAttribute('data-changed')).toBe('true');
    expect(button.title).toBe('보기 옵션 — 날짜순 · 머지 제외');
    cleanup();
    setup(Q, { viewOptions: [{ kind: 'item', label: 'x', onSelect: () => {} }] });
    expect(
      screen.getByRole('button', { name: S.filterBar.viewOptions }).hasAttribute('data-changed'),
    ).toBe(false);
  });

  it('도구 단추: 상태 글자 뒤·보기 옵션 앞에 아이콘 단추로, 눌림 상태는 aria-pressed', () => {
    const onClick = vi.fn();
    setup(Q, {
      status: '커밋 3개',
      viewOptions: [{ kind: 'item', label: 'x', onSelect: () => {} }],
      tools: [
        {
          key: 'find',
          icon: 'findInLog',
          label: S.filterBar.find,
          title: '찾기 (⌘F)',
          pressed: true,
          onClick,
        },
      ],
    });
    const find = screen.getByRole('button', { name: S.filterBar.find });
    expect(find.getAttribute('aria-pressed')).toBe('true');
    expect(find.title).toBe('찾기 (⌘F)');
    act(() => fireEvent.click(find));
    expect(onClick).toHaveBeenCalledTimes(1);
    // DOM 순서(= Tab 순서): 상태 → 찾기 → 보기 옵션
    const status = document.querySelector('[data-filter-bar] [aria-live]') as HTMLElement;
    const view = screen.getByRole('button', { name: S.filterBar.viewOptions });
    expect(status.textContent).toBe('커밋 3개');
    expect(status.compareDocumentPosition(find) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(find.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('잠금 (쓰기 진행 중, W26)', () => {
  it('질의를 바꾸는 조작이 aria-disabled 가 되고 눌러도 바뀌지 않는다. 포커스는 남고 텍스트 칸에는 적을 수 있다', () => {
    const q = withText(withRevs(Q, { kind: 'solo', name: 'main' }), {
      pattern: 'fix',
      regex: false,
      matchCase: false,
    });
    const { calls } = setup(q, { locked: true });
    const branch = dropButton(S.filterBar.branch);
    expect(branch.getAttribute('aria-disabled')).toBe('true');
    expect(branch.title).toContain(S.filterBar.locked);
    branch.focus();
    act(() => fireEvent.click(branch));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(branch);
    for (const name of [S.filterBar.author, S.filterBar.date, S.filterBar.path]) {
      expect(dropButton(name).getAttribute('aria-disabled')).toBe('true');
    }
    act(() =>
      fireEvent.click(
        screen.getByRole('button', { name: S.filterBar.clearCondition('브랜치: main') }),
      ),
    );
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.clearAll })));
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.regex })));
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.clearText })));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: S.filterBar.textLabel });
    act(() => fireEvent.change(input, { target: { value: 'feat' } }));
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input.value).toBe('feat');
    expect(screen.getByTestId('filter-pending')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
