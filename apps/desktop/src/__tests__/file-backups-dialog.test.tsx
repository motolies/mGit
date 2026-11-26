// 폐기 백업 대화상자의 삭제 (#26): 하나 지우기·오래된 것 한꺼번에 지우기 모두 위험 확인을 거치고, 지울 수를 미리 보인다.

import type { BackupRecord } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileBackupsDialog,
  parsePruneDays,
  pruneBefore,
  pruneCount,
  splitBackupPath,
} from '../features/safety/FileBackupsDialog';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({ session: {} as Record<string, unknown> }));

vi.mock('../store', async (orig) => {
  const m = await orig<typeof import('../store')>();
  return {
    ...m,
    useSession: (sel: (s: never) => unknown) => sel(h.session as never),
  };
});

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T12:00:00Z');

/** 사본 하나 (`daysAgo` 일 전) */
function backup(id: number, relPath: string, daysAgo: number): BackupRecord {
  return { id, relPath, savedAt: NOW - daysAgo * DAY, reason: 'discard' };
}

const LIST = [backup(3, 'new.txt', 1), backup(2, 'mid.txt', 20), backup(1, 'old.txt', 45)];

let deleteBackups: ReturnType<typeof vi.fn>;
beforeEach(() => {
  deleteBackups = vi.fn(async () => true);
  h.session = {
    fileBackups: LIST,
    closeFileBackups: vi.fn(),
    restoreFileBackup: vi.fn(async () => true),
    deleteFileBackups: deleteBackups,
    busy: false,
    actionError: null,
  };
});

/** 열린 대화상자 중 가장 안쪽 (확인 창) */
const topDialog = () => {
  const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  return open[open.length - 1] as HTMLDialogElement;
};

describe('오래된 사본 계산', () => {
  it('날 수는 0 이상의 정수만 받고, 0 이면 전부다', () => {
    expect(parsePruneDays(' 30 ')).toBe(30);
    expect(parsePruneDays('0')).toBe(0);
    expect(parsePruneDays('-1')).toBeNull();
    expect(parsePruneDays('1.5')).toBeNull();
    expect(parsePruneDays('')).toBeNull();
    expect(pruneBefore(30, NOW)).toBe(NOW - 30 * DAY);
    expect(pruneCount(LIST, pruneBefore(30, NOW))).toBe(1);
    expect(pruneCount(LIST, pruneBefore(10, NOW))).toBe(2);
    expect(pruneCount(LIST, pruneBefore(0, NOW))).toBe(3);
  });
});

describe('경로 칸 (#22)', () => {
  it('경로를 폴더 부분과 파일 이름으로 나눈다', () => {
    expect(splitBackupPath('a.txt')).toEqual({ dir: '', name: 'a.txt' });
    expect(splitBackupPath('src/deep/a.txt')).toEqual({ dir: 'src/deep/', name: 'a.txt' });
  });

  it('줄은 폴더 부분과 파일 이름을 따로 그리고(좁으면 폴더부터 줄인다) 전체 경로를 툴팁과 읽는 글자로 남긴다', async () => {
    const long = 'apps/desktop/src/features/workspace/editor/very-long-name.tsx';
    h.session = { ...h.session, fileBackups: [backup(9, long, 1), backup(8, 'top.txt', 2)] };
    render(<FileBackupsDialog />);
    await tick();
    const cell = screen.getByTitle(long);
    expect(cell.textContent).toBe(long);
    expect([...cell.children].map((el) => el.textContent)).toEqual([
      'apps/desktop/src/features/workspace/editor/',
      'very-long-name.tsx',
    ]);
    // 폴더 없는 경로는 이름 칸 하나다
    expect([...screen.getByTitle('top.txt').children].map((el) => el.textContent)).toEqual([
      'top.txt',
    ]);
    // 한 줄은 경로·시각·이유·복구…·삭제… 다섯 칸이다 (CSS 격자의 다섯 열 — 남는 폭은 경로 칸이 쓴다)
    expect(cell.closest('li')?.children).toHaveLength(5);
  });
});

describe('폐기 백업 삭제', () => {
  it('줄의 삭제… 는 되돌릴 수 없다는 위험 확인을 거쳐 그 사본만 지운다', async () => {
    render(<FileBackupsDialog />);
    await tick();
    const row = screen.getByText('mid.txt').closest('li') as HTMLElement;
    act(() =>
      fireEvent.click(within(row).getByRole('button', { name: S.safety.fileBackupDelete })),
    );
    await tick();
    let confirm = topDialog();
    expect(confirm.textContent).toContain(S.safety.fileBackupDeleteTitle('mid.txt'));
    expect(confirm.textContent).toContain(S.safety.fileBackupDeleteMessage);
    // 취소하면 지우지 않는다
    act(() => fireEvent.click(within(confirm).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(deleteBackups).not.toHaveBeenCalled();
    act(() =>
      fireEvent.click(within(row).getByRole('button', { name: S.safety.fileBackupDelete })),
    );
    await tick();
    confirm = topDialog();
    act(() =>
      fireEvent.click(
        within(confirm).getByRole('button', { name: S.safety.fileBackupDeleteConfirm }),
      ),
    );
    await tick();
    expect(deleteBackups).toHaveBeenCalledWith({ ids: [2] });
  });

  it('오래된 백업 삭제… 는 보관 기간을 처음 값으로, 지울 수를 보이며 기준 시각으로 지운다', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    render(<FileBackupsDialog />);
    await tick();
    expect(screen.getByText(/30일이 지난 사본은/)).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: S.safety.fileBackupsPrune })));
    await tick();
    const prompt = topDialog();
    expect(prompt.textContent).toContain(S.safety.fileBackupsPruneMessage);
    const days = within(prompt).getByRole<HTMLInputElement>('textbox', {
      name: S.safety.fileBackupsPruneDays,
    });
    expect(days.value).toBe('30');
    expect(prompt.textContent).toContain(S.safety.fileBackupsPruneCount(1, false));
    // 잘못된 값이면 확인이 꺼진다
    act(() => fireEvent.change(days, { target: { value: 'x' } }));
    expect(prompt.textContent).toContain(S.safety.fileBackupsPruneInvalid);
    const run = within(prompt).getByRole<HTMLButtonElement>('button', {
      name: S.safety.fileBackupDeleteConfirm,
    });
    expect(run.disabled).toBe(true);
    // 지울 것이 없으면 확인이 꺼진다
    act(() => fireEvent.change(days, { target: { value: '100' } }));
    expect(prompt.textContent).toContain(S.safety.fileBackupsPruneNone);
    expect(run.disabled).toBe(true);
    act(() => fireEvent.change(days, { target: { value: '10' } }));
    expect(prompt.textContent).toContain(S.safety.fileBackupsPruneCount(2, false));
    expect(run.disabled).toBe(false);
    act(() => fireEvent.click(run));
    await tick();
    expect(deleteBackups).toHaveBeenCalledWith({ beforeMs: NOW - 10 * DAY });
  });

  it('목록이 비었으면 오래된 백업 삭제… 가 꺼진다', async () => {
    h.session = { ...h.session, fileBackups: [] };
    render(<FileBackupsDialog />);
    await tick();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: S.safety.fileBackupsPrune }).disabled,
    ).toBe(true);
  });
});
