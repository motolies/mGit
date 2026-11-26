import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import { defaultShortcut } from '../command-keymap';
import { EditorZoomControls, useEditorZoom } from '../components/EditorZoom';
import { handleGlobalKey } from '../global-keys';
import {
  changeEditorZoom,
  getEditorPreferences,
  normalizeEditorPreferences,
  setEditorPreferences,
  ZOOM_STEPS,
} from '../store/editor-preferences';

const original = getEditorPreferences();
afterEach(() => {
  cleanup();
  setEditorPreferences(original);
});
/** 본문과 일반 입력란이 함께 있는 배율 명령 영역을 만든다. */
function Pane() {
  const ref = useRef<HTMLDivElement>(null);
  const zoom = useEditorZoom(ref);
  return (
    <div ref={ref}>
      <EditorZoomControls />
      <div contentEditable suppressContentEditableWarning data-testid="code">
        {zoom.fontSize}
      </div>
      <input aria-label="search" />
    </div>
  );
}
/** 실제 전역 라우터에 플랫폼별 배율 키 이벤트를 전달한다. */
function press(target: HTMLElement, key: string, id = 'editor.zoomIn') {
  const shortcut = defaultShortcut(id);
  const action: Action = {
    id,
    title: id,
    group: 'view',
    enabled: false,
    scope: 'editor',
    input: 'allow',
    shortcut,
    run: vi.fn(),
  };
  const listener = (event: KeyboardEvent) =>
    handleGlobalKey(event, {
      actions: [action],
      openPalette: vi.fn(),
      searchOpen: false,
      closeSearch: vi.fn(),
      activeDoc: null,
      closeActiveDoc: vi.fn(),
    });
  window.addEventListener('keydown', listener);
  target.focus();
  fireEvent.keyDown(target, {
    key,
    metaKey: /Mac/.test(navigator.platform),
    ctrlKey: !/Mac/.test(navigator.platform),
  });
  window.removeEventListener('keydown', listener);
}

describe('공통 본문 배율', () => {
  it('기존 설정과 유효하지 않은 값은 100%로 읽는다', () => {
    const { zoomPercent: _zoom, ...legacy } = original;
    expect(normalizeEditorPreferences(legacy).zoomPercent).toBe(100);
    expect(normalizeEditorPreferences({ ...legacy, zoomPercent: 999 }).zoomPercent).toBe(100);
  });
  it('단계를 이동하고 양 끝에서 멈추며 초기화한다', () => {
    changeEditorZoom(0);
    changeEditorZoom(1);
    expect(getEditorPreferences().zoomPercent).toBe(110);
    for (let i = 0; i < 30; i++) changeEditorZoom(1);
    expect(getEditorPreferences().zoomPercent).toBe(ZOOM_STEPS.at(-1));
    for (let i = 0; i < 30; i++) changeEditorZoom(-1);
    expect(getEditorPreferences().zoomPercent).toBe(50);
    changeEditorZoom(0);
    expect(getEditorPreferences().zoomPercent).toBe(100);
  });
  it('일반 설정 저장은 기존 배율을 보존한다', () => {
    changeEditorZoom(1);
    const before = getEditorPreferences().zoomPercent;
    const { zoomPercent: _zoom, ...settings } = original;
    setEditorPreferences(settings);
    expect(getEditorPreferences().zoomPercent).toBe(before);
  });
  it('단축키로 열린 화면을 함께 바꾸고 본문 포커스를 유지한다', () => {
    render(
      <>
        <Pane />
        <Pane />
      </>,
    );
    const code = screen.getAllByTestId('code')[0];
    if (!code) throw new Error('Missing code pane');
    press(code, '=');
    expect(getEditorPreferences().zoomPercent).toBe(110);
    expect(screen.getAllByText('110%')).toHaveLength(2);
    expect(document.activeElement).toBe(code);
    press(code, '-', 'editor.zoomOut');
    expect(getEditorPreferences().zoomPercent).toBe(100);
  });
  it('일반 입력란과 모달에서는 배율을 바꾸지 않는다', () => {
    render(<Pane />);
    press(screen.getByRole('textbox', { name: 'search' }), '=');
    expect(getEditorPreferences().zoomPercent).toBe(100);
    const dialog = document.createElement('dialog');
    dialog.open = true;
    document.body.append(dialog);
    press(screen.getByTestId('code'), '=');
    expect(getEditorPreferences().zoomPercent).toBe(100);
    dialog.remove();
  });
  it('현재 배율 버튼으로 초기화하며 Cmd+0 기본값은 유지한다', () => {
    render(<Pane />);
    act(() => changeEditorZoom(1));
    fireEvent.click(screen.getByText('110%'));
    expect(getEditorPreferences().zoomPercent).toBe(100);
    expect(defaultShortcut('view.toolCommit', undefined, true)).toBe('mod+0');
  });
});
