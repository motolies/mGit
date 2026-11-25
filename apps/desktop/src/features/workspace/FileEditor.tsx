import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, syntaxHighlighting } from '@codemirror/language';
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { codeHighlighter, loadLanguage } from '@mgit/diff-view';
import { Button, ConfirmDialog, S } from '@mgit/ui';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type EditorFile, fileEditors } from '../../store/file-editor-store';
import styles from './FileEditor.module.css';
import { canHighlight, type FileViewRepoTools } from './FileView';
import { MarkdownPreview, type PreviewSource } from './markdown/MarkdownPreview';
import { isMarkdown, type MarkdownMode, markdownViewState } from './markdown/preview-state';

/** 기존 토큰 변수를 쓰므로 테마 변경과 화면 확대를 그대로 따른다. */
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '4px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--fg-muted)',
    borderRight: '1px solid var(--panel-seam)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
  },
  '.cm-panels': {
    color: 'var(--fg)',
    backgroundColor: 'var(--bg-panel)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-textfield, .cm-button': {
    color: 'var(--fg)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
});

/** 일반 파일 편집기 확장. 저장과 조합 이벤트는 문서 저장소에 전달한다. */
function extensions(doc: EditorFile): Extension {
  return [
    theme,
    EditorState.readOnly.of(doc.mutationLocked === true),
    EditorView.editable.of(doc.mutationLocked !== true),
    lineNumbers(),
    drawSelection(),
    highlightActiveLine(),
    indentOnInput(),
    search({ top: true }),
    highlightSelectionMatches(),
    syntaxHighlighting(codeHighlighter),
    EditorState.tabSize.of(4),
    EditorView.contentAttributes.of({ 'aria-label': S.fileEditor.content, spellcheck: 'false' }),
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          void fileEditors.save(doc);
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    EditorView.domEventHandlers({
      compositionstart: () => {
        fileEditors.composition(doc, true);
        return false;
      },
      compositionend: () => {
        fileEditors.composition(doc, false);
        return false;
      },
      keydown: (event) => {
        // 앱의 Git 실행 취소나 전역 찾기가 텍스트 편집 명령을 가로채지 않게 한다.
        if (
          (event.ctrlKey || event.metaKey) &&
          ['z', 'y', 's', 'f', 'h'].includes(event.key.toLowerCase())
        )
          event.stopPropagation();
        return false;
      },
      scroll: (_event, view) => {
        if (view.scrollDOM.clientHeight > 0) {
          doc.scrollTop = view.scrollDOM.scrollTop;
          doc.scrollLeft = view.scrollDOM.scrollLeft;
        }
        return false;
      },
    }),
    doc.wrap ? EditorView.lineWrapping : [],
  ];
}

/** 탭이 사라져도 남는 EditorState를 표시하며 디스크 충돌은 명시적 확인 후 해결한다. */
export function FileEditor({
  doc,
  repoTools,
  source,
  refreshEpoch = 0,
}: {
  doc: EditorFile;
  source?: PreviewSource;
  refreshEpoch?: number;
  repoTools?: FileViewRepoTools | null;
}) {
  useSyncExternalStore(fileEditors.subscribe, fileEditors.getVersion);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [confirm, setConfirm] = useState<'reload' | 'overwrite' | null>(null);
  const [wrap, setWrap] = useState(doc.wrap);
  const markdown = isMarkdown(source?.path ?? doc.path);
  const viewState = markdownViewState(doc.fileKey);
  const [mode, setMode] = useState(viewState.mode);
  const [ratio, setRatio] = useState(viewState.ratio);
  const [horizontal, setHorizontal] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [previewText, setPreviewText] = useState(() => doc.state.doc.toString());
  const previewVisible = markdown && mode !== 'edit' && !!source;
  const switchMode = (next: MarkdownMode) => {
    const view = viewRef.current;
    if (view && !host.current?.hidden) {
      doc.scrollTop = view.scrollDOM.scrollTop;
      doc.scrollLeft = view.scrollDOM.scrollLeft;
    }
    viewState.mode = next;
    if (!doc.composing) setPreviewText(doc.state.doc.toString());
    setMode(next);
  };
  const find = () => {
    switchMode('edit');
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (view) {
        openSearchPanel(view);
        view.requestMeasure();
      }
    });
  };
  useEffect(() => {
    setMode(viewState.mode);
    setRatio(viewState.ratio);
    setWrap(doc.wrap);
    setPreviewText(doc.state.doc.toString());
  }, [doc, viewState]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sequence는 초안 변경, composing은 IME 완료 신호다.
  useEffect(() => {
    if (!previewVisible || doc.composing) return;
    const timer = setTimeout(() => setPreviewText(doc.state.doc.toString()), 300);
    return () => clearTimeout(timer);
  }, [doc, doc.sequence, doc.composing, previewVisible]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const resize = () => setHorizontal(element.getBoundingClientRect().width >= 800);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 보기 배치가 바뀌면 숨겨졌던 편집기 크기를 다시 측정한다.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view && mode !== 'preview') {
      view.scrollDOM.scrollTop = doc.scrollTop;
      view.scrollDOM.scrollLeft = doc.scrollLeft;
    }
    view?.requestMeasure();
  }, [doc, mode, horizontal, ratio]);
  const highlighting = canHighlight(doc.state.doc.lines, doc.state.doc.length);

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: doc.state,
      dispatchTransactions: (transactions, current) => {
        // 구조 변경 중에는 늦은 입력이 이동 전 경로의 초안을 되살리지 못하게 한다.
        if (doc.mutationLocked && transactions.some((transaction) => transaction.docChanged))
          return;
        current.update(transactions);
        fileEditors.update(doc, current.state);
      },
    });
    viewRef.current = view;
    view.dispatch({ effects: doc.controls.reconfigure(extensions(doc)) });
    view.scrollDOM.scrollTop = doc.scrollTop;
    view.scrollDOM.scrollLeft = doc.scrollLeft;
    return () => {
      if (!host.current?.hidden) {
        doc.scrollTop = view.scrollDOM.scrollTop;
        doc.scrollLeft = view.scrollDOM.scrollLeft;
      }
      viewRef.current = null;
      view.destroy();
    };
  }, [doc]);

  // 다른 화면에서 같은 파일을 편집하거나 원문을 다시 읽으면 공유 상태로 맞춘다.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view && view.state !== doc.state) {
      view.setState(doc.state);
      view.dispatch({ effects: doc.controls.reconfigure(extensions(doc)) });
    }
  });

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    doc.wrap = wrap;
    view.dispatch({ effects: doc.controls.reconfigure(extensions(doc)) });
  }, [doc, wrap, doc.mutationLocked]);

  // 언어 파서는 파일명으로 늦게 읽으며 큰 문서는 편집을 유지하고 강조만 끈다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation은 원문 교체 뒤 언어 확장을 다시 적용하는 신호다.
  useEffect(() => {
    let live = true;
    const apply = (language: Extension) => {
      const view = viewRef.current;
      if (live && view) view.dispatch({ effects: doc.language.reconfigure(language) });
    };
    if (!highlighting) apply([]);
    else {
      void loadLanguage(source?.path ?? doc.path).then(
        (support) => apply(support?.extension ?? []),
        () => apply([]),
      );
    }
    return () => {
      live = false;
    };
  }, [doc, highlighting, doc.generation, source?.path]);

  return (
    <section
      className={styles.pane}
      aria-label={S.fileEditor.title}
      onKeyDownCapture={(event) => {
        if (
          !previewVisible ||
          host.current?.contains(event.target as Node) ||
          !(event.metaKey || event.ctrlKey)
        )
          return;
        const key = event.key.toLowerCase();
        if (['s', 'f', 'h'].includes(key)) {
          event.preventDefault();
          event.stopPropagation();
          if (key === 's') void fileEditors.save(doc);
          else find();
        }
      }}
    >
      <header className={styles.header}>
        <span className={styles.path} title={source?.path ?? doc.path}>
          {source?.path ?? doc.path}
        </span>
        <span className={styles.meta}>
          {doc.bom ? 'UTF-8 BOM' : 'UTF-8'} · {doc.lineEnding.toUpperCase()}
        </span>
        {!highlighting ? <span className={styles.meta}>{S.fileEditor.noHighlight}</span> : null}
        <span className={styles.meta}>{S.fileEditor.autoSave}</span>
        <span role="status" data-status={doc.status}>
          {S.fileEditor[doc.status]}
        </span>
        <Button
          onClick={() => {
            void fileEditors.save(doc);
          }}
          disabled={!doc.dirty || doc.status === 'conflict' || doc.status === 'saving'}
        >
          {S.fileEditor.save}
        </Button>
        <Button onClick={find}>{S.fileEditor.findReplace}</Button>
        <Button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          {S.fileEditor.wrap}
        </Button>
        {markdown && source ? (
          <fieldset className={styles.modes} aria-label={S.markdown.viewMode}>
            {(['edit', 'preview', 'split'] as const).map((value) => (
              <Button key={value} aria-pressed={mode === value} onClick={() => switchMode(value)}>
                {S.markdown[value]}
              </Button>
            ))}
          </fieldset>
        ) : null}
        {repoTools ? (
          <>
            <Button onClick={repoTools.onHistory}>{S.fileEditor.history}</Button>
            <Button onClick={repoTools.onBlame}>Blame</Button>
          </>
        ) : null}
      </header>
      {doc.status === 'conflict' || doc.status === 'error' ? (
        <div className={styles.warning} role="alert">
          <span>{doc.error ?? S.fileEditor.externalChanged}</span>
          {doc.status === 'error' ? (
            <Button
              onClick={() => {
                void fileEditors.save(doc);
              }}
            >
              {S.fileEditor.retrySave}
            </Button>
          ) : null}
          <Button onClick={() => setConfirm('reload')}>{S.fileEditor.reload}</Button>
          <Button onClick={() => setConfirm('overwrite')}>{S.fileEditor.overwrite}</Button>
        </div>
      ) : null}
      <div
        className={styles.body}
        ref={body}
        data-direction={horizontal ? 'horizontal' : 'vertical'}
      >
        <div
          className={styles.editor}
          ref={host}
          data-testid="file-editor"
          hidden={previewVisible && mode === 'preview'}
          style={previewVisible && mode === 'split' ? { flex: `0 0 ${ratio}%` } : undefined}
        />
        {previewVisible && mode === 'split' ? (
          <button
            type="button"
            className={styles.separator}
            aria-label={S.markdown.resize}
            title={`${S.markdown.resize}: ${Math.round(ratio)}%`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !body.current) return;
              const rect = body.current.getBoundingClientRect();
              const position = horizontal
                ? (event.clientX - rect.left) / rect.width
                : (event.clientY - rect.top) / rect.height;
              const next = Math.max(15, Math.min(85, position * 100));
              viewState.ratio = next;
              setRatio(next);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key))
                return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 50
                  : Math.max(
                      15,
                      Math.min(85, ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -5 : 5)),
                    );
              viewState.ratio = next;
              setRatio(next);
            }}
          />
        ) : null}
        {previewVisible ? (
          <div className={styles.preview}>
            <MarkdownPreview
              text={previewText}
              source={source}
              viewState={viewState}
              refreshKey={`${refreshEpoch}-${doc.imageEpoch}`}
            />
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        danger
        title={confirm === 'overwrite' ? S.fileEditor.overwrite : S.fileEditor.reload}
        message={
          confirm === 'overwrite' ? S.fileEditor.overwriteConfirm : S.fileEditor.reloadConfirm
        }
        items={[doc.path]}
        confirmLabel={
          confirm === 'overwrite' ? S.fileEditor.overwriteAction : S.fileEditor.reloadAction
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === 'overwrite') void fileEditors.overwrite(doc);
          else void fileEditors.reload(doc);
          setConfirm(null);
        }}
      />
    </section>
  );
}
