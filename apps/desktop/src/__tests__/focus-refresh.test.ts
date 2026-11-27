// 창 포커스 복귀 갱신 조율 (반응성 G4, R9): 연달아 온 포커스는 한 번, 간격 안은 건너뜀, 보이는 것 먼저, 등록·해제가 새지
// 않음. 폴더 주기 재조회와 포커스가 겹치지 않음, 보이지 않는 동안 미룸, 뒤 탭은 다시 열 때 오래됐으면 한 번. 열린 파일은 보이는
// 것만 강제로 읽고 나머지는 보일 때 읽음. 파일 트리 배경 다시 읽기는 나열 묶음을 바꾸지 않음
import {
  createNullClient,
  type FsDirListing,
  type FsEditableFile,
  type FsEntry,
  type IpcClient,
  type RepoSummary,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFileEditorLifecycle } from '../file-editor-lifecycle';
import { type EditorFile, FileEditorStore, fileEditors } from '../store/file-editor-store';
import { createFileTree, type FileTreeSource } from '../store/file-tree';
import {
  FOCUS_REFRESH_GAP_MS,
  FOCUS_TIER_WAIT_MS,
  FocusTier,
  focusRefreshers,
  onFocusRefresh,
} from '../store/focus-refresh';
import { createFolderStore } from '../store/folder-store';

/** 창 포커스를 보내고 차례가 끝나기를 기다린다 */
async function focus() {
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
}

/** 창의 보임 상태를 바꾸고 알린다 */
let visibility: DocumentVisibilityState = 'visible';
async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('포커스 갱신 조율기', () => {
  it('연달아 온 포커스는 한 번만 돌리고, 간격 안의 포커스는 건너뛰고, 간격이 지나면 다시 돌린다', async () => {
    const run = vi.fn();
    const off = onFocusRefresh({ name: 't', tier: FocusTier.tab, run });
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await setVisibility('visible');
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_GAP_MS - 1);
    await focus();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await focus();
    expect(run).toHaveBeenCalledTimes(2);
    off();
  });

  it('듣는 쪽이 스스로 갱신한 시각도 보고, 간격 0 이면 매번 돌린다', async () => {
    let own: number | null = null;
    const quiet = vi.fn();
    const always = vi.fn();
    const offQuiet = onFocusRefresh({
      name: 'quiet',
      tier: FocusTier.tab,
      run: quiet,
      lastRefreshedAt: () => own,
    });
    const offAlways = onFocusRefresh({
      name: 'always',
      tier: FocusTier.visible,
      gapMs: 0,
      run: always,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    own = performance.now();
    await focus();
    expect(quiet).not.toHaveBeenCalled();
    await focus();
    expect(always).toHaveBeenCalledTimes(2);
    offQuiet();
    offAlways();
  });

  it('보이는 것 먼저: 앞 단계가 끝나야 다음 단계를 돌리고, 한 쪽의 실패가 다른 쪽을 막지 않는다', async () => {
    const order: string[] = [];
    let release = () => {};
    const off = [
      onFocusRefresh({
        name: 'rest',
        tier: FocusTier.rest,
        run: () => order.push('rest'),
      }),
      onFocusRefresh({
        name: 'tab',
        tier: FocusTier.tab,
        run: () => {
          order.push('tab');
          throw new Error('읽기 실패');
        },
      }),
      onFocusRefresh({
        name: 'visible',
        tier: FocusTier.visible,
        run: () => {
          order.push('visible');
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    ];
    await focus();
    expect(order).toEqual(['visible']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['visible', 'tab', 'rest']);
    for (const f of off) f();
  });

  it('앞 단계가 끝나지 않아도 기다리는 시간이 지나면 다음 단계를 돌리고, 그 뒤의 포커스도 막히지 않는다', async () => {
    const order: string[] = [];
    const off = [
      onFocusRefresh({
        name: 'stuck',
        tier: FocusTier.visible,
        run: () => {
          order.push('stuck');
          return new Promise<void>(() => {});
        },
      }),
      onFocusRefresh({
        name: 'next',
        tier: FocusTier.tab,
        gapMs: 0,
        run: () => order.push('next'),
      }),
    ];
    await focus();
    expect(order).toEqual(['stuck']);
    await vi.advanceTimersByTimeAsync(FOCUS_TIER_WAIT_MS);
    expect(order).toEqual(['stuck', 'next']);
    await focus();
    expect(order).toEqual(['stuck', 'next', 'next']);
    for (const f of off) f();
  });

  it('해제하면 빠지고, 마지막 해제 뒤에는 창 이벤트도 떼어 포커스에 아무것도 돌지 않는다', async () => {
    const run = vi.fn();
    const before = focusRefreshers().length;
    const off = onFocusRefresh({ name: 'tab-a', tier: FocusTier.tab, run });
    expect(focusRefreshers()).toContain('tab-a');
    off();
    expect(focusRefreshers()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_GAP_MS);
    await focus();
    expect(run).not.toHaveBeenCalled();
  });
});

/** 요약 한 줄 */
function summary(): RepoSummary {
  return {
    path: '/f/a',
    name: 'a',
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
  };
}

/** 주기 30초 폴더 스토어 (열자마자 읽는 것까지 끝낸 상태). `reads()` 는 요약 읽기 수 */
async function folder(autoRefreshSecs = 30) {
  const folderSummaries = vi.fn(async () => [summary()]);
  const fsListDir = vi.fn(
    async (): Promise<FsDirListing> => ({
      kind: 'listed',
      entries: [],
      total: 0,
      truncated: false,
      nonUtf8Names: 0,
    }),
  );
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries,
    fsListDir,
    folderSettings: vi.fn(async () => ({
      exclude: [],
      pullMode: 'ffOnly' as const,
      concurrency: 4,
      autoRefreshSecs,
      worktreeRoot: null,
    })),
  };
  const store = createFolderStore({ session: 3, path: '/f', repos: [] }, client);
  await vi.advanceTimersByTimeAsync(0);
  expect(folderSummaries).toHaveBeenCalledTimes(1);
  return { store, reads: () => folderSummaries.mock.calls.length, fsListDir };
}

describe('폴더 탭의 포커스·주기 재조회', () => {
  it('포커스로 읽은 직후의 주기 틱은 건너뛰고(주기는 마지막 전부 읽기에서 센다), 주기 틱 직후의 포커스도 건너뛴다', async () => {
    const { store, reads } = await folder();
    const stop = store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(20_000);
    await focus();
    expect(reads()).toBe(2);
    // 예전 주기(30초)의 차례 — 포커스로 10초 전에 읽었으므로 건너뛴다
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads()).toBe(2);
    // 포커스 읽기에서 30초 뒤
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads()).toBe(3);
    // 주기 틱 2초 뒤의 포커스: 요약은 건너뛴다
    await vi.advanceTimersByTimeAsync(2_000);
    await focus();
    expect(reads()).toBe(3);
    stop();
    store.getState().dispose();
  });

  it('사용자가 누른 새로고침은 간격과 무관하게 늘 읽고, 그 뒤 간격 안의 포커스는 건너뛴다', async () => {
    const { store, reads } = await folder();
    const stop = store.getState().startAutoRefresh();
    await store.getState().refresh();
    await store.getState().refresh();
    expect(reads()).toBe(3);
    await focus();
    expect(reads()).toBe(3);
    stop();
    store.getState().dispose();
  });

  it('창이 보이지 않는 동안은 주기 재조회를 미루고, 다시 보이면 한 번 읽는다', async () => {
    const { store, reads } = await folder();
    const stop = store.getState().startAutoRefresh();
    await setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(1);
    await setVisibility('visible');
    expect(reads()).toBe(2);
    // 그다음 주기는 그 읽기에서 30초 뒤
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads()).toBe(3);
    stop();
    store.getState().dispose();
  });

  it('뒤 탭(화면이 없어 켜지 않음)은 갱신하지 않고, 다시 열 때 마지막 읽기가 주기보다 오래됐으면 곧바로 한 번 읽는다', async () => {
    const stale = await folder();
    await vi.advanceTimersByTimeAsync(120_000);
    await focus();
    expect(stale.reads()).toBe(1);
    const stopStale = stale.store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.reads()).toBe(2);
    stopStale();
    stale.store.getState().dispose();

    const fresh = await folder();
    await vi.advanceTimersByTimeAsync(10_000);
    const stopFresh = fresh.store.getState().startAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.reads()).toBe(1);
    stopFresh();
    fresh.store.getState().dispose();
  });

  it('끄면(탭을 닫거나 다른 탭으로 감) 조율기에서 빠진다', async () => {
    const { store } = await folder();
    const stop = store.getState().startAutoRefresh();
    expect(focusRefreshers()).toEqual(
      expect.arrayContaining(['folder:3:summaries', 'folder:3:files']),
    );
    stop();
    expect(focusRefreshers().filter((name) => name.startsWith('folder:3'))).toEqual([]);
    store.getState().dispose();
  });
});

/** 표지 정밀도가 낮은 가짜 디스크: 내용이 바뀌어도 표지가 그대로다 (`coarse` 경로) */
function disk(coarse: string[]) {
  const files = new Map<string, { text: string; revision: number }>();
  const entry = (path: string) => {
    let file = files.get(path);
    if (!file) {
      file = { text: `${path}\n`, revision: 1 };
      files.set(path, file);
    }
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
      fileKey: `g4-${path}`,
      revision: String(file.revision),
    };
  });
  const stamps = vi.fn(async (_session: number, list: string[]) =>
    list.map((path) => (coarse.includes(path) ? 'same' : String(entry(path).revision))),
  );
  const client: IpcClient = {
    ...createNullClient(),
    fsReadEditableFile: read,
    fsFileStamps: stamps,
  };
  return {
    client,
    read,
    /** 다른 프로그램이 파일을 바꾼다 */
    external(path: string, text: string) {
      const file = entry(path);
      file.text = text;
      file.revision += 1;
    },
  };
}

/** 문서의 지금 원문 */
const textOf = (doc: EditorFile) => doc.state.doc.toString();

describe('열린 파일의 포커스 재검사', () => {
  it('보이는 문서는 표지가 그대로여도 원문을 읽고, 뒤 탭 문서는 표지로 검사한 뒤 보일 때 원문을 읽는다', async () => {
    const d = disk(['shown.ts', 'hidden.ts']);
    const store = new FileEditorStore();
    const shown = (await store.open(d.client, 1, 'shown.ts')) as EditorFile;
    const hidden = (await store.open(d.client, 1, 'hidden.ts')) as EditorFile;
    const stamped = (await store.open(d.client, 1, 'stamped.ts')) as EditorFile;
    const offShown = store.subscribeDoc(shown, () => {});
    // 표지를 한 번 받아 둔다 (2초 주기 검사)
    await store.refreshAll();
    d.read.mockClear();
    d.external('shown.ts', 'shown 2\n');
    d.external('hidden.ts', 'hidden 2\n');
    d.external('stamped.ts', 'stamped 2\n');

    await store.refreshShown();
    await store.refreshHidden();
    expect(textOf(shown)).toBe('shown 2\n');
    // 표지가 바뀐 뒤 탭 문서는 바로 읽는다
    expect(textOf(stamped)).toBe('stamped 2\n');
    // 표지가 그대로인 뒤 탭 문서는 아직 옛 원문이다 — 보이기 전에는 읽지 않는다
    expect(textOf(hidden)).toBe('hidden.ts\n');
    expect(d.read.mock.calls.map((call) => call[1]).sort()).toEqual(['shown.ts', 'stamped.ts']);

    // 탭을 열어 보이게 되면 원문을 한 번 읽는다
    const offHidden = store.subscribeDoc(hidden, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(hidden)).toBe('hidden 2\n');
    // 다시 구독해도(다른 탭에 갔다 옴) 포커스 복귀가 없었으면 또 읽지 않는다
    offHidden();
    d.read.mockClear();
    store.subscribeDoc(hidden, () => {})();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.read).not.toHaveBeenCalled();
    offShown();
  });

  it('앱 수명주기가 조율기에 걸어 두어, 창 포커스로 돌아오면 바깥에서 바뀐 보이는 파일이 반영된다', async () => {
    await installFileEditorLifecycle(false);
    expect(focusRefreshers()).toEqual(expect.arrayContaining(['editor:shown', 'editor:hidden']));
    const d = disk(['main.ts']);
    const doc = (await fileEditors.open(d.client, 41, 'main.ts')) as EditorFile;
    const off = fileEditors.subscribeDoc(doc, () => {});
    d.external('main.ts', 'changed outside\n');
    await focus();
    expect(textOf(doc)).toBe('changed outside\n');
    off();
    fileEditors.release(41);
  });
});

/** 나열 응답을 주는 가짜 파일 API. `src` 는 잘린 디렉터리(3개 중 2개)다 */
function treeSource() {
  const entry = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({
    name,
    kind,
    size: kind === 'file' ? 1 : null,
    mtimeMs: 0,
    openable: kind === 'file',
  });
  const list = vi.fn(async (dir: string, limit: number | null): Promise<FsDirListing> => {
    if (dir === '') {
      return {
        kind: 'listed',
        entries: [entry('src', 'dir'), entry('a.md')],
        total: 2,
        truncated: false,
        nonUtf8Names: 0,
      };
    }
    const all = [entry('x.ts'), entry('y.ts'), entry('z.ts')];
    const shown = limit === null ? all.slice(0, 2) : all.slice(0, limit);
    return {
      kind: 'listed',
      entries: shown,
      total: 3,
      truncated: shown.length < 3,
      nonUtf8Names: 0,
    };
  });
  const source: FileTreeSource = { list, read: async () => ({ kind: 'missing' }) };
  return { source, list };
}

describe('파일 트리 배경 다시 읽기', () => {
  it('내용이 같으면 나열 묶음(dirs)이 한 번도 바뀌지 않고, 사용자가 누른 "더 보기"는 읽는 중 표시가 보인다', async () => {
    const { source } = treeSource();
    const tree = createFileTree(source);
    tree.getState().open();
    await vi.advanceTimersByTimeAsync(0);
    tree.getState().setExpanded('src', true);
    await vi.advanceTimersByTimeAsync(0);
    const dirs = tree.getState().dirs;
    let swaps = 0;
    const off = tree.subscribe((now, before) => {
      if (now.dirs !== before.dirs) swaps += 1;
    });
    await tree.getState().reload();
    expect(tree.getState().dirs).toBe(dirs);
    expect(swaps).toBe(0);
    expect(tree.getState().reloadedAt()).not.toBeNull();

    tree.getState().loadMore('src');
    expect(tree.getState().dirs.src?.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const src = tree.getState().dirs.src;
    expect(src?.pending).toBe(false);
    expect(src?.load.state === 'listed' && src.load.entries.length).toBe(3);
    off();
    tree.getState().dispose();
  });
});
