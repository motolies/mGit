import type { DiffArrival } from '@mgit/diff-view';
import type { ChangedFile, DiffDocument } from '@mgit/ipc';
import { settingsStorage } from '@mgit/storage';
import { Button, S } from '@mgit/ui';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { FocusTier, onFocusRefresh } from '../../store/focus-refresh';
import { useEditorSelect } from '../../store/use-file-editors';
import type { ComparisonTarget } from '../../store/workspace-store';
import { ChangedFilesTree } from '../detail/ChangedFilesTree';
import { DiffPaneView } from '../diff/DiffPaneView';
import { useCurrentFile } from '../workspace/use-current-file';
import { ComparisonCommits } from './ComparisonCommits';
import { comparisonDrafts, comparisonStamp, LOCAL } from './comparison';
import styles from './history.module.css';
import { RefPicker } from './RefPicker';

/**
 * 변경 파일 트리 (비교 화면 전용 memo, E-3). 파일을 옮길 때 비교 화면은 경로·읽는 중·문서 도착으로 몇 번 다시 그려지는데,
 * 트리는 고른 파일이 바뀔 때만 다시 그리면 된다
 */
const ComparisonFilesTree = memo(ChangedFilesTree);
/** 트리 행 메뉴 (비교 화면에는 없다) */
const NO_MENU = () => [];

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
/** 고정한 기준·대상(oid 또는 로컬 내용)과 그 요청 */
type ResolvedComparison = { a: string; b: string; request: ComparisonRequest };
/** 받아 둔 문서: 표시 정체성(`key`), 조회 조건(`query` — 같은 조건이면 다시 묻지 않는다), 응답 */
type LoadedDocument = { key: string; query: string; value: DiffDocument };

/**
 * 고정 OID 비교(브랜치↔브랜치)의 마지막 결과 (G5). 편집기는 활성 문서만 그리므로 탭으로 돌아올 때마다 다시 조회하던 것을
 * 이것으로 바로 보인다 — OID 로 고정한 결과는 바뀌지 않아 다시 확인할 필요가 없다. 같은 요청 객체(`request`)일 때만 쓰고,
 * "비교 새로고침"·값 변경은 새 요청이라 다시 조회한다. 문서 객체가 열쇠라 탭을 닫으면(문서가 사라지면) 함께 사라진다
 */
type SavedComparison = {
  request: ComparisonRequest;
  resolved: ResolvedComparison;
  files: ChangedFile[];
  /** 보고 있던 파일의 문서. 크면 두지 않는다 */
  document: LoadedDocument | null;
};
const savedComparisons = new WeakMap<ComparisonTarget, SavedComparison>();
/** 결과를 둔 문서의 최근 순서 (약한 참조 — 닫힌 문서를 붙잡지 않는다). 상한을 넘으면 가장 오래된 것부터 버린다 */
let savedOrder: WeakRef<ComparisonTarget>[] = [];
/** 결과를 두는 비교 문서 수 */
const SAVED_COMPARISONS_MAX = 6;
/** 이보다 파일이 많은 비교는 두지 않는다 */
const SAVED_FILES_MAX = 5000;
/** 문서 원문(양쪽 합계 글자 수)이 이보다 크면 문서는 두지 않고 목록만 둔다 */
const SAVED_DOCUMENT_CHARS_MAX = 1_000_000;
/** 해석된 전체 OID (SHA-1·SHA-256) */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** 문서 원문의 크기 (양쪽 글자 수 합) */
function documentChars(value: DiffDocument): number {
  return (value.old.content?.length ?? 0) + (value.new.content?.length ?? 0);
}

/**
 * 고정 OID 비교의 결과를 둔다 (`savedComparisons`). 양쪽이 전체 OID 가 아니거나(로컬 내용 등) 파일이 너무 많으면 두지 않고,
 * 문서가 크면 목록만 둔다. 문서 수가 상한을 넘으면 가장 오래 쓰지 않은 것부터 버린다
 */
function saveComparison(doc: ComparisonTarget, saved: SavedComparison): void {
  if (
    !FULL_OID.test(saved.resolved.a) ||
    !FULL_OID.test(saved.resolved.b) ||
    saved.files.length > SAVED_FILES_MAX
  ) {
    savedComparisons.delete(doc);
    return;
  }
  const document =
    saved.document && documentChars(saved.document.value) <= SAVED_DOCUMENT_CHARS_MAX
      ? saved.document
      : null;
  savedComparisons.set(doc, { ...saved, document });
  savedOrder = savedOrder.filter((ref) => {
    const target = ref.deref();
    return target !== undefined && target !== doc;
  });
  savedOrder.push(new WeakRef(doc));
  while (savedOrder.length > SAVED_COMPARISONS_MAX) {
    const oldest = savedOrder.shift()?.deref();
    if (oldest) savedComparisons.delete(oldest);
  }
}

/** 초안 입력·Git 감시 신호를 묶는 시간. 글자를 칠 때마다 조회하지 않고 멈춘 뒤 한 번 묻는다 */
const LOCAL_REFRESH_DEBOUNCE_MS = 300;
/**
 * 로컬 비교가 보이는 동안의 느린 재검사 간격. 편집기에 열리지 않은 파일을 다른 프로그램이 바꿔도 status 가 같으면(이미 수정됨
 * 상태) Git 감시 신호가 오지 않으므로 그 안전망이다. 편집기의 2초 검사보다 느리게 두어 조회 부하를 줄이고, 직전 조회가 이
 * 간격 안에 있었으면 건너뛴다. 결과가 같으면 화면은 바뀌지 않는다
 */
const LOCAL_RECHECK_MS = 5000;

/** 기준(A)·대상(B) 중 어느 쪽 값을 해석하지 못했는지 (그 칸에 표시한다) */
type ComparisonSide = 'a' | 'b';

/** 한쪽 값을 해석하지 못한 실패. 메시지는 원래 오류의 글자 그대로다 */
class SideFailure extends Error {
  readonly side: ComparisonSide;
  readonly reason: unknown;
  /** 어느 칸의 실패인지와 원래 오류를 담는다 */
  constructor(side: ComparisonSide, reason: unknown) {
    super(String(reason));
    this.side = side;
    this.reason = reason;
  }
}

/** 문서의 표시 정체성: 같은 세션·저장소·기준·대상·파일이면 다시 받아도 같은 화면이다 (재조회 횟수는 넣지 않는다) */
function documentKeyOf(
  session: number | null,
  repoPath: string,
  request: ComparisonRequest,
  path: string | null,
): string {
  return JSON.stringify([session, repoPath, request.a, request.b, request.three, path]);
}

/** 문서 조회 조건: 표시 정체성 + 고정한 기준·대상 + 사용자 동작 조회 차례(`attempt`) + diff 옵션 + 전체 보기 */
function queryKeyOf(
  documentKey: string,
  resolved: ResolvedComparison,
  options: { context: number; ignoreWhitespace: boolean },
  full: boolean,
): string {
  return JSON.stringify([
    documentKey,
    resolved.a,
    resolved.b,
    resolved.request.attempt,
    options.context,
    options.ignoreWhitespace,
    full,
  ]);
}

/** 두 파일 목록이 같은지 (경로·옛 경로·변경 종류·유사도) — 같으면 상태를 바꾸지 않는다 */
function sameFiles(a: readonly ChangedFile[], b: readonly ChangedFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        file.path === other.path &&
        file.oldPath === other.oldPath &&
        JSON.stringify(file.change) === JSON.stringify(other.change)
      );
    })
  );
}

/** 받아 둔 문서가 같은 조회 조건의 같은 원문(revision)인지 — 같으면 화면을 그대로 둔다 */
function sameDocument(
  previous: LoadedDocument | null,
  query: string,
  value: DiffDocument,
): boolean {
  return (
    previous !== null && previous.query === query && previous.value.revision === value.revision
  );
}

/**
 * 파일 비교(`filterPath`) 문서 응답에서 목록 한 줄을 만든다. 내용·있음 여부·이름이 같으면 변경 없음(null). 로컬 쪽에 파일이
 * 없으면(지움) 다른 이름으로 옮긴 것인지 문서로는 알 수 없어 'list' — 목록으로 다시 가린다. 모드만 바뀐 경우는 문서에 드러나지
 * 않아 변경 없음으로 본다
 */
function localFileOf(value: DiffDocument, path: string): ChangedFile | null | 'list' {
  const oldPresent = value.old.path !== null;
  const newPresent = value.new.path !== null;
  if (oldPresent && !newPresent) return 'list';
  const kind = value.diff.change.kind;
  const moved = kind === 'renamed' || kind === 'copied';
  const changed =
    value.diff.hunks.length > 0 ||
    value.diff.binary !== null ||
    oldPresent !== newPresent ||
    moved ||
    kind === 'typeChanged';
  if (!changed) return null;
  return {
    path: value.new.path ?? path,
    oldPath: moved ? value.old.path : null,
    change: value.diff.change,
  };
}

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
  // 기준·대상·three-dot 은 고르는 즉시 적용한다 (초안 없이 `request` 하나). 새 요청 객체는 새로 해석하고, 같은 요청 객체면
  // 해석해 둔 OID 를 다시 쓴다 (`fixedComparisons` — 다시 열어도 커밋 시점이 고정된다)
  const initial = fixedComparisons.get(doc)?.request;
  // 탭으로 돌아왔을 때 같은 요청의 고정 OID 결과가 있으면 그대로 보이고 다시 묻지 않는다 (G5)
  const [restored] = useState(() => {
    const saved = savedComparisons.get(doc);
    return saved && saved.request === initial ? saved : null;
  });
  const [request, setRequest] = useState(
    initial ?? {
      a: doc.a,
      b: doc.b,
      three: doc.threeDot && doc.b !== LOCAL,
      attempt: 0,
    },
  );
  // 로컬 비교의 재조회 신호: 이 저장소(파일 비교면 그 파일)에 열린 편집기 문서의 초안·저장 지문. 값이 같으면 다시 그리지도
  // 재조회하지도 않는다 — 편집기의 2초 검사처럼 바뀐 것이 없는 일에는 같은 값이다 (F2)
  const localStamp = useEditorSelect(() =>
    request.b === LOCAL ? comparisonStamp(doc.repoPath, doc.filterPath) : '',
  );
  const [resolved, setResolved] = useState<ResolvedComparison | null>(restored?.resolved ?? null);
  const [files, setFiles] = useState<ChangedFile[]>(restored?.files ?? []);
  const [path, setPath] = useState<string | null>(chosenPaths.get(doc) ?? null);
  useEffect(() => {
    if (path) chosenPaths.set(doc, path);
  }, [doc, path]);
  const [loadedDocument, setDocument] = useState<LoadedDocument | null>(restored?.document ?? null);
  // 재조회 횟수는 표시 정체성이 아니다. 같은 파일은 유지하고 다른 기준·파일은 즉시 가린다.
  const documentKey = documentKeyOf(session, doc.repoPath, request, path);
  const document = loadedDocument?.key === documentKey ? loadedDocument.value : null;
  const queryOptions = useMemo(
    () => ({
      context: ws.options.context,
      ignoreWhitespace: ws.options.ignoreWhitespace,
    }),
    [ws.options.context, ws.options.ignoreWhitespace],
  );
  const [error, setError] = useState<string | null>(null);
  // 적용한 값을 해석하지 못한 칸 (그 칸에 표시한다. 다음 사용자 동작 조회가 지운다)
  const [failed, setFailed] = useState<{ side: ComparisonSide; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [full, setFull] = useState(false);
  const edit = useCurrentFile();
  const remote = repo.refs.labels.some(
    (r) =>
      r.kind.kind === 'remoteBranch' &&
      [request.a, request.b].some((v) => v === r.fullName || v === r.shortName),
  );
  const localStatus = request.b === LOCAL ? repo.status : null;
  const localRefs = request.b === LOCAL ? repo.refs : null;

  // 조회가 읽는 지금 값 (비동기 조회가 끝난 뒤에도 최신 값으로 견준다). 그린 뒤 효과보다 먼저 맞춘다
  const latest = useRef({
    client,
    session,
    request,
    resolved,
    path,
    files,
    loaded: loadedDocument,
    queryOptions,
    full,
  });
  useLayoutEffect(() => {
    latest.current = {
      client,
      session,
      request,
      resolved,
      path,
      files,
      loaded: loadedDocument,
      queryOptions,
      full,
    };
  });
  // 조회 차례 (F2). 사용자 동작(첫 조회·세션·기준·대상 변경·새로고침)은 세대를 올리고 로딩을 보이며, 앞 세대의 늦은 결과는
  // 버린다. 배경 갱신(초안·감시·포커스·느린 재검사)은 같은 세대에서 한 번에 하나만 돌리고, 도는 동안 신호가 더 오면 끝난 뒤
  // 한 번만 다시 돈다 — 조회가 신호 주기보다 길어도 끝난다
  const generation = useRef(0);
  const flight = useRef<{ gen: number; again: boolean } | null>(null);
  const lastQueryAt = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);

  /**
   * 목록(과 파일 비교면 그 파일의 문서)을 한 번 조회해 바뀐 것만 반영한다. `foreground` 면 로딩을 켜고 오류를 지운 뒤 시작하고,
   * 배경이면 로딩·오류를 건드리지 않고 실패해도 지금 내용을 그대로 둔 채 오류만 보인다(성공하면 오류를 지운다)
   */
  const queryOnce = useCallback(
    async (gen: number, foreground: boolean) => {
      const { client, session, request } = latest.current;
      if (session === null) return;
      const current = () => gen === generation.current && alive.current;
      if (foreground) {
        setLoading(true);
        setError(null);
        setFailed(null);
      }
      /** 한쪽 값을 해석한다. 실패하면 어느 칸인지 붙여 던진다 */
      const resolveSide = (side: ComparisonSide, rev: string) =>
        client.resolveRevision(session, rev).catch((reason: unknown) => {
          throw new SideFailure(side, reason);
        });
      try {
        const fixed = fixedComparisons.get(doc);
        const reuse = fixed && fixed.request === request;
        let base: string;
        let target: string;
        if (reuse) {
          base = fixed.a;
          target = fixed.b;
        } else {
          // 두 쪽을 함께 해석한다 (G5). 둘 다 실패하면 기준(A) 쪽을 알린다
          const [ra, rb] = await Promise.allSettled([
            resolveSide('a', request.a),
            request.b === LOCAL ? Promise.resolve(LOCAL) : resolveSide('b', request.b),
          ]);
          if (ra.status === 'rejected') throw ra.reason;
          if (rb.status === 'rejected') throw rb.reason;
          base = ra.value;
          target = rb.value;
        }
        if (!current()) return;
        fixedComparisons.set(doc, { request, a: base, b: target });
        let changed: ChangedFile[] | null = null;
        let direct: { path: string; value: DiffDocument; query: string } | null = null;
        if (target === LOCAL && doc.filterPath) {
          // 파일 비교: 저장소 전체 목록 없이 그 파일의 문서 하나로 변경 여부와 내용을 함께 얻는다
          const { queryOptions, full } = latest.current;
          const draft =
            comparisonDrafts(doc.repoPath).find(([p]) => p === doc.filterPath)?.[1] ?? null;
          const value = await client.compareLocalDocument(
            session,
            base,
            doc.filterPath,
            draft,
            queryOptions,
            full,
          );
          if (!current()) return;
          const file = localFileOf(value, doc.filterPath);
          if (file !== 'list') {
            changed = file ? [file] : [];
            if (file) {
              const resolvedNext = { a: base, b: target, request };
              direct = {
                path: file.path,
                value,
                query: queryKeyOf(
                  documentKeyOf(session, doc.repoPath, request, file.path),
                  resolvedNext,
                  queryOptions,
                  full,
                ),
              };
            }
          }
        }
        if (changed === null) {
          const allChanged =
            target === LOCAL
              ? (await client.compareLocalFiles(session, base, comparisonDrafts(doc.repoPath)))
                  .files
              : await client.compareRefs(session, base, target, request.three);
          if (!current()) return;
          changed = doc.filterPath
            ? allChanged.filter((f) => f.path === doc.filterPath || f.oldPath === doc.filterPath)
            : allChanged;
        }
        const sorted = orderedDiffFiles(changed);
        const now = latest.current;
        if (!sameFiles(now.files, sorted)) setFiles(sorted);
        setResolved((previous) =>
          previous && previous.a === base && previous.b === target && previous.request === request
            ? previous
            : { a: base, b: target, request },
        );
        const nextPath = sorted.some((f) => f.path === now.path)
          ? now.path
          : (nearestDiffFile(now.path, now.files, sorted)?.path ?? null);
        setPath(nextPath);
        if (direct && direct.path === nextPath) {
          const found = direct;
          const key = documentKeyOf(session, doc.repoPath, request, found.path);
          setDocument((previous) =>
            sameDocument(previous, found.query, found.value)
              ? previous
              : { key, query: found.query, value: found.value },
          );
        } else if (
          !foreground &&
          target === LOCAL &&
          !doc.filterPath &&
          nextPath !== null &&
          nextPath === now.path &&
          now.resolved
        ) {
          // 배경 갱신: 보고 있는 파일의 문서도 다시 받아, 원문이 같으면(revision) 화면을 그대로 둔다
          const { queryOptions, full } = latest.current;
          const query = queryKeyOf(
            documentKeyOf(session, doc.repoPath, request, nextPath),
            now.resolved,
            queryOptions,
            full,
          );
          const draft = comparisonDrafts(doc.repoPath).find(([p]) => p === nextPath)?.[1] ?? null;
          const value = await client.compareLocalDocument(
            session,
            base,
            nextPath,
            draft,
            queryOptions,
            full,
          );
          if (!current() || latest.current.path !== nextPath) return;
          const key = documentKeyOf(session, doc.repoPath, request, nextPath);
          setDocument((previous) =>
            sameDocument(previous, query, value) ? previous : { key, query, value },
          );
        }
        if (!foreground) setError(null);
      } catch (e) {
        if (!current()) return;
        setError(String(e instanceof SideFailure ? e.reason : e));
        if (e instanceof SideFailure) setFailed({ side: e.side, message: String(e.reason) });
        if (foreground && !latest.current.loaded) setFiles([]);
      } finally {
        lastQueryAt.current = performance.now();
        if (foreground && current()) setLoading(false);
      }
    },
    [doc],
  );

  /** 조회를 차례에 넣는다. 사용자 동작은 바로 새 세대로, 배경 갱신은 진행 중이면 끝난 뒤 한 번만 다시 돌도록 표시만 한다 */
  const run = useCallback(
    (foreground: boolean) => {
      if (foreground) generation.current += 1;
      else if (flight.current && flight.current.gen === generation.current) {
        flight.current.again = true;
        return;
      }
      const mine = { gen: generation.current, again: false };
      flight.current = mine;
      void (async () => {
        let first = foreground;
        do {
          mine.again = false;
          await queryOnce(mine.gen, first);
          first = false;
        } while (mine.again && mine.gen === generation.current && alive.current);
        if (flight.current === mine) flight.current = null;
      })();
    },
    [queryOnce],
  );

  // 사용자 동작 조회: 처음 열 때, 세션·기준·대상·새로고침이 바뀔 때. 로컬 비교도 지연 없이 바로 묻는다 (F2). 탭으로 돌아와
  // 둔 결과를 보이는 동안(요청이 그대로인 동안)은 묻지 않는다 (G5)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 클라이언트·문서·세션·요청이 바뀐 것이 새 조회의 신호다.
  useEffect(() => {
    if (session === null || request === restored?.request) return;
    run(true);
  }, [client, doc, session, request, run]);

  // 고정 OID 비교의 결과를 둔다: 지금 요청의 결과(목록과 보고 있는 파일의 문서)가 바뀔 때마다
  useEffect(() => {
    if (!resolved || resolved.b === LOCAL || resolved.request !== request) return;
    saveComparison(doc, {
      request,
      resolved,
      files,
      document: loadedDocument?.key === documentKey ? loadedDocument : null,
    });
  }, [doc, request, resolved, files, loadedDocument, documentKey]);

  // 배경 갱신 신호 (로컬 비교만): 이 저장소의 편집기 초안·저장 지문, Git 감시의 status·refs. 처음 값은 사용자 동작 조회가
  // 다루므로 바뀐 뒤에만, 잦은 입력은 묶어서 300ms 뒤 한 번 돈다
  const backgroundSignal = useRef<readonly unknown[] | null>(null);
  useEffect(() => {
    if (request.b !== LOCAL || session === null) return;
    const next = [localStamp, localStatus, localRefs];
    const previous = backgroundSignal.current;
    backgroundSignal.current = next;
    if (previous === null || previous.every((value, i) => value === next[i])) return;
    const timer = setTimeout(() => run(false), LOCAL_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localStamp, localStatus, localRefs, request.b, session, run]);

  // 편집기에 열리지 않은 파일의 외부 변경 (로컬 비교만): 창 포커스로 돌아오면 바로, 보이는 동안에는 느린 재검사로 잡는다
  useEffect(() => {
    if (request.b !== LOCAL || session === null) return;
    const recheck = () => {
      if (window.document.visibilityState !== 'visible') return;
      if (performance.now() - lastQueryAt.current < LOCAL_RECHECK_MS) return;
      run(false);
    };
    const timer = setInterval(recheck, LOCAL_RECHECK_MS);
    // 창 포커스 복귀는 포커스 갱신 조율기가 보이는 내용 단계로 돌린다. 방금 조회했으면(배경 갱신·느린 재검사) 건너뛴다 (G4)
    const off = onFocusRefresh({
      name: 'comparison:local',
      tier: FocusTier.visible,
      run: () => run(false),
      lastRefreshedAt: () => lastQueryAt.current || null,
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [request.b, session, run]);

  // 고른 파일의 문서: 파일·표시 옵션·전체 보기·사용자 동작 조회가 바뀔 때. 파일 비교 조회나 배경 갱신이 같은 조건의 문서를 이미
  // 받아 두었으면 다시 묻지 않는다
  // biome-ignore lint/correctness/useExhaustiveDependencies: 받아 둔 문서는 latest 로 읽는다 (문서가 들어올 때마다 다시 돌지 않게).
  useEffect(() => {
    let live = true;
    if (!resolved || resolved.request !== request || !path || session === null) {
      setDiffLoading(false);
      return;
    }
    const query = queryKeyOf(documentKey, resolved, queryOptions, full);
    if (latest.current.loaded?.query === query) {
      setDiffLoading(false);
      return;
    }
    // 같은 파일을 다른 조건으로 다시 물을 때만 읽는 중 상태를 켠다. 다른 파일·기준이면 보던 문서가 이미 가려져 읽는 중으로
    // 보인다 (`documentPending`) — 상태를 켜느라 비교 화면을 한 번 더 그리지 않는다 (E-3)
    if (latest.current.loaded?.key === documentKey) setDiffLoading(true);
    setError(null);
    const promise =
      resolved.b === LOCAL
        ? client.compareLocalDocument(
            session,
            resolved.a,
            path,
            comparisonDrafts(doc.repoPath).find(([p]) => p === path)?.[1] ?? null,
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
          if (live) setDocument({ key: documentKey, query, value: d });
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
  /** 칸에 직접 입력한 커밋·식을 확인한다 (실패하면 칸이 오류를 보이고 기존 비교를 그대로 둔다) */
  const verify = useCallback(
    async (text: string) => {
      if (session === null) throw new Error(S.history.loading);
      await client.resolveRevision(session, text);
    },
    [client, session],
  );
  // 대상 칸의 "현재 로컬 내용" (칸은 글자 값만 보므로 매번 새 객체여도 다시 계산하지 않는다)
  // 대상 칸의 "현재 로컬 내용" (화면 언어가 바뀌면 글자를 새로 읽는다. 그 밖에는 같은 객체 — 칸이 다시 그리지 않게)
  const localLabel = S.comparison.localContent;
  const localDetail = S.comparison.includesDraft;
  const localChoice = useMemo(
    () => ({ value: LOCAL, label: localLabel, detail: localDetail }),
    [localLabel, localDetail],
  );
  // 기준·대상 칸의 확정 (참조가 바뀌지 않게 — 칸은 memo 라 파일을 옮길 때 다시 그리지 않는다)
  const commitA = useCallback(
    (value: string) => setRequest((r) => ({ ...r, a: value, attempt: r.attempt + 1 })),
    [],
  );
  const commitB = useCallback(
    (value: string) =>
      setRequest((r) => ({
        ...r,
        b: value,
        three: value !== LOCAL && r.three,
        attempt: r.attempt + 1,
      })),
    [],
  );
  // 트리의 고르기·열기 (참조가 바뀌지 않게)
  const previewFile = useCallback((file: ChangedFile) => {
    setArrival(undefined);
    setPath(file.path);
    setFull(false);
  }, []);
  const openFile = useCallback((file: ChangedFile) => {
    setArrival(diffArrival(1));
    setPath(file.path);
    setFull(false);
  }, []);
  const treeRoot = useMemo(() => ({ name: doc.repoName }), [doc.repoName]);
  // 고른 파일의 문서를 아직 받지 못했다 (다른 파일·기준으로 바꿔 보던 문서가 가려진 동안)
  const documentPending =
    !!path &&
    session !== null &&
    resolved?.request === request &&
    loadedDocument?.key !== documentKey &&
    error === null;
  return (
    // 문서 칸(세로 flex)을 flex 로 채운다 — height:100% 면 WebKit 이 배치마다 하위 트리를 다시 배치한다 (bench/README.md)
    <section className={styles.box} style={{ flex: '1 1 0', maxHeight: 'none', minHeight: 0 }}>
      <header className={styles.compareHeader}>
        <div className={styles.refRow}>
          <RefPicker
            label={S.history.compareA}
            value={request.a}
            refs={repo.refs}
            disabled={session === null}
            invalid={failed?.side === 'a' ? failed.message : null}
            verify={verify}
            onCommit={commitA}
          />
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <RefPicker
            label={S.history.compareB}
            value={request.b}
            refs={repo.refs}
            local={localChoice}
            disabled={session === null}
            invalid={failed?.side === 'b' ? failed.message : null}
            verify={verify}
            onCommit={commitB}
          />
          <Button
            onClick={() => setRequest((r) => ({ ...r, a: r.b, b: r.a, attempt: r.attempt + 1 }))}
            disabled={request.b === LOCAL}
          >
            {S.comparison.swap}
          </Button>
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={request.three}
            disabled={request.b === LOCAL}
            onChange={(e) => {
              const three = e.target.checked;
              setRequest((r) => ({ ...r, three, attempt: r.attempt + 1 }));
            }}
          />
          {S.history.threeDot}
        </label>
        {/* 같은 ref 를 다시 해석한다 (브랜치가 옮겨 갔으면 새 커밋으로) */}
        <Button onClick={() => setRequest((r) => ({ ...r, attempt: r.attempt + 1 }))}>
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
            <ComparisonFilesTree
              files={files}
              root={treeRoot}
              selectedPath={path}
              collapsedIds={collapsed}
              onCollapsedChange={setCollapsed}
              previewOnSelection
              toolbar
              onPreview={previewFile}
              onOpen={openFile}
              menu={NO_MENU}
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
                loading={loading || diffLoading || documentPending}
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
