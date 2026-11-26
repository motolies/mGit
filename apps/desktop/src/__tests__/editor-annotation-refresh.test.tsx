// 인라인 Blame·변경 표시·2초 검사의 갱신 방식 (셋째 묶음 N6): 입력으로는 다시 조회하지 않고 조회해 둔 blame 을 편집에
// 맞춰 옮기며, HEAD 변경·원문 교체 때만 다시 조회한다. 2초 검사는 파일 표지가 같으면 원문을 읽지 않는다.

import { ChangeSet, Compartment, EditorState, Text } from '@codemirror/state';
import type { BlameLine, FsEditableFile, IpcClient } from '@mgit/ipc';
import { createNullClient } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import {
  annotationExtension,
  blameOf,
  lineChangesOf,
  mapBlame,
  setGitBase,
} from '../features/workspace/editor/annotations';
import { FileEditor, headKeyOf } from '../features/workspace/FileEditor';
import { setEditorPreferences } from '../store/editor-preferences';
import { type EditorFile, fileEditors } from '../store/file-editor-store';
import { clearSessionRegistry, registerSession } from '../store/session-registry';

/** blame 한 줄 (`n` 번째 줄, 작성자 이름으로 구분) */
function blame(n: number, author = `A${n}`): BlameLine {
  return {
    oid: String((n % 9) + 1).repeat(40),
    origLine: n,
    line: n,
    author,
    authorMail: '',
    authorTime: 1,
    summary: `s${n}`,
    boundary: false,
    text: `line${n}`,
  };
}

/** 원문 `before` 에 `edit` 을 적용한 변경과 결과 */
function apply(before: string, edit: { from: number; to?: number; insert: string }[]) {
  const doc = Text.of(before.split('\n'));
  const changes = ChangeSet.of(edit, doc.length);
  return { changes, before: doc, after: changes.apply(doc) };
}

/** 줄마다 작성자 (고친 줄은 null) */
const authors = (lines: readonly (BlameLine | null)[]) => lines.map((l) => l?.author ?? null);

describe('blame 을 편집에 맞춰 옮기기', () => {
  const base = 'line1\nline2\nline3';
  const lines = [blame(1), blame(2), blame(3)];

  it('줄 안을 고치면 그 줄만 고친 줄이 된다', () => {
    const { changes, before, after } = apply(base, [{ from: 7, insert: 'X' }]);
    expect(authors(mapBlame(lines, changes, before, after))).toEqual(['A1', null, 'A3']);
  });

  it('줄 끝에서 Enter 를 치면 원래 줄은 그대로이고 새 줄만 고친 줄이다', () => {
    const { changes, before, after } = apply(base, [{ from: 5, insert: '\nnew' }]);
    expect(authors(mapBlame(lines, changes, before, after))).toEqual(['A1', null, 'A2', 'A3']);
  });

  it('줄 앞에 줄을 넣거나 줄을 지우면 나머지 줄의 blame 이 따라 옮겨진다', () => {
    const inserted = apply(base, [{ from: 0, insert: 'top\n' }]);
    expect(authors(mapBlame(lines, inserted.changes, inserted.before, inserted.after))).toEqual([
      null,
      'A1',
      'A2',
      'A3',
    ]);
    const removed = apply(base, [{ from: 5, to: 11, insert: '' }]);
    expect(authors(mapBlame(lines, removed.changes, removed.before, removed.after))).toEqual([
      'A1',
      'A3',
    ]);
  });

  it('여러 곳을 한 번에 고치면(다중 커서) 각 줄이 고친 줄이 된다', () => {
    const { changes, before, after } = apply(base, [
      { from: 0, insert: '#' },
      { from: 12, insert: '#' },
    ]);
    expect(authors(mapBlame(lines, changes, before, after))).toEqual([null, 'A2', null]);
  });

  it('HEAD 에 없는 파일(blame 없음)은 그대로 둔다', () => {
    const { changes, before, after } = apply(base, [{ from: 0, insert: 'x' }]);
    expect(mapBlame([], changes, before, after)).toEqual([]);
  });

  it('문서 상태에 넣은 blame·HEAD 원문은 편집과 다시 구성(설정 변경)을 지나도 남는다', () => {
    const extension = (current: boolean) =>
      annotationExtension({
        current,
        all: false,
        changes: true,
        openCommit: vi.fn(),
        preview: vi.fn(),
      });
    const slot = new Compartment();
    let state = EditorState.create({ doc: base, extensions: [slot.of(extension(true))] });
    expect(blameOf(state)).toBeNull();
    state = state.update({ effects: setGitBase.of({ lines, head: base }) }).state;
    state = state.update({ changes: { from: 7, insert: 'X' } }).state;
    expect(authors(blameOf(state) ?? [])).toEqual(['A1', null, 'A3']);
    expect([...lineChangesOf(state).keys()]).toEqual([2]);
    // 인라인 Blame 설정을 꺼서 다시 구성해도 넣어 둔 값은 그대로다
    state = state.update({ effects: slot.reconfigure(extension(false)) }).state;
    expect(authors(blameOf(state) ?? [])).toEqual(['A1', null, 'A3']);
    expect([...lineChangesOf(state).keys()]).toEqual([2]);
  });
});

// ── 편집기 화면: 언제 조회하는가 ──

let session = 7000;
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
});
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  clearSessionRegistry();
  vi.useRealTimers();
});

const HEAD_A = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
const TEXT = 'line1\nline2\nline3\n';

/** 저장소 세션 흉내 (HEAD·상태만 바꾼다) 와 조회를 세는 클라이언트로 편집기를 연다 */
async function mountEditor() {
  let revision = 1;
  let disk = TEXT;
  const blameContents = vi.fn<IpcClient['blameContents']>(async (_s, _p, text) =>
    text
      .split('\n')
      .slice(0, -1)
      .map((_, i) => blame(i + 1)),
  );
  const revisionFileContent = vi.fn<IpcClient['revisionFileContent']>(async () => TEXT);
  const client: IpcClient = {
    ...createNullClient(),
    blameContents,
    revisionFileContent,
    fsReadEditableFile: async (): Promise<FsEditableFile> => ({
      kind: 'text',
      text: disk,
      size: disk.length,
      bom: false,
      lineEnding: 'lf',
      fileKey: `annot-${session}`,
      revision: String(revision),
    }),
    fsSaveFile: vi.fn(async (_s, _p, _r, text) => {
      disk = text;
      revision += 1;
      return { kind: 'saved' as const, revision: String(revision) };
    }),
  };
  const repo = createStore(() => ({
    id: session,
    path: '/r',
    refs: { head: HEAD_A as typeof HEAD_A | { state: 'detached'; oid: string } },
    status: { n: 0 },
    fileTree: createStore(() => ({ epoch: 0 })),
    jumpToCommit: vi.fn(),
  }));
  registerSession(session, { cache: { dispose: () => {} } as never, store: repo as never });
  const doc = (await fileEditors.open(client, session, 'a.ts')) as EditorFile;
  render(
    <FileEditor
      doc={doc}
      source={{ client, session, path: 'a.ts' }}
      repoTools={{ repoName: 'r', path: 'a.ts', onHistory: vi.fn(), onBlame: vi.fn() }}
    />,
  );
  /** 입력이 멈춘 뒤 조회·응답까지 */
  const settle = async (ms = 600) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  /** 끝에 글자를 하나 친다 */
  const type = (at: number, ch: string) =>
    act(() =>
      fileEditors.update(doc, doc.state.update({ changes: { from: at, insert: ch } }).state),
    );
  /** 저장 화면을 갱신한 것처럼 세션 상태를 바꾼다 (자동 저장 뒤 status 갱신) */
  const statusChanged = () => act(() => repo.setState({ status: { n: Math.random() } }));
  return {
    doc,
    repo,
    blameContents,
    revisionFileContent,
    settle,
    type,
    statusChanged,
    setDisk: (text: string) => {
      disk = text;
      revision += 1;
    },
  };
}

describe('편집기의 blame·HEAD 원문 조회 시점', () => {
  it('열 때 한 번 조회하고, 1분 동안 치고 저장해도 다시 조회하지 않으며 blame 은 편집을 따라간다', async () => {
    const t = await mountEditor();
    await t.settle();
    expect(t.blameContents).toHaveBeenCalledTimes(1);
    expect(t.revisionFileContent).toHaveBeenCalledTimes(1);
    // 조회 결과는 문서 끝의 빈 줄을 세지 않는다
    expect(authors(blameOf(t.doc.state) ?? [])).toEqual(['A1', 'A2', 'A3']);
    // 1분: 2초마다 글자 몇 개를 치고 쉰다 (자동 저장 → status 갱신이 따라온다)
    for (let round = 0; round < 30; round++) {
      for (let k = 0; k < 5; k++) {
        t.type(11, 'x');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      t.statusChanged();
    }
    expect(t.blameContents).toHaveBeenCalledTimes(1);
    expect(t.revisionFileContent).toHaveBeenCalledTimes(1);
    // 고친 2번째 줄만 고친 줄이고 나머지 blame 은 남는다. 변경 표시는 2번째 줄
    expect(authors(blameOf(t.doc.state) ?? [])).toEqual(['A1', null, 'A3', null]);
    expect([...lineChangesOf(t.doc.state).keys()]).toEqual([2]);
  });

  it('HEAD 가 바뀌면 다시 조회하고, 같은 HEAD 로 refs 만 다시 읽히면 조회하지 않는다', async () => {
    const t = await mountEditor();
    await t.settle();
    act(() => t.repo.setState({ refs: { head: { ...HEAD_A } } }));
    await t.settle();
    expect(t.blameContents).toHaveBeenCalledTimes(1);
    act(() => t.repo.setState({ refs: { head: { state: 'detached', oid: 'b'.repeat(40) } } }));
    await t.settle();
    expect(t.blameContents).toHaveBeenCalledTimes(2);
    expect(t.revisionFileContent).toHaveBeenCalledTimes(2);
  });

  it('원문을 다시 읽어 교체하면 다시 조회한다', async () => {
    const t = await mountEditor();
    await t.settle();
    t.setDisk('line1\nchanged\nline3\n');
    await act(async () => {
      await fileEditors.refreshAll({ force: true });
    });
    await t.settle();
    expect(t.blameContents).toHaveBeenCalledTimes(2);
    expect(t.blameContents.mock.calls[1]?.[2]).toBe('line1\nchanged\nline3\n');
  });

  it('조회 응답이 오기 전에 원문이 바뀌면 그 응답을 버리고 다음 멈춤에 다시 조회한다', async () => {
    const t = await mountEditor();
    let release!: () => void;
    t.blameContents.mockImplementationOnce(
      (_s, _p, text) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              text
                .split('\n')
                .slice(0, -1)
                .map((_, i) => blame(i + 1, 'stale')),
            );
        }),
    );
    await t.settle();
    t.type(0, 'y');
    await act(async () => release());
    expect(blameOf(t.doc.state)).toBeNull();
    await t.settle();
    expect(t.blameContents).toHaveBeenCalledTimes(2);
    expect(authors(blameOf(t.doc.state) ?? [])[0]).toBe('A1');
  });

  it('HEAD 비교 값은 branch·commit 으로 정한다', () => {
    expect(headKeyOf(HEAD_A)).toBe(headKeyOf({ ...HEAD_A }));
    expect(headKeyOf(HEAD_A)).not.toBe(headKeyOf({ ...HEAD_A, oid: 'c'.repeat(40) }));
    expect(headKeyOf({ state: 'unborn', branch: 'main' })).toBe('unborn:main');
    expect(headKeyOf(null)).toBe('');
  });
});

describe('2초 변경 검사', () => {
  /** 표지와 원문 읽기를 세는 클라이언트로 문서 하나를 연다 */
  async function openDoc(stamps: () => (string | null)[]) {
    const fsReadEditableFile = vi.fn(
      async (): Promise<FsEditableFile> => ({
        kind: 'text',
        text: 'a\n',
        size: 2,
        bom: false,
        lineEnding: 'lf',
        fileKey: `stamp-${session}`,
        revision: '1',
      }),
    );
    const fsFileStamps = vi.fn(async () => stamps());
    const client: IpcClient = { ...createNullClient(), fsReadEditableFile, fsFileStamps };
    await fileEditors.open(client, session, 'a.ts');
    fsReadEditableFile.mockClear();
    return { fsReadEditableFile, fsFileStamps };
  }

  it('표지가 지난번과 같으면 원문을 읽지 않고, 바뀌면 읽는다. 창 포커스(force)는 늘 읽는다', async () => {
    let stamp = 's1';
    const t = await openDoc(() => [stamp]);
    await fileEditors.refreshSession(session);
    expect(t.fsReadEditableFile).toHaveBeenCalledTimes(1);
    await fileEditors.refreshSession(session);
    await fileEditors.refreshSession(session);
    expect(t.fsReadEditableFile).toHaveBeenCalledTimes(1);
    expect(t.fsFileStamps).toHaveBeenCalledTimes(3);
    expect(t.fsFileStamps).toHaveBeenLastCalledWith(session, ['a.ts']);
    stamp = 's2';
    await fileEditors.refreshSession(session);
    expect(t.fsReadEditableFile).toHaveBeenCalledTimes(2);
    await fileEditors.refreshSession(session, { force: true });
    expect(t.fsReadEditableFile).toHaveBeenCalledTimes(3);
  });

  it('표지를 모르면(null) 예전처럼 매번 읽는다', async () => {
    const t = await openDoc(() => [null]);
    await fileEditors.refreshSession(session);
    await fileEditors.refreshSession(session);
    expect(t.fsReadEditableFile).toHaveBeenCalledTimes(2);
  });
});
