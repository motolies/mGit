// 편집기 저장소의 주제별 알림 (반응성 F1): 바뀐 것 없는 검사는 아무도 깨우지 않고, 문서·그림 재확인·탭 표시 구독자는
// 자기 주제가 바뀔 때만 깨어난다.
import {
  createNullClient,
  type FsEditableFile,
  type FsSaveResult,
  type IpcClient,
} from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditor } from '../features/workspace/FileEditor';
import { type EditorFile, FileEditorStore, fileEditors } from '../store/file-editor-store';
import { useEditorImageEpoch, useEditorMarks } from '../store/use-file-editors';

/** 파일 여러 개를 가진 가짜 디스크. 표지는 revision 을 그대로 쓴다 */
function disk(paths: string[]) {
  const files = new Map(paths.map((path) => [path, { text: `${path}\n`, revision: 1 }]));
  const entry = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`no file ${path}`);
    return file;
  };
  const read = vi.fn(async (_session: number, path: string): Promise<FsEditableFile> => {
    const file = entry(path);
    return {
      kind: 'text',
      text: file.text,
      size: file.text.length,
      bom: false,
      lineEnding: 'lf',
      fileKey: `topic-${path}`,
      revision: String(file.revision),
    };
  });
  const stamps = vi.fn(async (_session: number, list: string[]) =>
    list.map((path) => String(entry(path).revision)),
  );
  let saveResult: FsSaveResult | null = null;
  const save = vi.fn(
    async (
      _session: number,
      path: string,
      expected: string,
      text: string,
    ): Promise<FsSaveResult> => {
      if (saveResult) return saveResult;
      const file = entry(path);
      if (expected !== String(file.revision)) return { kind: 'conflict' };
      file.text = text;
      file.revision += 1;
      return { kind: 'saved', revision: String(file.revision) };
    },
  );
  const client: IpcClient = {
    ...createNullClient(),
    fsReadEditableFile: read,
    fsFileStamps: stamps,
    fsSaveFile: save,
  };
  return {
    client,
    read,
    stamps,
    save,
    /** 다른 프로그램이 파일을 바꾼다 */
    external(path: string, text: string) {
      const file = entry(path);
      file.text = text;
      file.revision += 1;
    },
    failSaves(result: FsSaveResult | null) {
      saveResult = result;
    },
  };
}

/** 구독 호출 수를 센다 */
function counter() {
  const counts = { n: 0 };
  return {
    counts,
    listener: () => {
      counts.n += 1;
    },
  };
}

/** 문서 전체를 바꾸는 편집 */
function edit(store: FileEditorStore, doc: EditorFile, text: string): void {
  store.update(
    doc,
    doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: text } }).state,
  );
}

/** 워크스페이스처럼 탭 표시만 구독하고 그릴 때마다 알린다 */
function MarksProbe({ session, onRender }: { session: number; onRender: () => void }) {
  useEditorMarks(session);
  onRender();
  return null;
}

/** 미리보기처럼 그림 재확인 신호를 받아 그 값을 알린다 */
function ImageProbe({ doc, onEpoch }: { doc: EditorFile; onEpoch: (epoch: number) => void }) {
  onEpoch(useEditorImageEpoch(doc));
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('편집기 저장소 알림 주제 (F1)', () => {
  /** 저장소 하나에 a·b 두 문서를 열고 주제별 계수기를 단다 */
  async function setup() {
    const d = disk(['a.ts', 'b.ts']);
    const store = new FileEditorStore();
    const a = (await store.open(d.client, 1, 'a.ts')) as EditorFile;
    const b = (await store.open(d.client, 1, 'b.ts')) as EditorFile;
    const all = counter();
    const marks = counter();
    const docA = counter();
    const docB = counter();
    const imageA = counter();
    store.subscribe(all.listener);
    store.subscribeMarks(marks.listener);
    store.subscribeDoc(a, docA.listener);
    store.subscribeDoc(b, docB.listener);
    store.subscribeImage(a, imageA.listener);
    const n = () => ({
      all: all.counts.n,
      marks: marks.counts.n,
      docA: docA.counts.n,
      docB: docB.counts.n,
      imageA: imageA.counts.n,
    });
    return { d, store, a, b, n };
  }

  it('바뀐 것 없는 주기 검사·창 포커스 검사는 아무도 깨우지 않고 그 문서의 그림 재확인만 알린다', async () => {
    const t = await setup();
    const version = t.store.getVersion();
    await t.store.refreshAll();
    await t.store.refreshAll();
    await t.store.refreshSession(1);
    await t.store.refreshAll({ force: true });
    expect(t.n()).toEqual({ all: 0, marks: 0, docA: 0, docB: 0, imageA: 4 });
    expect(t.store.getVersion()).toBe(version);
    expect(t.a.imageEpoch).toBe(4);
  });

  it('문서 A 의 입력은 B 를 깨우지 않고, 이미 저장 안 된 문서에 글자를 더해도 탭 표시 구독자는 그대로다', async () => {
    const t = await setup();
    edit(t.store, t.a, 'one');
    expect(t.n()).toMatchObject({ docA: 1, docB: 0, marks: 1, all: 1 });
    expect(t.store.marks().get(JSON.stringify([1, 'a.ts']))).toBe('unsaved');
    edit(t.store, t.a, 'two');
    edit(t.store, t.a, 'three');
    expect(t.n()).toMatchObject({ docA: 3, docB: 0, marks: 1 });
    // 1초 뒤 자동 저장: 저장 중(여전히 저장 안 됨)은 그대로, 저장 끝(깨끗)에 깨어난다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(t.a.status).toBe('saved');
    expect(t.n()).toMatchObject({ docB: 0, marks: 2 });
    expect(t.store.marks().size).toBe(0);
  });

  it('충돌·오류 전환에는 탭 표시 구독자가 깨어난다', async () => {
    const t = await setup();
    edit(t.store, t.a, 'draft');
    expect(t.n().marks).toBe(1);
    t.d.external('a.ts', 'outside\n');
    await t.store.refreshAll();
    expect(t.a.status).toBe('conflict');
    expect(t.n().marks).toBe(2);
    expect(t.store.marks().get(JSON.stringify([1, 'a.ts']))).toBe('conflict');
    // b 의 저장 실패 → 오류
    t.d.failSaves({ kind: 'failed', message: 'disk full' });
    edit(t.store, t.b, 'b draft');
    expect(t.n().marks).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(t.b.status).toBe('error');
    expect(t.n().marks).toBe(4);
    expect(t.store.marksOf(1)).toContain('error');
  });

  it('표지가 바뀌면(외부 변경) 그 문서만 다시 읽어 바꾸고 그 문서 구독자에게 알린다', async () => {
    const t = await setup();
    await t.store.refreshAll();
    t.d.read.mockClear();
    t.d.external('a.ts', 'changed outside\n');
    await t.store.refreshAll();
    expect(t.d.read).toHaveBeenCalledTimes(1);
    expect(t.a.state.doc.toString()).toBe('changed outside\n');
    expect(t.n()).toMatchObject({ docA: 1, docB: 0, marks: 0 });
  });
});

describe('편집기 구독 훅 (F1)', () => {
  let session = 7100;
  beforeEach(() => {
    session += 1;
  });
  afterEach(async () => {
    cleanup();
    await fileEditors.discard(session);
    fileEditors.releaseSession(session);
  });

  it('편집기는 자기 문서가 바뀔 때만 다시 그리고, 바뀐 것 없는 검사에는 그리지 않는다', async () => {
    const d = disk(['a.ts', 'b.ts']);
    const a = (await fileEditors.open(d.client, session, 'a.ts')) as EditorFile;
    const b = (await fileEditors.open(d.client, session, 'b.ts')) as EditorFile;
    const commits = { a: 0, b: 0 };
    render(
      <>
        <Profiler
          id="a"
          onRender={() => {
            commits.a += 1;
          }}
        >
          <FileEditor doc={a} source={{ client: d.client, session, path: 'a.ts' }} />
        </Profiler>
        <Profiler
          id="b"
          onRender={() => {
            commits.b += 1;
          }}
        >
          <FileEditor doc={b} source={{ client: d.client, session, path: 'b.ts' }} />
        </Profiler>
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = { ...commits };
    act(() => edit(fileEditors, a, 'typed'));
    expect(commits.a).toBeGreaterThan(before.a);
    expect(commits.b).toBe(before.b);
    const typed = { ...commits };
    await act(async () => {
      await fileEditors.refreshSession(session);
      await fileEditors.refreshSession(session);
    });
    expect(commits).toEqual(typed);
  });

  it('외부에서 파일이 바뀌면 그 문서의 편집기가 새 원문을 보인다', async () => {
    const d = disk(['a.ts']);
    const a = (await fileEditors.open(d.client, session, 'a.ts')) as EditorFile;
    const view = render(
      <FileEditor doc={a} source={{ client: d.client, session, path: 'a.ts' }} />,
    );
    await act(async () => {
      await fileEditors.refreshSession(session);
    });
    d.external('a.ts', 'from another program\n');
    await act(async () => {
      await fileEditors.refreshSession(session);
    });
    expect(view.container.querySelector('.cm-content')?.textContent).toContain(
      'from another program',
    );
  });

  it('탭 표시 구독은 저장 안 됨·저장됨 전환에만 다시 그리고, 그림 재확인 신호는 미리보기 쪽에 계속 전달된다', async () => {
    const d = disk(['a.md']);
    const a = (await fileEditors.open(d.client, session, 'a.md')) as EditorFile;
    const renders = { marks: 0 };
    const epochs: number[] = [];
    render(
      <>
        <MarksProbe session={session} onRender={() => (renders.marks += 1)} />
        <ImageProbe doc={a} onEpoch={(epoch) => epochs.push(epoch)} />
      </>,
    );
    const start = renders.marks;
    await act(async () => {
      await fileEditors.refreshSession(session);
      await fileEditors.refreshSession(session);
    });
    expect(renders.marks).toBe(start);
    expect(epochs.at(-1)).toBe(2);
    act(() => edit(fileEditors, a, 'one'));
    expect(renders.marks).toBe(start + 1);
    act(() => edit(fileEditors, a, 'two'));
    act(() => edit(fileEditors, a, 'three'));
    expect(renders.marks).toBe(start + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(a.status).toBe('saved');
    expect(renders.marks).toBe(start + 2);
  });
});
