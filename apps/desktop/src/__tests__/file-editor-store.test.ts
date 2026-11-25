import { redo, undo } from '@codemirror/commands';
import type { EditorState, Transaction } from '@codemirror/state';
import { createNullClient, type FsEditableFile, type FsSaveResult } from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EditorFile, FileEditorStore, fileText } from '../store/file-editor-store';

/** 수동 응답으로 저장과 외부 변경의 경합 순서를 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 동일 파일을 서로 다른 세션에서 여는 가짜 디스크를 만든다. */
function fixture(text = 'start\n') {
  const store = new FileEditorStore();
  let disk = text;
  let revision = 1;
  const snapshot = (): FsEditableFile => ({
    kind: 'text',
    text: disk,
    size: disk.length,
    fileKey: 'canonical-file',
    revision: String(revision),
    bom: disk.startsWith('\uFEFF'),
    lineEnding: disk.includes('\r\n') ? 'crlf' : 'lf',
  });
  const read = vi.fn(async () => snapshot());
  const save = vi.fn(
    async (
      _session: number,
      _path: string,
      expected: string,
      next: string,
    ): Promise<FsSaveResult> => {
      if (expected !== String(revision)) return { kind: 'conflict' };
      disk = next;
      revision += 1;
      return { kind: 'saved', revision: String(revision) };
    },
  );
  const client = { ...createNullClient(), fsReadEditableFile: read, fsSaveFile: save };
  return {
    store,
    client,
    read,
    save,
    snapshot,
    disk: () => disk,
    external: (next: string) => {
      disk = next;
      revision += 1;
    },
    open: async (session = 1, path = 'a.ts') =>
      (await store.open(client, session, path)) as EditorFile,
  };
}

/** 실제 편집 트랜잭션을 문서 저장소에 전달한다. */
function edit(store: FileEditorStore, doc: EditorFile, text: string): void {
  store.update(
    doc,
    doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: text } }).state,
  );
}

/** 화면 없이 실행 취소 명령에 필요한 편집기 인터페이스를 제공한다. */
function commandTarget(store: FileEditorStore, doc: EditorFile) {
  return {
    get state(): EditorState {
      return doc.state;
    },
    dispatch(transaction: Transaction) {
      store.update(doc, transaction.state);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('shared file editor documents', () => {
  it('does not save an opened file and debounces edits for a full second', async () => {
    const f = fixture();
    const doc = await f.open();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.save).not.toHaveBeenCalled();
    edit(f.store, doc, 'first');
    await vi.advanceTimersByTimeAsync(800);
    edit(f.store, doc, 'second');
    await vi.advanceTimersByTimeAsync(999);
    expect(f.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.disk()).toBe('second');
    expect(doc.status).toBe('saved');
  });

  it('shares drafts and undo across folder/repository aliases and pins both', async () => {
    const f = fixture();
    const pin1 = vi.fn();
    const pin2 = vi.fn();
    const doc = (await f.store.open(f.client, 1, 'a.ts', { onDirty: pin1 })) as EditorFile;
    const same = await f.store.open(f.client, 2, 'repo/a.ts', { onDirty: pin2 });
    expect(same).toBe(doc);
    edit(f.store, doc, 'shared');
    expect(pin1).toHaveBeenCalledOnce();
    expect(pin2).toHaveBeenCalledOnce();
    expect(undo(commandTarget(f.store, doc))).toBe(true);
    expect(doc.state.doc.toString()).toBe('start\n');
    expect(redo(commandTarget(f.store, doc))).toBe(true);
    expect(doc.state.doc.toString()).toBe('shared');
    f.store.releaseSession(1);
    expect(f.store.get(2, 'repo/a.ts')).toBe(doc);
    expect(await f.store.flush(2)).toBe(true);
    expect(f.save).toHaveBeenLastCalledWith(2, 'repo/a.ts', '1', 'shared');
  });

  it('defers autosave and immediate save during IME composition', async () => {
    const f = fixture();
    const doc = await f.open();
    f.store.composition(doc, true);
    edit(f.store, doc, '한');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f.store.flush()).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    edit(f.store, doc, '한글');
    f.store.composition(doc, false);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.disk()).toBe('한글');
  });

  it('serializes saves and drains new input when closing during a save', async () => {
    const f = fixture();
    const doc = await f.open();
    const pending = deferred<FsSaveResult>();
    f.save.mockImplementationOnce(() => pending.promise);
    edit(f.store, doc, 'first');
    const close = f.store.flush();
    edit(f.store, doc, 'latest');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.save).toHaveBeenCalledOnce();
    pending.resolve({ kind: 'saved', revision: '1' });
    expect(await close).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.disk()).toBe('latest');
    expect(doc.dirty).toBe(false);
  });

  it('keeps newer input dirty when an older save completes', async () => {
    const f = fixture();
    const doc = await f.open();
    const pending = deferred<FsSaveResult>();
    f.save.mockImplementationOnce(() => pending.promise);
    edit(f.store, doc, 'first');
    const saving = f.store.save(doc);
    edit(f.store, doc, 'latest');
    pending.resolve({ kind: 'saved', revision: '2' });
    await saving;
    expect(doc.state.doc.toString()).toBe('latest');
    expect(doc.status).toBe('pending');
    expect(doc.dirty).toBe(true);
  });

  it('preserves BOM, CRLF, Unicode and the edited final newline', async () => {
    const f = fixture('\uFEFF한글\r\n😀\r\n');
    const doc = await f.open();
    expect(doc.state.doc.toString()).toBe('한글\n😀\n');
    edit(f.store, doc, '한글 수정\n😀');
    expect(fileText(doc)).toBe('\uFEFF한글 수정\r\n😀');
    await f.store.flush();
    expect(f.disk()).toBe('\uFEFF한글 수정\r\n😀');
  });

  it('reloads a clean external change but suspends dirty drafts', async () => {
    const f = fixture();
    const doc = await f.open();
    f.external('external');
    await f.store.refreshAll();
    expect(doc.state.doc.toString()).toBe('external');
    edit(f.store, doc, 'draft');
    doc.error = 'Previous save failed';
    f.external('new external');
    await f.store.refreshSession(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(doc.status).toBe('conflict');
    expect(doc.error).toBeNull();
    expect(doc.state.doc.toString()).toBe('draft');
    expect(f.save).not.toHaveBeenCalled();
    expect(await f.store.flush()).toBe(false);
  });

  it('keeps drafts on missing files and allows explicit discard to close', async () => {
    const f = fixture();
    const doc = await f.open();
    edit(f.store, doc, 'draft');
    f.read.mockResolvedValue({ kind: 'missing' });
    await f.store.refreshAll();
    expect(await f.store.flush()).toBe(false);
    expect(doc.state.doc.toString()).toBe('draft');
    await f.store.discard();
    expect(await f.store.flush()).toBe(true);
    f.store.releaseSession(1);
    expect(f.store.documents()).toHaveLength(0);
  });

  it('ignores a stale external read that completes after a successful save', async () => {
    const f = fixture();
    const doc = await f.open();
    const pending = deferred<FsEditableFile>();
    f.read.mockImplementationOnce(() => pending.promise);
    const refresh = f.store.refresh(doc);
    edit(f.store, doc, 'saved');
    await f.store.flush();
    pending.resolve({ kind: 'missing' });
    await refresh;
    expect(doc.status).toBe('saved');
    expect(doc.state.doc.toString()).toBe('saved');
  });

  it('ignores a stale read failure after a successful save', async () => {
    const f = fixture();
    const doc = await f.open();
    let rejectRead!: (error: Error) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const refresh = f.store.refresh(doc);
    edit(f.store, doc, 'saved');
    await f.store.flush();
    rejectRead(new Error('Old read failed'));
    await refresh;
    expect(doc.status).toBe('saved');
    expect(doc.error).toBeNull();
    expect(doc.state.doc.toString()).toBe('saved');
  });

  it('preserves drafts on save failure and retries only explicitly', async () => {
    const f = fixture();
    const doc = await f.open();
    f.save.mockResolvedValueOnce({ kind: 'failed', message: 'disk full' });
    edit(f.store, doc, 'draft');
    expect(await f.store.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.save).toHaveBeenCalledOnce();
    expect(doc.error).toBe('disk full');
    expect(doc.state.doc.toString()).toBe('draft');
    expect(await f.store.flush()).toBe(true);
  });

  it('uses a newly read revision for overwrite and stops at a further conflict', async () => {
    const f = fixture();
    const doc = await f.open();
    edit(f.store, doc, 'draft');
    f.external('outside');
    await f.store.refresh(doc);
    f.save.mockResolvedValueOnce({ kind: 'conflict' });
    expect(await f.store.overwrite(doc)).toBe(false);
    expect(f.save).toHaveBeenLastCalledWith(1, 'a.ts', '2', 'draft');
    expect(doc.status).toBe('conflict');
    expect(doc.state.doc.toString()).toBe('draft');
  });

  it('does not discard edits made after reload confirmation', async () => {
    const f = fixture();
    const doc = await f.open();
    edit(f.store, doc, 'draft');
    const pending = deferred<FsEditableFile>();
    f.read.mockImplementationOnce(() => pending.promise);
    const reload = f.store.reload(doc);
    edit(f.store, doc, 'later input');
    pending.resolve(f.snapshot());
    await reload;
    expect(doc.state.doc.toString()).toBe('later input');
    expect(doc.status).toBe('conflict');
  });
});

describe('파일 구조 변경과 편집 상태', () => {
  it('구조 변경 잠금 중 입력과 외부 변경 조회를 멈춘다', async () => {
    const f = fixture();
    const doc = await f.open();
    f.store.lockMutation([doc], true);
    edit(f.store, doc, 'unexpected');
    f.external('outside');
    await f.store.refresh(doc);
    expect(doc.state.doc.toString()).toBe('start\n');
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(await f.store.save(doc)).toBe(false);
    f.store.lockMutation([doc], false);
    await f.store.refresh(doc);
    expect(doc.state.doc.toString()).toBe('outside');
  });
  it('이동 후 두 세션 별칭을 새 경로로 연결하고 편집 이력을 유지한다', async () => {
    const f = fixture();
    const doc = await f.open();
    await f.open(2, 'nested/a.ts');
    edit(f.store, doc, 'saved edit');
    await f.store.flush();
    const state = doc.state;
    f.read.mockResolvedValue({ ...f.snapshot(), fileKey: 'moved-file' } as FsEditableFile);
    await f.store.remap(doc, [
      { client: f.client, session: 1, path: 'b.ts' },
      { client: f.client, session: 2, path: 'nested/b.ts' },
    ]);
    expect(f.store.get(1, 'a.ts')).toBeUndefined();
    expect(f.store.get(2, 'nested/a.ts')).toBeUndefined();
    expect(f.store.get(1, 'b.ts')).toBe(doc);
    expect(f.store.get(2, 'nested/b.ts')).toBe(doc);
    expect(doc.state).toBe(state);
    expect(doc.fileKey).toBe('moved-file');
    expect(undo(commandTarget(f.store, doc))).toBe(true);
    expect(doc.state.doc.toString()).toBe('start\n');
  });
});
