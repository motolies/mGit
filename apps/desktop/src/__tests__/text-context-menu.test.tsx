import { S, TEXT_CONTEXT_EVENT } from '@mgit/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenuArea } from '../components/ContextMenu';
import { TextContextMenu } from '../components/TextContextMenu';
import { useAppStore } from '../store';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
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

/** 실제 DOM 선택 범위를 만들어 버튼 글자 선택과 다른 곳에 남은 선택을 재현한다. */
function selectText(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('조작용 컨트롤과 본문 선택의 경계', () => {
  it.each([
    'button',
    'tab',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'combobox',
    'option',
    'separator',
    'menuitem',
  ])('%s 컨트롤 안의 글자가 선택되어도 복사 메뉴를 열지 않는다', (role) => {
    render(
      <TextContextMenu>
        <div role={role}>
          <span>control label</span>
        </div>
      </TextContextMenu>,
    );
    const label = screen.getByText('control label');
    selectText(label);
    expect(fireEvent.contextMenu(label)).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('다른 본문에 선택이 남아 있어도 버튼과 빈 공간에는 메뉴가 없다', () => {
    render(
      <TextContextMenu>
        <div data-testid="container">
          <p>selected body</p>
        </div>
        <button type="button">action</button>
        <div data-testid="blank" />
      </TextContextMenu>,
    );
    selectText(screen.getByText('selected body'));
    fireEvent.contextMenu(screen.getByRole('button'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('blank'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('container'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('선택한 본문 자체에서는 복사를 유지한다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <TextContextMenu>
        <p>selected body</p>
      </TextContextMenu>,
    );
    const body = screen.getByText('selected body');
    selectText(body);
    fireEvent.contextMenu(body);
    fireEvent.click(screen.getByRole('menuitem', { name: S.textContext.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('selected body'));
  });

  it('비활성 입력에는 편집 메뉴가 없다', () => {
    render(
      <TextContextMenu>
        <input aria-label="disabled" disabled defaultValue="text" />
      </TextContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole('textbox'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('읽기 전용 입력은 복사만, 편집 가능한 입력은 붙여넣기를 제공한다', () => {
    render(
      <TextContextMenu>
        <input aria-label="readonly" readOnly defaultValue="text" />
        <input aria-label="editable" />
      </TextContextMenu>,
    );
    const input = screen.getByRole('textbox', { name: 'readonly' }) as HTMLInputElement;
    input.setSelectionRange(0, 4);
    fireEvent.contextMenu(input);
    expect(screen.getByRole('menuitem', { name: S.textContext.copy })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: S.textContext.paste })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'editable' }));
    expect(screen.getByRole('menuitem', { name: S.textContext.paste })).toBeTruthy();
  });

  it('터미널 등 전용 텍스트 어댑터의 동작은 유지한다', () => {
    render(
      <TextContextMenu>
        <div data-testid="terminal">terminal</div>
      </TextContextMenu>,
    );
    const terminal = screen.getByTestId('terminal');
    terminal.addEventListener(TEXT_CONTEXT_EVENT, (event) => {
      (event as CustomEvent).detail.adapter = { paste: () => {} };
    });
    fireEvent.contextMenu(terminal);
    expect(screen.getByRole('menuitem', { name: S.textContext.paste })).toBeTruthy();
  });
});

it('편집기·터미널 안의 조작 버튼에도 텍스트 메뉴를 붙이지 않는다', () => {
  render(
    <TextContextMenu>
      <div data-testid="adapter">
        <button type="button">tool</button>
      </div>
    </TextContextMenu>,
  );
  const query = vi.fn((event: Event) => {
    (event as CustomEvent).detail.adapter = { paste: () => {} };
  });
  screen.getByTestId('adapter').addEventListener(TEXT_CONTEXT_EVENT, query);
  fireEvent.contextMenu(screen.getByRole('button', { name: 'tool' }));
  expect(query).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});
