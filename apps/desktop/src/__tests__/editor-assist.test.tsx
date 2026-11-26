import { indentUnit } from '@codemirror/language';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadLanguage } from '@mgit/diff-view';
import { createNullClient, type FsEditableFile } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import { annotationExtension } from '../features/workspace/editor/annotations';
import { FileEditor } from '../features/workspace/FileEditor';
import { handleGlobalKey } from '../global-keys';
import { getEditorPreferences, setEditorPreferences } from '../store/editor-preferences';
import { type EditorFile, fileEditors } from '../store/file-editor-store';

const original = getEditorPreferences();
let session = 9700;
let opened: EditorFile | null = null;
beforeEach(() => {
  session++;
  setEditorPreferences({ ...original, autoCloseBrackets: true });
});
afterEach(async () => {
  cleanup();
  if (opened) fileEditors.lockMutation([opened], false);
  opened = null;
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  setEditorPreferences(original);
});

/** 주어진 내용의 공유 문서를 열어 실제 파일 편집기로 그리고 그 CodeMirror 화면을 돌려준다. */
async function openEditor(path: string, text: string) {
  const client = {
    ...createNullClient(),
    fsSaveFile: vi.fn(async () => ({ kind: 'saved' as const, revision: '2' })),
    fsReadEditableFile: async (): Promise<FsEditableFile> => ({
      kind: 'text',
      text,
      size: text.length,
      bom: false,
      lineEnding: 'lf',
      fileKey: `assist-${session}-${path}`,
      revision: '1',
    }),
  };
  const doc = (await fileEditors.open(client, session, path)) as EditorFile;
  opened = doc;
  render(<FileEditor doc={doc} source={{ client, session, path }} />);
  const root = screen.getByTestId('file-editor').querySelector('.cm-editor') as HTMLElement;
  const view = EditorView.findFromDOM(root);
  if (!view) throw new Error('Missing editor view');
  return { doc, view, content: view.contentDOM };
}

/** CodeMirror 가 DOM 입력을 읽었을 때와 같은 경로로 글자를 넣는다(입력 처리기 → 없으면 기본 삽입). */
function type(view: EditorView, text: string): boolean {
  const { from, to } = view.state.selection.main;
  const insert = () =>
    view.state.update({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    });
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, insert));
  if (!handled) view.dispatch(insert());
  return handled;
}

/** 같은 키를 쓰는 전역 동작 하나로 실제 전역 키 처리기를 창에 붙인다. */
function listenGlobal(shortcut: string) {
  const run = vi.fn();
  const action: Action = {
    id: 'test.global',
    title: 'test',
    group: 'view',
    shortcut,
    scope: 'global',
    enabled: true,
    run,
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
  return { run, dispose: () => window.removeEventListener('keydown', listener) };
}

/** jsdom 은 macOS 가 아니므로 CodeMirror 의 Mod 와 앱의 mod 가 모두 Ctrl 이다. */
const mod = { ctrlKey: true };

describe('편집 보조', () => {
  it('다중 선택·파일별 들여쓰기·접기 여백을 켜고, 접기 여백은 변경 표시·Blame 뒤에 둔다', async () => {
    const { view, doc } = await openEditor(
      'config.json',
      '{\n    "a": {\n        "b": 1\n    }\n}\n',
    );
    expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(true);
    expect(view.state.facet(indentUnit)).toBe('    ');
    expect(view.state.tabSize).toBe(4);
    expect(screen.getByText(`UTF-8 · LF · ${S.fileEditor.indentSpaces(4)}`)).toBeTruthy();
    act(() =>
      view.dispatch({
        effects: doc.annotations.reconfigure(
          annotationExtension(
            {
              lines: [],
              head: '',
              current: false,
              all: true,
              changes: true,
              openCommit: vi.fn(),
              preview: vi.fn(),
            },
            view.state.doc.toString(),
          ),
        ),
      }),
    );
    const gutters = [...view.dom.querySelectorAll('.cm-gutter')].map((el) => el.className);
    const at = (name: string) => gutters.findIndex((cls) => cls.includes(name));
    expect(at('cm-lineNumbers')).toBe(0);
    expect(at('mgit-change-gutter')).toBeGreaterThan(at('cm-lineNumbers'));
    expect(at('mgit-blame-gutter')).toBeGreaterThan(at('mgit-change-gutter'));
    expect(at('cm-foldGutter')).toBe(gutters.length - 1);
  });

  it('괄호 옆 커서에서 짝을 강조하고, 언어를 읽은 뒤 접기 키로 접고 편다', async () => {
    const { view, content } = await openEditor('a.json', '{\n  "a": [1, 2]\n}\n');
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    expect(view.dom.querySelectorAll('.cm-matchingBracket')).toHaveLength(2);
    await act(async () => {
      await loadLanguage('a.json');
    });
    expect(
      view.dom.querySelector(`.cm-foldGutter [title="${S.fileEditor.foldLine}"]`),
    ).not.toBeNull();
    content.focus();
    // 실제 웹뷰는 ⇧ 와 함께 누른 [ 를 { 로 보낸다. CodeMirror 는 keyCode 로 원래 키를 찾는다
    fireEvent.keyDown(content, { key: '{', keyCode: 219, shiftKey: true, ...mod });
    expect(view.dom.querySelector('.cm-foldPlaceholder')).not.toBeNull();
    expect(view.state.doc.toString()).toBe('{\n  "a": [1, 2]\n}\n');
    fireEvent.keyDown(content, { key: '}', keyCode: 221, shiftKey: true, ...mod });
    expect(view.dom.querySelector('.cm-foldPlaceholder')).toBeNull();
  });

  it('⌘D 는 편집기에서 다음 일치 항목을 더하고 같은 키의 전역 동작을 실행하지 않는다', async () => {
    const { view, doc, content } = await openEditor('a.txt', 'foo bar foo\n');
    const global = listenGlobal('mod+d');
    try {
      content.focus();
      fireEvent.keyDown(content, { key: 'd', ...mod });
      fireEvent.keyDown(content, { key: 'd', ...mod });
      expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
        [0, 3],
        [8, 11],
      ]);
      expect(doc.state.selection.ranges).toHaveLength(2);
      expect(global.run).not.toHaveBeenCalled();
      // 선택 위 입력은 CodeMirror 기본 입력 경로(replaceSelection)라 모든 선택에 한 번에 들어간다
      act(() => view.dispatch(view.state.replaceSelection('x')));
      expect(view.state.doc.toString()).toBe('x bar x\n');
      // 편집기 밖에서는 같은 키가 전역 동작으로 간다
      render(<button type="button">outside</button>);
      const outside = screen.getByText('outside');
      outside.focus();
      fireEvent.keyDown(outside, { key: 'd', ...mod });
      expect(global.run).toHaveBeenCalledTimes(1);
    } finally {
      global.dispose();
    }
  });

  it('⌘E(최근 파일)는 편집기 키가 아니므로 편집기 안에서도 앱 단축키로 간다', async () => {
    const { content, doc } = await openEditor('a.txt', 'line\n');
    const global = listenGlobal('mod+e');
    try {
      content.focus();
      fireEvent.keyDown(content, { key: 'e', ...mod });
      expect(global.run).toHaveBeenCalledTimes(1);
      expect(doc.state.doc.toString()).toBe('line\n');
    } finally {
      global.dispose();
    }
  });

  it('괄호·따옴표를 자동으로 닫고 Backspace 로 쌍을 지우며, 설정으로 끌 수 있다', async () => {
    const { view, content } = await openEditor('a.txt', '');
    act(() => {
      expect(type(view, '(')).toBe(true);
    });
    expect(view.state.doc.toString()).toBe('()');
    expect(view.state.selection.main.head).toBe(1);
    content.focus();
    fireEvent.keyDown(content, { key: 'Backspace', keyCode: 8 });
    expect(view.state.doc.toString()).toBe('');
    act(() => setEditorPreferences({ ...getEditorPreferences(), autoCloseBrackets: false }));
    act(() => {
      expect(type(view, '(')).toBe(false);
    });
    expect(view.state.doc.toString()).toBe('(');
  });

  it('한글 조합이 시작된 동안에는 자동 닫기가 비켜서고 조합이 끝나면 다시 닫는다', async () => {
    const { view, content, doc } = await openEditor('a.md', '');
    fireEvent.compositionStart(content);
    expect(doc.composing).toBe(true);
    act(() => {
      expect(type(view, '(')).toBe(false);
    });
    expect(view.state.doc.toString()).toBe('(');
    fireEvent.compositionEnd(content);
    expect(doc.composing).toBe(false);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    act(() => {
      expect(type(view, '[')).toBe(true);
    });
    expect(view.state.doc.toString()).toBe('([]');
    // 조합 중인 키(⌘D 포함)는 전역 처리기도 건드리지 않는다
    const global = listenGlobal('mod+d');
    try {
      fireEvent.keyDown(content, { key: 'd', keyCode: 229, isComposing: true, ...mod });
      expect(global.run).not.toHaveBeenCalled();
    } finally {
      global.dispose();
    }
  });

  it('구조 변경 잠금(읽기 전용) 중에는 자동 닫기를 붙이지 않고 글을 바꾸지 않으며, ⌘D 는 여전히 편집기 몫이다', async () => {
    const { view, doc, content } = await openEditor('a.txt', 'foo foo\n');
    act(() => fileEditors.lockMutation([doc], true));
    expect(view.state.readOnly).toBe(true);
    act(() => {
      expect(type(view, '(')).toBe(false);
    });
    expect(view.state.doc.toString()).toBe('foo foo\n');
    expect(doc.state.doc.toString()).toBe('foo foo\n');
    const global = listenGlobal('mod+d');
    try {
      content.focus();
      fireEvent.keyDown(content, { key: 'd', ...mod });
      expect(global.run).not.toHaveBeenCalled();
    } finally {
      global.dispose();
    }
    act(() => fileEditors.lockMutation([doc], false));
    expect(view.state.readOnly).toBe(false);
    // 다음 글자가 단어 글자이면 닫지 않으므로 줄 끝에서 확인한다
    act(() => view.dispatch({ selection: { anchor: 7 } }));
    act(() => {
      expect(type(view, '(')).toBe(true);
    });
    expect(doc.state.doc.toString()).toBe('foo foo()\n');
  });

  it('Makefile 은 내용과 상관없이 탭으로 들여쓰고 위 줄에 탭으로 보인다', async () => {
    const { view } = await openEditor('Makefile', 'all:\n    echo hi\n');
    expect(view.state.facet(indentUnit)).toBe('\t');
    expect(screen.getByText(`UTF-8 · LF · ${S.fileEditor.indentTabs}`)).toBeTruthy();
  });
});

describe('찾기·바꾸기 패널 문구', () => {
  const p = S.fileEditor.findPanel;

  it('찾기·바꾸기 패널의 입력란·단추·체크 칸과 줄로 이동 패널이 앱 언어의 문구로 보인다', async () => {
    const { view } = await openEditor('a.txt', 'foo bar foo\n');
    act(() => {
      openSearchPanel(view);
    });
    const panel = view.dom.querySelector('.cm-search') as HTMLElement;
    const field = (name: string) =>
      panel.querySelector<HTMLInputElement>(`input[name="${name}"]`) as HTMLInputElement;
    expect([field('search').placeholder, field('search').getAttribute('aria-label')]).toEqual([
      p.find,
      p.find,
    ]);
    expect(field('replace').placeholder).toBe(p.replace);
    expect([...panel.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      p.next,
      p.previous,
      p.all,
      p.replaceOne,
      p.replaceAll,
      '×',
    ]);
    expect(panel.querySelector('button[name="close"]')?.getAttribute('aria-label')).toBe(p.close);
    expect([...panel.querySelectorAll('label')].map((l) => l.textContent)).toEqual([
      p.matchCase,
      p.regexp,
      p.byWord,
    ]);
    // 알림 문구: `$` 자리에 수가 들어간다
    expect(view.state.phrase('replaced $ matches', 2)).toBe(p.replacedMatches.replace('$', '2'));
    act(() => {
      gotoLine(view);
    });
    const go = view.dom.querySelector('.cm-goto-line') as HTMLElement;
    expect(go.querySelector('label')?.textContent).toBe(`${p.goToLine}: `);
    expect(go.querySelector('button')?.textContent).toBe(p.go);
  });
});
