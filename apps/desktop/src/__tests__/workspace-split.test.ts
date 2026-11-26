import { describe, expect, it, vi } from 'vitest';
import { remapGroupFileDocs } from '../store/path-remap';
import { readRecentFiles, watchRecentFiles } from '../store/recent-files';
import {
  commitDiffDoc,
  createWorkspaceStore,
  type DocRequest,
  fileViewDoc,
  focusedEditorDoc,
  OVERVIEW_DOC,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
} from '../store/workspace-store';

// 편집기 분할 (R3): 왼쪽(기본) 그룹 + 파일 탭만 담는 오른쪽 그룹, 지금 그룹으로 열기·닫기, 비는 그룹은 사라진다

/** 파일 문서 요청 */
const file = (path: string, repoPath: string | null = '/r/api'): DocRequest =>
  fileViewDoc({ path, name: path, repoPath, repoName: repoPath ? 'api' : null });

/** 그룹의 문서 id 들 */
const ids = (docs: readonly { id: string }[] | undefined) => (docs ?? []).map((d) => d.id);

describe('편집기 분할 (R3)', () => {
  it('오른쪽으로 분할은 파일 탭을 오른쪽에도 열고 오른쪽이 지금 그룹이 된다. 파일이 아니면 그대로다', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().splitDoc(OVERVIEW_DOC.id, 'main');
    expect(ws.getState().split).toBeNull();

    ws.getState().splitDoc('file:a.ts', 'main');
    const state = ws.getState();
    expect(ids(state.docs)).toEqual(['overview', 'file:a.ts']);
    expect(ids(state.split?.docs)).toEqual(['file:a.ts']);
    expect(state.split?.activeDocId).toBe('file:a.ts');
    expect(state.focusedGroup).toBe('side');
    expect(focusedEditorDoc(state)?.id).toBe('file:a.ts');
  });

  it('지금 그룹으로 연다: 오른쪽이면 파일은 오른쪽에, 파일이 아닌 문서는 왼쪽에 열고 왼쪽이 지금 그룹이 된다', () => {
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    ws.getState().openDoc(file('b.ts'), 'preview');
    expect(ids(ws.getState().split?.docs)).toEqual(['file:a.ts', 'file:b.ts']);
    expect(ids(ws.getState().docs)).toEqual(['file:a.ts']);
    // 오른쪽 그룹도 미리보기 탭이 다음 미리보기에 자리를 내준다
    ws.getState().openDoc(file('c.ts'), 'preview');
    expect(ids(ws.getState().split?.docs)).toEqual(['file:a.ts', 'file:c.ts']);

    ws.getState().openDoc(
      commitDiffDoc({
        repoPath: '/r/api',
        repoName: 'api',
        oid: 'a'.repeat(40),
        path: 'x',
        oldPath: null,
        merge: false,
      }),
      'pinned',
    );
    expect(ws.getState().focusedGroup).toBe('main');
    expect(ws.getState().docs).toHaveLength(2);
    // 왼쪽이 지금 그룹이면 파일도 왼쪽에 연다
    ws.getState().openDoc(file('d.ts'), 'pinned');
    expect(ids(ws.getState().docs)).toContain('file:d.ts');
    expect(ids(ws.getState().split?.docs)).not.toContain('file:d.ts');
  });

  it('다른 쪽으로 옮기기: 옮긴 쪽이 비면 그 그룹이 사라진다 (왼쪽이 비면 오른쪽 탭이 왼쪽으로 온다)', () => {
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    ws.getState().moveDoc('file:b.ts', 'main');
    expect(ids(ws.getState().docs)).toEqual(['file:a.ts']);
    expect(ids(ws.getState().split?.docs)).toEqual(['file:b.ts']);
    // 오른쪽의 마지막 탭을 왼쪽으로 옮기면 분할이 풀린다
    ws.getState().moveDoc('file:b.ts', 'side');
    expect(ws.getState().split).toBeNull();
    expect(ids(ws.getState().docs)).toEqual(['file:a.ts', 'file:b.ts']);
    expect(ws.getState().focusedGroup).toBe('main');
    // 왼쪽의 마지막 탭을 오른쪽으로 옮기면 그대로 한 그룹이다
    const solo = createWorkspaceStore('repo');
    solo.getState().openDoc(file('a.ts'), 'pinned');
    solo.getState().moveDoc('file:a.ts', 'main');
    expect(solo.getState().split).toBeNull();
    expect(ids(solo.getState().docs)).toEqual(['file:a.ts']);
  });

  it('마지막 탭을 닫으면 그 그룹이 사라진다. 두 그룹에 열린 파일은 저장·확인 없이 이쪽만 닫는다', async () => {
    const beforeCloseFile = vi.fn(async () => true);
    const ws = createWorkspaceStore('repo', { beforeCloseFile });
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    // 같은 파일이 왼쪽에도 있다: 확인 없이 닫는다 → 오른쪽이 비어 분할이 풀린다
    ws.getState().closeSideDoc('file:a.ts');
    expect(beforeCloseFile).not.toHaveBeenCalled();
    expect(ws.getState().split).toBeNull();

    ws.getState().splitDoc('file:b.ts', 'main');
    ws.getState().closeDoc('file:a.ts');
    await vi.waitFor(() => expect(ids(ws.getState().docs)).toEqual(['file:b.ts']));
    expect(beforeCloseFile).toHaveBeenCalledWith('a.ts');
    // 왼쪽 마지막 탭 b 를 닫는다: 오른쪽에도 있어 확인 없이 닫고, 오른쪽 탭이 왼쪽으로 온다
    beforeCloseFile.mockClear();
    ws.getState().closeDoc('file:b.ts');
    expect(beforeCloseFile).not.toHaveBeenCalled();
    expect(ws.getState().split).toBeNull();
    expect(ids(ws.getState().docs)).toEqual(['file:b.ts']);
  });

  it('⌘W·Esc 의 닫기는 지금 그룹의 문서다. 분할 해제는 오른쪽 탭을 왼쪽에 합친다', () => {
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    ws.getState().openDoc(file('c.ts'), 'pinned');
    expect(ws.getState().closeFocusedDoc()).toBe(true);
    expect(ids(ws.getState().split?.docs)).toEqual(['file:a.ts']);
    ws.getState().openDoc(file('c.ts'), 'pinned');
    ws.getState().focusGroup('main');
    expect(focusedEditorDoc(ws.getState())?.id).toBe('file:b.ts');

    ws.getState().unsplit();
    expect(ws.getState().split).toBeNull();
    expect(ids(ws.getState().docs)).toEqual(['file:a.ts', 'file:b.ts', 'file:c.ts']);
    expect(ws.getState().activeDocId).toBe('file:c.ts');
  });

  it('고정은 두 그룹 모두에서, 활성 저장소는 지금 그룹의 문서를 따른다. 폭은 범위 안으로 맞춘다', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().openDoc(file('a.ts', '/r/api'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    ws.getState().openDoc(file('w.ts', '/r/web'), 'preview');
    expect(ws.getState().activeRepo).toBe('/r/web');
    ws.getState().pinDoc('file:w.ts');
    expect(ws.getState().split?.docs.find((d) => d.id === 'file:w.ts')?.pinned).toBe(true);
    ws.getState().focusGroup('main');
    expect(ws.getState().activeRepo).toBe('/r/api');
    ws.getState().activateSideDoc('file:w.ts');
    expect([ws.getState().focusedGroup, ws.getState().activeRepo]).toEqual(['side', '/r/web']);

    ws.getState().setSplitRatio(5);
    expect(ws.getState().splitRatio).toBe(SPLIT_RATIO_MIN);
    ws.getState().setSplitRatio(99);
    expect(ws.getState().splitRatio).toBe(SPLIT_RATIO_MAX);
  });

  it('파일 이동·이름 바꾸기는 두 그룹의 탭을 함께 옮기고 옮길 곳은 파일마다 한 번만 묻는다', () => {
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('gone.ts'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    ws.getState().splitDoc('file:gone.ts', 'main');
    const move = vi.fn((doc: { path: string } & ReturnType<typeof file>) =>
      doc.path === 'gone.ts' ? null : { ...doc, id: 'file:b.ts', path: 'b.ts', name: 'b.ts' },
    );
    const next = remapGroupFileDocs(ws.getState(), move as never);
    expect(move).toHaveBeenCalledTimes(2);
    expect(ids(next.docs)).toEqual(['file:b.ts']);
    expect(ids(next.split?.docs)).toEqual(['file:b.ts']);
    expect(next.split?.activeDocId).toBe('file:b.ts');
  });

  it('최근 파일은 두 그룹 어디서 보게 된 파일이든 올린다', () => {
    localStorage.clear();
    const ws = createWorkspaceStore('repo');
    const off = watchRecentFiles('/r', ws);
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().splitDoc('file:a.ts', 'main');
    ws.getState().openDoc(file('side.ts'), 'pinned');
    expect(readRecentFiles('/r')).toEqual(['side.ts', 'a.ts']);
    off();
  });
});
