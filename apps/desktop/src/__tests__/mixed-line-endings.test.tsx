// 줄 끝이 섞인 파일 (P0 B): 내용은 읽기 전용으로 보이고, 안내 띠의 단추로 확인을 받은 뒤 한 형식으로 통일해 저장하면
// 편집기로 열린다. 폴더 탭·저장소 탭이 같은 파일 보기 문서를 쓰므로 두 종류 모두 확인한다.

import {
  createNullClient,
  type FsEditableFile,
  type FsSaveResult,
  type IpcClient,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileViewDoc } from '../features/workspace/FileViewDoc';
import {
  changedLineEndings,
  type MixedLineEndingsFile,
} from '../features/workspace/MixedLineEndingsView';
import { useAppStore } from '../store';
import { fileEditors } from '../store/file-editor-store';
import { disposeWorkspace, registerWorkspace } from '../store/session-registry';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(() => {
  installDialogStub();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});
afterAll(removeDialogStub);

const PATH = 'scripts/legacy.bat';
/** BOM + CRLF + LF + 단독 CR, 마지막 줄 끝 없음 */
const MIXED: MixedLineEndingsFile = {
  kind: 'mixedLineEndings',
  text: '﻿first\r\nsecond\nthird\rlast',
  size: 30,
  revision: 'r1',
  lf: 1,
  crlf: 1,
  cr: 1,
};

let session = 7100;
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  disposeWorkspace(session);
});

/** 그 종류의 탭을 활성으로 두고 섞인 파일을 미리보기 탭으로 연다. 통일에 성공하면 다음 읽기부터 편집할 수 있는 텍스트다 */
async function mount(kind: 'folder' | 'repo', result: FsSaveResult) {
  session += 1;
  const id = session;
  let normalized = false;
  const fsReadEditableFile = vi.fn(
    async (): Promise<FsEditableFile> =>
      normalized
        ? {
            kind: 'text',
            text: '﻿first\nsecond\nthird\nlast',
            size: 27,
            fileKey: `legacy-${id}`,
            revision: 'r2',
            lineEnding: 'lf',
            bom: true,
          }
        : MIXED,
  );
  const fsNormalizeLineEndings = vi.fn<IpcClient['fsNormalizeLineEndings']>(async () => {
    normalized = result.kind === 'saved';
    return result;
  });
  const client: IpcClient = { ...createNullClient(), fsReadEditableFile, fsNormalizeLineEndings };
  const workspace = createWorkspaceStore(kind);
  registerWorkspace(id, workspace);
  const doc = {
    kind: 'file' as const,
    id: `file:${PATH}`,
    path: PATH,
    name: 'legacy.bat',
    repoPath: null,
    repoName: null,
  };
  workspace.getState().openDoc(doc, 'preview');
  act(() => {
    useAppStore.setState({
      client,
      sessions: { [id]: { id, kind, path: '/r', name: 'r', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
    });
  });
  render(<FileViewDoc doc={doc} />);
  await tick();
  return {
    id,
    fsReadEditableFile,
    fsNormalizeLineEndings,
    pinned: () => workspace.getState().docs.find((d) => d.id === doc.id)?.pinned,
  };
}

/** 열린 확인 대화상자 */
const openDialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');

const t = S.fileEditor;
const COUNTS = t.lineEndingCounts(1, 1, 1);

describe.each(['folder', 'repo'] as const)('줄 끝이 섞인 파일 (%s 탭)', (kind) => {
  it('내용을 읽기 전용으로 보이고, 확인 뒤 LF로 통일해 저장하면 탭을 고정하고 편집기로 연다', async () => {
    const view = await mount(kind, { kind: 'saved', revision: 'r2' });
    expect(screen.getByText(t.mixedReadOnly(COUNTS))).toBeTruthy();
    // 파일 보기의 읽기 전용 본문이다 (편집기가 아니다)
    expect(screen.getByLabelText(S.fileView.content)).toBeTruthy();
    expect(screen.queryByTestId('file-editor')).toBeNull();
    expect(screen.getByText('third')).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: t.normalizeLf })));
    await tick();
    const dialog = openDialog() as HTMLDialogElement;
    expect(dialog.textContent).toContain(t.normalizeTitle('LF'));
    // LF 로 바꾸면 CRLF 1줄과 단독 CR 1개가 바뀐다
    expect(dialog.textContent).toContain(t.normalizeMessage('LF', COUNTS, 2, 1));
    act(() =>
      fireEvent.click(within(dialog).getByRole('button', { name: t.normalizeAction('LF') })),
    );
    await tick();
    await tick();
    expect(view.fsNormalizeLineEndings).toHaveBeenCalledWith(view.id, PATH, 'r1', 'lf');
    expect(screen.getByTestId('file-editor')).toBeTruthy();
    expect(screen.queryByText(t.mixedReadOnly(COUNTS))).toBeNull();
    // 통일 저장은 파일을 바꾸므로 미리보기 탭을 고정한다
    expect(view.pinned()).toBe(true);
  });

  it('확인을 취소하면 통일하지 않는다', async () => {
    const view = await mount(kind, { kind: 'saved', revision: 'r2' });
    act(() => fireEvent.click(screen.getByRole('button', { name: t.normalizeCrlf })));
    await tick();
    const dialog = openDialog() as HTMLDialogElement;
    expect(dialog.textContent).toContain(t.normalizeMessage('CRLF', COUNTS, 2, 1));
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(view.fsNormalizeLineEndings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('file-editor')).toBeNull();
    expect(view.pinned()).toBe(false);
  });

  it('그사이 파일이 바뀌었으면 사유를 보이고 다시 읽는다. 저장에 실패하면 사유만 보인다', async () => {
    const view = await mount(kind, { kind: 'conflict' });
    expect(view.fsReadEditableFile).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.normalizeCrlf })));
    await tick();
    act(() =>
      fireEvent.click(
        within(openDialog() as HTMLDialogElement).getByRole('button', {
          name: t.normalizeAction('CRLF'),
        }),
      ),
    );
    await tick();
    await tick();
    expect(view.fsNormalizeLineEndings).toHaveBeenCalledWith(view.id, PATH, 'r1', 'crlf');
    expect(screen.getByRole('alert').textContent).toBe(t.normalizeConflict);
    expect(view.fsReadEditableFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('file-editor')).toBeNull();
    expect(view.pinned()).toBe(false);
  });
});

describe('줄 끝 통일 실패와 바뀌는 줄 수', () => {
  it('저장에 실패하면 다시 읽지 않고 사유를 띠에 보인다', async () => {
    const view = await mount('folder', { kind: 'failed', message: 'File exceeds 1 MiB' });
    act(() => fireEvent.click(screen.getByRole('button', { name: t.normalizeLf })));
    await tick();
    act(() =>
      fireEvent.click(
        within(openDialog() as HTMLDialogElement).getByRole('button', {
          name: t.normalizeAction('LF'),
        }),
      ),
    );
    await tick();
    await tick();
    expect(screen.getByRole('alert').textContent).toBe(t.normalizeFailed('File exceeds 1 MiB'));
    expect(view.fsReadEditableFile).toHaveBeenCalledTimes(1);
    // 다시 누를 수 있다
    expect(
      (screen.getByRole('button', { name: t.normalizeLf }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('바뀌는 줄 수는 목표가 아닌 줄 끝과 단독 CR 의 합이다', () => {
    const file = { ...MIXED, lf: 3, crlf: 5, cr: 1 };
    expect(changedLineEndings(file, 'lf')).toBe(6);
    expect(changedLineEndings(file, 'crlf')).toBe(4);
    expect(t.lineEndingCounts(3, 5, 0)).toBe('LF 3줄 · CRLF 5줄');
    expect(t.lineEndingCounts(3, 5, 1)).toBe('LF 3줄 · CRLF 5줄 · 단독 CR 1개');
  });
});
