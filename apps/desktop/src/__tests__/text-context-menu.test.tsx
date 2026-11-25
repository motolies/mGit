import { S } from '@mgit/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenuArea } from '../components/ContextMenu';
import { TextContextMenu } from '../components/TextContextMenu';
import { useAppStore } from '../store';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('텍스트 컨텍스트 메뉴', () => {
  it('빈 공간에서 WebView 기본 메뉴를 차단한다', () => {
    render(
      <TextContextMenu>
        <div data-testid="background" />
      </TextContextMenu>,
    );
    expect(fireEvent.contextMenu(screen.getByTestId('background'))).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('입력의 우클릭 당시 선택을 복사한다', async () => {
    useAppStore.setState({ uiLocale: 'en' });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <TextContextMenu>
        <input aria-label="name" defaultValue="hello world" />
      </TextContextMenu>,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.setSelectionRange(0, 5);
    fireEvent.contextMenu(input);
    fireEvent.click(screen.getByRole('menuitem', { name: S.textContext.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'));
  });

  it('안쪽 도메인 메뉴를 가로채지 않는다', () => {
    render(
      <TextContextMenu>
        <ContextMenuArea resolveTarget={() => 'file'} items={() => [{ label: 'File action' }]}>
          <span>file</span>
        </ContextMenuArea>
      </TextContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('file'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'File action' })).toBeTruthy();
  });
});
