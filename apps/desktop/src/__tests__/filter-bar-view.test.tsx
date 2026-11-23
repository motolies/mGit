import type { AuthorList, GraphQuery } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  type AuthorSource,
  FilterBar,
  type FilterBarProps,
} from '../features/filter-bar/FilterBar';
import {
  filterOf,
  quickRange,
  withAuthors,
  withDates,
  withRevs,
  withText,
} from '../features/filter-bar/filter-model';
import { DEFAULT_TIMELINE_QUERY } from '../store/folder-store';

const Q: GraphQuery = DEFAULT_TIMELINE_QUERY;
const NOW = new Date(2025, 9, 28, 15, 0);
const AUTHORS: AuthorList = {
  authors: [
    { name: '한도윤', email: 'doyun.han@example.com', commits: 30 },
    { name: '서하린', email: 'harin.seo@example.com', commits: 21 },
    { name: 'Jamie Park', email: 'jamie.park@example.com', commits: 9 },
  ],
  total: 3,
  truncated: false,
  timedOut: false,
};

interface HarnessOptions {
  initial?: GraphQuery;
  /** 이 질의를 거부하고 사유를 돌려준다 (코어의 잘못된 정규식 흉내: 질의는 이전 값으로 남는다) */
  reject?: (q: GraphQuery) => string | null;
  authors?: Partial<AuthorSource>;
  props?: Partial<FilterBarProps>;
  repoScope?: boolean;
}

/** 시험이 보는 기록: 적용한 질의·범위와 콜백 */
interface Records {
  calls: GraphQuery[];
  scopes: string[][];
  load: Mock<AuthorSource['load']>;
  onEscape: Mock<() => void>;
  onTextEdit: Mock<() => void>;
}

/** 필터 바를 스토어처럼 감싼다: 적용한 질의를 바로 반영하고(거부하면 그대로 두고 사유를 준다) 호출을 기록한다 */
function Harness({ opts, rec }: { opts: HarnessOptions; rec: Records }) {
  const [query, setQuery] = useState(opts.initial ?? Q);
  const [scope, setScope] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <FilterBar
      query={query}
      onQueryChange={(q) => {
        rec.calls.push(q);
        const why = opts.reject?.(q) ?? null;
        if (why === null) {
          setQuery(q);
        }
        setError(why);
      }}
      capabilities={{ repoScope: opts.repoScope ?? true }}
      repos={{
        options: [
          { path: '/r/api', name: 'api-gateway', color: 0 },
          { path: '/r/web', name: 'web-console', color: 1 },
          { path: '/r/infra', name: 'infra-scripts', color: 2, error: '요약 실패' },
        ],
        scope,
        onScopeChange: (paths) => {
          rec.scopes.push(paths);
          setScope(paths);
        },
      }}
      branches={{
        options: [
          { name: 'main', remote: false, current: true },
          { name: 'feature/x', remote: false, current: false },
          { name: 'origin/main', remote: true, current: false },
        ],
        headAvailable: true,
        headTitle: 'api: main',
      }}
      authors={{
        state: 'ready',
        list: AUTHORS,
        error: null,
        load: rec.load,
        ...opts.authors,
      }}
      textError={error}
      onTextEdit={() => {
        rec.onTextEdit();
        setError(null);
      }}
      onEscape={rec.onEscape}
      now={() => NOW}
      {...opts.props}
    />
  );
}

/** 필터 바를 그리고 기록을 돌려준다 */
function setup(opts: HarnessOptions = {}) {
  const rec: Records = {
    calls: [],
    scopes: [],
    load: vi.fn<AuthorSource['load']>(),
    onEscape: vi.fn(),
    onTextEdit: vi.fn(),
  };
  render(<Harness opts={opts} rec={rec} />);
  return { ...rec, last: () => rec.calls.at(-1) };
}

const input = () => screen.getByRole<HTMLInputElement>('textbox', { name: S.filterBar.textLabel });
const type = (value: string) => act(() => fireEvent.change(input(), { target: { value } }));
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(input(), { key: k, ...init });
  });
const toggle = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
/** 드롭다운 단추 (요약 글자로 시작하는 이름) */
const dropButton = (name: string) =>
  screen
    .getAllByRole<HTMLButtonElement>('button')
    .find(
      (b) => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent?.startsWith(name),
    ) as HTMLButtonElement;
const popover = () => screen.queryByRole('dialog');
const option = (label: string) =>
  within(popover() as HTMLElement)
    .getAllByRole('option')
    .find((o) => o.textContent?.includes(label)) as HTMLElement;

afterEach(cleanup);

describe('텍스트·해시 입력 (LG-06)', () => {
  it('Enter 로 적용하고, 입력할 때마다는 적용하지 않는다. 앞뒤 공백을 다듬는다', () => {
    const { calls, last } = setup();
    type('  fix: ');
    expect(calls).toHaveLength(0);
    key('Enter');
    expect(calls).toHaveLength(1);
    expect(filterOf(last() as GraphQuery).text).toEqual({
      pattern: 'fix:',
      regex: false,
      matchCase: false,
    });
    // 같은 값으로 다시 Enter 하면 다시 적용하지 않는다
    key('Enter');
    expect(calls).toHaveLength(1);
  });

  it('한글 입력기 조합 중의 Enter(isComposing·keyCode 229)는 적용하지 않는다', () => {
    const { calls } = setup();
    type('주문');
    key('Enter', { isComposing: true });
    key('Enter', { keyCode: 229 });
    expect(calls).toHaveLength(0);
    key('Enter');
    expect(calls).toHaveLength(1);
    expect(filterOf(calls[0] as GraphQuery).text.pattern).toBe('주문');
  });

  it('공백만 넣고 Enter 하면 조건 없음이다 (적용된 검색어가 있으면 풀린다)', () => {
    const { last } = setup({
      initial: withText(Q, { pattern: 'fix', regex: false, matchCase: false }),
    });
    expect(input().value).toBe('fix');
    type('   ');
    key('Enter');
    expect(filterOf(last() as GraphQuery).text.pattern).toBe('');
  });

  it('적용된 값과 입력 중인 값이 다르면 "적용 전" 이 보이고, 적용하면 사라진다', () => {
    setup();
    expect(screen.queryByTestId('filter-pending')).toBeNull();
    type('fix');
    expect(screen.getByTestId('filter-pending').textContent).toBe(S.filterBar.pending);
    key('Enter');
    expect(screen.queryByTestId('filter-pending')).toBeNull();
  });

  it('토글은 눌린 상태를 aria-pressed 로 보이고, 적용된 검색어가 있으면 바로 다시 적용한다', () => {
    const { calls, last } = setup();
    // 검색어가 없으면 토글만 바뀌고 적용하지 않는다
    act(() => fireEvent.click(toggle(S.filterBar.regex)));
    expect(toggle(S.filterBar.regex).getAttribute('aria-pressed')).toBe('true');
    expect(calls).toHaveLength(0);
    type('^(feat|fix):');
    key('Enter');
    expect(filterOf(last() as GraphQuery).text).toEqual({
      pattern: '^(feat|fix):',
      regex: true,
      matchCase: false,
    });
    act(() => fireEvent.click(toggle(S.filterBar.matchCase)));
    expect(toggle(S.filterBar.matchCase).getAttribute('aria-pressed')).toBe('true');
    expect(calls).toHaveLength(2);
    expect(filterOf(last() as GraphQuery).text.matchCase).toBe(true);
    // 정규식 토글의 툴팁에 문법을 적는다
    expect(toggle(S.filterBar.regex).getAttribute('title')).toContain('POSIX');
  });

  it('지우기 단추는 입력을 비우고 적용된 검색어를 푼다', () => {
    const { last } = setup({
      initial: withText(Q, { pattern: 'fix', regex: false, matchCase: false }),
    });
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.clearText })));
    expect(input().value).toBe('');
    expect(filterOf(last() as GraphQuery).text.pattern).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('검색어가 해시로 보이면(hex 7자 이상) 해시로도 찾는다는 표시가 보인다', () => {
    setup();
    type('a1b2c3');
    expect(screen.queryByTitle(S.filterBar.hashTitle('a1b2c3'))).toBeNull();
    type('A1B2C3D4');
    expect(screen.getByTitle(S.filterBar.hashTitle('a1b2c3d4')).textContent).toBe('#');
  });

  it('잘못된 정규식: 사유가 입력란 옆에 보이고 이전 질의가 그대로이며, 입력을 고치면 사유가 사라진다', () => {
    const { calls, onTextEdit } = setup({
      initial: withText(Q, { pattern: 'fix', regex: true, matchCase: false }),
      reject: (q) => (filterOf(q).text.pattern === '(' ? 'parentheses not balanced' : null),
    });
    type('(');
    key('Enter');
    expect(calls).toHaveLength(1);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('parentheses not balanced');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    // 입력은 사용자가 고칠 수 있게 그대로다 (되돌아간 질의로 덮지 않는다)
    expect(input().value).toBe('(');
    type('(a)');
    expect(onTextEdit).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Esc: 입력 중인 값이 다르면 적용된 값으로 되돌리고, 같으면 로그로 돌아간다(onEscape). 전역 Esc 로 가지 않는다', () => {
    const { onEscape } = setup({
      initial: withText(Q, { pattern: 'fix', regex: false, matchCase: false }),
    });
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    try {
      type('fix: 주문');
      key('Escape');
      expect(input().value).toBe('fix');
      expect(onEscape).not.toHaveBeenCalled();
      key('Escape');
      expect(onEscape).toHaveBeenCalledTimes(1);
      // 전역 키 처리(window)까지 가지 않는다 (미리보기 탭 닫기 등과 겹치지 않는다)
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });
});

describe('드롭다운 (LG-06)', () => {
  it('저장소 드롭다운: 열기·여러 개 체크는 닫을 때 한 번만 적용, Esc 로 닫으면 포커스가 단추로 돌아온다', () => {
    const { scopes } = setup();
    const button = dropButton(S.filterBar.repo);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => fireEvent.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(popover()).not.toBeNull();
    // 열면 검색 칸에 포커스, 모두 해제 = 전부라는 안내
    expect(document.activeElement?.getAttribute('role')).toBe('combobox');
    expect(popover()?.textContent).toContain(S.filterBar.repoNone);
    // 요약을 못 읽은 저장소도 목록에 있다
    expect(option('infra-scripts')).toBeTruthy();
    act(() => fireEvent.click(option('api-gateway')));
    act(() => fireEvent.click(option('web-console')));
    expect(option('api-gateway').getAttribute('aria-selected')).toBe('true');
    expect(scopes).toHaveLength(0);
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(popover()).toBeNull();
    expect(scopes).toEqual([['/r/api', '/r/web']]);
    expect(document.activeElement).toBe(dropButton(S.filterBar.repo));
    expect(dropButton(S.filterBar.repo).textContent).toBe('저장소: api-gateway +1');
    // 체크를 바꾸지 않고 닫으면 적용하지 않는다
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    expect(scopes).toHaveLength(1);
  });

  it('바깥을 누르면 닫히며 적용하고, 포커스를 단추로 가져오지 않는다', () => {
    const { calls } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    act(() => fireEvent.click(option('main')));
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(popover()).toBeNull();
    expect(calls.at(-1)?.revs).toEqual({ kind: 'solo', name: 'main' });
    expect(document.activeElement).not.toBe(dropButton(S.filterBar.branch));
  });

  it('검색 칸: 글자로 거르고 ↑↓ 로 항목을 옮겨 Enter 로 체크한다 (한글 조합 중 Enter 제외)', () => {
    const { calls } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const search = document.activeElement as HTMLInputElement;
    act(() => fireEvent.change(search, { target: { value: 'main' } }));
    const shown = within(popover() as HTMLElement).getAllByRole('option');
    expect(shown.map((o) => o.textContent)).toEqual(['main현재', 'origin/main']);
    act(() => {
      fireEvent.keyDown(search, { key: 'ArrowDown' });
    });
    expect(search.getAttribute('aria-activedescendant')).toBe(shown[1]?.id);
    act(() => {
      fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    });
    expect(shown[1]?.getAttribute('aria-selected')).toBe('false');
    act(() => {
      fireEvent.keyDown(search, { key: 'Enter' });
    });
    expect(
      within(popover() as HTMLElement)
        .getAllByRole('option')[1]
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(calls.at(-1)?.revs).toEqual({ kind: 'solo', name: 'origin/main' });
  });

  it('검색 칸이 비어 있으면 Space 가 체크이고 Home·End 는 처음·끝 항목, 검색어가 있으면 Space 는 글자다 (W19 ③)', () => {
    setup();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    const search = document.activeElement as HTMLInputElement;
    const options = () => within(popover() as HTMLElement).getAllByRole('option');
    act(() => {
      fireEvent.keyDown(search, { key: 'End' });
    });
    expect(search.getAttribute('aria-activedescendant')).toBe(options().at(-1)?.id);
    act(() => {
      fireEvent.keyDown(search, { key: 'Home' });
    });
    expect(search.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    const space = fireEvent.keyDown(search, { key: ' ' });
    // 막힌 기본 동작 = 글자가 들어가지 않고 체크했다
    expect(space).toBe(false);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.change(search, { target: { value: 'ma' } }));
    expect(fireEvent.keyDown(search, { key: ' ' })).toBe(true);
  });

  it('branch: HEAD 는 다른 branch 와 함께 고를 수 없고, 고르면 head 범위다', () => {
    const { calls } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.branch)));
    act(() => fireEvent.click(option('feature/x')));
    act(() => fireEvent.click(option(S.branches.head)));
    expect(option('feature/x').getAttribute('aria-selected')).toBe('false');
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(calls.at(-1)?.revs).toEqual({ kind: 'head' });
    // 단추 툴팁에 저장소마다의 HEAD
    expect(dropButton(S.filterBar.branch).getAttribute('title')).toContain('api: main');
  });

  it('작성자: 열 때 후보를 읽게 하고, 이름·이메일·커밋 수를 보인다. 두 명 체크 → 요약 → × 로 해제', () => {
    const { load, calls } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    expect(load).toHaveBeenCalledWith(false);
    const harin = option('서하린');
    expect(harin.textContent).toBe('서하린harin.seo@example.com21');
    act(() => fireEvent.click(harin));
    act(() => fireEvent.click(option('Jamie Park')));
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(filterOf(calls.at(-1) as GraphQuery).authors).toEqual([
      'harin.seo@example.com',
      'jamie.park@example.com',
    ]);
    expect(dropButton(S.filterBar.author).textContent).toBe('작성자: 서하린 +1');
    const clear = screen.getByRole('button', {
      name: S.filterBar.clearCondition('작성자: 서하린 +1'),
    });
    act(() => fireEvent.click(clear));
    expect(filterOf(calls.at(-1) as GraphQuery).authors).toEqual([]);
    expect(dropButton(S.filterBar.author).textContent).toBe(S.filterBar.author);
  });

  it('작성자: 후보에 없는 이메일이 질의에 있으면 그 값도 보이고 지울 수 있다', () => {
    const { calls } = setup({ initial: withAuthors(Q, ['gone@example.com']) });
    expect(dropButton(S.filterBar.author).textContent).toBe('작성자: gone@example.com');
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    expect(popover()?.textContent).toContain(S.filterBar.authorMissing);
    const gone = option('gone@example.com');
    expect(gone.getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.click(gone));
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(filterOf(calls.at(-1) as GraphQuery).authors).toEqual([]);
  });

  it.each<[string, Partial<AuthorSource>, string, boolean]>([
    ['읽는 중', { state: 'loading', list: null }, S.filterBar.authorsLoading, false],
    [
      '실패',
      { state: 'error', list: null, error: 'boom' },
      S.filterBar.authorsFailed('boom'),
      true,
    ],
    [
      '시간 초과',
      { state: 'ready', list: { ...AUTHORS, timedOut: true } },
      S.filterBar.authorsTimedOut,
      true,
    ],
    [
      '잘림',
      { state: 'ready', list: { ...AUTHORS, truncated: true, total: 1500 } },
      S.filterBar.authorsTruncated(3, 1500),
      false,
    ],
  ])('작성자 후보 상태: %s', (_name, authors, text, retry) => {
    const { load } = setup({ authors });
    act(() => fireEvent.click(dropButton(S.filterBar.author)));
    expect(popover()?.textContent).toContain(text);
    const again = within(popover() as HTMLElement).queryByRole('button', {
      name: S.filterBar.retry,
    });
    expect(again !== null).toBe(retry);
    if (again) {
      act(() => fireEvent.click(again));
      expect(load).toHaveBeenLastCalledWith(true);
    }
  });

  it('날짜: 빠른 선택은 고른 시점에 고정된 범위로 바로 적용하고 닫는다. 직접 범위는 적용 단추로', () => {
    const { calls } = setup();
    act(() => fireEvent.click(dropButton(S.filterBar.date)));
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.dates.last7 })));
    expect(popover()).toBeNull();
    const range = quickRange('last7', NOW);
    expect(filterOf(calls.at(-1) as GraphQuery)).toMatchObject(range);
    expect(dropButton(S.filterBar.date).textContent).toBe(`날짜: ${S.filterBar.dates.last7}`);
    // 날짜만이면 목록 모드가 아니다 (그래프 선이 남는다)
    expect(screen.queryByText(S.filterBar.listMode)).toBeNull();

    act(() => fireEvent.click(dropButton(S.filterBar.date)));
    const [from, to] = Array.from(
      (popover() as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="date"]'),
    );
    // 열면 지금 범위가 채워져 있다
    expect(from?.value).toBe('2025-10-22');
    expect(to?.value).toBe('2025-10-28');
    act(() => fireEvent.change(from as HTMLInputElement, { target: { value: '2025-10-25' } }));
    act(() => fireEvent.change(to as HTMLInputElement, { target: { value: '2025-10-20' } }));
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.dates.apply })));
    // 시작 > 끝은 맞바꾼다
    expect(filterOf(calls.at(-1) as GraphQuery)).toMatchObject({
      since: Math.floor(new Date(2025, 9, 20).getTime() / 1000),
      until: Math.floor(new Date(2025, 9, 26).getTime() / 1000) - 1,
    });
    expect(document.activeElement).toBe(dropButton(S.filterBar.date));
  });

  it('모두 지우기: 조건이 하나라도 있을 때만 보이고 텍스트·조건·저장소 범위를 한 번에 푼다', () => {
    const { calls, scopes } = setup();
    expect(screen.queryByRole('button', { name: S.filterBar.clearAll })).toBeNull();
    type('fix');
    key('Enter');
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() => fireEvent.click(option('web-console')));
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.clearAll })));
    expect(filterOf(calls.at(-1) as GraphQuery).text.pattern).toBe('');
    expect(scopes.at(-1)).toEqual([]);
    expect(input().value).toBe('');
    expect(screen.queryByRole('button', { name: S.filterBar.clearAll })).toBeNull();
  });

  it('능력 플래그가 없으면 저장소 드롭다운이 없고 첫 드롭다운은 branch 다', () => {
    setup({ repoScope: false });
    expect(dropButton(S.filterBar.repo)).toBeUndefined();
    expect(dropButton(S.filterBar.branch).hasAttribute('data-filter-first')).toBe(true);
  });

  it('텍스트·작성자 필터가 걸리면 그래프 선이 없는 까닭(목록 모드)을 보인다', () => {
    setup({ initial: withAuthors(Q, ['harin.seo@example.com']) });
    expect(screen.getByText(S.filterBar.listMode).closest('[title]')?.getAttribute('title')).toBe(
      S.filterBar.listModeTitle,
    );
  });
});

describe('좁은 폭 (W19)', () => {
  /** 필터 바의 폭을 정한다 (jsdom 은 배치가 없다 — 필터 바가 처음 재는 폭만 바꾼다) */
  const atWidth = (width: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-filter-bar') ? new DOMRect(0, 0, width, 31) : new DOMRect();
    });
  const bar = () => document.querySelector<HTMLElement>('[data-filter-bar]') as HTMLElement;
  const tail = {
    status: '12개 일치',
    statusTitle: '잘린 저장소: api',
    onRefresh: vi.fn(),
    viewOptions: [
      { kind: 'check' as const, label: '원격 숨기기', checked: false, onChange: () => {} },
    ],
  };
  afterEach(() => vi.restoreAllMocks());

  it('960×600 의 로그 칸 폭: 한 줄이고 드롭다운 단추는 아이콘만 — 이름·고른 값은 보조 기술 이름과 툴팁, 걸린 조건은 표시와 × 로', () => {
    atWidth(475);
    const { calls } = setup({ initial: withAuthors(Q, ['harin.seo@example.com']), props: tail });
    expect(bar().dataset.mode).toBe('compact');
    expect(bar().dataset.rows).toBe('1');
    // 이름은 보이지 않는 글자로 남아 단추의 이름이 된다 (넓을 때와 같은 이름)
    const branch = screen.getByRole('button', { name: S.filterBar.branch });
    expect(branch.getAttribute('title')).toBe(S.filterBar.branch);
    expect(branch.closest('[data-active]')?.getAttribute('data-active')).toBe('false');
    const authorName = S.filterBar.summary(S.filterBar.author, '서하린');
    const author = screen.getByRole('button', { name: authorName });
    expect(author.getAttribute('title')).toBe(authorName);
    // 걸린 조건: 단추 묶음이 걸린 상태(점·배경)이고 그 조건만 지우는 × 가 있다
    expect(author.closest('[data-active]')?.getAttribute('data-active')).toBe('true');
    // 모두 지우기·보기 옵션·새로고침은 좁아도 그대로 닿는다
    expect(screen.getByRole('button', { name: S.filterBar.clearAll })).toBeTruthy();
    expect(screen.getByRole('button', { name: S.filterBar.viewOptions })).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: S.filterBar.refresh })));
    expect(tail.onRefresh).toHaveBeenCalledTimes(1);
    // 줄어든 상태 글자의 툴팁에 전부를 싣는다
    expect(screen.getByText('12개 일치').getAttribute('title')).toBe('12개 일치\n잘린 저장소: api');
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.filterBar.clearCondition(authorName) })),
    );
    expect(filterOf(calls.at(-1) as GraphQuery).authors).toEqual([]);
    expect(screen.getByRole('button', { name: S.filterBar.author })).toBeTruthy();
  });

  it('넓으면 이름이 보이는 한 줄이고 상태 툴팁은 지금 그대로, 로그 칸 최소 폭에서는 두 줄이다', () => {
    const wide = atWidth(710);
    setup({ props: tail });
    expect(bar().dataset.mode).toBe('full');
    expect(screen.getByText('12개 일치').getAttribute('title')).toBe('잘린 저장소: api');
    cleanup();
    wide.mockRestore();
    atWidth(344);
    setup({ props: tail });
    expect(bar().dataset.mode).toBe('stacked');
    expect(bar().dataset.rows).toBe('2');
  });

  it('걸린 조건이 늘어 아이콘 한 줄에 못 넣으면 두 줄이다', () => {
    atWidth(475);
    // 작성자 하나(목록 모드 표시·모두 지우기 포함)까지는 한 줄
    setup({ initial: withAuthors(Q, ['harin.seo@example.com']), props: tail });
    expect(bar().dataset.mode).toBe('compact');
    // 저장소 범위가 더 걸리면 × 하나만큼 모자라 두 줄이다
    act(() => fireEvent.click(dropButton(S.filterBar.repo)));
    act(() => fireEvent.click(option('web-console')));
    act(() => {
      fireEvent.keyDown(popover() as HTMLElement, { key: 'Escape' });
    });
    expect(bar().dataset.mode).toBe('stacked');
  });

  it('두 줄일 때 Tab 순서가 화면 순서(입력 → 윗줄 오른쪽 상태·단추 → 아랫줄 드롭다운)와 같다 (W19 ③)', () => {
    /** 필터 바 안 조작 요소의 DOM 순서: 입력·새로고침·첫 드롭다운의 차례 */
    const order = () => {
      const all = [...bar().querySelectorAll<HTMLElement>('input, button')];
      return {
        input: all.indexOf(input()),
        refresh: all.indexOf(screen.getByRole('button', { name: S.filterBar.refresh })),
        drop: all.indexOf(dropButton(S.filterBar.branch)),
      };
    };
    const wide = atWidth(710);
    setup({ props: tail });
    expect(bar().dataset.mode).toBe('full');
    // 한 줄: 입력 → 드롭다운 → 오른쪽 끝
    const one = order();
    expect(one.input < one.drop && one.drop < one.refresh).toBe(true);
    cleanup();
    wide.mockRestore();
    atWidth(344);
    setup({ props: tail });
    expect(bar().dataset.mode).toBe('stacked');
    // 두 줄: 입력 → 윗줄 오른쪽 → 아랫줄 드롭다운
    const two = order();
    expect(two.input < two.refresh && two.refresh < two.drop).toBe(true);
  });

  it('조건이 모두 걸려도 넓으면 한 줄이다', () => {
    atWidth(710);
    const many = withDates(
      withRevs(withAuthors(Q, ['harin.seo@example.com']), { kind: 'solo', name: 'main' }),
      quickRange('last7', NOW),
    );
    setup({ initial: many, props: tail });
    expect(bar().dataset.mode).toBe('full');
  });
});
