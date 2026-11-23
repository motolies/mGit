import { isImeKey, matchShortcut } from '@mgit/ui';
import type { Action } from './actions';

/** 팔레트 단축키 (레지스트리 밖: 팔레트 자체를 연다) */
export const PALETTE_SHORTCUT = 'mod+shift+p';

/**
 * Esc 가 보는 활성 문서의 종류 (결정 8번): `diff`·`conflict` 는 세션 diff·충돌 문서(작업 트리·커밋·범위 파일 diff 탭, 충돌
 * 편집기 탭 — 폴더 탭·저장소 탭 공통, W21), `preview`·`pinned` 는 에디터 공간의 미리보기 탭·고정 탭(개요 포함). Esc 는
 * 앞의 셋만 닫는다
 */
export type KeyDocKind = 'diff' | 'conflict' | 'preview' | 'pinned';

/**
 * 활성 탭 워크스페이스의 활성 문서를 Esc 가 보는 문서로 바꾼다. 세션 diff 문서(작업 트리 diff W14, 저장소 탭의 커밋·범위
 * 파일 diff W20)는 `diff`, 충돌 문서(W15)는 `conflict` 다 (결정 8번: Esc 가 닫는다 — 편집기 안의 Esc 는 편집기 몫이고,
 * 초안이 있으면 닫기 전에 확인한다 — 저장소 탭도 W21 부터). 개요는 늘 고정 탭이다. 문서가 없으면 null
 */
export function editorKeyDoc(
  doc: { pinned: boolean; kind?: string } | undefined,
): KeyDocKind | null {
  if (!doc) {
    return null;
  }
  if (doc.kind === 'worktreeDiff' || doc.kind === 'historyDiff') {
    return 'diff';
  }
  if (doc.kind === 'conflict') {
    return 'conflict';
  }
  return doc.pinned ? 'pinned' : 'preview';
}

/** 전역 키 처리에 필요한 상태와 동작 */
export interface GlobalKeyContext {
  actions: readonly Action[];
  openPalette(): void;
  /** 저장소 탭의 그래프 검색이 열려 있는지 (폴더 탭은 늘 거짓) */
  searchOpen: boolean;
  closeSearch(): void;
  /** 활성 문서의 종류. 닫을 문서가 없으면 null */
  activeDoc: KeyDocKind | null;
  /** 활성 문서를 닫는다 (워크스페이스의 `closeDoc` — 세션 문서면 그 세션 슬롯을 비워 그 탭이 닫힌다) */
  closeActiveDoc(): void;
}

/** 키 입력을 먼저 받아야 할 대화상자·메뉴가 떠 있는지 */
export function isModalOpen(root: ParentNode = document): boolean {
  return root.querySelector('dialog[open], [role="dialog"], [role="menu"]') !== null;
}

/** 수정키가 붙은 Esc 가 레지스트리 동작의 단축키인지 (⇧Esc = 아래 도구 창 숨기기 등) */
function isBoundEscape(e: KeyboardEvent, actions: readonly Action[]): boolean {
  if (!(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
    return false;
  }
  return actions.some((a) => a.shortcut !== undefined && matchShortcut(e, a.shortcut));
}

/**
 * 전역 단축키 (UX-03): 레지스트리의 `shortcut` 과 맞는 동작을 실행한다. Esc 는 검색 → 세션 diff·충돌 화면 →
 * 미리보기 탭 순서로 하나를 닫고, 고정 탭과 개요는 닫지 않는다 (결정 8번). 팔레트는 ⌘⇧P. 한글 조합 중, 이미 처리된
 * 키, 모달이 떠 있을 때는 건드리지 않는다 (모달 뒤의 화면이 닫히거나, 단축키를 재지정하는 입력란의 키가 실제 동작을
 * 실행하지 않게 한다 — 대화상자의 Esc 는 대화상자가 먼저 닫는다). 수정키가 붙은 Esc 가 레지스트리 단축키면 화면을
 * 닫지 않고 그 동작만 실행한다 (맨 Esc 는 언제나 화면 닫기)
 */
export function handleGlobalKey(e: KeyboardEvent, ctx: GlobalKeyContext): void {
  if (isImeKey(e) || e.defaultPrevented || isModalOpen()) {
    return;
  }
  const target = e.target as HTMLElement | null;
  // 입력란 안에서는 글자 단축키를 가로채지 않는다 (수정키 조합만)
  const typing = target?.closest?.('input, textarea, [contenteditable="true"], .cm-content');
  if (e.key === 'Escape' && !isBoundEscape(e, ctx.actions)) {
    if (ctx.searchOpen) {
      ctx.closeSearch();
    } else if (ctx.activeDoc === 'diff') {
      ctx.closeActiveDoc();
    } else if (ctx.activeDoc === 'conflict' && !target?.closest?.('.cm-content')) {
      // 편집기 안의 Esc 는 편집기 몫이다. 닫기 전에 확인창(초안, W15)이 뜰 수 있으므로 이 키의 기본 동작을 막는다 —
      // 막지 않으면 같은 Esc 가 방금 연 모달 대화상자를 곧바로 취소한다 (브라우저의 닫기 요청)
      e.preventDefault();
      ctx.closeActiveDoc();
    } else if (ctx.activeDoc === 'preview' && !typing) {
      // 입력란(브랜치 검색 등)의 Esc 는 그 입력란 몫이다
      ctx.closeActiveDoc();
    }
    return;
  }
  if (matchShortcut(e, PALETTE_SHORTCUT)) {
    e.preventDefault();
    ctx.openPalette();
    return;
  }
  for (const a of ctx.actions) {
    if (a.shortcut && matchShortcut(e, a.shortcut)) {
      // 입력란에서는 글자 단축키와 ⌘Z/⌘⇧Z(텍스트 undo) 를 가로채지 않는다. Esc 조합은 글자가 아니다
      const text = !a.shortcut.includes('mod') && e.key !== 'Escape';
      if (typing && (text || a.shortcut.endsWith('+z'))) {
        return;
      }
      e.preventDefault();
      if (a.enabled) {
        a.run();
      }
      return;
    }
  }
}
