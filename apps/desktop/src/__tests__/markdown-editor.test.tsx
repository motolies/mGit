import { undo } from '@codemirror/commands';
import { createNullClient, type FsEditableFile, type FsSaveResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditor } from '../features/workspace/FileEditor';
import { type EditorFile, fileEditors } from '../store/file-editor-store';

vi.mock('../features/workspace/markdown/MermaidBlock', () => ({ MermaidBlock: () => null }));
let serial = 6000;
let session = 0;
beforeEach(() => {
  vi.useFakeTimers();
  session = ++serial;
});
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  vi.useRealTimers();
});

/** 자동 저장 가능한 실제 공유 문서를 만들고 화면의 현재 경로를 별도로 전달한다. */
async function fixture() {
  let disk = '# Original\n';
  let revision = 1;
  const read = vi.fn(
    async (): Promise<FsEditableFile> => ({
      kind: 'text',
      text: disk,
      size: disk.length,
      bom: false,
      lineEnding: 'lf',
      fileKey: `markdown-${session}`,
      revision: String(revision),
    }),
  );
  const save = vi.fn(
    async (
      _session: number,
      _path: string,
      _revision: string,
      text: string,
    ): Promise<FsSaveResult> => {
      disk = text;
      revision++;
      return { kind: 'saved', revision: String(revision) };
    },
  );
  const client = { ...createNullClient(), fsReadEditableFile: read, fsSaveFile: save };
  const doc = (await fileEditors.open(client, session, 'readme.md')) as EditorFile;
  const props = { doc, source: { client, session, path: 'readme.md' } };
  const view = render(<FileEditor {...props} />);
  return {
    ...view,
    doc,
    props,
    save,
    external: () => {
      disk = '# External';
      revision++;
    },
  };
}

/** CodeMirror가 저장한 상태를 바꾸고 실제 렌더링까지 반영한다. */
function edit(doc: EditorFile, text: string) {
  act(() =>
    fileEditors.update(
      doc,
      doc.state.update({
        changes: { from: 0, to: doc.state.doc.length, insert: text },
        selection: { anchor: text.length },
      }).state,
    ),
  );
}

describe('Markdown editor lifecycle', () => {
  it('starts in edit, shows unsaved drafts immediately, preserves state, cursor, Undo and tab settings', async () => {
    const { doc, props, unmount } = await fixture();
    expect(screen.getByRole('button', { name: S.markdown.edit }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    edit(doc, '# Draft');
    const state = doc.state;
    fireEvent.click(screen.getByRole('button', { name: S.markdown.preview }));
    expect(screen.getByRole('heading', { name: 'Draft' })).toBeTruthy();
    expect(screen.getByTestId('file-editor').hidden).toBe(true);
    expect(doc.state.doc.toString()).toBe(state.doc.toString());
    expect(doc.state.selection.main.anchor).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: S.markdown.split }));
    fireEvent.keyDown(screen.getByRole('button', { name: S.markdown.resize }), {
      key: 'ArrowRight',
    });
    const preview = screen.getByRole('region', { name: S.markdown.preview });
    fireEvent.wheel(preview);
    preview.scrollTop = 120;
    fireEvent.scroll(preview);
    unmount();
    render(<FileEditor {...props} />);
    expect(
      screen.getByRole('button', { name: S.markdown.split }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: S.markdown.resize }).title).toContain('55%');
    expect(screen.getByRole('region', { name: S.markdown.preview }).scrollTop).toBe(120);
    act(() => {
      undo({
        state: doc.state,
        dispatch: (transaction) => fileEditors.update(doc, transaction.state),
      });
    });
    expect(doc.state.doc.toString()).toBe('# Original\n');
  });
  it('saves and opens find from the preview side of split mode', async () => {
    const { doc, save } = await fixture();
    edit(doc, '# Split draft');
    fireEvent.click(screen.getByRole('button', { name: S.markdown.split }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('region', { name: S.markdown.preview }), {
        key: 's',
        metaKey: true,
      });
    });
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('region', { name: S.markdown.preview }), {
      key: 'f',
      ctrlKey: true,
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.getByRole('button', { name: S.markdown.edit }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
  it('debounces preview 300ms and pauses during Korean IME composition', async () => {
    const { doc } = await fixture();
    fireEvent.click(screen.getByRole('button', { name: S.markdown.split }));
    edit(doc, '# First');
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole('heading', { name: 'First' })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy();
    act(() => fileEditors.composition(doc, true));
    edit(doc, '# 한글 조합');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('heading', { name: '한글 조합' })).toBeNull();
    act(() => fileEditors.composition(doc, false));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('heading', { name: '한글 조합' })).toBeTruthy();
  });
  it('saves from preview keyboard and retains preview on save failure and external conflict', async () => {
    const { doc, save, external } = await fixture();
    edit(doc, '# Draft');
    save.mockResolvedValueOnce({ kind: 'failed', message: 'disk full' });
    fireEvent.click(screen.getByRole('button', { name: S.markdown.preview }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('region', { name: S.markdown.preview }), {
        key: 's',
        ctrlKey: true,
      });
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText('disk full')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Draft' })).toBeTruthy();
    external();
    await act(async () => fileEditors.refresh(doc));
    expect(doc.status).toBe('conflict');
    expect(screen.getByRole('heading', { name: 'Draft' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.fileEditor.findReplace }));
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.getByTestId('file-editor').hidden).toBe(false);
    expect(screen.getByRole('button', { name: S.markdown.edit }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
