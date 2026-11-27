import type { WorkspaceFileList, WorkspaceSearchHit, WorkspaceSearchResult } from '@mgit/ipc';
import { Button, isImeKey, S } from '@mgit/ui';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MatchedText } from '../../components/MatchedText';
import { rovingIndex } from '../../components/roving';
import { useModal } from '../../components/use-modal';
import { getWorkspaceStore, useAppStore, useFolder } from '../../store';
import { editorDraftStamp, editorDrafts } from '../../store/editor-drafts';
import { fileEditors } from '../../store/file-editor-store';
import { readRecentFiles } from '../../store/recent-files';
import { tabSpace } from '../../store/session-space';
import { useEditorSelect } from '../../store/use-file-editors';
import { fileViewDoc } from '../../store/workspace-store';
import { fileListCache, filesStamp } from './file-list';
import { presentRecent, rankFiles, repoOf } from './fuzzy';
import { ReplacePreviewDialog, type ReplaceRequest } from './ReplacePreview';
import { useSearchPanel } from './search-state';
import styles from './WorkspaceSearch.module.css';

/** 빠른 열기 결과 줄 수 */
const QUICK_OPEN_LIMIT = 100;

/** 빠른 열기와 내용 검색의 결과를 저장소·파일 단위로 보여준다. */
export function WorkspaceSearch() {
  const { mode, focusVersion, close } = useSearchPanel();
  const input = useRef<HTMLInputElement>(null);
  const resultViewport = useRef<HTMLDivElement>(null);
  const listId = useId();
  const composing = useRef(false);
  const session = useAppStore((s) => s.activeSessionId);
  const client = useAppStore((s) => s.client);
  const root = useAppStore((s) => (session === null ? '' : (s.sessions[session]?.path ?? '')));
  // 내용 검색일 때만 이 탭 공간의 초안 지문(경로·sequence)을 본다. 바뀐 것 없는 검사·저장 상태 전환·이 공간 밖의 입력에는
  // 다시 그리지도 재검색하지도 않는다 (F1)
  const draftStamp = useEditorSelect(() => {
    if (mode !== 'content' || session === null) return '';
    const space = tabSpace(session, root);
    return space ? editorDraftStamp(space) : '';
  });
  const restoreAfterClose = useRef(true);
  // 빠른 열기 창: 전체 파일(⌘P) 또는 최근 파일만(⌘E)
  const quick = mode === 'files' || mode === 'recent';
  const dialog = useModal(quick, { restoreFocus: () => restoreAfterClose.current });
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [filter, setFilter] = useState('');
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [fileList, setFileList] = useState<WorkspaceFileList | null>(null);
  const [listBusy, setListBusy] = useState(false);
  // 여러 파일 바꾸기: 바꿀 내용, 열린 바꾸기 창의 요청, 바꾼 뒤 검색을 다시 돌리는 신호
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState<ReplaceRequest | null>(null);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const openSessions = useAppStore((s) => s.sessions);
  const sequence = useRef(0);
  const pending = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 검색 모드 전환 때 입력과 결과를 초기화한다.
  useEffect(() => {
    setQuery('');
    setResult(null);
    setScope('');
    setRecent(readRecentFiles(root));
  }, [mode, root]);
  // 빠른 열기를 열 때마다(같은 명령을 다시 실행해도) 받아 둔 목록을 바로 보이고, 표지가 바뀌었을 때만 새로 받는다.
  // 입력마다 다시 받지 않는다. 받는 동안 낡은 목록에서 고른 파일이 사라졌어도 여는 쪽이 "파일 없음"으로 보인다
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusVersion 은 빠른 열기를 다시 연 신호다.
  useEffect(() => {
    if (!quick || session === null) return;
    let live = true;
    fileListCache.retain((id) => openSessions[id] !== undefined);
    setFileList(fileListCache.peek(session));
    setError('');
    const request = `files-${session}-${Date.now()}`;
    const loading = fileListCache.load(session, filesStamp(session), () => {
      pending.current = request;
      return client.workspaceFiles(session, request);
    });
    setListBusy(fileListCache.isLoading(session));
    loading
      .then(
        (list) => {
          if (live) setFileList(list);
        },
        (cause: unknown) => {
          if (live) setError(String(cause));
        },
      )
      .finally(() => {
        if (pending.current === request) pending.current = null;
        if (live) setListBusy(false);
      });
    return () => {
      live = false;
    };
  }, [client, session, mode, focusVersion, openSessions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 열린 파일의 초안이 바뀌거나 바꾸기를 마치면 검색 결과를 갱신한다.
  useEffect(() => {
    const seq = ++sequence.current;
    setSelection(0);
    setResult(null);
    if (mode !== 'content' || session === null) return;
    const request = `search-${session}-${Date.now()}-${seq}`;
    const timer = setTimeout(() => {
      pending.current = request;
      setBusy(true);
      setError('');
      // 초안은 탭 공간의 경로로 보낸다 (그룹 탭은 `별칭/…`). 공간을 아직 모르면(그룹 스토어 없음) 보낼 초안이 없다
      const space = tabSpace(session, root);
      const drafts = space ? editorDrafts(space) : [];
      void client
        .workspaceSearch(session, request, {
          text: query,
          content: mode === 'content',
          regex,
          caseSensitive: matchCase,
          pathFilter: filter,
          scope,
          drafts,
        })
        .then(
          (next) => {
            if (seq === sequence.current) setResult(next);
          },
          (cause: unknown) => {
            if (seq === sequence.current) setError(String(cause));
          },
        )
        .finally(() => {
          if (seq === sequence.current) {
            pending.current = null;
            setBusy(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      void client.workspaceSearchCancel(session, request).catch(() => {});
    };
  }, [
    client,
    session,
    root,
    mode,
    query,
    regex,
    matchCase,
    filter,
    scope,
    draftStamp,
    searchEpoch,
  ]);
  // 폴더 탭의 저장소 목록과 경로 공간(그룹은 별칭)을 구독한다. 패널이 열린 동안 폴더를 다시 훑거나 그룹을 고쳐도 저장소
  // 범위 선택지가 낡지 않는다 (예전에는 편집기 저장소의 전역 알림이 우연히 다시 그려 주었다)
  const folderView = useFolder((f) => ({ repos: f.repos, space: f.space }));
  const repos = folderView?.repos ?? [];
  // 저장소 범위 선택지의 값: 저장소의 탭 공간 경로 (폴더는 폴더 기준, 그룹은 별칭)
  const scopeSpace = session === null ? null : tabSpace(session, root);
  // 경로 10만 개면 한 번 순위 계산에 수십 ms 가 걸리므로, 입력칸은 먼저 그리고 순위는 뒤따라 계산한다
  const rankedQuery = useDeferredValue(query);
  // 순위를 매길 후보: 빠른 열기는 전체 파일, 최근 파일은 최근 목록 중 아직 있는 것 (목록을 아직 못 받았으면 그대로)
  const candidates = useMemo(
    () =>
      mode === 'recent'
        ? fileList
          ? presentRecent(recent, fileList.files)
          : recent
        : (fileList?.files ?? []),
    [mode, fileList, recent],
  );
  const ranked = useMemo(
    () => (quick ? rankFiles(candidates, rankedQuery, recent, QUICK_OPEN_LIMIT) : null),
    [quick, candidates, rankedQuery, recent],
  );
  /** 빠른 열기 결과 줄을 여는 동작이 쓰는 검색 결과 모양으로 바꾼다 (저장소는 가장 긴 저장소 디렉터리) */
  const fileHit = (path: string): WorkspaceSearchHit => ({
    path,
    repo: repoOf(path, fileList?.repos ?? []),
    line: 1,
    column: 1,
    text: '',
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileHit 은 fileList 만 읽는다.
  const hits: WorkspaceSearchHit[] = useMemo(
    () => (ranked ? ranked.items.map((item) => fileHit(item.path)) : (result?.hits ?? [])),
    [ranked, fileList, result],
  );
  /**
   * Enter 로 열 결과. 빠르게 치고 바로 Enter 를 누르면 뒤따르는 순위 계산이 아직 앞 검색어 것이므로, 그때는 지금
   * 검색어로 다시 계산해 고른다 (검색어가 바뀌면 고른 줄은 첫 줄로 돌아간다)
   */
  const enterTarget = (): WorkspaceSearchHit | undefined => {
    if (!quick || rankedQuery === query) return hits[selection];
    const first = rankFiles(candidates, query, recent, 1).items[0];
    return first ? fileHit(first.path) : undefined;
  };
  const summary = quick ? fileList : result;
  const showBusy = quick ? listBusy : busy;
  const rows = useMemo(
    () =>
      hits.flatMap((hit, index) => {
        const item = { hit, index, header: false };
        return mode === 'content' && (index === 0 || hits[index - 1]?.path !== hit.path)
          ? [{ hit, index, header: true }, item]
          : [item];
      }),
    [hits, mode],
  );
  const activeRow = rows.findIndex((row) => !row.header && row.index === selection);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => resultViewport.current,
    estimateSize: (index) => (rows[index]?.header ? 28 : 34),
    initialRect: { width: 600, height: 340 },
    overscan: 5,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(activeRow >= 0 ? [activeRow] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  // useModal이 showModal을 실행한 뒤 입력칸을 고른다. 닫힌 dialog 내부에는 먼저 포커스할 수 없다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 같은 검색 명령을 다시 실행해도 입력칸으로 돌아간다.
  useEffect(() => {
    if (!mode) return;
    restoreAfterClose.current = true;
    input.current?.focus();
    input.current?.select();
  }, [mode, focusVersion]);
  useLayoutEffect(() => {
    if (activeRow >= 0) virtual.scrollToIndex(activeRow, { align: 'auto' });
  }, [activeRow, virtual]);
  if (!mode || session === null) return null;
  /** 파일 초안에 선택 위치를 적용하고 워크스페이스 탭으로 이동한다. */
  const open = async (hit: WorkspaceSearchHit) => {
    try {
      const doc = await fileEditors.open(client, session, hit.path);
      // 먼저 모달을 닫아 새 편집기의 포커스를 막는 native modal 상태를 해제한다.
      if (quick) {
        restoreAfterClose.current = false;
        dialog.current?.close();
        close(false);
      }
      // 결과의 저장소(탭 공간 경로 — 그룹은 `별칭/…`)를 절대 경로로. 공간을 모르면 저장소 없이 연다
      const repoPath = hit.repo == null ? null : (tabSpace(session, root)?.toAbs(hit.repo) ?? null);
      getWorkspaceStore(session)
        ?.getState()
        .openDoc(
          fileViewDoc({
            path: hit.path,
            name: hit.path.split('/').pop() ?? hit.path,
            repoPath,
            repoName: repoPath?.split('/').pop() ?? null,
          }),
          'pinned',
        );
      // 최근 파일 기록은 연 탭이 보이게 될 때 앱 스토어의 감시(`watchRecentFiles`)가 한다 (어느 길로 열었든 같게).
      // 낡은 목록에서 고른 파일이 이미 없으면 편집기 탭이 "파일 없음"을 보이고, 다음에 열 때 목록을 다시 받는다
      if (quick && 'kind' in doc && doc.kind === 'missing') fileListCache.invalidate(session);
      if ('fileKey' in doc) {
        const line = doc.state.doc.line(Math.min(hit.line, doc.state.doc.lines));
        const pos = Math.min(line.to, line.from + hit.column - 1);
        doc.scrollTop = Math.max(0, (hit.line - 5) * 20);
        // 파일 열기가 비동기여도 해당 문서가 마운트될 때 정확한 편집기가 요청을 소비한다.
        fileEditors.reveal(doc, pos, { session, path: hit.path });
      }
    } catch (cause) {
      setError(String(cause));
    }
  };
  /** 지금 검색 조건과 바꿀 내용으로 바꾸기 창을 연다 (정규식·대소문자·범위·경로 필터가 검색과 같다) */
  const openReplace = () => {
    if (!query) return;
    setReplacing({
      pattern: { text: query, regex, caseSensitive: matchCase, replacement },
      pathFilter: filter,
      scope,
    });
  };
  const body = (
    <div className={styles.body}>
      <header>
        <strong>
          {mode === 'recent'
            ? S.workspaceSearch.recentFiles
            : mode === 'files'
              ? S.workspaceSearch.quickOpen
              : S.workspaceSearch.title}
        </strong>
        <Button size="compact" onClick={() => close()}>
          {S.workspaceSearch.close}
        </Button>
      </header>
      <input
        aria-label={S.workspaceSearch.query}
        ref={input}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-activedescendant={hits[selection] ? `${listId}-${selection}` : undefined}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        value={query}
        placeholder={
          quick ? S.workspaceSearch.filePlaceholder : S.workspaceSearch.contentPlaceholder
        }
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (composing.current || isImeKey(e) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
            return;
          // 좌우·Home·End는 검색어 안의 커서 이동으로 유지한다.
          if (e.key === 'Home' || e.key === 'End') return;
          const next = rovingIndex(e.key, selection, hits.length, 'vertical', false);
          if (next !== null) {
            e.preventDefault();
            setSelection(next);
          } else if (e.key === 'Enter') {
            const target = enterTarget();
            if (!target) return;
            e.preventDefault();
            void open(target);
          }
        }}
      />
      {mode === 'content' ? (
        <div className={styles.options}>
          <select
            aria-label={S.workspaceSearch.repoScope}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">{S.workspaceSearch.all}</option>
            {repos.map((repo) => (
              <option key={repo.path} value={scopeSpace?.toRel(repo.path) ?? ''}>
                {repo.path.split('/').pop()}
              </option>
            ))}
          </select>
          <input
            aria-label={S.workspaceSearch.folderScope}
            placeholder={S.workspaceSearch.scopePlaceholder}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <input
            aria-label={S.workspaceSearch.pathFilter}
            placeholder={S.workspaceSearch.pathContains}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label>
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            {S.workspaceSearch.regex}
          </label>
          <label>
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(e) => setMatchCase(e.target.checked)}
            />
            {S.workspaceSearch.matchCase}
          </label>
        </div>
      ) : null}
      {mode === 'content' ? (
        <div className={styles.replace}>
          <input
            aria-label={S.workspaceSearch.replaceWith}
            placeholder={S.workspaceSearch.replacePlaceholder}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (!isImeKey(e) && e.key === 'Enter') {
                e.preventDefault();
                openReplace();
              }
            }}
          />
          <Button size="compact" disabled={!query} onClick={openReplace}>
            {S.workspaceSearch.replaceOpen}
          </Button>
        </div>
      ) : null}
      <div role="status">
        {showBusy
          ? S.workspaceSearch.searching
          : S.workspaceSearch.results(ranked ? ranked.total : hits.length)}{' '}
        {summary?.skipped ? S.workspaceSearch.skipped(summary.skipped) : ''}{' '}
        {summary?.truncated ? S.workspaceSearch.limited : ''}
        {showBusy ? (
          <Button
            size="compact"
            onClick={() => {
              if (pending.current) void client.workspaceSearchCancel(session, pending.current);
            }}
          >
            {S.workspaceSearch.cancel}
          </Button>
        ) : null}
      </div>
      {error ? <div role="alert">{error}</div> : null}
      <div
        ref={resultViewport}
        className={styles.results}
        id={listId}
        role="listbox"
        aria-label={S.workspaceSearch.results(hits.length)}
        aria-busy={showBusy}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const { hit, index, header } = row;
            const style = {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              width: '100%',
              height: item.size,
              transform: `translateY(${item.start}px)`,
            };
            if (header)
              return (
                <div
                  key={item.key}
                  role="presentation"
                  className={styles.resultGroup}
                  style={style}
                  title={hit.path}
                >
                  {hit.repo || root.split('/').pop()} / {hit.path}
                </div>
              );
            return (
              <div
                key={item.key}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (!isImeKey(event) && event.key === 'Enter') {
                    event.preventDefault();
                    void open(hit);
                  }
                }}
                aria-selected={selection === index}
                aria-posinset={index + 1}
                aria-setsize={hits.length}
                className={styles.hit}
                style={style}
                title={`${hit.path}:${hit.line}:${hit.column}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSelection(index);
                  void open(hit);
                }}
              >
                {quick ? (
                  <>
                    <MatchedText
                      text={hit.path}
                      positions={ranked?.items[index]?.positions ?? []}
                    />
                    <small>{hit.repo || root.split('/').pop()}</small>
                  </>
                ) : (
                  <>
                    <small>
                      {hit.line}:{hit.column}
                    </small>
                    <code>{hit.text}</code>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {replacing ? (
        <ReplacePreviewDialog
          client={client}
          session={session}
          root={root}
          request={replacing}
          onClose={() => setReplacing(null)}
          onApplied={() => setSearchEpoch((n) => n + 1)}
        />
      ) : null}
    </div>
  );
  return quick ? (
    <dialog ref={dialog} className={styles.dialog} onClose={() => close()}>
      {body}
    </dialog>
  ) : (
    <section
      className={styles.panel}
      aria-label={S.workspaceSearch.title}
      onKeyDown={(event) => {
        if (!isImeKey(event) && !composing.current && event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      {body}
    </section>
  );
}
