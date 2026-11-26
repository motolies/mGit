import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { queryTextContext, S, type TextContextAdapter } from '@mgit/ui';
import { type ReactNode, useEffect } from 'react';
import { editorContextItems } from '../features/workspace/editor/editor-context';
import { useAppStore } from '../store';
import { ContextMenuArea, type MenuItem } from './ContextMenu';
import styles from './TextContextMenu.module.css';

/** 우클릭 당시 선택을 보존해 CodeMirror의 트랜잭션으로 편집한다. */
function codeActions(view: EditorView): TextContextAdapter & { editorMenu: MenuItem[] } {
  const selection = view.state.selection.main;
  const text = view.state.sliceDoc(selection.from, selection.to);
  const replace = (insert: string) => {
    if (view.state.readOnly) return;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: { anchor: selection.from + insert.length },
      userEvent: 'input.paste',
    });
    view.focus();
  };
  return {
    editorMenu: editorContextItems.get(view)?.() ?? [],
    copy: text ? () => navigator.clipboard.writeText(text) : undefined,
    cut:
      text && !view.state.readOnly
        ? async () => {
            await navigator.clipboard.writeText(text);
            replace('');
          }
        : undefined,
    paste: !view.state.readOnly
      ? async () => replace(await navigator.clipboard.readText())
      : undefined,
    selectAll: () => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    },
    undo:
      !view.state.readOnly && undoDepth(view.state) > 0
        ? () => {
            undo(view);
            view.focus();
          }
        : undefined,
    redo:
      !view.state.readOnly && redoDepth(view.state) > 0
        ? () => {
            redo(view);
            view.focus();
          }
        : undefined,
  };
}

/** 표준 입력은 브라우저 편집 명령으로 변경해 입력 이벤트와 실행 취소 이력을 유지한다. */
function inputActions(input: HTMLInputElement | HTMLTextAreaElement): TextContextAdapter {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  const text = input.value.slice(start, end);
  const writable = !input.readOnly && !input.disabled;
  const replace = (value: string) => {
    input.focus();
    input.setSelectionRange(start, end);
    document.execCommand('insertText', false, value);
  };
  return {
    copy: text && input.type !== 'password' ? () => navigator.clipboard.writeText(text) : undefined,
    cut:
      text && writable && input.type !== 'password'
        ? async () => {
            await navigator.clipboard.writeText(text);
            replace('');
          }
        : undefined,
    paste: writable ? async () => replace(await navigator.clipboard.readText()) : undefined,
    selectAll: () => {
      input.focus();
      input.select();
    },
  };
}

const NON_TEXT_CONTROLS =
  'button, a, select, option, label, summary, input, [role="button"], [role="tab"], ' +
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], [role="slider"], ' +
  '[role="combobox"], [role="option"], [role="separator"], [role="toolbar"]';

/** 다른 영역에 남은 선택을 제외하고 우클릭한 본문의 선택만 복사한다. */
function selectedTextAt(target: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString()) return null;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const selectedHere = Array.from(target.childNodes).some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent?.trim() && range.intersectsNode(node),
    );
    if (selectedHere) return selection.toString();
  }
  return null;
}

/** 가장 바깥 영역은 기본 Reload를 막고 텍스트 영역에는 편집 메뉴를 제공한다. */
export function TextContextMenu({ children }: { children: ReactNode }) {
  useEffect(() => {
    // 포털과 비어 있는 셸 영역도 브라우저의 Reload 메뉴로 빠지지 않는다.
    const suppressDefault = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', suppressDefault);
    return () => document.removeEventListener('contextmenu', suppressDefault);
  }, []);
  useAppStore((state) => state.uiLocale);
  const { undo, redo, cut, copy, paste, selectAll } = S.textContext;
  const labels = { undo, redo, cut, copy, paste, selectAll };
  return (
    <ContextMenuArea<TextContextAdapter>
      className={styles.boundary}
      resolveTarget={(event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target || target.closest('[data-context-area]') !== event.currentTarget) return null;
        if (target.matches('input:disabled, textarea:disabled')) return null;
        const textInput =
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLInputElement && target.selectionStart !== null);
        if (!textInput && target.closest(NON_TEXT_CONTROLS)) return null;
        const custom = queryTextContext(target);
        if (custom) return custom;
        const cm = target.closest<HTMLElement>('.cm-editor');
        const view = cm ? EditorView.findFromDOM(cm) : null;
        if (view) return codeActions(view);
        if (target instanceof HTMLTextAreaElement) return inputActions(target);
        if (target instanceof HTMLInputElement && target.selectionStart !== null)
          return inputActions(target);
        const selected = selectedTextAt(target);
        return selected ? { copy: () => navigator.clipboard.writeText(selected) } : null;
      }}
      items={(adapter) => [
        ...(Object.keys(labels) as (keyof TextContextAdapter)[]).flatMap((key): MenuItem[] => {
          const action = adapter[key];
          return action
            ? [
                {
                  label: labels[key],
                  onSelect: () => {
                    void Promise.resolve()
                      .then(action)
                      .catch((error: unknown) => {
                        useAppStore.getState().notice({
                          kind: 'error',
                          title: S.textContext.error,
                          message: error instanceof Error ? error.message : String(error),
                        });
                      });
                  },
                },
              ]
            : [];
        }),
        ...((adapter as TextContextAdapter & { editorMenu?: MenuItem[] }).editorMenu ?? []),
      ]}
    >
      {children}
    </ContextMenuArea>
  );
}
