// 대시보드의 보낼 것 있음·업스트림 없음·스태시 있음 필터와 스태시 열·정렬 (셋째 묶음 K).

import { createNullClient, type FolderSettings, type IpcClient, type RepoSummary } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Dashboard } from '../features/folder/Dashboard';
import { useAppStore } from '../store';
import { createFolderStore } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  clearSessionRegistry();
});

const ID = 93;
const ROOT = '/f';
const pathOf = (name: string) => `${ROOT}/${name}`;

/** 요약 한 줄 (업스트림이 있는 깨끗한 main 이 기본) */
function summary(name: string, extra: Partial<RepoSummary> = {}): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    op: null,
    lastFetch: null,
    error: null,
    ...extra,
  };
}

/** api 는 보낼 commit 2·stash 3, auth 는 업스트림 없음, docs 는 stash 1, web 은 분리 HEAD */
const SUMMARIES = [
  summary('api', { ahead: 2, stashCount: 3 }),
  summary('auth', { branch: 'feat', ahead: null, behind: null, remotes: ['origin'] }),
  summary('docs', { behind: 1, stashCount: 1 }),
  summary('web', { branch: null, detached: true, ahead: null, behind: null }),
];

const SETTINGS: FolderSettings = {
  exclude: [],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

/** 폴더 탭을 등록하고 개요를 그린다 */
async function mount() {
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => SUMMARIES,
    folderSettings: async () => SETTINGS,
  };
  const store = createFolderStore(
    {
      session: ID,
      path: ROOT,
      repos: SUMMARIES.map((s) => ({ path: s.path, kind: 'standalone' as const })),
    },
    client,
  );
  registerFolder(ID, store);
  act(() => {
    useAppStore.setState({
      client,
      sessions: { [ID]: { id: ID, kind: 'folder', path: ROOT, name: 'f', parent: null } },
      sessionOrder: [ID],
      activeSessionId: ID,
      toasts: [],
    });
  });
  await tick();
  render(<Dashboard />);
  await tick();
  return store;
}

/** 표의 줄: [저장소 이름, 스태시 칸] */
function rows(): [string, string][] {
  const table = screen.getByRole('table');
  const header = within(table).getAllByRole('columnheader');
  const stashAt = header.findIndex((th) => th.textContent === S.folder.columns.stash);
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((tr) => {
      const cells = within(tr).getAllByRole('cell');
      return [cells[1]?.textContent ?? '', cells[stashAt]?.textContent ?? ''];
    });
}

/** 필터 단추를 누른다 */
async function filter(label: string) {
  act(() => fireEvent.click(screen.getByRole('button', { name: label })));
  await tick();
}

describe('대시보드 필터와 스태시 열', () => {
  it('필터는 전체·변경 있음·뒤처짐·보낼 것 있음·업스트림 없음·스태시 있음·진행 중 순서이고 하나만 눌린다', async () => {
    await mount();
    const f = S.folder.filter;
    const labels = [f.all, f.changed, f.behind, f.ahead, f.noUpstream, f.stashed, f.inProgress];
    for (const label of labels) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    await filter(f.ahead);
    expect(rows().map(([name]) => name)).toEqual(['api']);
    expect(screen.getByRole('button', { name: f.ahead }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: f.all }).getAttribute('aria-pressed')).toBe('false');
    // 분리 HEAD(web)는 업스트림 없음에 들지 않는다
    await filter(f.noUpstream);
    expect(rows().map(([name]) => name)).toEqual(['auth']);
    await filter(f.stashed);
    expect(rows()).toEqual([
      ['api', '3'],
      ['docs', '1'],
    ]);
  });

  it('스태시 열은 0 이면 비우고, 머리를 누르면 스태시 수가 많은 순으로 정렬한다', async () => {
    const store = await mount();
    expect(rows()).toEqual([
      ['api', '3'],
      ['auth', ''],
      ['docs', '1'],
      ['web', ''],
    ]);
    const head = screen.getByRole('button', { name: S.folder.columns.stash });
    expect(head.title).toBe(S.folder.columns.stashTip);
    act(() => fireEvent.click(head));
    await tick();
    expect(store.getState().sort).toBe('stash');
    expect(head.closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(rows().map(([name]) => name)).toEqual(['api', 'docs', 'auth', 'web']);
  });
});
