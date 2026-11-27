import type { FsDirListing, FsEntry, FsFile } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import {
  collapsedSelectionState,
  createFileTree,
  type DirMap,
  type FileTreeSource,
  FS_LIST_MAX,
  LIST_CONCURRENCY,
  noteRowId,
  parseNoteRowId,
  pruneVanished,
  rangeSelection,
  type SelectionState,
  survivingSelection,
  survivingSelectionState,
  visibleExpandedDirs,
} from '../store/file-tree';

/** 항목 하나 */
function entry(name: string, kind: FsEntry['kind'] = 'file'): FsEntry {
  return { name, kind, size: kind === 'file' ? 1 : null, mtimeMs: 0, openable: kind === 'file' };
}

/** 나열 응답 */
function listing(entries: FsEntry[], total = entries.length): FsDirListing {
  return { kind: 'listed', entries, total, truncated: total > entries.length, nonUtf8Names: 0 };
}

/** 읽은 디렉터리 상태 */
function listedState(entries: FsEntry[]) {
  return {
    load: {
      state: 'listed' as const,
      entries,
      total: entries.length,
      truncated: false,
      nonUtf8Names: 0,
    },
    limit: null,
    pending: false,
  };
}

/** 대기 중인 요청 하나 */
interface Call {
  dir: string;
  limit: number | null;
  resolve: (listing: FsDirListing) => void;
  reject: (error: unknown) => void;
}

/** 응답을 손으로 주는 가짜 파일 API. `answer` 가 그 디렉터리의 가장 오래된 요청에 답한다 */
function manualSource() {
  const calls: Call[] = [];
  const open: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const source: FileTreeSource = {
    list: (dir, limit) =>
      new Promise<FsDirListing>((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const call: Call = {
          dir,
          limit,
          resolve: (l) => {
            inFlight -= 1;
            resolve(l);
          },
          reject: (e) => {
            inFlight -= 1;
            reject(e);
          },
        };
        calls.push(call);
        open.push(call);
      }),
    read: async (): Promise<FsFile> => ({ kind: 'missing' }),
  };
  /** 그 디렉터리의 가장 오래된 열린 요청에 답한다 */
  const take = (dir: string): Call => {
    const at = open.findIndex((c) => c.dir === dir);
    const call = open[at];
    if (!call) {
      throw new Error(`요청 없음: ${dir}`);
    }
    open.splice(at, 1);
    return call;
  };
  return {
    source,
    calls,
    open,
    maxInFlight: () => maxInFlight,
    answer: async (dir: string, result: FsDirListing) => {
      take(dir).resolve(result);
      await flush();
    },
    fail: async (dir: string, error: unknown) => {
      take(dir).reject(error);
      await flush();
    },
  };
}

/** 약속 사슬이 다 돌게 한다 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 나열 요청한 디렉터리들 */
const dirsOf = (calls: readonly Call[]) => calls.map((c) => c.dir);

describe('순수 함수', () => {
  const dirs: DirMap = {
    '': listedState([entry('api', 'dir'), entry('web', 'dir'), entry('a.md')]),
    api: listedState([entry('src', 'dir')]),
    'api/src': listedState([entry('Main.java')]),
    web: listedState([]),
  };

  it('보이는 펼친 디렉터리: 루트부터, 조상이 접힌 것은 빼고, 아직 안 읽은 것도 넣는다', () => {
    expect(visibleExpandedDirs(dirs, { '': true, api: true, 'api/src': true })).toEqual([
      '',
      'api',
      'api/src',
    ]);
    expect(visibleExpandedDirs(dirs, { '': true, 'api/src': true })).toEqual(['']);
    expect(visibleExpandedDirs({ '': dirs[''] as never }, { '': true, web: true })).toEqual([
      '',
      'web',
    ]);
    expect(visibleExpandedDirs(dirs, { api: true })).toEqual([]);
  });

  it('부모 목록에서 사라진 디렉터리는 그 아래까지 펼침·결과를 지운다. 그대로면 같은 객체다', () => {
    const expanded = { '': true as const, api: true as const, 'api/src': true as const };
    const same = pruneVanished(dirs, expanded);
    expect(same.dirs).toBe(dirs);
    expect(same.expanded).toBe(expanded);
    const next = pruneVanished(
      { ...dirs, '': listedState([entry('web', 'dir'), entry('api')]) },
      expanded,
    );
    // api 가 파일이 되어도 디렉터리로는 사라진 것이다
    expect(Object.keys(next.expanded)).toEqual(['']);
    expect(Object.keys(next.dirs).sort()).toEqual(['', 'web']);
    expect(next.removed.sort()).toEqual(['api', 'api/src']);
  });

  it('선택이 사라지면 남아 있는 가장 가까운 조상으로, 모르는 곳은 그대로 둔다', () => {
    expect(survivingSelection(dirs, 'api/src/Main.java')).toBe('api/src/Main.java');
    expect(survivingSelection({ ...dirs, 'api/src': listedState([]) }, 'api/src/Main.java')).toBe(
      'api/src',
    );
    expect(survivingSelection({ ...dirs, '': listedState([]) }, 'api/src/Main.java')).toBe('');
    // 부모를 아직 안 읽었으면 판단하지 않는다
    expect(survivingSelection({ '': dirs[''] as never }, 'api/x/y')).toBe('api/x/y');
    expect(survivingSelection(dirs, '')).toBe('');
    expect(survivingSelection(dirs, null)).toBeNull();
  });

  it('안내 줄 선택은 그 줄이 사라지면 그 디렉터리로 간다', () => {
    expect(parseNoteRowId(noteRowId('more', 'logs'))).toEqual({ kind: 'more', dir: 'logs' });
    expect(parseNoteRowId('logs')).toBeNull();
    // web 은 비어 있어 상태 줄이 있다
    expect(survivingSelection(dirs, noteRowId('status', 'web'))).toBe(noteRowId('status', 'web'));
    expect(survivingSelection(dirs, noteRowId('status', 'api'))).toBe('api');
    expect(survivingSelection(dirs, noteRowId('more', 'api'))).toBe('api');
  });
});

describe('createFileTree (PT-03·08·09)', () => {
  it('펼칠 때 그 디렉터리만 읽고, 같은 디렉터리를 두 번 읽지 않으며, 접었다 펴도 다시 읽지 않는다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    tree.getState().open();
    expect(dirsOf(s.calls)).toEqual(['']);
    expect(tree.getState().dirs['']).toMatchObject({ load: { state: 'loading' }, pending: true });
    await s.answer('', listing([entry('api', 'dir'), entry('README.md')]));
    expect(tree.getState().dirs['']?.load.state).toBe('listed');

    tree.getState().setExpanded('api', true);
    tree.getState().setExpanded('api', true);
    expect(dirsOf(s.calls)).toEqual(['', 'api']);
    await s.answer('api', listing([entry('pom.xml')]));
    tree.getState().toggle('api');
    expect(tree.getState().expanded.api).toBeUndefined();
    tree.getState().toggle('api');
    expect(tree.getState().expanded.api).toBe(true);
    expect(dirsOf(s.calls)).toEqual(['', 'api']);
  });

  it('없음·권한 없음·오류를 상태로 싣고, 다시 시도하면 다시 읽는다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer(
      '',
      listing([entry('gone', 'dir'), entry('private', 'dir'), entry('bad', 'dir')]),
    );
    for (const dir of ['gone', 'private', 'bad']) {
      tree.getState().setExpanded(dir, true);
    }
    await s.answer('gone', { kind: 'missing' });
    await s.answer('private', { kind: 'denied' });
    await s.fail('bad', new Error('EIO'));
    const { dirs } = tree.getState();
    expect(dirs.gone?.load).toEqual({ state: 'missing' });
    expect(dirs.private?.load).toEqual({ state: 'denied' });
    expect(dirs.bad?.load).toMatchObject({ state: 'error' });
    expect(dirs.bad?.load.state === 'error' && dirs.bad.load.error).toContain('EIO');

    tree.getState().retry('bad');
    await s.answer('bad', listing([entry('ok.txt')]));
    expect(tree.getState().dirs.bad?.load.state).toBe('listed');
  });

  it('늦게 온 옛 응답은 버린다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    tree.getState().retry('');
    expect(dirsOf(s.calls)).toEqual(['', '']);
    // 나중 요청의 응답이 먼저 오고, 옛 요청의 응답이 뒤에 온다
    const [first, second] = s.open.splice(0, 2);
    second?.resolve(listing([entry('new.txt')]));
    await flush();
    first?.resolve(listing([entry('old.txt')]));
    await flush();
    const load = tree.getState().dirs['']?.load;
    expect(load?.state === 'listed' && load.entries.map((e) => e.name)).toEqual(['new.txt']);
  });

  it('"더 보기" 는 상한을 전체 수(최대 50,000)로 올려 다시 읽고, 그 줄을 고르고 있었으면 새 첫 항목을 고른다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    const first = [entry('a.log'), entry('b.log')];
    await s.answer('', listing(first, 4));
    tree.getState().select(noteRowId('more', ''));
    tree.getState().loadMore('');
    // 읽는 동안 또 눌러도 한 번만
    tree.getState().loadMore('');
    expect(s.calls.map((c) => c.limit)).toEqual([null, 4]);
    // 읽는 동안 이전 항목을 그대로 보인다
    expect(tree.getState().dirs['']).toMatchObject({ pending: true, load: { state: 'listed' } });
    await s.answer('', listing([...first, entry('c.log'), entry('d.log')]));
    expect(tree.getState().dirs['']).toMatchObject({ limit: 4, pending: false });
    expect(tree.getState().selected).toBe('c.log');
    // 잘리지 않았으면 아무 일도 없다
    tree.getState().loadMore('');
    expect(s.calls).toHaveLength(2);

    // 상한을 넘는 디렉터리는 상한까지만
    const big = createFileTree(s.source);
    big.getState().open();
    await s.answer('', listing([entry('x')], 120_000));
    big.getState().loadMore('');
    expect(s.calls.at(-1)?.limit).toBe(FS_LIST_MAX);
  });

  it('다시 읽기는 보이는 펼친 디렉터리만, 상한을 지켜, 동시 4건까지 나열하고 그동안 기존 항목을 보인다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    const top = ['a', 'b', 'c', 'd', 'e', 'hidden'].map((n) => entry(n, 'dir'));
    await s.answer('', listing(top));
    for (const name of ['a', 'b', 'c', 'd', 'e', 'hidden']) {
      tree.getState().setExpanded(name, true);
      await s.answer(name, listing([entry('sub', 'dir')]));
    }
    tree.getState().setExpanded('hidden/sub', true);
    await s.answer('hidden/sub', listing([entry('x.txt')]));
    tree.getState().setExpanded('hidden', false);
    s.calls.length = 0;
    const epoch = tree.getState().epoch;

    const done = tree.getState().reload();
    expect(tree.getState().epoch).toBe(epoch + 1);
    // 숨은 디렉터리(hidden 과 그 아래)는 다시 읽지 않고 읽어 둔 결과를 버린다
    expect(tree.getState().dirs.hidden).toBeUndefined();
    expect(tree.getState().dirs['hidden/sub']).toBeUndefined();
    expect(s.open.length).toBeLessThanOrEqual(LIST_CONCURRENCY);
    // 그동안 기존 항목을 그대로 보인다. 배경 다시 읽기라 읽는 중 표시도 켜지 않는다 (G4)
    expect(tree.getState().dirs['']).toMatchObject({ pending: false, load: { state: 'listed' } });
    for (const dir of ['', 'a', 'b', 'c', 'd', 'e']) {
      await s.answer(dir, listing(dir === '' ? top : [entry('sub', 'dir')]));
    }
    await done;
    expect(dirsOf(s.calls).sort()).toEqual(['', 'a', 'b', 'c', 'd', 'e']);
    expect(s.maxInFlight()).toBeLessThanOrEqual(LIST_CONCURRENCY);
    // 숨은 디렉터리의 펼침 기록은 남는다: 다시 펼치면 그때 새로 읽는다
    tree.getState().setExpanded('hidden', true);
    expect(dirsOf(s.calls).slice(-1)).toEqual(['hidden']);
    await s.answer('hidden', listing([entry('sub', 'dir')]));
    expect(dirsOf(s.calls).slice(-1)).toEqual(['hidden/sub']);
  });

  it('다시 읽은 뒤 사라진 디렉터리는 접힌 채 사라지고, 선택은 가까운 조상으로 옮긴다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer('', listing([entry('api', 'dir'), entry('web', 'dir')]));
    tree.getState().setExpanded('api', true);
    await s.answer('api', listing([entry('src', 'dir')]));
    tree.getState().setExpanded('api/src', true);
    await s.answer('api/src', listing([entry('Main.java'), entry('Old.java')]));
    tree.getState().select('api/src/Old.java');

    // Old.java 만 사라졌다
    let done = tree.getState().reload();
    await s.answer('', listing([entry('api', 'dir'), entry('web', 'dir')]));
    await s.answer('api', listing([entry('src', 'dir')]));
    await s.answer('api/src', listing([entry('Main.java')]));
    await done;
    expect(tree.getState().selected).toBe('api/src');

    // api 가 통째로 사라졌다: 그 아래 펼침 기록과 결과를 지우고 선택은 루트로
    tree.getState().select('api/src/Main.java');
    done = tree.getState().reload();
    await s.answer('', listing([entry('web', 'dir')]));
    expect(tree.getState().expanded.api).toBeUndefined();
    expect(tree.getState().expanded['api/src']).toBeUndefined();
    expect(tree.getState().selected).toBe('');
    // 지운 디렉터리의 늦은 응답은 버린다
    await s.answer('api', listing([entry('src', 'dir')]));
    await s.answer('api/src', listing([entry('Main.java')]));
    await done;
    expect(tree.getState().dirs.api).toBeUndefined();
    expect(tree.getState().dirs['api/src']).toBeUndefined();
  });

  it('다시 읽는 중에 또 부르면 끝난 뒤 한 번 더 돈다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer('', listing([]));
    const first = tree.getState().reload();
    const second = tree.getState().reload();
    expect(second).toBe(first);
    await s.answer('', listing([]));
    expect(dirsOf(s.calls)).toEqual(['', '', '']);
    await s.answer('', listing([]));
    await first;
    expect(tree.getState().epoch).toBe(2);
  });

  it('접으면 그 안의 선택(안내 줄 포함)이 접은 디렉터리로 옮긴다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer('', listing([entry('api', 'dir')]));
    tree.getState().setExpanded('api', true);
    tree.getState().select(noteRowId('status', 'api'));
    tree.getState().setExpanded('api', false);
    expect(tree.getState().selected).toBe('api');
    tree.getState().setExpanded('api', true);
    await s.answer('api', listing([entry('a.ts')]));
    tree.getState().select('api/a.ts');
    tree.getState().toggle('');
    expect(tree.getState().selected).toBe('');
  });

  it('트리에서 찾기: 조상을 차례로 펼쳐 읽고 그 행을 고른다. 없으면 가장 가까운 조상을 고른다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    const found = tree.getState().reveal('api/src/Main.java');
    await s.answer('', listing([entry('api', 'dir')]));
    await s.answer('api', listing([entry('src', 'dir')]));
    await s.answer('api/src', listing([entry('Main.java')]));
    await found;
    expect(tree.getState()).toMatchObject({
      selected: 'api/src/Main.java',
      revealSeq: 1,
      expanded: { '': true, api: true, 'api/src': true },
    });

    // 읽어 둔 디렉터리는 다시 읽지 않고, 없는 파일이면 그 디렉터리를 고른다
    await tree.getState().reveal('api/src/Gone.java');
    expect(tree.getState()).toMatchObject({ selected: 'api/src', revealSeq: 2 });
    expect(s.calls).toHaveLength(3);
  });

  it('트리에서 찾기의 선택 유지 (R1 거르기를 끈 뒤): 펼치고 스크롤 차례만 올리고 선택은 그대로 둔다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().toggleInSelection('api/src/Main.java');
    tree.getState().toggleInSelection('web/b.ts');
    const found = tree.getState().reveal('web/b.ts', true);
    await s.answer('', listing([entry('api', 'dir'), entry('web', 'dir')]));
    await s.answer('web', listing([entry('b.ts')]));
    await found;
    expect(tree.getState()).toMatchObject({
      selected: 'web/b.ts',
      revealSeq: 1,
      expanded: { '': true, web: true },
    });
    expect(Object.keys(tree.getState().selection).sort()).toEqual([
      'api/src/Main.java',
      'web/b.ts',
    ]);
  });

  it('보기 거르기 (R1): 일부만 바꾸고, 같은 값이면 상태를 새로 만들지 않는다. 나열·펼침은 건드리지 않는다', () => {
    const tree = createFileTree(manualSource().source);
    const before = tree.getState();
    expect(before.filter).toEqual({ query: '', changedOnly: false });
    tree.getState().setFilter({ query: '' });
    expect(tree.getState()).toBe(before);
    tree.getState().setFilter({ query: 'main' });
    tree.getState().setFilter({ changedOnly: true });
    expect(tree.getState().filter).toEqual({ query: 'main', changedOnly: true });
    expect(tree.getState().expanded).toBe(before.expanded);
  });

  it('dispose 뒤의 응답은 버린다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    tree.getState().dispose();
    await s.answer('', listing([entry('a')]));
    expect(tree.getState().dirs['']?.load.state).toBe('loading');
  });
});

/** 선택 집합의 id 를 정렬해서 */
const ids = (state: { selection: Readonly<Record<string, true>> }) =>
  Object.keys(state.selection).sort();

describe('다중 선택 순수 함수 (PT-07)', () => {
  const dirs: DirMap = {
    '': listedState([entry('api', 'dir'), entry('web', 'dir'), entry('a.md')]),
    api: listedState([entry('src', 'dir'), entry('pom.xml')]),
    'api/src': listedState([entry('Main.java')]),
    web: listedState([]),
  };
  const state = (selection: string[], selected: string | null, anchor = selected) =>
    ({
      selection: Object.fromEntries(selection.map((id) => [id, true])),
      selected,
      anchor,
    }) as SelectionState;

  it('범위는 보이는 행 순서로 양쪽 끝을 포함하고, 사이의 안내 줄은 뺀다', () => {
    const order = ['', 'api', noteRowId('status', 'api'), 'web', 'a.md'];
    expect(rangeSelection(order, 'api', 'a.md')).toEqual(['api', 'web', 'a.md']);
    // 아래에서 위로도 같다
    expect(rangeSelection(order, 'a.md', 'api')).toEqual(['api', 'web', 'a.md']);
    // 끝 행이 안내 줄이면 그 줄은 넣는다
    expect(rangeSelection(order, 'api', noteRowId('status', 'api'))).toEqual([
      'api',
      noteRowId('status', 'api'),
    ]);
    // 시작 행이 지금 보이지 않으면 끝 행 하나
    expect(rangeSelection(order, 'api/src', 'web')).toEqual(['web']);
  });

  it('다시 읽은 뒤: 사라진 고른 행은 빼고, 기준 행은 가까운 조상으로 옮겨 고른다. 그대로면 같은 객체', () => {
    const cur = state(['api/src/Main.java', 'a.md', 'web'], 'api/src/Main.java', 'a.md');
    expect(survivingSelectionState(dirs, cur)).toBe(cur);
    const next = survivingSelectionState(
      { ...dirs, 'api/src': listedState([]), '': listedState([entry('api', 'dir')]) },
      cur,
    );
    expect(ids(next)).toEqual(['api/src']);
    expect(next.selected).toBe('api/src');
    // 범위 시작 행(a.md)도 사라졌으면 조상(루트)으로
    expect(next.anchor).toBe('');
  });

  it('⌘ 로 뺀 기준 행이 사라지면 옮기기만 하고 고르지는 않는다', () => {
    const next = survivingSelectionState(
      { ...dirs, 'api/src': listedState([]) },
      state(['web'], 'api/src/Main.java'),
    );
    expect(ids(next)).toEqual(['web']);
    expect(next.selected).toBe('api/src');
  });

  it('접으면 그 안의 고른 행(안내 줄 포함)은 빠지고 접은 디렉터리가 고른 행이 된다. 밖의 선택은 그대로', () => {
    const cur = state(['api/src', noteRowId('more', 'api'), 'web'], 'api/src', 'web');
    const next = collapsedSelectionState(cur, 'api');
    expect(ids(next)).toEqual(['api', 'web']);
    expect(next.selected).toBe('api');
    expect(next.anchor).toBe('web');
    // 안에 고른 것이 없으면 같은 객체
    const outside = state(['web'], 'web');
    expect(collapsedSelectionState(outside, 'api')).toBe(outside);
    // 접은 디렉터리 자신을 고르고 있었으면 그대로
    const self = state(['api'], 'api');
    expect(collapsedSelectionState(self, 'api')).toBe(self);
  });
});

describe('createFileTree — 다중 선택 (PT-07)', () => {
  /** 루트에 api·web·docs 디렉터리와 README.md 가 있는 트리 */
  async function opened() {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer(
      '',
      listing([entry('api', 'dir'), entry('docs', 'dir'), entry('web', 'dir'), entry('README.md')]),
    );
    return { s, tree };
  }
  const ORDER = ['', 'api', 'docs', 'web', 'README.md'];

  it('그냥 고르기는 하나만, ⌘ 는 더하고 빼기, 기준 행·범위 시작 행이 그 행이 된다', async () => {
    const { tree } = await opened();
    tree.getState().select('api');
    tree.getState().toggleInSelection('web');
    expect(ids(tree.getState())).toEqual(['api', 'web']);
    expect(tree.getState()).toMatchObject({ selected: 'web', anchor: 'web' });
    tree.getState().toggleInSelection('api');
    expect(ids(tree.getState())).toEqual(['web']);
    // 뺀 행도 기준 행이다 (키보드 포커스가 그 자리에 남는다)
    expect(tree.getState().selected).toBe('api');
    tree.getState().select('docs');
    expect(ids(tree.getState())).toEqual(['docs']);
    tree.getState().select(null);
    expect(ids(tree.getState())).toEqual([]);
    expect(tree.getState().selected).toBeNull();
  });

  it('⇧ 범위는 시작 행을 지키고 넓히거나 줄인다', async () => {
    const { tree } = await opened();
    tree.getState().select('docs');
    tree.getState().selectRange('README.md', ORDER);
    expect(ids(tree.getState())).toEqual(['README.md', 'docs', 'web']);
    tree.getState().selectRange('api', ORDER);
    expect(ids(tree.getState())).toEqual(['api', 'docs']);
    expect(tree.getState()).toMatchObject({ selected: 'api', anchor: 'docs' });
  });

  it('체크박스용 넣고 빼기는 다른 선택과 기준 행을 그대로 둔다. 바뀐 것이 없으면 상태를 바꾸지 않는다', async () => {
    const { tree } = await opened();
    tree.getState().select('README.md');
    tree.getState().markSelected(['api', 'web'], true);
    expect(ids(tree.getState())).toEqual(['README.md', 'api', 'web']);
    expect(tree.getState().selected).toBe('README.md');
    tree.getState().markSelected(['web'], false);
    expect(ids(tree.getState())).toEqual(['README.md', 'api']);
    const before = tree.getState().selection;
    tree.getState().markSelected(['api'], true);
    expect(tree.getState().selection).toBe(before);
  });

  it('다시 읽은 뒤 사라진 고른 행은 빠지고, 나머지 선택은 남는다', async () => {
    const { s, tree } = await opened();
    tree.getState().select('api');
    tree.getState().toggleInSelection('web');
    tree.getState().toggleInSelection('README.md');
    const done = tree.getState().reload();
    await s.answer('', listing([entry('api', 'dir'), entry('docs', 'dir'), entry('README.md')]));
    await done;
    expect(ids(tree.getState())).toEqual(['README.md', 'api']);
    expect(tree.getState().selected).toBe('README.md');
  });

  it('접으면 그 안의 고른 행이 접은 디렉터리로 모인다', async () => {
    const { s, tree } = await opened();
    tree.getState().setExpanded('api', true);
    await s.answer('api', listing([entry('a.ts'), entry('b.ts')]));
    tree.getState().select('api/a.ts');
    tree.getState().toggleInSelection('api/b.ts');
    tree.getState().toggleInSelection('web');
    tree.getState().toggle('api');
    expect(ids(tree.getState())).toEqual(['api', 'web']);
    // 기준 행(web)은 밖에 있어 그대로다
    expect(tree.getState().selected).toBe('web');
  });

  it('"더 보기" 줄이 선택 집합에 있으면 새로 보인 첫 항목으로 바뀐다', async () => {
    const s = manualSource();
    const tree = createFileTree(s.source);
    tree.getState().open();
    await s.answer('', listing([entry('a.log'), entry('b.log')], 3));
    tree.getState().select('a.log');
    tree.getState().toggleInSelection(noteRowId('more', ''));
    tree.getState().loadMore('');
    await s.answer('', listing([entry('a.log'), entry('b.log'), entry('c.log')]));
    expect(ids(tree.getState())).toEqual(['a.log', 'c.log']);
    expect(tree.getState()).toMatchObject({ selected: 'c.log', anchor: 'c.log' });
  });
});
