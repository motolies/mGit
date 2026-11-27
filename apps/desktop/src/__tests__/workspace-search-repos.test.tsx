// 검색 패널의 저장소 범위 선택지는 폴더 스토어의 저장소 목록을 구독한다 (반응성 1라운드 보완): 패널이 열린 동안 폴더를
// 다시 훑어도 선택지가 낡지 않는다. 예전에는 편집기 저장소의 전역 알림이 우연히 다시 그려 주었다.
import { S } from '@mgit/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { useSearchPanel } from '../features/search/search-state';
import { WorkspaceSearch } from '../features/search/WorkspaceSearch';

/** 흉내 폴더 스토어의 상태 (저장소 목록만) */
type FolderLike = { repos: { path: string }[]; summaries: unknown[] };
const fixture = vi.hoisted(() => ({ folder: null as unknown as StoreApi<FolderLike> }));
vi.mock('../store', async () => {
  const { createStore: create, useStore: use } = await import('zustand');
  const { useShallow: shallow } = await import('zustand/react/shallow');
  fixture.folder = create<FolderLike>(() => ({
    repos: [{ path: '/workspace/api' }],
    summaries: [],
  }));
  const state = {
    activeSessionId: 1,
    sessions: { 1: { path: '/workspace' } },
    client: {
      workspaceSearch: vi.fn(async () => ({
        hits: [],
        skipped: 0,
        truncated: false,
        cancelled: false,
      })),
      workspaceSearchCancel: vi.fn(async () => {}),
      workspaceFiles: vi.fn(async () => ({
        files: [],
        repos: [''],
        skipped: 0,
        truncated: false,
        cancelled: false,
      })),
    },
  };
  return {
    useAppStore: (selector: (s: unknown) => unknown) => selector(state),
    getFolderStore: () => fixture.folder,
    getSessionStore: () => undefined,
    getWorkspaceStore: () => undefined,
    useFolder: (selector: (s: unknown) => unknown) => use(fixture.folder, shallow(selector)),
  };
});
vi.mock('../store/editor-drafts', () => ({ editorDrafts: () => [], editorDraftStamp: () => '' }));

beforeEach(() => {
  useSearchPanel.setState({ mode: null, focusVersion: 0 });
});
afterEach(cleanup);

it('패널이 열린 동안 폴더를 다시 훑어 저장소가 늘면 범위 선택지에도 곧바로 보인다', () => {
  render(<WorkspaceSearch />);
  act(() => useSearchPanel.getState().open('content'));
  const scope = () => screen.getByRole('combobox', { name: S.workspaceSearch.repoScope });
  const names = () => [...scope().querySelectorAll('option')].map((option) => option.textContent);
  expect(names()).toEqual([S.workspaceSearch.all, 'api']);
  act(() =>
    fixture.folder.setState({ repos: [{ path: '/workspace/api' }, { path: '/workspace/web' }] }),
  );
  expect(names()).toEqual([S.workspaceSearch.all, 'api', 'web']);
});
