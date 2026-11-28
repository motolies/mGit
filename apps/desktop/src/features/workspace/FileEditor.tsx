import { defaultKeymap, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
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
import type { FsEncoding, HeadState, SessionId } from '@mgit/ipc';
import { Button, ConfirmDialog, S, ToolGroup } from '@mgit/ui';
import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { registerCommand } from '../../command-registry';
import { EditorZoomControls, useEditorZoom } from '../../components/EditorZoom';
import { useRovingToolbar } from '../../components/roving';
import { useAppStore } from '../../store';
import { getEditorPreferences, useEditorPreferences } from '../../store/editor-preferences';
import { type EditorFile, fileEditors } from '../../store/file-editor-store';
import { getFolderStore, getSessionStore } from '../../store/session-registry';
import { useEditorDoc, useEditorImageEpoch } from '../../store/use-file-editors';
import { openFileComparison } from '../history/comparison';
import { EncodingMenu, encodingName } from './EncodingMenu';
import {
  annotationExtension,
  type ChangePreview,
  type GitBase,
  setGitBase,
} from './editor/annotations';
import { editingAssist } from './editor/editing-assist';
import { editorContextItems } from './editor/editor-context';
import { formatText } from './editor/formatter';
import { formatterParser } from './editor/formatter-language';
import { indentUnitFor } from './editor/indentation';
import styles from './FileEditor.module.css';
import { canHighlight, type FileViewRepoTools } from './FileView';
import { MarkdownPreview, type PreviewSource } from './markdown/MarkdownPreview';
import { isMarkdown, type MarkdownMode, markdownViewState } from './markdown/preview-state';

/** 기존 토큰 변수를 쓰므로 테마 변경과 화면 확대를 그대로 따른다. */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)',
    fontSize: 'var(--editor-font-size, 12px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.666666667', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '4px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--fg-muted)',
    borderRight: '1px solid var(--panel-seam)',
  },
  // 선택 레이어는 본문 뒤에 있으므로 현재 줄 배경이 선택 범위를 덮지 않게 한다.
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 5%, transparent)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--bg-selected-inactive)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--bg-selected)',
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

/** 문서마다 들여쓰기 추정을 한 번만 한다. 원문 교체(generation)나 이름 변경(path) 뒤에만 다시 훑는다. */
const indentCache = new WeakMap<EditorFile, { generation: number; path: string; unit: string }>();

/** 공유 문서의 들여쓰기 단위. 입력 중에는 바꾸지 않아 Tab 의 동작이 타이핑 도중 달라지지 않는다. */
function documentIndent(doc: EditorFile): string {
  const cached = indentCache.get(doc);
  if (cached && cached.generation === doc.generation && cached.path === doc.path)
    return cached.unit;
  const unit = indentUnitFor(doc.path, doc.state.doc.toString());
  indentCache.set(doc, { generation: doc.generation, path: doc.path, unit });
  return unit;
}

/** HEAD 가 가리키는 곳을 비교할 값 (branch·commit). refs 를 다시 읽어 객체가 새로 와도 같은 곳이면 같다 */
export function headKeyOf(head: HeadState | null | undefined): string {
  if (!head) return '';
  switch (head.state) {
    case 'attached':
      return `attached:${head.branch}:${head.oid}`;
    case 'detached':
      return `detached:${head.oid}`;
    case 'unborn':
      return `unborn:${head.branch}`;
  }
}

/**
 * 찾기·바꾸기 패널과 줄로 이동 패널의 CodeMirror 문구를 앱 언어로 바꾼다 (접기 문구와 같은 `EditorState.phrases` 방식).
 * 열쇠는 `@codemirror/search` 가 `state.phrase()` 로 묻는 영어 원문이고, `$` 자리에는 CodeMirror 가 수·줄 번호를 넣는다
 */
export function searchPhrases(): Record<string, string> {
  const p = S.fileEditor.findPanel;
  return {
    Find: p.find,
    Replace: p.replace,
    next: p.next,
    previous: p.previous,
    all: p.all,
    'match case': p.matchCase,
    regexp: p.regexp,
    'by word': p.byWord,
    replace: p.replaceOne,
    'replace all': p.replaceAll,
    close: p.close,
    'current match': p.currentMatch,
    'on line': p.onLine,
    'replaced $ matches': p.replacedMatches,
    'replaced match on line $': p.replacedOnLine,
    'Go to line': p.goToLine,
    go: p.go,
  };
}

/** 위 줄에 보일 들여쓰기 이름 (`탭`·`공백 2칸`) */
function indentLabel(unit: string): string {
  return unit.startsWith('\t') ? S.fileEditor.indentTabs : S.fileEditor.indentSpaces(unit.length);
}

/**
 * 일반 파일 편집기 확장. 저장과 조합 이벤트는 문서 저장소에 전달한다. 편집 보조(`editingAssist`)의 키 묶음은
 * 기본 keymap 보다 앞에 둔다(Backspace 의 괄호 쌍 지우기가 먼저)
 */
function extensions(doc: EditorFile, autoCloseBrackets: boolean): Extension {
  const readOnly = doc.mutationLocked === true;
  return [
    theme,
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    lineNumbers(),
    drawSelection(),
    highlightActiveLine(),
    indentOnInput(),
    search({ top: true }),
    EditorState.phrases.of(searchPhrases()),
    highlightSelectionMatches(),
    syntaxHighlighting(codeHighlighter),
    editingAssist({ autoCloseBrackets, readOnly, indentUnit: documentIndent(doc) }),
    EditorView.contentAttributes.of({ 'aria-label': S.fileEditor.content, spellcheck: 'false' }),
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          void (doc.explicitSave?.() ?? fileEditors.save(doc));
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
          !event.altKey &&
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

/**
 * 문서의 그림 재확인 신호(`imageEpoch`)를 받아 미리보기에 넘긴다. 검사마다(2초) 오르므로 편집기 전체가 아니라 미리보기만
 * 다시 그린다 (F1)
 */
function DocMarkdownPreview({
  doc,
  ...props
}: { doc: EditorFile } & Omit<ComponentProps<typeof MarkdownPreview>, 'checkKey'>) {
  const checkKey = useEditorImageEpoch(doc);
  return <MarkdownPreview {...props} checkKey={checkKey} />;
}

/** 탭이 사라져도 남는 EditorState를 표시하며 디스크 충돌은 명시적 확인 후 해결한다. */
export function FileEditor({
  doc,
  repoTools,
  repoPath,
  source,
  refreshEpoch = 0,
  onEncoding,
}: {
  doc: EditorFile;
  repoPath?: string | null;
  source?: PreviewSource;
  refreshEpoch?: number;
  repoTools?: FileViewRepoTools | null;
  /** 머리줄 인코딩 단추에서 고른 인코딩으로 다시 연다 (R2). 주지 않으면 인코딩은 글자로만 보인다 */
  onEncoding?: (encoding: FsEncoding | null) => void;
}) {
  const editTools = useRovingToolbar<HTMLDivElement>('horizontal');
  const viewTools = useRovingToolbar<HTMLDivElement>('horizontal');
  const historyTools = useRovingToolbar<HTMLDivElement>('horizontal');
  // 이 문서가 바뀔 때만 다시 그린다 — 다른 문서의 입력·저장, 바뀐 것 없는 검사에는 깨지 않는다 (F1)
  useEditorDoc(doc);
  const host = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const zoom = useEditorZoom(paneRef);
  useLayoutEffect(() => {
    void zoom.fontSize;
    viewRef.current?.requestMeasure();
  }, [zoom.fontSize]);
  const [confirm, setConfirm] = useState<'reload' | 'overwrite' | null>(null);
  const preferences = useEditorPreferences();
  const [overrides, setOverrides] = useState<Partial<typeof preferences>>({});
  const prefs = { ...preferences, ...overrides };
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [gitSession, setGitSession] = useState<SessionId | null>(null);
  // HEAD 가 바뀐 횟수 (commit·checkout·reset 등). blame·HEAD 원문은 이때만 다시 조회한다 (N6)
  const [headEpoch, setHeadEpoch] = useState(0);
  // 조회가 필요해진 횟수와 마지막으로 결과를 넣은 횟수. 둘이 다르면 입력이 멈춘 뒤 조회한다
  const [queryEpoch, setQueryEpoch] = useState(0);
  // 처음에는 같은 값이라 조회하지 않는다 — 저장소 세션이 정해져 차례가 오를 때 첫 조회를 한 번 한다
  const [loadedEpoch, setLoadedEpoch] = useState(0);
  const [changePreview, setChangePreview] = useState<ChangePreview | null>(null);
  const formatBusy = useRef(false);
  const canFormat = formatterParser(source?.path ?? doc.path) !== null;
  /** 현재 초안에만 포맷 결과를 적용하며 저장 큐와 실행 취소를 공유한다. */
  const format = async (): Promise<boolean> => {
    if (
      !canFormat ||
      formatBusy.current ||
      doc.composing ||
      doc.mutationLocked ||
      doc.status === 'conflict'
    )
      return false;
    formatBusy.current = true;
    setFormatting(true);
    setFormatError(null);
    const sequence = doc.sequence;
    const generation = doc.generation;
    try {
      const text = await formatText(
        doc.state.doc.toString(),
        source?.path ?? doc.path,
        prefs.printWidth,
      );
      if (
        doc.sequence !== sequence ||
        doc.generation !== generation ||
        doc.mutationLocked ||
        doc.composing
      )
        throw new Error(S.fileEditor.formatStale);
      const view = viewRef.current;
      if (!view || view.state !== doc.state) return false;
      if (text !== doc.state.doc.toString())
        view.dispatch({
          changes: { from: 0, to: doc.state.doc.length, insert: text },
          annotations: isolateHistory.of('full'),
          userEvent: 'input.format',
        });
      return true;
    } catch (cause) {
      setFormatError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      formatBusy.current = false;
      setFormatting(false);
    }
  };
  /** 명시적 저장에서만 선택적으로 포맷하고 자동 저장은 기존 큐를 유지한다. */
  const saveExplicit = async () => {
    if (prefs.formatOnSave && canFormat && !(await format())) return false;
    return fileEditors.save(doc);
  };
  useEffect(() => {
    doc.explicitSave = saveExplicit;
    const unregister = paneRef.current
      ? registerCommand('editor.format', paneRef.current, {
          enabled: () => canFormat && !formatting && !doc.composing && !doc.mutationLocked,
          run: () => void format(),
        })
      : undefined;
    const view = viewRef.current;
    if (view)
      editorContextItems.set(view, () => [
        {
          label: S.fileEditor.format,
          disabled: !canFormat || formatting,
          separator: true,
          onSelect: () => void format(),
        },
        {
          label: S.comparison.file,
          disabled: gitSession === null || !repoTools,
          onSelect: () => {
            if (gitSession !== null && repoTools)
              void openFileComparison(
                gitSession,
                repoPath ?? getSessionStore(gitSession)?.getState().path ?? '',
                repoTools.path,
              );
          },
        },
        ...(['currentBlame', 'allBlame', 'changeMarkers'] as const).map((key) => ({
          label: `${prefs[key] ? '✓ ' : ''}${S.fileEditor[key]}`,
          disabled: !repoTools,
          onSelect: () => setOverrides((old) => ({ ...old, [key]: !prefs[key] })),
        })),
        { label: S.fileEditor.editorDefaults, onSelect: () => setOverrides({}) },
      ]);
    return () => {
      unregister?.();
      delete doc.explicitSave;
      if (view) editorContextItems.delete(view);
    };
  });
  // 저장소 세션은 현재 파일의 소속으로 고정한다. 폴더 탭에서도 다른 저장소의 이력을 섞지 않는다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: source와 도구 객체는 매 렌더 새로 생성되므로 식별자만 추적한다.
  useEffect(() => {
    let live = true;
    setGitSession(null);
    if (!source || !repoTools) return;
    if (getSessionStore(source.session)) setGitSession(source.session);
    else if (repoPath)
      void useAppStore.getState().withRepoSession(source.session, repoPath, (state) => {
        if (live) setGitSession(state.id);
      });
    return () => {
      live = false;
    };
  }, [source?.session, repoPath, repoTools?.path]);
  // HEAD 가 가리키는 곳이 바뀔 때만 다시 조회한다. 상태(stage·작업 트리)나 원격 ref 변화로는 blame·HEAD 원문이
  // 바뀌지 않는다 (자동 저장마다 오는 status 갱신으로 다시 조회하던 것을 없앴다, N6)
  useEffect(() => {
    if (gitSession === null) return;
    return getSessionStore(gitSession)?.subscribe((now, before) => {
      if (headKeyOf(now.refs.head) !== headKeyOf(before.refs.head))
        setHeadEpoch((epoch) => epoch + 1);
    });
  }, [gitSession]);
  const annotating = !!repoTools && (prefs.currentBlame || prefs.allBlame || prefs.changeMarkers);
  // 다시 조회할 때: 저장소 세션이 정해짐, 원문 교체(다시 읽기), HEAD 변경, 새로고침, 주석을 켬. 입력으로는 조회하지 않고
  // 조회해 둔 blame 을 편집에 맞춰 옮긴다 (`annotations.ts` `mapBlame`). 저장소 세션이 정해지기 전에는 차례를 올리지 않는다
  // — 문서가 붙을 때와 세션이 정해질 때 두 번 올라 첫 조회가 한 번 더 도는 일을 막는다 (조회는 세션이 있어야 한다)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 조회가 필요해진 신호만 센다.
  useEffect(() => {
    if (gitSession === null) return;
    setQueryEpoch((epoch) => epoch + 1);
  }, [
    doc,
    gitSession,
    doc.generation,
    headEpoch,
    refreshEpoch,
    prefs.currentBlame,
    prefs.allBlame,
    prefs.changeMarkers,
  ]);
  const needsQuery = loadedEpoch !== queryEpoch;
  // 조회는 입력이 0.5초 멈춘 뒤 한 번 한다. 응답이 오기 전에 원문이 바뀌었으면 버리고 다음 멈춤에 다시 한다 (조회한
  // 원문과 맞지 않는 blame 을 넣지 않는다). 조회할 것이 없는 동안에는 원문 변경을 보지 않는다
  // biome-ignore lint/correctness/useExhaustiveDependencies: 조회가 필요할 때만 sequence 를 본다.
  useEffect(() => {
    if (!needsQuery || !source || !repoTools || gitSession === null || doc.composing) return;
    if (!annotating) {
      setLoadedEpoch(queryEpoch);
      return;
    }
    let live = true;
    const sequence = doc.sequence;
    const epoch = queryEpoch;
    const timer = setTimeout(() => {
      const text = doc.state.doc.toString();
      void Promise.all([
        prefs.currentBlame || prefs.allBlame
          ? source.client.blameContents(gitSession, repoTools.path, text, false).catch(() => [])
          : Promise.resolve([]),
        prefs.changeMarkers
          ? source.client
              .revisionFileContent(gitSession, 'HEAD', repoTools.path)
              .then((head) => head ?? '')
              .catch(() => null)
          : Promise.resolve(null),
      ]).then(([lines, head]) => {
        if (!live || doc.sequence !== sequence || doc.composing) return;
        installGitBase({ lines, head });
        setLoadedEpoch(epoch);
      });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    needsQuery,
    queryEpoch,
    needsQuery ? doc.sequence : -1,
    doc.composing,
    gitSession,
    annotating,
  ]);
  /** 조회 결과를 문서 상태에 넣는다. 화면이 이 문서를 보이고 있으면 화면으로, 아니면 공유 상태에 바로 넣는다 */
  const installGitBase = (base: GitBase) => {
    const view = viewRef.current;
    if (view && view.state === doc.state) view.dispatch({ effects: setGitBase.of(base) });
    else fileEditors.update(doc, doc.state.update({ effects: setGitBase.of(base) }).state);
  };
  // 주석 표시는 설정·세션이 바뀌거나 원문이 교체됐을 때만 다시 구성한다. 글자를 칠 때마다 다시 만들지 않는다 —
  // blame·변경 표시는 문서 상태 안에서 편집을 따라 바뀐다 (N6)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 표시 설정과 원문 교체만 다시 구성할 신호다.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !doc.annotations) return;
    if (view.state !== doc.state) view.setState(doc.state);
    view.dispatch({
      effects: doc.annotations.reconfigure(
        annotating
          ? annotationExtension({
              current: prefs.currentBlame,
              all: prefs.allBlame,
              changes: prefs.changeMarkers,
              openCommit: (oid) => {
                const folder = source ? getFolderStore(source.session) : undefined;
                if (folder && repoPath) folder.getState().revealTimelineCommit(repoPath, oid);
                else if (gitSession !== null)
                  void getSessionStore(gitSession)?.getState().jumpToCommit(oid);
                const app = useAppStore.getState();
                if (app.dock.tool !== 'git' || app.dock.gitTab !== 'log')
                  app.toggleDock('git', 'log');
              },
              preview: setChangePreview,
            })
          : [],
      ),
    });
  }, [
    doc,
    doc.generation,
    annotating,
    prefs.currentBlame,
    prefs.allBlame,
    prefs.changeMarkers,
    gitSession,
    repoPath,
  ]);

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
    view.dispatch({
      effects: doc.controls.reconfigure(extensions(doc, getEditorPreferences().autoCloseBrackets)),
    });
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
      view.dispatch({
        effects: doc.controls.reconfigure(
          extensions(doc, getEditorPreferences().autoCloseBrackets),
        ),
      });
    }
    const focus = doc.revealFocus;
    const ownsReveal = !focus || (source?.session === focus.session && source.path === focus.path);
    if (view && focus && ownsReveal && markdown && mode === 'preview') {
      switchMode('edit');
      return;
    }
    if (view && ownsReveal && !host.current?.closest('[hidden], [inert]')) {
      if (doc.revealPosition !== undefined) {
        view.dispatch({ effects: EditorView.scrollIntoView(doc.revealPosition, { y: 'center' }) });
        delete doc.revealPosition;
      }
      if (focus) {
        view.focus();
        if (view.contentDOM.contains(document.activeElement)) delete doc.revealFocus;
      }
    }
  });

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    doc.wrap = wrap;
    view.dispatch({
      effects: doc.controls.reconfigure(extensions(doc, prefs.autoCloseBrackets)),
    });
  }, [doc, wrap, doc.mutationLocked, prefs.autoCloseBrackets]);

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
      ref={paneRef}
      style={{ '--editor-font-size': `${zoom.fontSize}px` } as React.CSSProperties}
      className={styles.pane}
      aria-label={S.fileEditor.title}
      onKeyDownCapture={(event) => {
        if (
          !previewVisible ||
          event.altKey ||
          host.current?.contains(event.target as Node) ||
          !(event.metaKey || event.ctrlKey)
        )
          return;
        const key = event.key.toLowerCase();
        if (['s', 'f', 'h'].includes(key)) {
          event.preventDefault();
          event.stopPropagation();
          if (key === 's') void (doc.explicitSave?.() ?? fileEditors.save(doc));
          else find();
        }
      }}
    >
      <header className={styles.header}>
        <span className={styles.path} title={source?.path ?? doc.path}>
          {source?.path ?? doc.path}
        </span>
        {/* 상태 묶음: 인코딩·줄 끝·들여쓰기, 강조 생략, 자동 저장, 저장 상태 */}
        <span className={styles.status}>
          <span className={styles.meta}>
            {onEncoding ? (
              <EncodingMenu
                encoding={doc.encoding}
                bom={doc.bom}
                guessed={doc.guessed}
                chosen={doc.readAs !== null}
                locked={
                  doc.dirty || doc.inflight || doc.composing || doc.mutationLocked
                    ? S.fileEditor.encodingLocked
                    : null
                }
                onChoose={onEncoding}
              />
            ) : (
              `${encodingName(doc.encoding)}${doc.bom ? ' BOM' : ''}`
            )}{' '}
            · {doc.lineEnding.toUpperCase()} · {indentLabel(documentIndent(doc))}
          </span>
          {!highlighting ? <span className={styles.meta}>{S.fileEditor.noHighlight}</span> : null}
          <span className={styles.meta}>{S.fileEditor.autoSave}</span>
          <span role="status" data-status={doc.status}>
            {S.fileEditor[doc.status]}
          </span>
        </span>
        {/* 크기(배율 세그먼트)와 편집(저장·포맷·찾기) 묶음. 한 막대라 방향키로 Format → Find 가 이어진다 */}
        <div {...editTools} className={styles.tools} role="toolbar" aria-label={S.fileEditor.title}>
          <EditorZoomControls />
          <ToolGroup>
            <Button
              onClick={() => {
                void (doc.explicitSave?.() ?? fileEditors.save(doc));
              }}
              disabled={!doc.dirty || doc.status === 'conflict' || doc.status === 'saving'}
            >
              {S.fileEditor.save}
            </Button>
            <Button
              onClick={() => void format()}
              disabled={!canFormat || formatting || doc.composing || doc.mutationLocked}
            >
              {formatting ? S.fileEditor.formatting : S.fileEditor.format}
            </Button>
            <Button onClick={find}>{S.fileEditor.findReplace}</Button>
          </ToolGroup>
        </div>
        {/* 보기 묶음: 줄바꿈은 단독, Markdown 보기 모드는 붙인 세그먼트 */}
        <div
          {...viewTools}
          className={styles.tools}
          role="toolbar"
          aria-label={S.fileEditor.viewTools}
        >
          <ToolGroup>
            <Button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              {S.fileEditor.wrap}
            </Button>
            {markdown && source ? (
              <ToolGroup segmented label={S.markdown.viewMode}>
                {(['edit', 'preview', 'split'] as const).map((value) => (
                  <Button
                    key={value}
                    aria-pressed={mode === value}
                    onClick={() => switchMode(value)}
                  >
                    {S.markdown[value]}
                  </Button>
                ))}
              </ToolGroup>
            ) : null}
          </ToolGroup>
        </div>
        {repoTools ? (
          <div
            {...historyTools}
            className={styles.tools}
            role="toolbar"
            aria-label={S.fileEditor.history}
          >
            <ToolGroup>
              <Button onClick={repoTools.onHistory}>{S.fileEditor.history}</Button>
              <Button onClick={repoTools.onBlame}>{S.fileView.blame}</Button>
            </ToolGroup>
          </div>
        ) : null}
      </header>
      {formatError ? (
        <div className={styles.warning} role="alert">
          {formatError}
        </div>
      ) : null}
      {changePreview ? (
        <div className={`${styles.warning} ${styles.changePreview}`}>
          <div>
            <strong>{S.fileEditor.previousContent}</strong>
            <pre>{changePreview.before}</pre>
            <strong>{S.fileEditor.localChange}</strong>
            <pre>{changePreview.after}</pre>
          </div>
          <Button onClick={() => setChangePreview(null)}>{S.history.close}</Button>
        </div>
      ) : null}
      {doc.status === 'conflict' || doc.status === 'error' ? (
        <div className={styles.warning} role="alert">
          <span>{doc.error ?? S.fileEditor.externalChanged}</span>
          {doc.status === 'error' ? (
            <Button
              onClick={() => {
                void (doc.explicitSave?.() ?? fileEditors.save(doc));
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
            <DocMarkdownPreview
              doc={doc}
              zoomPercent={zoom.zoomPercent}
              text={previewText}
              source={source}
              viewState={viewState}
              refreshKey={String(refreshEpoch)}
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
