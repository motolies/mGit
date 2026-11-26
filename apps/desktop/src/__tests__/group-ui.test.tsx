import {
  createNullClient,
  type GroupListItem,
  type GroupPathCheck,
  type IpcClient,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupDialog } from '../features/group/GroupDialog';
import { HomeScreen } from '../features/home/HomeScreen';
import { useAppStore } from '../store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 그룹 화면 (MR-13 M2): 홈의 그룹 묶음과 그룹 대화상자 (만들기·위치 다시 지정·저장)

const GROUP: GroupListItem = {
  id: 'g000000000001',
  name: 'Work',
  pinned: false,
  lastOpenedAt: 0,
  members: [
    { alias: 'api', path: '/w/api', state: 'present', kind: 'standalone' },
    { alias: 'legacy', path: '/old/legacy', state: 'missing', kind: null },
  ],
};

const initial = useAppStore.getState();

beforeEach(() => {
  installDialogStub();
});
afterEach(() => {
  cleanup();
  removeDialogStub();
  useAppStore.setState(initial, true);
});

describe('홈의 그룹 묶음', () => {
  it('그룹 이름·저장소 수·찾을 수 없음 배지를 보이고, 열기·고정·편집을 부른다', async () => {
    const openGroupAt = vi.fn(async () => {});
    const updateGroup = vi.fn(async () => true);
    const setGroupDialog = vi.fn();
    act(() =>
      useAppStore.setState({
        groups: [GROUP],
        recent: [],
        loadRecent: vi.fn(async () => {}),
        loadGroups: vi.fn(async () => {}),
        openGroupAt,
        updateGroup,
        setGroupDialog,
      }),
    );
    render(<HomeScreen />);
    const section = screen.getByRole('region', { name: S.group.section });
    expect(within(section).getByText('Work')).toBeTruthy();
    expect(within(section).getByText(S.group.state.missing)).toBeTruthy();
    fireEvent.click(within(section).getByText('Work'));
    expect(openGroupAt).toHaveBeenCalledWith(GROUP.id);
    fireEvent.click(within(section).getByRole('button', { name: `${S.home.pin}: Work` }));
    expect(updateGroup).toHaveBeenCalledWith(GROUP.id, { pinned: true });
    fireEvent.click(within(section).getByRole('button', { name: S.group.editNamed('Work') }));
    expect(setGroupDialog).toHaveBeenCalledWith({ mode: 'edit', id: GROUP.id });
    fireEvent.click(screen.getByRole('button', { name: S.group.create }));
    expect(setGroupDialog).toHaveBeenCalledWith({ mode: 'create' });
    // 종류 필터 "그룹" 은 최근 목록 묶음을 숨긴다
    fireEvent.change(screen.getByLabelText(S.home.kindFilter), { target: { value: 'group' } });
    expect(screen.queryByRole('region', { name: S.home.recent })).toBeNull();
    expect(screen.getByRole('region', { name: S.group.section })).toBeTruthy();
  });
});

describe('그룹 대화상자', () => {
  it('새 그룹: 폴더를 골라 저장소를 더하면 코어가 정한 별칭이 보이고, 만들기가 이름·경로로 만든다', async () => {
    const createGroup = vi.fn(async () => true);
    const client: IpcClient = {
      ...createNullClient(),
      groupCheckPaths: vi.fn(
        async (_group: string | null, paths: readonly string[]): Promise<GroupPathCheck[]> =>
          paths.includes('/w')
            ? [
                { input: '/w', path: '/w/api', kind: 'standalone', alias: 'api', issue: null },
                { input: '/w', path: '/w/web', kind: 'standalone', alias: 'web', issue: null },
                { input: '/w', path: '/w/nested', kind: null, alias: null, issue: 'notRepo' },
              ]
            : [],
      ),
    };
    act(() =>
      useAppStore.setState({
        client,
        groupDialog: { mode: 'create' },
        pickDirectory: vi.fn(async () => '/w'),
        createGroup,
      }),
    );
    render(<GroupDialog />);
    fireEvent.click(screen.getByRole('button', { name: S.group.addFromFolder }));
    await tick();
    const list = screen.getByRole('list', { name: S.group.members });
    expect(within(list).getByText('api')).toBeTruthy();
    expect(within(list).getByText('web')).toBeTruthy();
    // 이름 없이 만들면 안내
    fireEvent.click(screen.getByRole('button', { name: S.group.createButton }));
    expect(screen.getByRole('alert').textContent).toBe(S.group.nameRequired);
    fireEvent.change(screen.getByLabelText(S.group.name), { target: { value: ' Pair ' } });
    fireEvent.click(screen.getByRole('button', { name: `${S.group.exclude}: web` }));
    fireEvent.click(screen.getByRole('button', { name: S.group.createButton }));
    await tick();
    expect(createGroup).toHaveBeenCalledWith('Pair', ['/w/api']);
  });

  it('편집: 사라진 멤버의 위치를 다시 지정하면 별칭은 그대로 경로만 바뀌고, 저장이 전체 목록으로 고친다', async () => {
    const updateGroup = vi.fn(async () => true);
    const client: IpcClient = {
      ...createNullClient(),
      groupCheckPaths: vi.fn(
        async (): Promise<GroupPathCheck[]> => [
          {
            input: '/new/legacy',
            path: '/new/legacy',
            kind: 'standalone',
            alias: 'legacy',
            issue: null,
          },
        ],
      ),
    };
    act(() =>
      useAppStore.setState({
        client,
        groups: [GROUP],
        sessions: {},
        groupDialog: { mode: 'edit', id: GROUP.id },
        pickDirectory: vi.fn(async () => '/new/legacy'),
        updateGroup,
      }),
    );
    render(<GroupDialog />);
    expect(screen.getByText(S.group.editTitle('Work'))).toBeTruthy();
    expect(screen.getByText(`· ${S.group.state.missing}`, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `${S.group.relocate} legacy` }));
    await tick();
    fireEvent.click(screen.getByRole('button', { name: S.group.save }));
    await tick();
    expect(updateGroup).toHaveBeenCalledWith(GROUP.id, {
      name: 'Work',
      members: [
        { alias: 'api', path: '/w/api' },
        { alias: 'legacy', path: '/new/legacy' },
      ],
    });
  });

  it('편집: 별칭 칸을 고치면 쓸 수 없는 별칭·겹치는 별칭은 저장을 막고, 고친 별칭으로 저장한다 (M4)', async () => {
    const updateGroup = vi.fn(async () => true);
    act(() =>
      useAppStore.setState({
        client: createNullClient(),
        groups: [GROUP],
        sessions: {},
        groupDialog: { mode: 'edit', id: GROUP.id },
        updateGroup,
      }),
    );
    render(<GroupDialog />);
    const input = screen.getByRole('textbox', { name: `${S.group.alias}: /w/api` });
    const save = screen.getByRole('button', { name: S.group.save }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'a/b' } });
    expect(screen.getByRole('alert').textContent).toBe(S.group.aliasInvalid('a/b'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'LEGACY' } });
    expect(screen.getByRole('alert').textContent).toBe(S.group.aliasDuplicate('LEGACY'));
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'backend' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save.disabled).toBe(false);
    // 입력 중에도 칸이 다시 만들어지지 않는다 (줄 열쇠는 위치)
    expect(screen.getByRole('textbox', { name: `${S.group.alias}: /w/api` })).toBe(input);
    fireEvent.click(save);
    await tick();
    expect(updateGroup).toHaveBeenCalledWith(GROUP.id, {
      name: 'Work',
      members: [
        { alias: 'backend', path: '/w/api' },
        { alias: 'legacy', path: '/old/legacy' },
      ],
    });
  });
});
