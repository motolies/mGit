import { S } from '@mgit/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffPaneView } from '../features/diff/DiffPaneView';
import { EditorArea } from '../features/workspace/EditorArea';
import { currentFileDoc, currentFileTabMenu } from '../features/workspace/use-current-file';
import { DEFAULT_DIFF_OPTIONS } from '../store/session-store';
import {
  allDocs,
  commitDiffDoc,
  createWorkspaceStore,
  type EditorDoc,
  historyDiffDoc,
  rangeDiffDoc,
  worktreeDiffDoc,
} from '../store/workspace-store';

afterEach(cleanup);

const target = { repoPath: '/projects/api', repoName: 'api', path: 'src/과거 파일.ts' };

/** 작업 트리·staged·커밋·범위 diff를 각각 준비한다. */
function diffDocs(): EditorDoc[] {
  return [
    worktreeDiffDoc({ ...target, staged: false }),
    worktreeDiffDoc({ ...target, staged: true }),
    historyDiffDoc({ ...target, rev: { kind: 'commit', oid: 'a'.repeat(40) } }),
    historyDiffDoc({ ...target, rev: { kind: 'range', label: 'a..b' } }),
    commitDiffDoc({ ...target, oid: 'b'.repeat(40), oldPath: 'old.ts', merge: false }),
    rangeDiffDoc({ ...target, base: 'a'.repeat(40), newer: 'b'.repeat(40), label: 'a..b' }),
  ].map((doc) => ({ ...doc, pinned: true }));
}

describe('현재 파일 편집 진입', () => {
  it('폴더와 저장소 경로를 각 Project 파일 탭의 동일한 ID로 바꾼다', () => {
    expect(currentFileDoc('/projects', target.repoPath, target.path)).toMatchObject({
      id: 'file:api/src/과거 파일.ts',
      path: 'api/src/과거 파일.ts',
    });
    expect(currentFileDoc(target.repoPath, target.repoPath, target.path)).toMatchObject({
      id: 'file:src/과거 파일.ts',
      path: target.path,
    });
    expect(currentFileDoc('/projects/api-other', target.repoPath, target.path)).toBeNull();
  });

  it('모든 diff 메뉴는 과거 경로를 그대로 전달하고 이름 변경의 옛 경로로 대체하지 않는다', () => {
    const open = vi.fn();
    for (const doc of diffDocs()) {
      const menu = currentFileTabMenu(doc, open);
      expect(menu).toHaveLength(1);
      expect(menu[0]?.label).toBe(S.fileView.editCurrent);
      menu[0]?.onSelect?.();
      expect(open).toHaveBeenLastCalledWith(target.repoPath, target.path, target.repoName);
    }
  });

  it('편집 파일을 다시 열어도 하나의 고정 탭을 사용하며 기존 diff는 남는다', () => {
    const ws = createWorkspaceStore('folder');
    const diff = commitDiffDoc({ ...target, oid: 'b'.repeat(40), oldPath: 'old.ts', merge: false });
    ws.getState().openDoc(diff, 'preview');
    const file = currentFileDoc('/projects', target.repoPath, target.path);
    if (!file) throw new Error('파일 문서가 필요합니다');
    ws.getState().openDoc(file, 'pinned');
    ws.getState().openDoc(file, 'pinned');
    const docs = allDocs(ws.getState());
    expect(docs.filter((doc) => doc.id === file.id)).toHaveLength(1);
    expect(docs.find((doc) => doc.id === file.id)?.pinned).toBe(true);
    expect(docs.some((doc) => doc.id === diff.id)).toBe(true);
  });

  it('같은 파일도 비교 범위가 다르면 고정한 범위 문서를 보존한다', () => {
    const ws = createWorkspaceStore('repo');
    const first = rangeDiffDoc({ ...target, base: 'a', newer: 'b', label: 'a..b' });
    const second = rangeDiffDoc({ ...target, base: 'b', newer: 'c', label: 'b..c' });
    ws.getState().openDoc(first, 'pinned');
    ws.getState().openDoc(second, 'preview');
    expect(ws.getState().docs).toEqual([
      expect.objectContaining({
        id: first.id,
        kind: 'rangeDiff',
        base: 'a',
        newer: 'b',
        pinned: true,
      }),
      expect.objectContaining({
        id: second.id,
        kind: 'rangeDiff',
        base: 'b',
        newer: 'c',
        pinned: false,
      }),
    ]);
    expect(first.id).not.toBe(second.id);
  });

  it('공통 diff 도구 모음의 편집 버튼이 전달한 동작을 실행한다', () => {
    const edit = vi.fn();
    render(
      <DiffPaneView
        path={target.path}
        areaLabel="commit abc"
        diff={null}
        loading={false}
        error={null}
        mode="split"
        onModeChange={vi.fn()}
        options={DEFAULT_DIFF_OPTIONS}
        onOptionsChange={vi.fn()}
        onLoadFull={vi.fn()}
        onEditCurrent={edit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: S.fileView.editCurrent }));
    expect(edit).toHaveBeenCalledOnce();
  });

  it('비활성 diff 탭의 우클릭도 해당 탭 파일을 연다', () => {
    const first = diffDocs()[0];
    if (!first) throw new Error('diff 문서가 필요합니다');
    const docs = [first, { ...first, id: 'second', path: 'other.ts' }];
    const edit = vi.fn();
    render(
      <EditorArea
        docs={docs}
        activeId="second"
        titleOf={(doc) => doc.id}
        renderDoc={() => null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onPin={vi.fn()}
        tabMenu={(doc) => currentFileTabMenu(doc, edit)}
        empty={null}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('tab', { name: first.id }));
    fireEvent.click(screen.getByRole('menuitem', { name: S.fileView.editCurrent }));
    expect(edit).toHaveBeenCalledWith(target.repoPath, target.path, target.repoName);
  });
});

/** 탭 본문의 문서 종류와 무관하게 공통 메뉴가 같은 대상을 사용한다. */
describe('편집기 탭 공통 메뉴', () => {
  const docs = [
    { id: 'a', pinned: false },
    { id: 'b', pinned: true },
    { id: 'c', pinned: true },
  ];

  function setup() {
    const onClose = vi.fn();
    const onCloseMany = vi.fn(async () => true);
    const onPin = vi.fn();
    render(
      <EditorArea
        docs={docs}
        activeId="a"
        titleOf={(doc) => doc.id}
        renderDoc={() => null}
        onActivate={vi.fn()}
        onClose={onClose}
        onCloseMany={onCloseMany}
        onPin={onPin}
        empty={null}
      />,
    );
    return { onClose, onCloseMany, onPin };
  }

  it('비활성 탭의 오른쪽 닫기는 우클릭한 탭 오른쪽 문서만 전달한다', () => {
    const { onCloseMany } = setup();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' }));
    fireEvent.click(screen.getByRole('menuitem', { name: S.workspace.closeRightTabs }));
    expect(onCloseMany).toHaveBeenCalledWith(['c']);
  });

  it('다른 탭 닫기와 모두 닫기는 현재 탭 순서를 보존한다', () => {
    const { onCloseMany } = setup();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' }));
    fireEvent.click(screen.getByRole('menuitem', { name: S.toolbar.closeOtherTabs }));
    expect(onCloseMany).toHaveBeenCalledWith(['a', 'c']);
  });

  it('Shift+F10으로 일반 문서의 메뉴를 열고 미리보기 탭을 고정한다', () => {
    const { onPin } = setup();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'a' }), { key: 'F10', shiftKey: true });
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(S.actions.pin) }));
    expect(onPin).toHaveBeenCalledWith('a');
  });

  it('맨 오른쪽 탭의 오른쪽 닫기와 이미 고정된 탭의 고정은 비활성이다', () => {
    setup();
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'c' }));
    expect(
      screen
        .getByRole('menuitem', { name: S.workspace.closeRightTabs })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen
        .getByRole('menuitem', { name: new RegExp(S.actions.pin) })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });
});
