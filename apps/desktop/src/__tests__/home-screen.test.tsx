import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeScreen } from '../features/home/HomeScreen';
import { useAppStore } from '../store';

const original = useAppStore.getState();
afterEach(() => {
  cleanup();
  useAppStore.setState(original, true);
});

/** 실제 저장 동작 대신 고정 여부만 바꾸어 목록 이동과 필터를 검증한다. */
function setup() {
  const select = vi.fn();
  useAppStore.setState({
    isOpening: false,
    recent: [
      { path: '/work/team', name: 'team', kind: 'folder', pinned: true, lastOpenedAt: 10 },
      { path: '/work/api', name: 'api', kind: 'repo', pinned: false, lastOpenedAt: 20 },
    ],
    sessions: { 7: { id: 7, kind: 'repo', name: 'api', path: '/work/api', parent: null } },
    sessionOrder: [7],
    activeSessionId: null,
    loadRecent: async () => {},
    setActiveSession: select,
    pinRecent: async (path, pinned) => {
      useAppStore.setState((s) => ({
        recent: s.recent.map((r) => (r.path === path ? { ...r, pinned } : r)),
      }));
    },
  });
  render(<HomeScreen />);
  return select;
}

it('즐겨찾기와 최근을 중복 없이 구분하고 종류 필터와 경로 검색을 적용한다', () => {
  setup();
  const favorites = screen.getByRole('region', { name: S.home.favorites });
  const recent = screen.getByRole('region', { name: S.home.recent });
  expect(within(favorites).getByText('team')).toBeTruthy();
  expect(within(recent).queryByText('team')).toBeNull();
  expect(within(recent).getByText(S.home.repo)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: S.home.kindFilter }), {
    target: { value: 'repo' },
  });
  expect(screen.queryByText('team')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: S.home.search }), {
    target: { value: '/missing' },
  });
  expect(screen.queryByText('api')).toBeNull();
  expect(screen.getAllByText(S.home.noMatches)).toHaveLength(2);
});

it('즐겨찾기 해제는 최근 구역으로 이동하고 열린 항목은 기존 탭을 선택한다', async () => {
  const select = setup();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: `${S.home.unpin}: team` })),
  );
  expect(
    within(screen.getByRole('region', { name: S.home.favorites })).queryByText('team'),
  ).toBeNull();
  expect(
    within(screen.getByRole('region', { name: S.home.recent })).getByText('team'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /api.*Git/ }));
  expect(select).toHaveBeenCalledExactlyOnceWith(7);
});
