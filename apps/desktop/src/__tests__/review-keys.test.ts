import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../actions';
import { editorKeyDoc, type GlobalKeyContext, handleGlobalKey, isModalOpen } from '../global-keys';
import { type RepoDocSlot, repoSessionDocs } from '../store/workspace-store';

/** 키 이벤트 */
function key(k: string, init: KeyboardEventInit = {}, target: HTMLElement = document.body) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

/**
 * 전역 키 처리 문맥 (W13: 문서 기준). 저장소 탭의 가운데 diff·충돌 화면은 워크스페이스의 활성 세션 문서이고(W20)
 * `activeDoc` 'diff'·'conflict' 다. 닫기(세션 슬롯 비우기)는 `closeActiveDoc` 하나다
 */
function ctx(over: Partial<GlobalKeyContext> = {}): GlobalKeyContext {
  return {
    actions: [] as Action[],
    openPalette: vi.fn(),
    searchOpen: false,
    closeSearch: vi.fn(),
    activeDoc: null,
    closeActiveDoc: vi.fn(),
    ...over,
  } as GlobalKeyContext;
}

/** 단축키 하나를 가진 동작 */
function action(shortcut: string): Action {
  return { id: 'a', title: 'a', group: 'repo', shortcut, enabled: true, run: vi.fn() };
}

const MOD = /Mac/.test(navigator.platform ?? '') ? { metaKey: true } : { ctrlKey: true };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isModalOpen', () => {
  it('열린 dialog·역할 기반 대화상자·메뉴를 찾는다', () => {
    expect(isModalOpen()).toBe(false);
    document.body.innerHTML = '<dialog></dialog>';
    expect(isModalOpen()).toBe(false);
    document.body.innerHTML = '<dialog open></dialog>';
    expect(isModalOpen()).toBe(true);
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(isModalOpen()).toBe(true);
    document.body.innerHTML = '<div role="menu"></div>';
    expect(isModalOpen()).toBe(true);
  });
});

describe('Esc 가 보는 활성 문서', () => {
  it('저장소 탭: 슬롯에서 파생한 세션 diff(작업 트리·커밋·범위)·충돌 문서만 문서다 (활성 문서가 없으면 그래프 — 닫을 것이 없다, W20)', () => {
    /** 슬롯 하나만 채운 저장소 탭의 세션 문서 하나 (세션 문서는 늘 고정으로 실린다) */
    const docOf = (slot: Partial<RepoDocSlot>) => {
      const [doc] = repoSessionDocs('/r', 'r', {
        selectedFile: null,
        conflict: null,
        conflictDrafts: {},
        conflictLoading: false,
        ...slot,
      });
      return doc ? { ...doc, pinned: true } : undefined;
    };
    expect(editorKeyDoc(docOf({ selectedFile: { path: 'a', staged: false, commit: null } }))).toBe(
      'diff',
    );
    expect(editorKeyDoc(docOf({ selectedFile: { path: 'a', staged: false, commit: 'c' } }))).toBe(
      'diff',
    );
    expect(
      editorKeyDoc(
        docOf({
          selectedFile: {
            path: 'a',
            staged: false,
            commit: null,
            range: { base: 'b', newer: 'n', label: 'o..n' },
          },
        }),
      ),
    ).toBe('diff');
    expect(
      editorKeyDoc(docOf({ conflict: { path: 'a', payload: { file: { stages: [] } } as never } })),
    ).toBe('conflict');
    expect(editorKeyDoc(docOf({ conflictLoading: true }))).toBe('conflict');
    expect(editorKeyDoc(docOf({}))).toBeNull();
  });

  it('폴더 탭: 활성 에디터 탭이 미리보기면 preview, 고정·개요면 pinned, 없으면 null', () => {
    expect(editorKeyDoc({ pinned: false })).toBe('preview');
    expect(editorKeyDoc({ pinned: true })).toBe('pinned');
    expect(editorKeyDoc(undefined)).toBeNull();
  });
});

describe('handleGlobalKey', () => {
  it('모달이 열려 있으면 단축키를 실행하지 않는다', () => {
    document.body.innerHTML = '<dialog open></dialog>';
    const a = action('mod+shift+x');
    const c = ctx({ actions: [a] });
    handleGlobalKey(key('x', { ...MOD, shiftKey: true }), c);
    expect(a.run).not.toHaveBeenCalled();
  });

  it('모달이 열려 있으면 Esc 는 대화상자 몫이다 (충돌 화면·미리보기 탭을 닫지 않는다)', () => {
    document.body.innerHTML = '<dialog open></dialog>';
    const c = ctx({ activeDoc: 'conflict' });
    handleGlobalKey(key('Escape'), c);
    expect(c.closeActiveDoc).not.toHaveBeenCalled();
    const preview = ctx({ activeDoc: 'preview' });
    handleGlobalKey(key('Escape'), preview);
    expect(preview.closeActiveDoc).not.toHaveBeenCalled();
  });

  it('이미 처리된 키는 건드리지 않는다', () => {
    const a = action('mod+shift+x');
    const c = ctx({ actions: [a] });
    const e = key('x', { ...MOD, shiftKey: true });
    e.preventDefault();
    handleGlobalKey(e, c);
    expect(a.run).not.toHaveBeenCalled();
  });

  it('편집기 안의 Esc 는 충돌 화면을 닫지 않고, 편집기 밖이면 닫는다', () => {
    document.body.innerHTML = '<div class="cm-content" contenteditable="true"><p></p></div>';
    const inside = document.querySelector('p') as HTMLElement;
    const c = ctx({ activeDoc: 'conflict' });
    handleGlobalKey(key('Escape', {}, inside), c);
    expect(c.closeActiveDoc).not.toHaveBeenCalled();
    handleGlobalKey(key('Escape'), c);
    expect(c.closeActiveDoc).toHaveBeenCalledTimes(1);
  });

  it('Esc 는 검색 → 세션 diff → 미리보기 탭 순서로 하나만 닫는다', () => {
    const search = ctx({ searchOpen: true, activeDoc: 'diff' });
    handleGlobalKey(key('Escape'), search);
    expect(search.closeSearch).toHaveBeenCalledTimes(1);
    expect(search.closeActiveDoc).not.toHaveBeenCalled();
    const diff = ctx({ activeDoc: 'diff' });
    handleGlobalKey(key('Escape'), diff);
    expect(diff.closeActiveDoc).toHaveBeenCalledTimes(1);
    const preview = ctx({ activeDoc: 'preview' });
    handleGlobalKey(key('Escape'), preview);
    expect(preview.closeActiveDoc).toHaveBeenCalledTimes(1);
  });

  it('개요·고정 탭은 Esc 로 닫히지 않는다 (탭이 없어도 아무것도 하지 않는다)', () => {
    for (const activeDoc of ['pinned', null] as const) {
      const c = ctx({ activeDoc });
      handleGlobalKey(key('Escape'), c);
      expect(c.closeActiveDoc).not.toHaveBeenCalled();
      expect(c.closeSearch).not.toHaveBeenCalled();
    }
  });

  it('입력란 안의 Esc 는 미리보기 탭을 닫지 않는다 (세션 diff 는 지금처럼 닫는다)', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLElement;
    const preview = ctx({ activeDoc: 'preview' });
    handleGlobalKey(key('Escape', {}, input), preview);
    expect(preview.closeActiveDoc).not.toHaveBeenCalled();
    const diff = ctx({ activeDoc: 'diff' });
    handleGlobalKey(key('Escape', {}, input), diff);
    expect(diff.closeActiveDoc).toHaveBeenCalledTimes(1);
  });

  it('평소에는 단축키가 실행되고 팔레트가 열린다', () => {
    const a = action('mod+shift+x');
    const c = ctx({ actions: [a] });
    handleGlobalKey(key('x', { ...MOD, shiftKey: true }), c);
    expect(a.run).toHaveBeenCalledTimes(1);
    handleGlobalKey(key('a', { ...MOD, shiftKey: true }), c);
    expect(c.openPalette).toHaveBeenCalledTimes(1);
  });

  it('⇧Esc 가 레지스트리 단축키면 그 동작만 실행하고 화면은 닫지 않는다', () => {
    const hide = action('shift+escape');
    const c = ctx({ actions: [hide], activeDoc: 'diff', searchOpen: true });
    const e = key('Escape', { shiftKey: true });
    handleGlobalKey(e, c);
    expect(hide.run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(c.closeSearch).not.toHaveBeenCalled();
    expect(c.closeActiveDoc).not.toHaveBeenCalled();
    // 맨 Esc 는 그대로 화면을 닫고 동작은 실행하지 않는다
    handleGlobalKey(key('Escape'), c);
    expect(c.closeSearch).toHaveBeenCalledTimes(1);
    expect(hide.run).toHaveBeenCalledTimes(1);
  });

  it('⇧Esc 는 입력란 안에서도 동작하고, 꺼진 동작이면 아무것도 하지 않는다', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLElement;
    const hide = action('shift+escape');
    handleGlobalKey(key('Escape', { shiftKey: true }, input), ctx({ actions: [hide] }));
    expect(hide.run).toHaveBeenCalledTimes(1);

    // 도구 창이 숨겨져 꺼진 동작: 키는 그 동작의 것이라 화면 닫기로 넘어가지 않는다
    const off = { ...action('shift+escape'), enabled: false };
    const c = ctx({ actions: [off], activeDoc: 'diff' });
    handleGlobalKey(key('Escape', { shiftKey: true }), c);
    expect(off.run).not.toHaveBeenCalled();
    expect(c.closeActiveDoc).not.toHaveBeenCalled();
  });

  it('수정키가 붙은 Esc 에 맞는 동작이 없으면 기존대로 화면을 닫는다', () => {
    // 사용자가 ⇧Esc 를 다른 키로 재지정한 경우
    const c = ctx({ actions: [action('f9')], activeDoc: 'diff' });
    handleGlobalKey(key('Escape', { shiftKey: true }), c);
    expect(c.closeActiveDoc).toHaveBeenCalledTimes(1);
  });

  it('입력란 안에서는 수정키 없는 글자·기능키 단축키를 가로채지 않는다', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLElement;
    const a = action('f8');
    handleGlobalKey(key('F8', {}, input), ctx({ actions: [a] }));
    expect(a.run).not.toHaveBeenCalled();
    handleGlobalKey(key('F8'), ctx({ actions: [a] }));
    expect(a.run).toHaveBeenCalledTimes(1);
  });
});
