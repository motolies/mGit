import type { ChangedFile, DiffDocument } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getSessionStore,
  useActiveTab,
  useAppStore,
  useScopeSessionId,
  useSession,
  useSessionOf,
  useWorkspace,
} from '../../store';
import { fileEditors } from '../../store/file-editor-store';
import type { ComparisonTarget } from '../../store/workspace-store';
import { DiffPaneView } from '../diff/DiffPaneView';
import { useCurrentFile } from '../workspace/use-current-file';
import { ComparisonCommits } from './ComparisonCommits';
import { comparisonDrafts, LOCAL } from './comparison';
import styles from './history.module.css';

/** 메뉴에서 요청한 비교를 편집기 고정 탭으로 전달한다. */
export function ComparisonLauncher() {
  const session = useScopeSessionId();
  const { compare, path, close } = useSession((s) => ({
    compare: s.compare,
    path: s.path,
    close: s.closeCompare,
  }));
  const open = useWorkspace((w) => w.openDoc);
  useEffect(() => {
    if (!compare || session === null || !open) return;
    const { a, b, threeDot } = compare;
    open(
      {
        kind: 'comparison',
        id: `comparison:${JSON.stringify([path, a, b, threeDot])}`,
        repoPath: path,
        repoName: path.split('/').pop() ?? path,
        session,
        a,
        b,
        threeDot,
      },
      'pinned',
    );
    close();
  }, [compare, session, path, open, close]);
  return null;
}

type ComparisonRequest = { a: string; b: string; three: boolean; attempt: number };
type FixedComparison = { request: ComparisonRequest; a: string; b: string };
const fixedComparisons = new WeakMap<ComparisonTarget, FixedComparison>();
const chosenPaths = new WeakMap<ComparisonTarget, string>();

/** 비교마다 독립된 기준과 파일 선택을 유지하고 원문 편집은 기존 파일 탭으로 연결한다. */
export function ComparisonDoc({ doc }: { doc: ComparisonTarget }) {
  const tab = useActiveTab();
  const folder = tab?.kind === 'folder' ? tab.id : null;
  const [session, setSession] = useState<number | null>(folder === null ? doc.session : null);
  useEffect(() => {
    let live = true;
    if (folder === null) {
      setSession(doc.session);
      return;
    }
    setSession(null);
    let acquired = false;
    void useAppStore
      .getState()
      .withRepoSession(folder, doc.repoPath, (state) => {
        acquired = true;
        if (live) setSession(state.id);
      })
      .then(
        () => {
          if (live && !acquired) setError(S.repoSession.openFailed(doc.repoName));
        },
        (cause) => {
          if (live) setError(String(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [folder, doc.session, doc.repoPath, doc.repoName]);
  const client = useAppStore((s) => s.client);
  const ws = useWorkspace((w) => ({
    mode: w.diffMode,
    options: w.diffOptions,
    setMode: w.setDiffMode,
    setOptions: w.setDiffOptions,
  })) ?? {
    mode: 'split' as const,
    options: {
      ignoreWhitespace: false,
      context: 3,
      wrap: false,
      tabWidth: 4,
      fullFile: false,
      horizontalSync: true,
      highlightMode: 'word' as const,
    },
    setMode: () => {},
    setOptions: () => {},
  };
  const repo = useSessionOf(session, (s) => ({
    refs: s.refs,
    status: s.status,
    fetch: s.fetch,
    busy: s.busy,
    lastFetchAt: s.lastFetchAt,
  }));
  const epoch = useSyncExternalStore(fileEditors.subscribe, fileEditors.getVersion);
  const initial = fixedComparisons.get(doc)?.request;
  const [a, setA] = useState(initial?.a ?? doc.a);
  const [b, setB] = useState(initial?.b ?? doc.b);
  const [three, setThree] = useState(initial?.three ?? (doc.threeDot && doc.b !== LOCAL));
  const [request, setRequest] = useState(
    initial ?? {
      a: doc.a,
      b: doc.b,
      three: doc.threeDot && doc.b !== LOCAL,
      attempt: 0,
    },
  );
  const [resolved, setResolved] = useState<{
    a: string;
    b: string;
    drafts: [string, string][];
  } | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [path, setPath] = useState<string | null>(chosenPaths.get(doc) ?? null);
  useEffect(() => {
    if (path) chosenPaths.set(doc, path);
  }, [doc, path]);
  const [document, setDocument] = useState<DiffDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [full, setFull] = useState(false);
  const edit = useCurrentFile();
  const remote = repo.refs.labels.some(
    (r) =>
      r.kind.kind === 'remoteBranch' &&
      [request.a, request.b].some((v) => v === r.fullName || v === r.shortName),
  );
  const localEpoch = request.b === LOCAL ? epoch : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 초안과 Git 감시 변화는 조회 무효화 신호다.
  useEffect(() => {
    if (session === null) return;
    let live = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError(null);
        setDocument(null);
        setResolved(null);
        const drafts = comparisonDrafts(doc.repoPath);
        void (async () => {
          const fixed = fixedComparisons.get(doc);
          const reuse = fixed && fixed.request === request;
          const base = reuse ? fixed.a : await client.resolveRevision(session, request.a);
          const target = reuse
            ? fixed.b
            : request.b === LOCAL
              ? LOCAL
              : await client.resolveRevision(session, request.b);
          const allChanged =
            target === LOCAL
              ? (await client.compareLocalFiles(session, base, drafts)).files
              : await client.compareRefs(session, base, target, request.three);
          const changed = doc.filterPath
            ? allChanged.filter((f) => f.path === doc.filterPath || f.oldPath === doc.filterPath)
            : allChanged;
          if (live) {
            fixedComparisons.set(doc, { request, a: base, b: target });
            setFiles(changed);
            setFull(false);
            setResolved({ a: base, b: target, drafts });
            setPath((previous) =>
              changed.some((f) => f.path === previous) ? previous : (changed[0]?.path ?? null),
            );
          }
        })()
          .catch((e) => {
            if (live) {
              setError(String(e));
              setFiles([]);
            }
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      request.b === LOCAL ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    client,
    doc,
    session,
    doc.repoPath,
    doc.filterPath,
    request,
    localEpoch,
    repo.status,
    repo.refs,
  ]);
  useEffect(() => {
    let live = true;
    setDocument(null);
    if (!resolved || !path || session === null) return;
    setDiffLoading(true);
    setError(null);
    const promise =
      resolved.b === LOCAL
        ? client.compareLocalDocument(
            session,
            resolved.a,
            path,
            resolved.drafts.find(([p]) => p === path)?.[1] ?? null,
            ws.options,
            full,
          )
        : client.compareFileDiffDocument(
            session,
            resolved.a,
            resolved.b,
            request.three,
            path,
            ws.options,
            full,
          );
    void promise
      .then(
        (d) => {
          if (live) setDocument(d);
        },
        (e) => {
          if (live) setError(String(e));
        },
      )
      .finally(() => {
        if (live) setDiffLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, session, resolved, path, ws.options, request.three, full]);
  return (
    <section className={styles.box} style={{ height: '100%', maxHeight: 'none', minHeight: 0 }}>
      <header className={styles.header} style={{ flexWrap: 'wrap' }}>
        <datalist id="comparison-refs">
          {repo.refs.labels.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.shortName}
            </option>
          ))}
        </datalist>
        <input
          list="comparison-refs"
          aria-label={S.history.compareA}
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <span>→</span>
        <input
          aria-label={S.history.compareB}
          value={b === LOCAL ? S.comparison.localContent : b}
          onChange={(e) =>
            setB(e.target.value === S.comparison.localContent ? LOCAL : e.target.value)
          }
          list="comparison-local"
        />
        <datalist id="comparison-local">
          <option value={S.comparison.localContent}>{S.comparison.localContent}</option>
          {repo.refs.labels.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.shortName}
            </option>
          ))}
        </datalist>
        <Button
          onClick={() => {
            setA(b);
            setB(a);
          }}
          disabled={b === LOCAL}
        >
          {S.comparison.swap}
        </Button>
        <label>
          <input
            type="checkbox"
            checked={three}
            disabled={b === LOCAL}
            onChange={(e) => setThree(e.target.checked)}
          />
          {S.history.threeDot}
        </label>
        <Button
          onClick={() =>
            setRequest({ a, b, three: b !== LOCAL && three, attempt: request.attempt + 1 })
          }
        >
          {S.comparison.refresh}
        </Button>
        <Button
          disabled={repo.busy || session === null}
          onClick={() =>
            void repo.fetch(null, false).then(() => {
              const failure = getSessionStore(session ?? -1)?.getState().actionError;
              if (failure) setError(failure);
              else setRequest((r) => ({ ...r, attempt: r.attempt + 1 }));
            })
          }
        >
          {S.comparison.fetchRefresh}
        </Button>
        {path && (
          <Button onClick={() => edit(doc.repoPath, path, doc.repoName)}>
            {S.fileView.editCurrent}
          </Button>
        )}
      </header>
      <div className={styles.muted}>
        {doc.repoName} ·{' '}
        {request.b === LOCAL ? S.comparison.includesDraft : S.comparison.commitSnapshot}{' '}
        {resolved
          ? `· ${resolved.a.slice(0, 8)} → ${resolved.b === LOCAL ? S.comparison.localContent : resolved.b.slice(0, 8)}`
          : ''}
      </div>
      {resolved && session !== null && resolved.b !== LOCAL && (
        <ComparisonCommits client={client} session={session} a={resolved.a} b={resolved.b} />
      )}
      {remote && (
        <div className={styles.muted}>
          {S.comparison.remoteTime}:{' '}
          {repo.lastFetchAt
            ? new Date(repo.lastFetchAt).toLocaleString()
            : S.comparison.unknownTime}
        </div>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {loading || (session === null && !error) ? (
        <div className={styles.empty}>{S.history.loading}</div>
      ) : (
        <div className={styles.split} style={{ flex: 1, height: 'auto' }}>
          <ul className={styles.files}>
            {!error && files.length === 0 && <li>{S.history.noDiff}</li>}
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={styles.file}
                  data-open={path === f.path}
                  onClick={() => {
                    setPath(f.path);
                    setFull(false);
                  }}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.diffArea}>
            {path && (
              <DiffPaneView
                diff={document?.diff ?? null}
                document={document}
                areaLabel={S.history.compareTitle}
                error={null}
                options={ws.options}
                onOptionsChange={ws.setOptions}
                onLoadFull={() => setFull(true)}
                path={path}
                mode={ws.mode}
                onModeChange={ws.setMode}
                loading={diffLoading}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
