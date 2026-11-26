import type { WorkspaceSearchHit, WorkspaceSearchResult } from '@mgit/ipc';
import { Button, isImeKey, S } from '@mgit/ui';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { rovingIndex } from '../../components/roving';
import { useModal } from '../../components/use-modal';
import { getFolderStore, getWorkspaceStore, useAppStore } from '../../store';
import { editorDrafts } from '../../store/editor-drafts';
import { fileEditors } from '../../store/file-editor-store';
import { readPref, writePref } from '../../store/prefs';
import { fileViewDoc } from '../../store/workspace-store';
import { useSearchPanel } from './search-state';
import styles from './WorkspaceSearch.module.css';

/** 파일명 일치와 최근 방문 순서로 빠른 열기 후보를 정렬한다. */
export function rankFiles(
  hits: WorkspaceSearchHit[],
  query: string,
  recent: string[],
): WorkspaceSearchHit[] {
  const score = (h: WorkspaceSearchHit) => {
    const name = h.path.split('/').pop()?.toLowerCase() ?? '';
    const q = query.toLowerCase();
    return (
      (name === q ? 10000 : name.startsWith(q) && q ? 5000 : 0) +
      (recent.includes(h.path) ? 1000 - recent.indexOf(h.path) : 0)
    );
  };
  return [...hits].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
}

/** 빠른 열기와 내용 검색의 결과를 저장소·파일 단위로 보여준다. */
export function WorkspaceSearch() {
  const { mode, focusVersion, close } = useSearchPanel();
  const input = useRef<HTMLInputElement>(null);
  const resultViewport = useRef<HTMLDivElement>(null);
  const listId = useId();
  const composing = useRef(false);
  const draftVersion = useSyncExternalStore(fileEditors.subscribe, fileEditors.getVersion);
  const session = useAppStore((s) => s.activeSessionId);
  const client = useAppStore((s) => s.client);
  const root = useAppStore((s) => (session === null ? '' : (s.sessions[session]?.path ?? '')));
  const restoreAfterClose = useRef(true);
  const dialog = useModal(mode === 'files', { restoreFocus: () => restoreAfterClose.current });
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
  const sequence = useRef(0);
  const pending = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 검색 모드 전환 때 입력과 결과를 초기화한다.
  useEffect(() => {
    setQuery('');
    setResult(null);
    setScope('');
    setRecent(readPref<string[]>(`mgit.search.recent:${root}`, []));
  }, [mode, root]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 열린 파일의 초안이 바뀌면 검색 결과를 갱신한다.
  useEffect(() => {
    const seq = ++sequence.current;
    setSelection(0);
    setResult(null);
    if (!mode || session === null) return;
    const request = `search-${session}-${Date.now()}-${seq}`;
    const timer = setTimeout(() => {
      pending.current = request;
      setBusy(true);
      setError('');
      const drafts = editorDrafts(root);
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
  }, [client, session, root, mode, query, regex, matchCase, filter, scope, draftVersion]);
  const repos = session === null ? [] : (getFolderStore(session)?.getState().repos ?? []);
  const hits = useMemo(
    () =>
      mode === 'files'
        ? rankFiles(result?.hits ?? [], query, recent).slice(0, 100)
        : (result?.hits ?? []),
    [mode, result, query, recent],
  );
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
      if (mode === 'files') {
        restoreAfterClose.current = false;
        dialog.current?.close();
        close(false);
      }
      const repoPath = hit.repo === null ? null : hit.repo ? `${root}/${hit.repo}` : root;
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
      const next = [hit.path, ...recent.filter((p) => p !== hit.path)].slice(0, 50);
      setRecent(next);
      writePref(`mgit.search.recent:${root}`, next);
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
  const body = (
    <div className={styles.body}>
      <header>
        <strong>{mode === 'files' ? S.workspaceSearch.quickOpen : S.workspaceSearch.title}</strong>
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
          mode === 'files'
            ? S.workspaceSearch.filePlaceholder
            : S.workspaceSearch.contentPlaceholder
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
          } else if (e.key === 'Enter' && hits[selection]) {
            e.preventDefault();
            void open(hits[selection]);
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
              <option
                key={repo.path}
                value={repo.path.startsWith(`${root}/`) ? repo.path.slice(root.length + 1) : ''}
              >
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
      <div role="status">
        {busy ? S.workspaceSearch.searching : S.workspaceSearch.results(hits.length)}{' '}
        {result?.skipped ? S.workspaceSearch.skipped(result.skipped) : ''}{' '}
        {result?.truncated ? S.workspaceSearch.limited : ''}
        {busy ? (
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
        aria-busy={busy}
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
                {mode === 'files' ? (
                  <>
                    <span>{hit.path}</span>
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
    </div>
  );
  return mode === 'files' ? (
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
