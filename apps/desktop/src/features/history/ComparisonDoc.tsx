import type { DiffArrival } from '@mgit/diff-view';
import type { ChangedFile, DiffDocument } from '@mgit/ipc';
import { settingsStorage } from '@mgit/storage';
import { Button, S } from '@mgit/ui';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import {
  getSessionStore,
  useActiveTab,
  useAppStore,
  useScopeSessionId,
  useSession,
  useSessionOf,
  useWorkspace,
} from '../../store';
import { diffArrival, nearestDiffFile, orderedDiffFiles } from '../../store/diff-origin';
import { fileEditors } from '../../store/file-editor-store';
import type { ComparisonTarget } from '../../store/workspace-store';
import { ChangedFilesTree } from '../detail/ChangedFilesTree';
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
const collapsedTrees = new WeakMap<ComparisonTarget, ReadonlySet<string>>();

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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    collapsedTrees.get(doc) ?? new Set(),
  );
  const [arrival, setArrival] = useState<DiffArrival>();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'comparison-files',
    storage: settingsStorage,
  });
  useEffect(() => {
    collapsedTrees.set(doc, collapsed);
  }, [doc, collapsed]);
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
    request: ComparisonRequest;
  } | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [path, setPath] = useState<string | null>(chosenPaths.get(doc) ?? null);
  useEffect(() => {
    if (path) chosenPaths.set(doc, path);
  }, [doc, path]);
  const [loadedDocument, setDocument] = useState<{ key: string; value: DiffDocument } | null>(null);
  // 재조회 횟수는 표시 정체성이 아니다. 같은 파일은 유지하고 다른 기준·파일은 즉시 가린다.
  const documentKey = JSON.stringify([
    session,
    doc.repoPath,
    request.a,
    request.b,
    request.three,
    path,
  ]);
  const document = loadedDocument?.key === documentKey ? loadedDocument.value : null;
  const queryOptions = useMemo(
    () => ({
      context: ws.options.context,
      ignoreWhitespace: ws.options.ignoreWhitespace,
    }),
    [ws.options.context, ws.options.ignoreWhitespace],
  );
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
  const localStatus = request.b === LOCAL ? repo.status : null;
  const localRefs = request.b === LOCAL ? repo.refs : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 초안과 Git 감시 변화는 조회 무효화 신호다.
  useEffect(() => {
    if (session === null) return;
    let live = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError(null);

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
            setFiles(orderedDiffFiles(changed));
            setResolved({ a: base, b: target, drafts, request });
            setPath((previous) => {
              if (changed.some((f) => f.path === previous)) return previous;
              const sorted = orderedDiffFiles(changed);
              return nearestDiffFile(previous, files, sorted)?.path ?? null;
            });
          }
        })()
          .catch((e) => {
            if (live) {
              setError(String(e));
              if (!document) setFiles([]);
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
    localStatus,
    localRefs,
  ]);
  useEffect(() => {
    let live = true;
    if (!resolved || resolved.request !== request || !path || session === null) {
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    setError(null);
    const promise =
      resolved.b === LOCAL
        ? client.compareLocalDocument(
            session,
            resolved.a,
            path,
            resolved.drafts.find(([p]) => p === path)?.[1] ?? null,
            queryOptions,
            full,
          )
        : client.compareFileDiffDocument(
            session,
            resolved.a,
            resolved.b,
            request.three,
            path,
            queryOptions,
            full,
          );
    void promise
      .then(
        (d) => {
          if (live) setDocument({ key: documentKey, value: d });
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
  }, [client, session, resolved, path, queryOptions, request, documentKey, full]);
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
      {!document && (loading || session === null) && !error && (
        <div role="status">{S.history.loading}</div>
      )}
      <Group
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        style={{ flex: 1, minHeight: 0 }}
      >
        <Panel
          id="comparison-files"
          defaultSize="300px"
          minSize="160px"
          maxSize="55%"
          style={{ display: 'flex', minHeight: 0 }}
        >
          {files.length === 0 ? (
            <div className={styles.empty}>{!loading && !error ? S.history.noDiff : ''}</div>
          ) : (
            <ChangedFilesTree
              files={files}
              root={{ name: doc.repoName }}
              selectedPath={path}
              collapsedIds={collapsed}
              onCollapsedChange={setCollapsed}
              previewOnSelection
              toolbar
              onPreview={(file) => {
                setArrival(undefined);
                setPath(file.path);
                setFull(false);
              }}
              onOpen={(file) => {
                setArrival(diffArrival(1));
                setPath(file.path);
                setFull(false);
              }}
              menu={() => []}
            />
          )}
        </Panel>
        <Separator className={styles.separator} aria-label={S.comparison.resizeFiles} />
        <Panel id="comparison-diff" minSize="240px" style={{ minHeight: 0 }}>
          <div className={styles.diffArea} style={{ height: '100%' }}>
            {path && (
              <DiffPaneView
                diff={document?.diff ?? null}
                document={document}
                areaLabel={S.history.compareTitle}
                error={error}
                options={ws.options}
                onOptionsChange={ws.setOptions}
                onLoadFull={() => setFull(true)}
                path={path}
                mode={ws.mode}
                onModeChange={ws.setMode}
                loading={loading || diffLoading}
                arrival={arrival}
                fileNavigation={{
                  index: files.findIndex((file) => file.path === path),
                  total: files.length,
                  move: (direction) => {
                    const next = files[files.findIndex((file) => file.path === path) + direction];
                    if (next) {
                      setArrival(diffArrival(direction));
                      setPath(next.path);
                      setFull(false);
                    }
                  },
                }}
              />
            )}
          </div>
        </Panel>
      </Group>
    </section>
  );
}
