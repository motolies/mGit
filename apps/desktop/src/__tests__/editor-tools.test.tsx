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
async function fixture() {
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
  render(<FileEditor doc={doc} source={{ client, session, path: 'a.ts' }} />);
  return doc;
}
describe('editor tools', () => {
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
              pending: false,
              openCommit,
              preview: vi.fn(),
            },
            'first\nsecond',
          ),
        ],
      }),
    });
    expect(host.querySelector('.mgit-inline-blame')?.textContent).toContain('Kim');
    view.dispatch({ selection: { anchor: 6 } });
    expect(host.querySelector('.mgit-inline-blame')?.textContent).toContain('Lee');
    (host.querySelector('.mgit-inline-blame') as HTMLButtonElement).click();
    expect(openCommit).toHaveBeenCalledWith('2'.repeat(40));
    view.destroy();
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
