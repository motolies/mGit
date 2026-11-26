// 파일 인코딩 (R2): 편집기 머리줄의 인코딩 단추로 다른 인코딩을 골라 다시 열고, 같은 인코딩으로 다시 쓸 수 없는 파일은
// 읽기 전용으로 까닭과 외부 앱 단추를 보인다. UTF-8·후보로 읽지 못한 파일은 인코딩을 골라 열 수 있다.

import {
  createNullClient,
  type FsEditableFile,
  type FsEncoding,
  type FsSaveResult,
  type IpcClient,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileViewDoc } from '../features/workspace/FileViewDoc';
import { useAppStore } from '../store';
import { type EditorFile, fileEditors } from '../store/file-editor-store';
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

const PATH = 'legacy/readme.txt';
const t = S.fileEditor;

/** EUC-KR 로 추정한 편집 가능한 텍스트 */
const GUESSED: FsEditableFile = {
  kind: 'text',
  text: '안녕\n',
  size: 5,
  fileKey: 'legacy',
  revision: 'r1',
  lineEnding: 'lf',
  bom: false,
  encoding: 'eucKr',
  guessed: true,
};

let session = 7300;
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  disposeWorkspace(session);
});

/** 고른 인코딩마다 답을 정해 둔 파일을 미리보기 탭으로 연다. 키 `auto` 는 고르지 않은 읽기다 */
async function mount(answers: Partial<Record<FsEncoding | 'auto', FsEditableFile>>) {
  session += 1;
  const id = session;
  const fsReadEditableFile = vi.fn(
    async (_s: number, _p: string, encoding?: FsEncoding | null): Promise<FsEditableFile> =>
      answers[encoding ?? 'auto'] ?? { kind: 'missing' },
  );
  const fsNormalizeLineEndings = vi.fn<IpcClient['fsNormalizeLineEndings']>(
    async (): Promise<FsSaveResult> => ({ kind: 'conflict' }),
  );
  const client: IpcClient = { ...createNullClient(), fsReadEditableFile, fsNormalizeLineEndings };
  const workspace = createWorkspaceStore('folder');
  registerWorkspace(id, workspace);
  const doc = {
    kind: 'file' as const,
    id: `file:${PATH}`,
    path: PATH,
    name: 'readme.txt',
    repoPath: null,
    repoName: null,
  };
  workspace.getState().openDoc(doc, 'preview');
  act(() => {
    useAppStore.setState({
      client,
      sessions: { [id]: { id, kind: 'folder', path: '/r', name: 'r', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
    });
  });
  render(<FileViewDoc doc={doc} />);
  await tick();
  return { id, fsReadEditableFile, fsNormalizeLineEndings };
}

/** 머리줄의 인코딩 단추 (이름 글자로 찾는다) */
const encodingButton = (label: string) => screen.getByRole('button', { name: t.encoding(label) });

/** 인코딩 단추의 메뉴를 열고 그 인코딩을 고른다 (Radix 메뉴 — 키보드 Enter 로 연다) */
async function choose(label: string, name: string) {
  act(() => {
    fireEvent.keyDown(encodingButton(label), { key: 'Enter' });
  });
  await tick();
  const item = screen.getByRole('menuitemradio', { name: new RegExp(`${name}$`) });
  act(() => fireEvent.click(item));
  await tick();
  await tick();
}

describe('파일 인코딩 (R2)', () => {
  it('추정한 인코딩은 머리줄에 "추정" 과 까닭으로 보이고, 다른 인코딩을 고르면 그 인코딩으로 다시 읽는다', async () => {
    const lossy: FsEditableFile = {
      kind: 'lossy',
      text: '一\n',
      size: 5,
      encoding: 'shiftJis',
      guessed: false,
      malformed: false,
    };
    const view = await mount({ auto: GUESSED, shiftJis: lossy });
    const label = `EUC-KR (${t.encodingGuessedTag})`;
    expect(encodingButton(label).title).toBe(t.encodingGuessed('EUC-KR'));
    expect(screen.getByTestId('file-editor')).toBeTruthy();

    await choose(label, 'Shift_JIS');
    expect(view.fsReadEditableFile).toHaveBeenLastCalledWith(view.id, PATH, 'shiftJis');
    // 다시 쓸 수 없는 인코딩: 편집기가 아니라 읽기 전용 본문 + 까닭 + 외부 앱 단추
    expect(screen.queryByTestId('file-editor')).toBeNull();
    expect(screen.getByLabelText(S.fileView.content)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(t.lossyIrreversible('Shift_JIS'));
    expect(screen.getByRole('button', { name: S.actions.openEditor })).toBeTruthy();

    // 고른 인코딩은 "자동으로 알아내기" 로 되돌린다 (인자 둘로 읽는다)
    act(() => {
      fireEvent.keyDown(encodingButton('Shift_JIS'), { key: 'Enter' });
    });
    await tick();
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(t.encodingAuto) })));
    await tick();
    await tick();
    expect(view.fsReadEditableFile).toHaveBeenLastCalledWith(view.id, PATH);
    expect(screen.getByTestId('file-editor')).toBeTruthy();
  });

  it('UTF-8·후보로 읽지 못한 파일은 안내와 "인코딩 골라 열기…" 단추를 보이고, 읽을 수 없는 바이트는 � 로 보인다', async () => {
    const view = await mount({
      auto: { kind: 'notUtf8', size: 3 },
      big5: {
        kind: 'lossy',
        text: 'a�',
        size: 3,
        encoding: 'big5',
        guessed: false,
        malformed: true,
      },
    });
    expect(screen.getByRole('status').textContent).toBe(t.notUtf8Hint);
    await choose(t.encodingPick, 'Big5');
    expect(view.fsReadEditableFile).toHaveBeenLastCalledWith(view.id, PATH, 'big5');
    expect(screen.getByRole('status').textContent).toBe(t.lossyMalformed('Big5'));
    expect(encodingButton('Big5')).toBeTruthy();
  });

  it('저장하지 않은 편집이 있으면 인코딩 단추가 막히고 까닭을 알린다', async () => {
    const view = await mount({ auto: GUESSED });
    const doc = fileEditors.get(view.id, PATH) as EditorFile;
    act(() =>
      fileEditors.update(doc, doc.state.update({ changes: { from: 0, insert: 'x' } }).state),
    );
    const button = encodingButton(`EUC-KR (${t.encodingGuessedTag})`);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toBe(t.encodingLocked);
    act(() => {
      fireEvent.keyDown(button, { key: 'Enter' });
    });
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('줄 끝이 섞인 EUC-KR 파일의 통일은 같은 인코딩으로 보낸다', async () => {
    const view = await mount({
      auto: {
        kind: 'mixedLineEndings',
        text: '가\r\n나\n',
        size: 7,
        revision: 'r1',
        lf: 1,
        crlf: 1,
        cr: 0,
        encoding: 'eucKr',
        guessed: true,
      },
    });
    expect(encodingButton(`EUC-KR (${t.encodingGuessedTag})`)).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: t.normalizeLf })));
    await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;
    act(() =>
      fireEvent.click(
        [...dialog.querySelectorAll('button')].find(
          (b) => b.textContent === t.normalizeAction('LF'),
        ) as HTMLButtonElement,
      ),
    );
    await tick();
    expect(view.fsNormalizeLineEndings).toHaveBeenCalledWith(view.id, PATH, 'r1', 'lf', 'eucKr');
  });
});
