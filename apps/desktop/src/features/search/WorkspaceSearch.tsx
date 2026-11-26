import type { WorkspaceSearchHit, WorkspaceSearchResult } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  const { mode, close } = useSearchPanel();
  const draftVersion = useSyncExternalStore(fileEditors.subscribe, fileEditors.getVersion);
  const session = useAppStore((s) => s.activeSessionId);
  const client = useAppStore((s) => s.client);
  const root = useAppStore((s) => (session === null ? '' : (s.sessions[session]?.path ?? '')));
  const dialog = useModal(mode === 'files');
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
  if (!mode || session === null) return null;
  const repos = getFolderStore(session)?.getState().repos ?? [];
  const hits =
    mode === 'files'
      ? rankFiles(result?.hits ?? [], query, recent).slice(0, 100)
      : (result?.hits ?? []);
  /** 파일 초안에 선택 위치를 적용하고 워크스페이스 탭으로 이동한다. */
  const open = async (hit: WorkspaceSearchHit) => {
    try {
      const doc = await fileEditors.open(client, session, hit.path);
      if ('fileKey' in doc) {
        const line = doc.state.doc.line(Math.min(hit.line, doc.state.doc.lines));
        const pos = Math.min(line.to, line.from + hit.column - 1);
        doc.scrollTop = Math.max(0, (hit.line - 5) * 20);
        fileEditors.reveal(doc, pos);
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
      if (mode === 'files') close();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const body = (
    <div className={styles.body}>
      <header>
        <strong>{mode === 'files' ? S.workspaceSearch.quickOpen : S.workspaceSearch.title}</strong>
        <button type="button" onClick={close}>
          {S.workspaceSearch.close}
        </button>
      </header>
      <input
        aria-label={S.workspaceSearch.query}
        // biome-ignore lint/a11y/noAutofocus: 사용자가 검색을 실행한 직후 포커스를 옮긴다.
        autoFocus
        value={query}
        placeholder={
          mode === 'files'
            ? S.workspaceSearch.filePlaceholder
            : S.workspaceSearch.contentPlaceholder
        }
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelection((s) => Math.min(s + 1, hits.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelection((s) => Math.max(0, s - 1));
          }
          if (e.key === 'Enter' && hits[selection]) {
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
          <button
            type="button"
            onClick={() => {
              if (pending.current) void client.workspaceSearchCancel(session, pending.current);
            }}
          >
            {S.workspaceSearch.cancel}
          </button>
        ) : null}
      </div>
      {error ? <div role="alert">{error}</div> : null}
      <div className={styles.results}>
        {hits.map((hit, i) => (
          <div key={`${hit.path}:${hit.line}`}>
            {mode === 'content' && (i === 0 || hits[i - 1]?.path !== hit.path) ? (
              <h4>
                {hit.repo || root.split('/').pop()} / {hit.path}
              </h4>
            ) : null}
            <button
              className={styles.hit}
              data-selected={selection === i}
              type="button"
              onClick={() => void open(hit)}
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
            </button>
          </div>
        ))}
      </div>
    </div>
  );
  return mode === 'files' ? (
    <dialog ref={dialog} className={styles.dialog} onClose={close}>
      {body}
    </dialog>
  ) : (
    <section
      className={styles.panel}
      aria-label={S.workspaceSearch.title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      {body}
    </section>
  );
}
