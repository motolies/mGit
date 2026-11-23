// C3a: 태그 문서 화면 (`features/tags/TagsDoc.tsx`, TG-10) — 머리·필터·목록의 aria 와 키보드, 빈 상태, ⌘2 포커스 대상.
// 세션은 고정 객체(동작은 스파이), 화면 상태는 실제 워크스페이스 스토어를 쓴다 (탭별 상태가 바뀌면 다시 그린다)

import type { RefLabel, TagSyncEntry, TagSyncReport } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { focusTargetIn } from '../actions';
import { TagsDoc } from '../features/tags/TagsDoc';
import { createWorkspaceStore, type WorkspaceState } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  ws: null as unknown,
}));

vi.mock('../store', async (orig) => {
  const m = await orig<typeof import('../store')>();
  return {
    ...m,
    useSession: (sel: (s: never) => unknown) => sel(h.session as never),
    // 실제 워크스페이스 스토어를 구독한다 (화면 상태가 바뀌면 다시 그린다)
    useWorkspace: (sel: (w: WorkspaceState) => unknown) =>
      useStore(h.ws as ReturnType<typeof createWorkspaceStore>, useShallow(sel)),
  };
});

beforeAll(() => {
  // 가상 목록이 줄을 그리게 스크롤 영역 크기를 준다
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

const C = (n: number) => String(n).repeat(40).slice(0, 40);

/** 로컬 tag 라벨 */
const tag = (name: string, annotated: boolean, target: string): RefLabel =>
  ({
    fullName: `refs/tags/${name}`,
    shortName: name,
    kind: { kind: 'tag', annotated },
    target,
    isCurrent: false,
    upstreamGone: false,
  }) as RefLabel;

const entry = (name: string, kind: 'localOnly' | 'remoteOnly'): TagSyncEntry => ({
  name,
  state: { kind },
  localObject: null,
  localCommit: null,
  remoteObject: null,
  remoteCommit: kind === 'remoteOnly' ? C(9) : null,
});

/** origin 을 확인한 보고서: v2.4.0 로컬에만, v1.9.0 원격에만, 나머지 같음 */
const ORIGIN: TagSyncReport = {
  remote: 'origin',
  checkedAt: 1_000,
  stale: false,
  lastError: null,
  counts: { localOnly: 1, remoteOnly: 1, same: 2, diverged: 0, unknown: 0 },
  entries: [entry('v1.9.0', 'remoteOnly'), entry('v2.4.0', 'localOnly')],
  pushUrlDiffers: false,
};

/** 세션 흉내 */
function session(over: Record<string, unknown> = {}) {
  h.session = {
    refs: {
      labels: [
        tag('v2.4.0', true, C(1)),
        tag('v2.3.0', false, C(3)),
        tag('v2.2.0', true, C(2)),
        {
          ...tag('main', false, C(5)),
          fullName: 'refs/heads/main',
          kind: { kind: 'localBranch' },
          isCurrent: true,
          upstream: 'upstream/main',
        },
      ],
      remotes: [
        { name: 'origin', fetchUrl: 'o', pushUrl: null },
        { name: 'upstream', fetchUrl: 'u', pushUrl: null },
      ],
    },
    tagReports: {},
    tagChecking: [],
    busy: false,
    op: null,
    checkRemoteTags: vi.fn(async () => {}),
    reloadRemoteTags: vi.fn(async () => {}),
    jumpToCommit: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    pushTags: vi.fn(async () => []),
    deleteTagsScoped: vi.fn(async () => undefined),
    fetchTags: vi.fn(async () => []),
    runTagBatch: vi.fn(async () => ({ results: [], error: null })),
    tagList: null,
    loadTagList: vi.fn(async () => {}),
    ...over,
  };
  return h.session as Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  installDialogStub();
  h.ws = createWorkspaceStore('repo');
});
afterEach(() => {
  cleanup();
  removeDialogStub();
});

const listbox = () => screen.getByRole('listbox', { name: S.tag.doc.list });
/** 줄의 이름 칸 (선택 표시 다음 칸) */
const nameOf = (option: Element) => option.children[1]?.textContent;
const optionNames = () =>
  within(listbox())
    .getAllByRole('option')
    .map((o) => nameOf(o));
const filterButton = (key: keyof typeof S.tag.doc.filter) =>
  within(screen.getByRole('group', { name: S.tag.doc.filters })).getByRole('button', {
    name: new RegExp(`^${S.tag.doc.filter[key]}`),
  });

describe('태그 문서 머리·필터 (TG-10 ②③)', () => {
  it('처음 원격은 업스트림의 원격이고, 확인 전에는 전체 외 필터가 꺼지고 상태 칸은 비어 있다. 열면 캐시를 읽는다', async () => {
    const s = session();
    render(<TagsDoc />);
    await tick();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: S.tag.doc.remote }).value).toBe(
      'upstream',
    );
    expect(screen.getByRole('status').textContent).toBe(S.tag.doc.notChecked);
    expect(filterButton('all').getAttribute('aria-pressed')).toBe('true');
    expect(filterButton('localOnly')).toHaveProperty('disabled', true);
    expect(optionNames()).toEqual(['v2.4.0', 'v2.3.0', 'v2.2.0']);
    expect(s.reloadRemoteTags).toHaveBeenCalledWith({ all: true });
    // 원격 확인은 고른 원격만
    fireEvent.click(screen.getByRole('button', { name: S.tag.doc.check }));
    expect(s.checkRemoteTags).toHaveBeenCalledWith(['upstream']);
  });

  it('확인한 원격으로 바꾸면 필터에 개수가 붙고, 고른 필터만 보인다 (aria-pressed). 원격에만 있는 줄도 나온다', async () => {
    session({ tagReports: { origin: ORIGIN } });
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('combobox', { name: S.tag.doc.remote }), {
      target: { value: 'origin' },
    });
    expect(optionNames()).toEqual(['v2.4.0', 'v2.3.0', 'v2.2.0', 'v1.9.0']);
    expect(filterButton('localOnly').textContent).toBe(
      S.tag.doc.filterCount(S.tag.doc.filter.localOnly, 1),
    );
    fireEvent.click(filterButton('remoteOnly'));
    expect(filterButton('remoteOnly').getAttribute('aria-pressed')).toBe('true');
    expect(optionNames()).toEqual(['v1.9.0']);
    expect(within(listbox()).getByRole('option').getAttribute('data-local')).toBe('false');
  });

  it('빈 상태: tag 가 없을 때, 찾기 결과가 없을 때. 원격이 없으면 그 사유를 보이고 확인 단추를 끈다', async () => {
    session();
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('searchbox', { name: S.tag.doc.search }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(S.tag.doc.empty.noMatch)).toBeTruthy();
    cleanup();
    session({ refs: { labels: [], remotes: [] } });
    render(<TagsDoc />);
    await tick();
    expect(screen.getByText(S.tag.doc.empty.noTags)).toBeTruthy();
    expect(screen.getByText(S.tag.doc.noRemote)).toBeTruthy();
    expect(screen.getByRole('button', { name: S.tag.doc.check })).toHaveProperty('disabled', true);
  });
});

describe('태그 문서 목록 (TG-10 ⑤)', () => {
  it('다중 선택 listbox: 화살표는 커서만, Space 로 고르고, ⇧↓ 범위, ⌘A 전부, Esc 비움. Enter 는 로그에서 보기', async () => {
    const s = session();
    render(<TagsDoc />);
    await tick();
    const list = listbox();
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    const selected = () =>
      within(list)
        .getAllByRole('option')
        .filter((o) => o.getAttribute('aria-selected') === 'true')
        .map((o) => nameOf(o));
    const press = (key: string, init: Record<string, boolean> = {}) =>
      act(() => {
        fireEvent.keyDown(list, { key, ...init });
      });
    press('ArrowDown');
    expect(selected()).toEqual([]);
    const active = () => document.getElementById(list.getAttribute('aria-activedescendant') ?? '');
    expect(active()?.textContent).toContain('v2.4.0');
    press(' ');
    expect(selected()).toEqual(['v2.4.0']);
    press('ArrowDown', { shiftKey: true });
    expect(selected()).toEqual(['v2.4.0', 'v2.3.0']);
    press('Escape');
    expect(selected()).toEqual([]);
    press('a', { metaKey: true, ctrlKey: true });
    expect(selected()).toEqual(['v2.4.0', 'v2.3.0', 'v2.2.0']);
    press('Enter');
    expect(s.jumpToCommit).toHaveBeenCalledWith(C(3));
  });

  it('클릭은 그 줄만 고르고, 열 머리로 정렬 방향을 바꾼다 (이름 역순이 기본)', async () => {
    session();
    render(<TagsDoc />);
    await tick();
    fireEvent.click(within(listbox()).getAllByRole('option')[1] as HTMLElement);
    expect(
      within(listbox())
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-selected')),
    ).toEqual(['false', 'true', 'false']);
    fireEvent.click(screen.getByText(new RegExp(`^${S.tag.doc.columns.name}`)));
    expect(optionNames()).toEqual(['v2.2.0', 'v2.3.0', 'v2.4.0']);
  });

  it('⌘2 의 포커스 대상(활성 탭 패널의 tabindex=0)이 목록이다 — 머리의 입력란이 아니다', async () => {
    session();
    render(
      <div data-panel="editor">
        <div role="tabpanel">
          <TagsDoc />
        </div>
      </div>,
    );
    await tick();
    const panel = document.querySelector('[data-panel="editor"]') as HTMLElement;
    expect(focusTargetIn(panel)).toBe(listbox());
  });
});

describe('태그 문서 날짜·툴팁·가져오기 (C3b)', () => {
  it('열면 로컬 tag 목록을 읽고, 날짜 열과 줄 툴팁(tag 제목·만든 이)을 보인다. 날짜로 정렬한다', async () => {
    const s = session({
      tagList: [
        {
          name: 'v2.4.0',
          annotated: true,
          object: 'f'.repeat(40),
          commit: C(1),
          date: 1_700_000_000,
          commitSubject: 'feat: a',
          tagSubject: 'Release v2.4.0',
          tagger: 'Kim <k@x>',
        },
        {
          name: 'v2.2.0',
          annotated: true,
          object: 'e'.repeat(40),
          commit: C(2),
          date: 1_800_000_000,
          commitSubject: 'feat: b',
          tagSubject: 'Release v2.2.0',
          tagger: 'Lee <l@x>',
        },
      ],
    });
    render(<TagsDoc />);
    await tick();
    expect(s.loadTagList).toHaveBeenCalled();
    const first = within(listbox()).getAllByRole('option')[0] as HTMLElement;
    expect(first.getAttribute('title')).toBe(
      ['v2.4.0', 'Release v2.4.0', S.tag.doc.tagger('Kim <k@x>')].join('\n'),
    );
    expect(first.children[6]?.textContent).not.toBe('');
    fireEvent.click(screen.getByText(new RegExp(`^${S.tag.doc.columns.date}`)));
    // 최신이 위, 날짜를 모르는 v2.3.0 은 뒤
    expect(optionNames()).toEqual(['v2.2.0', 'v2.4.0', 'v2.3.0']);
  });

  it('원격에만 있는 줄의 메뉴는 이 원격에서 가져오기·삭제…·이름 복사. 가져오기는 결과 칸으로 (토스트 없음)', async () => {
    const s = session({ tagReports: { origin: ORIGIN } });
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('combobox', { name: S.tag.doc.remote }), {
      target: { value: 'origin' },
    });
    const remoteOnly = within(listbox())
      .getAllByRole('option')
      .find((o) => o.getAttribute('data-local') === 'false') as HTMLElement;
    fireEvent.contextMenu(remoteOnly);
    await tick();
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual([S.tag.doc.fetch, S.menu.delete, S.menu.copyName]);
    fireEvent.click(screen.getByRole('menuitem', { name: S.tag.doc.fetch }));
    expect(s.runTagBatch).toHaveBeenCalledWith({
      kind: 'fetch',
      remote: 'origin',
      names: ['v1.9.0'],
      overwrite: false,
    });
    expect(s.fetchTags).not.toHaveBeenCalled();
  });
});

describe('태그 문서 일괄 작업 (C4, TG-12·13)', () => {
  /** 고른 줄을 정한다 (화면 상태에 직접) */
  const pick = (selected: string[]) =>
    act(() => {
      (h.ws as ReturnType<typeof createWorkspaceStore>).getState().setTagsView({ selected });
    });
  const toolbar = () => screen.getByRole('toolbar', { name: S.tag.batch.label });

  it('단추마다 고른 것 가운데 해당하는 개수, 0 이면 꺼짐 (push = 로컬에만, 가져오기 = 원격에만, 삭제 = 있는 곳)', async () => {
    session({ tagReports: { origin: ORIGIN } });
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('combobox', { name: S.tag.doc.remote }), {
      target: { value: 'origin' },
    });
    pick(['v2.4.0', 'v2.3.0', 'v1.9.0']);
    const buttons = within(toolbar())
      .getAllByRole('button')
      .map((b) => [b.textContent, (b as HTMLButtonElement).disabled]);
    expect(buttons).toEqual([
      [S.tag.batch.push('origin', 1), false],
      [S.tag.batch.fetch(1), false],
      [S.tag.batch.del(3), false],
    ]);
    pick(['v2.3.0']);
    expect(
      within(toolbar())
        .getAllByRole('button')
        .map((b) => (b as HTMLButtonElement).disabled),
    ).toEqual([true, true, false]);
  });

  it('일괄 push 결과: 요약(status)과 실패만 남긴 목록, 실패한 것이 선택으로 남고 일시적 실패만 다시 시도', async () => {
    const s = session({ tagReports: { origin: ORIGIN } });
    s.runTagBatch
      ?.mockResolvedValueOnce({
        results: [
          { name: 'v2.4.0', status: 'pushed', message: null, remoteOid: null, remoteCommit: null },
          { name: 'v2.2.0', status: 'unknown', message: null, remoteOid: null, remoteCommit: null },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        results: [
          { name: 'v2.2.0', status: 'pushed', message: null, remoteOid: null, remoteCommit: null },
        ],
        error: null,
      });
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('combobox', { name: S.tag.doc.remote }), {
      target: { value: 'origin' },
    });
    // v2.2.0 은 원격 상태를 모르는 줄로 만든다 (보고서에 없음 = 같음 이므로 push 대상이 되게 직접 고른다)
    pick(['v2.4.0']);
    await act(async () => {
      fireEvent.click(
        within(toolbar()).getByRole('button', { name: S.tag.batch.push('origin', 1) }),
      );
    });
    await tick();
    expect(s.runTagBatch).toHaveBeenCalledWith({
      kind: 'push',
      remote: 'origin',
      names: ['v2.4.0'],
    });
    expect(screen.getAllByRole('status').map((e) => e.textContent)).toContain(
      S.tag.result.summary(S.tag.result.push('origin'), 1, 1),
    );
    const list = screen.getByRole('list', { name: S.tag.result.list });
    expect(list.textContent).toContain('v2.2.0');
    expect(list.textContent).toContain(S.tag.status.unknown);
    // 실패한 것이 선택으로 남는다
    expect((h.ws as ReturnType<typeof createWorkspaceStore>).getState().tagsView.selected).toEqual([
      'v2.2.0',
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: S.tag.result.retry }));
    });
    await tick();
    expect(s.runTagBatch).toHaveBeenLastCalledWith({
      kind: 'push',
      remote: 'origin',
      names: ['v2.2.0'],
    });
    expect(screen.queryByRole('list', { name: S.tag.result.list })).toBeNull();
    expect(screen.getByRole('button', { name: S.tag.result.retry })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('모든 tag push 요청(TG-13): 그 원격을 확인하고 "로컬에만" 필터로 바꿔 그것을 모두 고른 뒤 push 단추에 포커스한다', async () => {
    const s = session({ tagReports: { origin: ORIGIN } });
    render(<TagsDoc />);
    await tick();
    act(() => {
      (h.ws as ReturnType<typeof createWorkspaceStore>)
        .getState()
        .setTagsView({ request: { kind: 'pushAll', remote: 'origin', seq: 1 } });
    });
    await tick();
    await tick();
    const view = (h.ws as ReturnType<typeof createWorkspaceStore>).getState().tagsView;
    expect(s.checkRemoteTags).toHaveBeenCalledWith(['origin']);
    expect(view).toMatchObject({
      request: null,
      remote: 'origin',
      filter: 'localOnly',
      selected: ['v2.4.0'],
    });
    expect(document.activeElement?.textContent).toBe(S.tag.batch.push('origin', 1));
  });
});

describe('다름 해소 (C5, TG-15)', () => {
  /** origin 에서 v2.2.0 이 다름 (원격 객체 R) */
  const DIVERGED: TagSyncReport = {
    ...ORIGIN,
    entries: [
      ...ORIGIN.entries,
      {
        name: 'v2.2.0',
        state: { kind: 'diverged', sameCommit: false },
        localObject: null,
        localCommit: C(2),
        remoteObject: 'r'.repeat(40),
        remoteCommit: C(7),
      },
    ],
  };

  it('다른 줄의 메뉴에 원격 것으로·로컬 것으로 맞추기. 원격 것으로는 덮어쓰는 가져오기, 로컬 것으로는 lease 덮어쓰기', async () => {
    const s = session({ tagReports: { origin: DIVERGED } });
    render(<TagsDoc />);
    await tick();
    fireEvent.change(screen.getByRole('combobox', { name: S.tag.doc.remote }), {
      target: { value: 'origin' },
    });
    const row = () =>
      within(listbox())
        .getAllByRole('option')
        .find((o) => nameOf(o) === 'v2.2.0') as HTMLElement;
    const open = async () => {
      fireEvent.contextMenu(row());
      await tick();
    };
    await open();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      S.tag.doc.showInLog,
      S.remote.pushTo('origin'),
      S.menu.delete,
      S.tag.align.toRemote,
      S.tag.align.toLocal,
      S.menu.checkoutDetached,
      S.menu.copyName,
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: S.tag.align.toRemote }));
    });
    await tick();
    // 일반 확인 (위험 아님): 확인하면 덮어쓰는 가져오기
    await act(async () => {
      fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    });
    await tick();
    expect(s.runTagBatch).toHaveBeenCalledWith({
      kind: 'fetch',
      remote: 'origin',
      names: ['v2.2.0'],
      overwrite: true,
    });
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: S.tag.align.toLocal }));
    });
    await tick();
    expect(document.querySelector('dialog[open] p')?.textContent).toBe(S.tag.align.toLocalMessage);
    await act(async () => {
      fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    });
    await tick();
    expect(s.runTagBatch).toHaveBeenLastCalledWith({
      kind: 'replace',
      remote: 'origin',
      items: [{ name: 'v2.2.0', expectedRemote: 'r'.repeat(40) }],
    });
  });
});

describe('대량 일괄 push 의 시간 안내 (C4 보강, B4)', () => {
  it('보낼 tag 가 500개 이상이면 일괄 단추 옆에 안내, 499개면 없다', async () => {
    const many = Array.from({ length: 500 }, (_, i) => tag(`v9.0.${i}`, false, C(1)));
    session({
      refs: { labels: many, remotes: [{ name: 'origin', fetchUrl: 'o', pushUrl: null }] },
    });
    render(<TagsDoc />);
    await tick();
    const pick = (n: number) =>
      act(() => {
        (h.ws as ReturnType<typeof createWorkspaceStore>)
          .getState()
          .setTagsView({ selected: many.slice(0, n).map((l) => l.shortName) });
      });
    pick(499);
    expect(screen.queryByText(S.tag.batch.slow)).toBeNull();
    pick(500);
    expect(screen.getByText(S.tag.batch.slow)).toBeTruthy();
    expect(screen.getByRole('button', { name: S.tag.batch.push('origin', 500) })).toBeTruthy();
  });
});
