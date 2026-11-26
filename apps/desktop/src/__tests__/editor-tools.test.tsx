import { undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createNullClient, type FsEditableFile } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationExtension,
  blameLabel,
  changedLines,
} from '../features/workspace/editor/annotations';
import { formatText } from '../features/workspace/editor/formatter';
import { formatterParser } from '../features/workspace/editor/formatter-language';
import { FileEditor } from '../features/workspace/FileEditor';
import { setEditorPreferences } from '../store/editor-preferences';
import { type EditorFile, fileEditors, fileText } from '../store/file-editor-store';

vi.mock('../features/workspace/editor/formatter', () => ({ formatText: vi.fn() }));
let session = 9000;
beforeEach(() => {
  session++;
  vi.useFakeTimers();
  setEditorPreferences({
    printWidth: 200,
    currentBlame: true,
    allBlame: false,
    changeMarkers: true,
    formatOnSave: false,
  });
  vi.mocked(formatText).mockReset();
});
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  vi.useRealTimers();
});
/** BOM과 CRLF를 가진 실제 공유 문서를 사용한다. */
async function fixture(mount = true) {
  const client = {
    ...createNullClient(),
    fsSaveFile: vi.fn(async () => ({ kind: 'saved' as const, revision: '2' })),
    fsReadEditableFile: async (): Promise<FsEditableFile> => ({
      kind: 'text',
      text: '\uFEFFconst x=1;\r\n',
      size: 15,
      bom: true,
      lineEnding: 'crlf',
      fileKey: `format-${session}`,
      revision: '1',
    }),
  };
  const doc = (await fileEditors.open(client, session, 'a.ts')) as EditorFile;
  if (mount) render(<FileEditor doc={doc} source={{ client, session, path: 'a.ts' }} />);
  return doc;
}
describe('editor tools', () => {
  it('an explicit reveal focuses only its target editor after a delayed mount', async () => {
    const doc = await fixture(false);
    const source = [...doc.sources.values()][0];
    if (!source) throw new Error('Missing fixture source');
    render(<button type="button">origin</button>);
    const origin = screen.getByText('origin');
    origin.focus();
    act(() => fileEditors.reveal(doc, 6, { session, path: 'a.ts' }));
    expect(document.activeElement).toBe(origin);
    const unrelated = render(<FileEditor doc={doc} source={{ ...source, session: session + 1 }} />);
    expect(document.activeElement).toBe(origin);
    expect(doc.revealFocus).toEqual({ session, path: 'a.ts' });
    expect(doc.revealPosition).toBe(6);
    unrelated.unmount();
    render(<FileEditor doc={doc} source={source} />);
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: S.fileEditor.content }),
    );
    expect(doc.state.selection.main.anchor).toBe(6);
    expect(doc.revealFocus).toBeUndefined();
    expect(doc.revealPosition).toBeUndefined();
  });

  it('workspace search modifiers propagate while ordinary editor search stays local', async () => {
    await fixture();
    const content = screen.getByRole('textbox', { name: S.fileEditor.content });
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    try {
      fireEvent.keyDown(content, { key: 'f', metaKey: true, altKey: true });
      expect(seen).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(content, { key: 'f', metaKey: true });
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', seen);
    }
  });
  it('toolbar arrows move focus without formatting or changing the draft', async () => {
    const doc = await fixture();
    const format = screen.getByRole('button', { name: S.fileEditor.format });
    const find = screen.getByRole('button', { name: S.fileEditor.findReplace });
    act(() => format.focus());
    fireEvent.keyDown(format, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(find);
    expect(formatText).not.toHaveBeenCalled();
    expect(doc.dirty).toBe(false);
  });
  it('formats once, preserves serialization and reverses in one Undo', async () => {
    const doc = await fixture();
    vi.mocked(formatText).mockResolvedValue('const x = 1;\n');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: S.fileEditor.format })),
    );
    expect(formatText).toHaveBeenCalledWith('const x=1;\n', 'a.ts', 200);
    expect(fileText(doc)).toBe('\uFEFFconst x = 1;\r\n');
    act(() => undo({ state: doc.state, dispatch: (tr) => fileEditors.update(doc, tr.state) }));
    expect(fileText(doc)).toBe('\uFEFFconst x=1;\r\n');
  });
  it('discards results when the draft changes while formatting', async () => {
    const doc = await fixture();
    let resolve!: (text: string) => void;
    vi.mocked(formatText).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: S.fileEditor.format }));
    act(() =>
      fileEditors.update(
        doc,
        doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: 'new draft' } })
          .state,
      ),
    );
    await act(async () => resolve('stale result'));
    expect(doc.state.doc.toString()).toBe('new draft');
    expect(screen.getByRole('alert').textContent).toBe(S.fileEditor.formatStale);
  });
  it('keeps the original text when a parser fails', async () => {
    const doc = await fixture();
    vi.mocked(formatText).mockRejectedValue(new Error('Invalid syntax'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: S.fileEditor.format })),
    );
    expect(fileText(doc)).toBe('\uFEFFconst x=1;\r\n');
    expect(screen.getByRole('alert').textContent).toBe('Invalid syntax');
  });
  it('does not format auto saves, and formats an explicit save when enabled', async () => {
    const doc = await fixture();
    act(() =>
      setEditorPreferences({
        printWidth: 200,
        currentBlame: true,
        allBlame: false,
        changeMarkers: true,
        formatOnSave: true,
      }),
    );
    act(() =>
      fileEditors.update(
        doc,
        doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: 'const y=2;\n' } })
          .state,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(formatText).not.toHaveBeenCalled();
    vi.mocked(formatText).mockResolvedValue('const y = 2;\n');
    await act(async () => {
      await doc.explicitSave?.();
    });
    expect(formatText).toHaveBeenCalledWith('const y=2;\n', 'a.ts', 200);
    expect(doc.state.doc.toString()).toBe('const y = 2;\n');
  });
  it('maps supported files and leaves unsupported types alone', () => {
    for (const path of ['a.tsx', 'a.js', 'a.json', 'a.html', 'a.css', 'a.md', 'a.yml', 'Main.java'])
      expect(formatterParser(path)).not.toBeNull();
    expect(formatterParser('image.png')).toBeNull();
  });
  it('updates current-line attribution from cached metadata and links the commit', () => {
    const openCommit = vi.fn();
    const lines = ['first', 'second'].map((text, i) => ({
      oid: String(i + 1).repeat(40),
      origLine: i + 1,
      line: i + 1,
      author: i === 0 ? 'Kim' : 'Lee',
      authorMail: '',
      authorTime: 123,
      summary: text,
      boundary: false,
      text,
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'first\nsecond',
        extensions: [
          annotationExtension(
            {
              lines,
              head: 'first\nsecond',
              current: true,
              all: true,
              changes: true,
              openCommit,
              preview: vi.fn(),
            },
            'first\nsecond',
          ),
        ],
      }),
    });
    expect(host.querySelector('.mgit-inline-blame')?.textContent).toContain('Kim');
    // Blame는 코드 DOM 밖에 있어 줄 끝 커서·줄 높이·텍스트 선택에 포함되지 않는다.
    expect(view.contentDOM.querySelector('.mgit-inline-blame')).toBeNull();
    expect(view.contentDOM.textContent).toBe('firstsecond');
    expect(view.contentDOM.querySelector('.cm-widgetBuffer')).toBeNull();
    view.dispatch({ selection: { anchor: 6 } });
    expect(host.querySelector('.mgit-inline-blame')?.textContent).toContain('Lee');
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
    const blame = host.querySelector('.mgit-inline-blame') as HTMLButtonElement;
    const position = view.state.selection.main.head;
    expect(fireEvent.mouseDown(blame)).toBe(false);
    expect(view.state.selection.main.head).toBe(position);
    expect(view.contentDOM.textContent).toBe('firstsecond');
    blame.click();
    expect(openCommit).toHaveBeenCalledWith('2'.repeat(40));
    view.destroy();
    expect(host.querySelector('.mgit-inline-blame')).toBeNull();
    host.remove();
  });
  it('marks additions, modifications and deletions without inventing attribution', () => {
    expect([...changedLines('', 'new\n').values()].some((line) => line.kind === 'added')).toBe(
      true,
    );
    expect([...changedLines('old\n', '').values()].some((line) => line.kind === 'deleted')).toBe(
      true,
    );
    expect(
      [...changedLines('old\n', 'new\n').values()].some((line) => line.kind === 'modified'),
    ).toBe(true);
    expect(blameLabel(undefined)).toBe(S.fileEditor.localChange);
  });
});
