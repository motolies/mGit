// 내용을 보이지 못하는 파일 (L): 안내 위 띠에 외부 편집기·Finder 단추를 두고 앱 스토어의 외부 열기로 탭 루트 기준
// 절대 경로를 넘긴다. 폴더 탭·저장소 탭이 같은 파일 보기 문서를 쓰므로 둘 다 확인한다.

import { createNullClient, type FsEditableFile, type IpcClient } from '@mgit/ipc';
import { isMac, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ExternalOpenAction,
  externalOpenActions,
  type UnavailableKind,
} from '../features/workspace/ExternalOpenBar';
import { FileViewDoc } from '../features/workspace/FileViewDoc';
import { useAppStore } from '../store';
import { fileEditors } from '../store/file-editor-store';
import { disposeWorkspace, registerWorkspace } from '../store/session-registry';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(() => {
  installDialogStub();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(removeDialogStub);

const original = useAppStore.getState().openExternal;
let session = 7400;
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  disposeWorkspace(session);
  useAppStore.setState({ openExternal: original });
});

/** Finder 단추 이름 (macOS 가 아니면 파일 탐색기) */
const revealName = () => (isMac() ? S.actions.revealFinder : S.actions.reveal);

/** 그 종류의 탭을 활성으로 두고 파일 보기 문서를 그린다. 외부 열기는 흉내 낸다 */
async function mount(kind: 'folder' | 'repo', file: FsEditableFile, path = 'data/big.bin') {
  session += 1;
  const id = session;
  const client: IpcClient = { ...createNullClient(), fsReadEditableFile: async () => file };
  const openExternal = vi.fn(async () => true);
  const workspace = createWorkspaceStore(kind);
  registerWorkspace(id, workspace);
  const doc = {
    kind: 'file' as const,
    id: `file:${path}`,
    path,
    name: path.split('/').pop() ?? path,
    repoPath: null,
    repoName: null,
  };
  workspace.getState().openDoc(doc, 'pinned');
  act(() => {
    useAppStore.setState({
      client,
      openExternal,
      sessions: { [id]: { id, kind, path: '/root dir', name: 'root', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
    });
  });
  render(<FileViewDoc doc={doc} />);
  await tick();
  return { openExternal };
}

/** 띠에 보이는 단추 */
function shownActions(): ExternalOpenAction[] {
  return [
    ...(screen.queryByRole('button', { name: S.actions.openEditor }) ? ['editor' as const] : []),
    ...(screen.queryByRole('button', { name: revealName() }) ? ['reveal' as const] : []),
  ];
}

// [안내 종류, 조회 결과, 보일 단추]
const cases: [UnavailableKind, FsEditableFile, ExternalOpenAction[]][] = [
  ['tooLarge', { kind: 'tooLarge', size: 2_000_000, limit: 1_048_576 }, ['editor', 'reveal']],
  ['notUtf8', { kind: 'notUtf8', size: 10 }, ['editor', 'reveal']],
  ['binary', { kind: 'binary', size: 10 }, ['editor', 'reveal']],
  ['unsupported', { kind: 'unsupported', fileKind: 'symlink' }, ['reveal']],
  ['denied', { kind: 'denied' }, ['reveal']],
  ['missing', { kind: 'missing' }, []],
];

describe('내용을 보이지 못하는 파일의 외부 열기 단추', () => {
  it.each(cases)('%s 안내의 단추 표', (kind, _file, expected) => {
    expect(externalOpenActions(kind)).toEqual(expected);
  });

  describe.each(['folder', 'repo'] as const)('%s 탭', (tab) => {
    it.each(cases)(
      '%s: 안내와 함께 단추를 보이고 탭 루트 기준 절대 경로로 연다',
      async (_k, file, expected) => {
        const { openExternal } = await mount(tab, file);
        expect(shownActions()).toEqual(expected);
        // UTF-8 아님은 인코딩을 고르라는 안내가 띠의 글이다 (R2)
        const notice = file.kind === 'notUtf8' ? S.fileEditor.notUtf8Hint : S.fileView.openOutside;
        expect(screen.queryByText(notice) !== null).toBe(expected.length > 0);
        for (const action of expected) {
          fireEvent.click(
            screen.getByRole('button', {
              name: action === 'editor' ? S.actions.openEditor : revealName(),
            }),
          );
          expect(openExternal).toHaveBeenLastCalledWith(action, '/root dir/data/big.bin');
        }
        expect(openExternal).toHaveBeenCalledTimes(expected.length);
      },
    );

    it('편집할 수 있는 텍스트와 줄 끝이 섞인 파일에는 단추가 없다', async () => {
      await mount(tab, {
        kind: 'text',
        text: 'hello\n',
        size: 6,
        fileKey: `ext-${tab}`,
        revision: '1',
        lineEnding: 'lf',
        bom: false,
      });
      expect(screen.getByTestId('file-editor')).toBeTruthy();
      expect(shownActions()).toEqual([]);
      cleanup();
      await mount(tab, {
        kind: 'mixedLineEndings',
        text: 'a\r\nb\n',
        size: 5,
        revision: 'r',
        lf: 1,
        crlf: 1,
        cr: 0,
      });
      expect(screen.getByText(S.fileEditor.normalizeLf)).toBeTruthy();
      expect(shownActions()).toEqual([]);
    });
  });
});
