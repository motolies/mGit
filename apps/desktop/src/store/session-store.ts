import { DEFAULT_GRAPH_COLUMNS, type GraphColumns } from '@mgit/graph-view';
import type {
  AdvancedSearch,
  BackupRecord,
  BackupRef,
  BatchOp,
  BatchResult,
  BlameLine,
  BranchUpdate,
  ChangedFile,
  CheckoutTarget,
  CommandLogRecord,
  CommitDetail,
  CommitTemplate,
  ConflictOrigins,
  ConflictPayload,
  ConflictRule,
  ConflictSide,
  CreatePr,
  DiffOptions,
  DifftoolTarget,
  FileDiff,
  GraphLayoutPrefs,
  GraphQuery,
  GraphRangeCache,
  GraphRow,
  HistoryEntry,
  InProgressOp,
  IpcClient,
  KeptResolution,
  LfsStatus,
  LineSelection,
  LocalTag,
  MergeMode,
  MergePreview,
  Module,
  OpOutcome,
  PerfStatus,
  PlanCommit,
  PrTemplate,
  PullMode,
  PullRequest,
  PushSpec,
  RadarEntry,
  RebasePlan,
  RebaseStepPreview,
  ReflogEntry,
  RemoteProject,
  RenameConflict,
  RepoOpened,
  RepoRefs,
  RepoSettings,
  RerereStatus,
  ResetMode,
  RuleResult,
  SecretHit,
  SessionEvent,
  SessionId,
  SessionProfile,
  SideLabels,
  SignatureStatus,
  SigningInfo,
  StashEntry,
  StatusEntry,
  SubmoduleInfo,
  SubmodulePointerLog,
  SubmoduleUnpushed,
  SyntaxCompare,
  TagRefResult,
  TagSyncReport,
  UndoState,
  UnresolveMode,
  WorkTreeStatus,
  WorktreeRemoveCheck,
  WorktreeSource,
  WorktreeWip,
} from '@mgit/ipc';
import { EMPTY_COMMIT_FILTER, IpcClientError, isEmptyCommitFilter, toIpcError } from '@mgit/ipc';
import type { MergeDraft } from '@mgit/merge-editor';
import { S, shortHash } from '@mgit/ui';
import { createStore, type StoreApi } from 'zustand';
import { prependCapped } from './command-log';
import { type ContainingEntry, createContainingLoader } from './containing-loader';
import { describeError } from './errors';
import { createFileTree, type FileTreeStore } from './file-tree';
import type { TimelineAuthors } from './folder-store';
import { type Notice, notifyHub } from './notify';
import { readPref, writePref } from './prefs';
import {
  buildSquashRangePlan,
  checkSquashRange,
  rangeRowCount,
  type SquashRangePrep,
  type SquashRangeTarget,
  squashRangeDraft,
  squashRangeOnto,
} from './squash-range';
import {
  type DivergedAsk,
  isMissingRemoteRef,
  isTagSuccess,
  runTagDelete,
  sameTagReport,
  type TagBatchOp,
  type TagBatchOutcome,
  type TagCommitPair,
  type TagDeleteScope,
  type TagDeleteSummary,
  tagDeleteChangedAnything,
  tagDeleteComplete,
  tagDeletePlaces,
  tagDeleteProblems,
  tagFailureList,
} from './tag-ops';

export type LoadState = 'opening' | 'streaming' | 'complete' | 'error';
export type DiffMode = 'unified' | 'split';

/** 문서로 보이는 세션 슬롯: diff = "지금 고른 파일"(`selectedFile`), conflict = 열린 충돌(`conflict`) */
export type SessionDocSlot = 'diff' | 'conflict';

/** 장시간 명령 출력 보관 줄 수 */
const OUTPUT_CAPACITY = 2000;
/** 검색 결과 상한 */
const SEARCH_LIMIT = 5000;
/** 파일 히스토리 상한 */
const HISTORY_LIMIT = 500;
/** 폐기 백업 목록 상한 */
const FILE_BACKUP_LIMIT = 200;
/** 이보다 오래 걸린 작업은 끝났을 때 알린다 (UX-09) */
const LONG_OP_MS = 1500;
/** 사용자 설정 키 */
const PREF_DIFF_OPTIONS = 'mgit.diffOptions';
const PREF_GRAPH_COLUMNS = 'mgit.graphColumns';
const PREF_GRAPH_LAYOUT = 'mgit.graphLayout';
const PREF_GRAPH_VIEW = 'mgit.graphView';

/** diff 보기 옵션 (DIFF-03). 공백 무시·문맥은 코어가, 줄바꿈·탭 폭은 뷰가 쓴다 */
export interface DiffViewOptions extends DiffOptions {
  wrap: boolean;
  tabWidth: number;
}

export const DEFAULT_DIFF_OPTIONS: DiffViewOptions = {
  ignoreWhitespace: false,
  context: 3,
  wrap: true,
  tabWidth: 4,
};

export const DEFAULT_GRAPH_QUERY: GraphQuery = {
  revs: { kind: 'all' },
  hideRemotes: false,
  pathScope: [],
  sort: 'topo',
  firstParent: false,
  noMerges: false,
  filter: EMPTY_COMMIT_FILTER,
};

/** 전체 그래프(필터·정렬·옵션 없음)인지. 커밋 필터가 빠진 옛 질의는 필터 없음으로 본다 (코어 `is_default`) */
export function isDefaultGraphQuery(q: GraphQuery): boolean {
  return (
    q.revs.kind === 'all' &&
    !q.hideRemotes &&
    q.pathScope.length === 0 &&
    q.sort === 'topo' &&
    !q.firstParent &&
    !q.noMerges &&
    isEmptyCommitFilter(q.filter)
  );
}

/** 레이아웃 설정 기본값 (코어 기본값과 같아야 한다) */
export const DEFAULT_LAYOUT_PREFS: GraphLayoutPrefs = {
  pinHead: true,
  refColors: true,
  collapseLongEdges: true,
};

/** 코어 기본값 그대로인지 */
export function isDefaultLayoutPrefs(p: GraphLayoutPrefs): boolean {
  return p.pinHead && p.refColors && p.collapseLongEdges;
}

/** 그래프 보기 설정 (렌더링만, 재로드 없음) */
export interface GraphViewPrefs {
  /** HEAD 에서 닿지 않는 커밋을 흐리게 */
  dimOffHead: boolean;
}

export const DEFAULT_GRAPH_VIEW: GraphViewPrefs = { dimOffHead: true };

/** 범위 diff 대상 (GRAPH-10): `base..newer` */
export interface RangeTarget {
  base: string;
  newer: string;
  label: string;
}

/** blame 뷰 (DIFF-04) */
export interface BlameView {
  path: string;
  rev: string | null;
  lines: BlameLine[];
  loading: boolean;
  error: string | null;
}

/** 파일 히스토리 뷰 (DIFF-05) */
export interface FileHistoryView {
  path: string;
  entries: HistoryEntry[];
  loading: boolean;
}

/** 두 ref 비교 (DIFF-06) */
export interface CompareView {
  a: string;
  b: string;
  threeDot: boolean;
  files: ChangedFile[];
  path: string | null;
  diff: FileDiff | null;
  loading: boolean;
  diffLoading: boolean;
}

/** ⇧+클릭 범위 선택 (GRAPH-10). 행 `from..to`, commit `older^..newer` */
export interface RangeSelection {
  from: number;
  to: number;
  newer: string;
  older: string;
  /** `older^` 또는 빈 트리 */
  base: string;
  files: ChangedFile[];
  loading: boolean;
}

/** 장시간 명령 하나의 진행 상태 (RM-05, CHG-06) */
export interface OperationState {
  id: number;
  kind: string;
  label: string;
  phase: string;
  percent: number | null;
  message: string;
  /** 출력 줄 (stderr 는 `!` 접두) */
  output: string[];
  done: boolean;
  ok: boolean;
  cancelled: boolean;
  lockLeft: boolean;
  /** 시작 시각 (ms). 오래 걸린 작업만 알린다 (UX-09) */
  startedAt: number;
}

/** 우측·중앙 패널이 보고 있는 파일. `commit` 이 있으면 그 커밋의 파일 diff */
export interface FileTarget {
  path: string;
  staged: boolean;
  commit: string | null;
  /** 커밋 파일이 이름이 바뀐 것이면 옛 경로. 커밋 파일 diff 를 rename 으로 짝지을 때 함께 넘긴다 */
  oldPath?: string | null;
  /** 있으면 범위 diff (GRAPH-10) */
  range?: RangeTarget;
}

/** 그래프 검색 상태 (GRAPH-06) */
export interface SearchState {
  open: boolean;
  query: string;
  rows: number[];
  total: number;
  truncated: boolean;
  cursor: number;
  /** 고급 검색 조건 (GRAPH-07). 있으면 재검색 때 이것을 쓴다 */
  advanced: AdvancedSearch | null;
}

/** 검색 실행 옵션 */
export interface SearchRunOptions {
  /** 재로드가 다시 돌리는 검색: 사용자가 보던 스크롤과 현재 결과 번호를 건드리지 않는다 */
  keepPosition?: boolean;
}

/** 쓰기 명령 실패 중 전용 대화상자로 이어지는 것 */
export type PendingHint =
  | { kind: 'dirtyWorkTree'; files: string[]; target: CheckoutTarget }
  /** 원격 브랜치 체크아웃: 같은 이름의 로컬이 다른 곳을 추적한다. `oid` 는 원격 브랜치 커밋 (분리된 HEAD 용) */
  | {
      kind: 'remoteBranchTaken';
      local: string;
      remote: string;
      name: string;
      upstream: string | null;
      oid: string | null;
    }
  | { kind: 'notFullyMerged'; name: string }
  | { kind: 'branchElsewhere'; path: string; name: string }
  /** `spec` 은 거부된 push 그대로. 강제 push·pull 후 push 가 같은 대상으로 가게 한다 */
  | { kind: 'nonFastForward'; spec: PushSpec }
  /** 강제 push 가 lease 로 거부됐다 */
  | { kind: 'staleInfo'; spec: PushSpec }
  /**
   * tag push 가 이름 충돌로 거부됐다 (TG-02): 원격에 이름이 같은 다른 tag 가 있다. 아무것도 바뀌지 않았다.
   * `commits` 는 단일 조회로 받은 두 commit (B5) — 받기 전·실패면 없다
   */
  | { kind: 'tagExists'; remote: string; names: string[]; commits?: TagCommitPair[] }
  | { kind: 'indexLock' }
  | { kind: 'detachedHead' }
  | { kind: 'noUpstream'; spec?: PushSpec }
  | { kind: 'hookFailed' }
  | { kind: 'nothingToCommit' }
  | { kind: 'nestedRepo'; paths: string[] }
  | { kind: 'submoduleUnpushed'; items: SubmoduleUnpushed[]; spec: PushSpec }
  | {
      kind: 'pushUpstreamMismatch';
      local: string;
      remote: string;
      upstream: string;
      spec: PushSpec;
    }
  | { kind: 'conflictMarkers'; files: string[]; retry: MarkerRetry }
  | { kind: 'reapplyResolutions'; count: number }
  | {
      kind: 'syntaxErrors';
      path: string;
      content: string;
      compare: SyntaxCompare;
      allowConflictMarkers: boolean;
    };

/** 충돌 마커로 거부된 동작. "그래도 진행" 하면 허용 플래그를 켜고 다시 한다 */
export type MarkerRetry =
  | { kind: 'commit'; ignoreSecrets: boolean }
  | { kind: 'opContinue' }
  | { kind: 'saveConflict'; content: string; force: boolean };

/** 미저장 충돌 편집. `key` 는 그 충돌의 블롭 조합으로, 다른 충돌에 잘못 쓰이지 않게 한다 */
export interface ConflictDraft extends MergeDraft {
  key: string;
}

/** 호출자가 따로 다루지 않은 힌트를 전용 대화상자로 (SF-05) */
function defaultHint(hint: { kind: string }): PendingHint | null {
  switch (hint.kind) {
    case 'indexLock':
    case 'detachedHead':
    case 'noUpstream':
    case 'hookFailed':
    case 'nothingToCommit':
      return { kind: hint.kind };
    default:
      return null;
  }
}

/** Commit 도구 창 Stash 탭에서 고른 스태시와 그 파일 목록 (ST-04, W23) */
export interface StashView {
  entry: StashEntry;
  files: ChangedFile[];
}

/** 저장소 탭 하나의 상태. 그래프 데이터 자체는 `GraphRangeCache` 에 있다 */
export interface SessionState {
  id: SessionId;
  path: string;
  name: string;
  /**
   * 세션 프로필 (W13): `full` = 저장소 탭의 세션, `light` = 폴더 탭이 연 숨은 세션(그래프를 읽지 않고 생성 때 읽기도
   * 줄인다). 탭으로 열면 `promote()` 로 `full` 이 된다. 내려가는 일은 없다
   */
  profile: SessionProfile;
  /**
   * 저장소 탭 Project 도구 창의 파일 트리 (W21, 루트 = 작업 트리 하나). 폴더 스토어의 것과 같은 스토어를 세션 파일
   * API 로 만든다. 읽기는 Project 도구 창이 처음 보일 때(`open`) 시작하므로 가벼운 세션은 읽지 않는다
   */
  fileTree: FileTreeStore;
  /** 파일 트리의 펼친 디렉터리를 다시 나열한다. 트리를 아직 연 적이 없으면 아무것도 하지 않는다 */
  reloadFiles(): Promise<void>;
  refs: RepoRefs;
  status: WorkTreeStatus;
  op: InProgressOp | null;
  generation: number;
  totalRows: number;
  loadState: LoadState;
  error?: string;
  commitGraphSuggested: boolean;
  /** 그림자 재로드 진행 중 */
  reloading: boolean;
  reloadError: string | null;
  operations: Record<number, OperationState>;
  operationOrder: number[];
  log: CommandLogRecord[];

  // 선택·보기 (S2·S3)
  selectedCommit: string | null;
  wipSelected: boolean;
  selectedFile: FileTarget | null;
  diffMode: DiffMode;
  diff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  actionError: string | null;
  detail: CommitDetail | null;
  detailLoading: boolean;
  /** 상세에 보이는 커밋을 포함하는 branch (CD-03). `of` 가 보이는 커밋과 다르면 쓰지 않는다 */
  containing: ContainingEntry<string> | null;
  search: SearchState;
  /** 그래프가 스크롤해야 할 행 (소비하면 null) */
  scrollToRow: number | null;
  /** 로드가 끝나면 이동할 커밋 */
  pendingJump: string | null;
  pendingHint: PendingHint | null;
  /** 쓰기 명령이 진행 중 (버튼 비활성) */
  busy: boolean;
  /**
   * 원격별 tag 상태 보고서 (B5, TG-08·09). 확인했거나 확인에 실패한 원격만 있다. 쓰기의 busy 와 무관하다 — 확인은 busy 를
   * 켜지 않고 취소할 수 있는 op(kind `tagCheck`)만 붙는다
   */
  tagReports: Record<string, TagSyncReport>;
  /** 지금 원격 tag 를 확인(네트워크) 중인 원격 */
  tagChecking: string[];
  /** 로컬 tag 목록 (C3b, 태그 문서의 종류·날짜·제목 열). 읽은 적이 없으면 null */
  tagList: LocalTag[] | null;
  lastOutcome: OpOutcome | null;
  /// S5
  nestedRepos: string[];
  superproject: string | null;
  submodules: SubmoduleInfo[];
  /// S6: 열린 충돌 파일
  conflict: { path: string; payload: ConflictPayload } | null;
  conflictLoading: boolean;
  /** 경로별 미저장 결과 편집. 화면을 떠나도 남는다 */
  conflictDrafts: Record<string, ConflictDraft>;
  /// A1 안전장치
  undoState: UndoState;
  backups: BackupRef[];
  reflogOpen: boolean;
  reflogRef: string;
  reflog: ReflogEntry[];
  /** 폐기 백업 대화상자. 열려 있으면 목록, 닫혀 있으면 null */
  fileBackups: BackupRecord[] | null;
  commitTemplates: CommitTemplate[];
  /// A2 이력 수정
  worktreeWips: WorktreeWip[];
  /** `hasMerges` 면 실행 시 머지가 평탄화된다 */
  rebasePlan: { onto: string | null; commits: PlanCommit[]; hasMerges: boolean } | null;
  /// A3 diff·히스토리·그래프
  diffOptions: DiffViewOptions;
  /**
   * 코어가 받아들인 그래프 질의. `setGraphQuery` 가 성공한 뒤에 바뀐다 (낙관적으로 바꾸지 않는다) — 코어가 거부하면
   * (잘못된 정규식 `invalidFilter` 등) 이 값이 그대로 "마지막으로 받아들여진 질의"다
   */
  graphQuery: GraphQuery;
  /**
   * 텍스트 필터를 적용하지 못한 사유 (W26 — 잘못된 정규식, 코어의 `invalidFilter` 문구). 필터 바가 입력란 아래에
   * 보인다. 입력을 고치거나(`clearFilterError`) 가장 나중에 보낸 질의가 받아들여지면 빈다
   */
  filterError: string | null;
  /**
   * 로그 필터의 작성자 후보 (W26, 폴더 `TimelineAuthors` 와 같은 모양). 드롭다운을 열 때 읽고(`loadGraphAuthors`), ref 가
   * 바뀌면(`refsChanged`) 낡은 것으로 본다(`idle` — 목록은 남겨 단추의 이름 표시에 쓴다). 가벼운 세션은 읽지 않는다
   */
  graphAuthors: TimelineAuthors;
  graphColumns: GraphColumns;
  /** 레이아웃 설정 (코어와 동기, localStorage 보존) */
  layoutPrefs: GraphLayoutPrefs;
  graphView: GraphViewPrefs;
  blame: BlameView | null;
  fileHistory: FileHistoryView | null;
  compare: CompareView | null;
  range: RangeSelection | null;
  /// A4 서명·비밀 스캔·설정·최적화
  signingInfo: SigningInfo | null;
  /** null 이면 설정(commit.gpgSign)대로 */
  commitSign: boolean | null;
  /** 커밋 전 스캔에서 찾은 비밀 정보. 있으면 커밋을 멈춘다 (CHG-09) */
  secretHits: SecretHit[] | null;
  perfSuggestion: PerfStatus | null;
  /** 저장소 설정 대화상자 (열려 있으면 값) */
  repoSettings: RepoSettings | null;
  shallow: boolean;
  detailSignature: SignatureStatus | null;
  /// B2 PR/MR·아바타
  remoteProject: RemoteProject | null;
  pullRequests: PullRequest[];
  prsLoading: boolean;
  prsError: string | null;
  /** 이메일 → data URI (없으면 null). 요청 중인 것은 키가 없다 */
  avatars: Record<string, string | null>;
  /// C2 서브모듈 포인터 로그 (열린 diff 에 맞춰)
  submoduleLog: { path: string; old: string | null; new: string; log: SubmodulePointerLog } | null;
  /// C3 빌드 멀티 모듈
  modules: Module[];
  /** 고른 모듈 경로 (그래프·변경 범위). null 이면 전체 */
  moduleScope: string | null;
  /// D1 충돌 예방
  preview: MergePreviewState | null;
  rebasePreview: {
    onto: string;
    loading: boolean;
    steps: RebaseStepPreview[];
    error: string | null;
  } | null;
  /** 충돌 레이더 (CF-02): 현재 branch 와 주요 branch 의 병합 예상 */
  radar: RadarEntry[];
  /** 이 세션이 격리 병합 워크트리면 그 branch (CF-05) */
  isolatedBranch: string | null;
  /// D2 충돌 해결 보조
  origins: { path: string; loading: boolean; data: ConflictOrigins | null } | null;
  mergeTool: string | null;
  rerere: RerereStatus;
  kept: KeptResolution[];
  renameConflicts: RenameConflict[];
  rules: ConflictRule[];
  ruleResults: RuleResult[] | null;
  review: ReviewState | null;
  assistDialog: 'rename' | 'rules' | null;
  /** 재적용을 이미 제안한 작업 식별자 */
  reapplyOfferedFor: string | null;
  /// D3 검증·초기화·LFS
  verifyCommand: string | null;
  worktreeInitCommand: string | null;
  lfs: LfsStatus | null;
  /// S4
  pullMode: PullMode;
  stashes: StashEntry[];
  stashView: StashView | null;

  // 커밋 입력 (S2)
  commitMessage: string;
  commitAmend: boolean;
  commitNoVerify: boolean;
  committing: boolean;
  commitError: string | null;
  lastCommitOpId: number | null;
  lastCommitHash: string | null;

  applyEvent(event: SessionEvent): void;
  /**
   * 가벼운 세션을 전체 프로필로 올린다 (W13 승격): 생성 때 건너뛴 읽기와 레이아웃 설정 동기화를 돌린다. 그래프는
   * 코어가 승격하며 로드를 시작하고, 그 이벤트가 이 스토어로 온다. 이미 전체면 아무것도 하지 않는다
   */
  promote(): void;
  refresh(): Promise<void>;
  reloadGraph(): Promise<void>;
  cancelOperation(id: number): Promise<boolean>;
  dismissOperation(id: number): void;
  resolveRow(oid: string): Promise<number | null>;

  selectWip(): void;
  /**
   * 상세에 지금 보이는 커밋을 알린다 (null = 없음, CD-03). 짧은 디바운스 뒤에 포함 branch 를 읽고, 읽어 둔
   * 커밋은 다시 읽지 않는다. `refsChanged` 가 오면 읽어 둔 것을 버리고 보이는 커밋만 다시 읽는다
   */
  showContaining(oid: string | null): void;
  /** 보이는 커밋의 포함 branch 를 바로 다시 읽는다 (시간 초과·오류 뒤 "다시 시도") */
  retryContaining(): void;
  selectCommit(oid: string): void;
  openFile(path: string, staged: boolean): Promise<void>;
  /**
   * 커밋(또는 스태시) 파일의 diff 를 연다. `oldPath` 는 이름이 바뀐 파일의 옛 경로(상세의
   * `ChangedFile.oldPath`)로, 주면 rename 으로 짝지은 diff 가 나온다. 모르면 생략 (새 경로만으로 묻는다)
   */
  openCommitFile(oid: string, path: string, oldPath?: string | null): Promise<void>;
  closeFile(): void;
  setDiffMode(mode: DiffMode): void;
  loadFullDiff(): Promise<void>;
  clearActionError(): void;
  consumeScroll(): void;
  jumpToCommit(oid: string): Promise<void>;
  /** 로드가 끝난 뒤 커밋으로 이동한다 (아직 스트리밍 중이면 보관했다가 끝나면 이동) */
  jumpToCommitWhenLoaded(oid: string): void;

  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  discard(paths: string[]): Promise<void>;
  /**
   * 경로(파일·폴더)의 변경을 HEAD 기준으로 되돌린다 (파일 메뉴 Rollback — stage 된 변경 포함, 백업 뒤). 성공하면
   * `discard` 처럼 "폐기 백업에서 복구할 수 있습니다" 를 알린다. 실패 사유는 `actionError`
   */
  rollback(paths: string[]): Promise<void>;
  applyLines(selection: LineSelection[]): Promise<void>;
  applyHunk(hunk: number): Promise<void>;
  discardLines(selection: LineSelection[]): Promise<void>;
  discardHunk(hunk: number): Promise<void>;

  setCommitMessage(message: string): void;
  setCommitAmend(on: boolean): Promise<void>;
  setCommitNoVerify(on: boolean): void;
  /** `ignoreSecrets` 면 비밀 스캔 경고를, `allowConflictMarkers` 면 충돌 마커 검사를 건너뛴다 */
  commit(opts?: { ignoreSecrets?: boolean; allowConflictMarkers?: boolean }): Promise<boolean>;
  /** 커밋 메시지 전체. 못 읽으면 `actionError` 를 남기고 null */
  commitMessageOf(oid: string): Promise<string | null>;

  // 검색 (GRAPH-06)
  setSearchOpen(open: boolean): void;
  runSearch(query: string, opts?: SearchRunOptions): Promise<void>;
  searchStep(delta: number): void;
  runAdvancedSearch(query: AdvancedSearch, opts?: SearchRunOptions): Promise<void>;

  // diff 옵션·그래프 질의·blame·히스토리·비교·범위 (A3)
  setDiffOptions(patch: Partial<DiffViewOptions>): void;
  /**
   * 그래프 질의를 바꾼다: 코어가 받아들이면 `graphQuery` 를 바꾸고(받은 순서대로 — 지금까지와 같다) 그래프는 코어가
   * 다시 읽는다. 코어가 `invalidFilter` 로 거부하면 알림 대신 `filterError` 를 세우고 질의는 그대로 둔다 (W26 — 가장
   * 나중에 보낸 요청의 실패만. 늦게 실패한 옛 요청은 무시한다). 그 밖의 실패는 지금처럼 `run` 이 다룬다. 받아들여진
   * 경로 범위가 모듈 범위와 어긋나면 모듈 범위를 푼다 (범위의 두 출처 맞추기)
   */
  setGraphQuery(query: GraphQuery): Promise<void>;
  /** 텍스트 필터 오류를 지운다 (입력을 고쳤다) */
  clearFilterError(): void;
  /** 작성자 후보를 읽게 한다. `force` 가 아니면 이미 읽었거나 읽는 중인 후보를 그대로 쓴다. 가벼운 세션은 읽지 않는다 */
  loadGraphAuthors(force: boolean): void;
  /** 레이아웃 설정 변경: 저장 후 코어가 git 없이 재배치한다 */
  setGraphLayoutPrefs(prefs: GraphLayoutPrefs): Promise<void>;
  setGraphViewPrefs(patch: Partial<GraphViewPrefs>): void;
  setGraphColumns(columns: GraphColumns): void;
  openBlame(path: string, rev: string | null): Promise<void>;
  closeBlame(): void;
  openFileHistory(path: string): Promise<void>;
  closeFileHistory(): void;
  openCompare(a: string, b: string, threeDot: boolean): Promise<void>;
  compareSelectFile(path: string | null): Promise<void>;
  closeCompare(): void;
  selectRange(row: GraphRow): Promise<void>;
  clearRange(): void;
  openRangeFile(path: string): Promise<void>;
  openDifftool(target: DifftoolTarget): Promise<void>;

  // 서명·비밀 스캔·설정·최적화 (A4)
  loadSigningInfo(): Promise<void>;
  setCommitSign(sign: boolean | null): void;
  dismissSecrets(): void;
  addSecretIgnore(ignore: { rule: string | null; path: string | null }): Promise<void>;
  checkPerf(): Promise<void>;
  enablePerf(): Promise<void>;
  dismissPerf(): void;
  openRepoSettings(): Promise<void>;
  closeRepoSettings(): void;
  saveUser(name: string, email: string): Promise<void>;
  saveGitignore(text: string): Promise<void>;
  unshallow(): Promise<void>;
  /** 작성자 프로필 적용 (AU-06) */
  applyProfile(profileId: string): Promise<void>;

  // PR/MR·아바타 (B2)
  loadRemoteProject(): Promise<void>;
  loadPullRequests(): Promise<void>;
  /**
   * PR 목록의 첫 읽기 (W24 Pull Requests 도구 창): 계정이 연결된 원격 프로젝트가 있고 그 프로젝트(계정·경로)로 아직 읽지
   * 않았을 때만 `loadPullRequests` 를 부른다. 기억은 세션에 있다 — 도구 창을 닫았다 열거나 로그·다른 탭에 다녀와도 다시
   * 읽지 않고, 원격 프로젝트가 바뀌면 다시 읽는다. 새로고침·만든 뒤 다시 읽기는 `loadPullRequests` 를 그대로 부른다
   */
  ensurePullRequests(): Promise<void>;
  createPullRequest(spec: CreatePr): Promise<PullRequest | null>;
  /** 만든 브랜치 이름 (실패하면 null) */
  checkoutPullRequest(number: number, worktree: string | null): Promise<string | null>;
  prTemplates(): Promise<PrTemplate[]>;
  requestAvatars(emails: readonly (string | undefined)[]): void;

  // 브랜치·태그·병합 (S3)
  checkout(target: CheckoutTarget, stashFirst?: boolean): Promise<void>;
  createBranch(name: string, start: string | null, checkout: boolean): Promise<void>;
  renameBranch(oldName: string, newName: string): Promise<void>;
  deleteBranch(name: string, force: boolean): Promise<void>;
  deleteRemoteBranch(remote: string, name: string): Promise<void>;
  setUpstream(branch: string, upstream: string | null): Promise<void>;
  /**
   * 로컬 branch 를 업스트림으로 fast-forward (BR-09): checkout 하지 않은 branch 도 갱신하고 Undo 할 수 있다. 결과는
   * 알림으로 보인다 (`branchUpdateNotice`)
   */
  updateBranch(name: string): Promise<void>;
  createTag(
    name: string,
    target: string | null,
    message: string | null,
    sign?: boolean,
  ): Promise<void>;
  /**
   * tag 들을 고른 원격으로 push 한다 (TG-01·02). 결과를 직접 알린다: 이름 충돌은 안내(`tagExists`), 그 밖의 실패는 오류
   * 줄, 모두 성공이면 토스트. 이 작업의 op 끝 토스트는 띄우지 않는다. 결과(요청 순서), 명령 전체가 실패하면 undefined
   */
  pushTags(remote: string, names: string[]): Promise<TagRefResult[] | undefined>;
  /**
   * 지울 곳(로컬·원격들)에서 tag 들을 지운다 (TG-03~06). 원격들 → (원격 것이 다르면 `onDiverged` 로 묻고) → 로컬 순서이고
   * busy 는 한 번만, 묻는 동안에도 켜 둔다. 결과를 직접 알린다 (다 지움 = 토스트, 아니면 오류 줄. 취소하고 바뀐 것이
   * 없으면 알리지 않는다). 요약을 돌려준다
   */
  deleteTagsScoped(
    names: string[],
    scope: TagDeleteScope,
    opts?: { onDiverged?: DivergedAsk; silent?: boolean },
  ): Promise<TagDeleteSummary | undefined>;
  /**
   * 태그 문서의 일괄 작업 (C4·C5): push · 가져오기 · 로컬 것으로 덮어쓰기를 busy 한 번으로 돌리고 결과를 알리지 않고
   * 돌려준다 (문서 안 작업은 토스트를 띄우지 않고 결과 칸이 보인다, TG-12 ③). 명령 전체가 실패하면 결과 없이 그 안내
   */
  runTagBatch(op: TagBatchOp): Promise<TagBatchOutcome>;
  /**
   * 원격 tag 를 로컬 것으로 덮어쓴다 (C5, TG-15 "로컬 것으로 맞추기"): 확인한 원격 객체로 lease 를 건 push 한 번
   * (`--force` 없음, undo 없음). 결과를 직접 알린다 (모두 성공이면 토스트, 아니면 오류 줄 — 그 사이 원격이 바뀌었으면
   * 원격은 그대로다). 결과, 명령 전체가 실패하면 undefined
   */
  replaceRemoteTags(
    remote: string,
    items: { name: string; expectedRemote: string }[],
  ): Promise<TagRefResult[] | undefined>;
  merge(reference: string, mode: MergeMode): Promise<void>;
  rebase(onto: string, autostash: boolean): Promise<void>;
  cherryPick(oids: string[]): Promise<void>;
  revert(oids: string[]): Promise<void>;
  reset(target: string, mode: ResetMode): Promise<void>;
  opContinue(allowConflictMarkers?: boolean): Promise<void>;
  opSkip(): Promise<void>;
  opAbort(): Promise<void>;
  commitGraphWrite(): Promise<void>;
  dismissCommitGraph(): void;
  dismissHint(): void;
  /**
   * 원격 tag 를 확인한다 (TG-08, 네트워크): 원격마다 `ls-remote` 로 보고서를 새로 받는다. 주지 않으면 모든 원격. busy 를
   * 켜지 않고, 한 원격의 실패(보고서의 `lastError`)가 다른 원격의 결과를 지우지 않는다
   */
  checkRemoteTags(remotes?: string[]): Promise<void>;
  /**
   * 네트워크 없이 보고서를 다시 받는다 (앱의 push·삭제·조회 뒤, ref 변경 뒤 — 코어 캐시가 고친 값). 기본은 받은 적이 있는
   * 원격만, `all` 이면 모든 원격(다른 탭이 이미 확인한 같은 저장소의 캐시를 읽는다). 사라진 원격·비워진 캐시는 지운다
   */
  reloadRemoteTags(opts?: { all?: boolean }): Promise<void>;
  /** 로컬 tag 목록을 (다시) 읽는다 (태그 문서가 보일 때, ref 가 바뀐 뒤). 실패하면 이전 값을 둔다 */
  loadTagList(): Promise<void>;
  /**
   * 원격 tag 를 받아 온다 (TG-11, `overwrite` 면 로컬의 다른 tag 를 원격 것으로 바꾼다 — TG-15). 결과를 직접 알린다:
   * 모두 성공이면 토스트, 아니면 오류 줄. 원격에 없는 이름이 섞여 전체가 멈췄으면 "다시 확인 후 다시 시도" 안내.
   * 이 작업의 op 끝 토스트는 띄우지 않는다. 결과, 명령 전체가 실패하면 undefined
   */
  fetchTags(
    remote: string,
    names: string[],
    overwrite: boolean,
  ): Promise<TagRefResult[] | undefined>;

  // 원격·동기화 (RM-01~06)
  setPullMode(mode: PullMode): void;
  fetch(remote: string | null, prune: boolean): Promise<void>;
  /** 성공 여부. 실패는 힌트나 `actionError` 로 간다 */
  pull(): Promise<boolean>;
  /**
   * 성공 여부. `skipSubmoduleCheck` 가 아니면 push 안 된 서브모듈 commit 을 먼저 확인한다 (SUB-09).
   * 힌트 대화상자에는 고른 대상을 담아, 강제 push·재시도가 같은 곳으로 가게 한다
   */
  push(spec?: Partial<PushSpec>, opts?: { skipSubmoduleCheck?: boolean }): Promise<boolean>;
  remoteAdd(name: string, url: string): Promise<void>;
  remoteRename(oldName: string, newName: string): Promise<void>;
  remoteRemove(name: string): Promise<void>;
  remoteSetUrl(name: string, url: string): Promise<void>;

  // 스태시 (ST-01·03·04)
  loadStashes(): Promise<void>;
  stashPush(
    message: string | null,
    includeUntracked: boolean,
    stagedOnly: boolean,
    paths: string[],
  ): Promise<void>;
  /** apply·pop·drop 은 oid 로 받아 실행 직전에 번호를 다시 찾는다. 성공 여부를 돌려준다 */
  stashApply(oid: string): Promise<boolean>;
  stashPop(oid: string): Promise<boolean>;
  stashDrop(oid: string): Promise<boolean>;
  /**
   * 스태시를 보고(`stashView`) 그 파일 목록을 읽는다 (저장소 탭 Commit 도구 창의 Stash 탭, W23). 로그의 선택(커밋·WIP·
   * 범위)과 독립이다 — 서로를 비우지 않는다. 보던 스태시가 사라지면 `loadStashes` 가 비운다
   */
  selectStash(entry: StashEntry): Promise<void>;

  // 워크트리 (WT-02·04)
  suggestWorktreePath(branch: string): Promise<string | null>;
  worktreeAdd(path: string, source: WorktreeSource): Promise<string | null>;
  worktreeRemoveCheck(path: string): Promise<WorktreeRemoveCheck | null>;
  worktreeRemove(path: string, force: boolean, deleteBranch: boolean): Promise<void>;
  worktreePrune(): Promise<void>;

  // 서브모듈 (SUB-01·02)
  loadSubmodules(): Promise<void>;
  submoduleUpdate(recursive: boolean): Promise<void>;
  loadSubmoduleLog(path: string, old: string | null, newOid: string): Promise<void>;
  submoduleAdd(url: string, path: string, branch: string | null): Promise<void>;
  submoduleAdopt(path: string): Promise<void>;
  submoduleRemove(path: string): Promise<void>;
  submoduleSetBranch(path: string, branch: string | null): Promise<void>;
  submoduleUpdateRemote(path: string | null, mode: string | null): Promise<void>;
  submoduleSync(): Promise<void>;
  submoduleBatch(op: BatchOp, paths: string[]): Promise<BatchResult | null>;
  // 빌드 멀티 모듈 (C3)
  loadModules(): Promise<void>;
  selectModule(path: string | null): Promise<void>;
  addManualModule(name: string, path: string): Promise<void>;
  hideModule(path: string): Promise<void>;

  // 충돌 예방 (D1)
  openMergePreview(reference: string): Promise<void>;
  closeMergePreview(): void;
  previewSetWip(includeWip: boolean): Promise<void>;
  previewSimulate(): Promise<void>;
  previewOpenFile(path: string): Promise<void>;
  previewRun(strategy: string[], mode: MergeMode): Promise<void>;
  openRebasePreview(onto: string): Promise<void>;
  closeRebasePreview(): void;
  loadRadar(): Promise<void>;
  /** 격리 병합 시작. 만든 워크트리 경로 (실패면 null) */
  isolatedMerge(reference: string, mode: MergeMode): Promise<string | null>;
  loadIsolated(): Promise<void>;
  /** 격리 결과를 메인에 반영. 메인 워크트리 경로 */
  isolatedApply(): Promise<string | null>;
  isolatedDiscard(): Promise<string | null>;

  /** 열린 충돌의 열 라벨 (없으면 null) */
  conflictLabels: SideLabels | null;

  // 충돌 해결 보조 (D2)
  loadConflictOrigins(path: string): Promise<void>;
  loadMergeTool(): Promise<void>;
  openMergetool(path: string): Promise<void>;
  loadRerere(): Promise<void>;
  rerereSet(enabled: boolean, autoupdate: boolean): Promise<void>;
  rerereForget(path: string): Promise<void>;
  loadKept(): Promise<void>;
  reapplyKept(): Promise<void>;
  keptClear(): Promise<void>;
  loadRenameConflicts(): Promise<void>;
  resolveRename(rc: RenameConflict, keep: ConflictSide): Promise<void>;
  loadRules(): Promise<void>;
  saveRules(rules: ConflictRule[]): Promise<void>;
  applyRules(): Promise<void>;
  openReview(path: string): Promise<void>;
  openRemergeDiff(oid: string): Promise<void>;
  closeReview(): void;
  openAssistDialog(kind: 'rename' | 'rules'): void;
  closeAssistDialog(): void;

  // 검증·초기화·LFS (D3)
  loadCommands(): Promise<void>;
  saveVerifyCommand(cmd: string | null): Promise<void>;
  saveWorktreeInitCommand(cmd: string | null): Promise<void>;
  runVerify(): Promise<void>;
  loadLfs(): Promise<void>;
  lfsInstall(): Promise<void>;
  lfsTrack(pattern: string): Promise<void>;
  lfsUntrack(pattern: string): Promise<void>;
  lfsLock(path: string): Promise<void>;
  lfsUnlock(path: string, force: boolean): Promise<void>;

  /** 서브모듈을 먼저 push 하고 상위를 push (SUB-09) */
  pushSubmodulesThenPush(spec?: Partial<PushSpec>): Promise<void>;

  // 충돌 해결 (CF-06~13·26)
  openConflict(path: string): Promise<void>;
  closeConflict(): void;
  /**
   * 결과 저장 (CF-10). 구문 오류가 새로 생기면 힌트를 띄우고 false (force 면 통과, CF-25).
   * `allowConflictMarkers` 면 마커가 남아 있어도 저장한다
   */
  saveConflict(
    content: string,
    opts?: { force?: boolean; allowConflictMarkers?: boolean },
  ): Promise<boolean>;
  /** 미저장 결과 편집을 남기거나 (null 이면) 지운다 */
  setConflictDraft(path: string, draft: ConflictDraft | null): void;
  pickSide(path: string, side: ConflictSide): Promise<void>;
  resolveDelete(path: string, keep: boolean): Promise<void>;
  unresolve(path: string, mode: UnresolveMode): Promise<void>;

  // 안전장치 (SF-03·04·05, AD-02, WT-08, CHG-07·10)
  loadUndo(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  loadBackups(): Promise<void>;
  /** 폐기 백업 대화상자 (CHG-04) */
  openFileBackups(): Promise<void>;
  closeFileBackups(): void;
  restoreFileBackup(id: number): Promise<boolean>;
  backupRestore(backup: string, newBranch: string | null): Promise<void>;
  backupDelete(backup: string): Promise<void>;
  setReflogOpen(open: boolean): void;
  loadReflog(reference: string): Promise<void>;
  reflogRestore(oid: string, newBranch: string): Promise<void>;
  worktreeLock(path: string, reason: string | null): Promise<void>;
  worktreeUnlock(path: string): Promise<void>;
  ignoreAdd(patterns: string[]): Promise<void>;
  loadCommitTemplates(): Promise<void>;
  removeIndexLock(): Promise<void>;

  // 이력 수정 (MRG-07·09, WT-06)
  loadWorktreeWips(): Promise<void>;
  openRebasePlan(onto: string | null): Promise<void>;
  closeRebasePlan(): void;
  runRebasePlan(plan: RebasePlan): Promise<boolean>;
  rewordCommit(oid: string, message: string): Promise<void>;
  squashIntoParent(oid: string): Promise<void>;
  /**
   * 로그 범위를 하나로 합칠 준비 (MRG-07): 범위를 현재 branch 의 이력(`older^..HEAD`)과 맞춰 보고 메시지 초안을 만든다.
   * 합칠 수 없으면 사유를 오류 줄(`actionError`)에 두고 null
   */
  prepareSquashRange(): Promise<SquashRangePrep | null>;
  /** 준비한 범위를 메시지 하나의 commit 으로 합친다. 실행하면 범위를 풀고, 깨끗이 끝나면 로그를 새 commit 으로 옮긴다 */
  squashRange(target: SquashRangeTarget, message: string): Promise<boolean>;
}

export type SessionStore = StoreApi<SessionState>;

/** 경로의 마지막 요소를 탭 이름으로 쓴다 */
export function repoNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** HEAD 의 짧은 브랜치명. detached 면 null */
/** 해결 리뷰 대화상자 상태 (CF-27) */
export interface ReviewState {
  title: string;
  subtitle: string;
  text: string;
  note: string | null;
  emptyText: string;
  loading: boolean;
  error: string | null;
}

/** 병합 미리보기 대화상자 상태 (CF-01·04) */
export interface MergePreviewState {
  reference: string;
  includeWip: boolean;
  loading: boolean;
  result: MergePreview | null;
  simulate: MergePreview[] | null;
  simulating: boolean;
  file: { path: string; content: string } | null;
  error: string | null;
}

export function headBranchOf(refs: RepoRefs): string | null {
  return refs.head.state === 'detached' ? null : refs.head.branch;
}

/** 진행 중 작업 배너 문구 */
export function opLabel(op: InProgressOp | null): string | null {
  if (!op) {
    return null;
  }
  switch (op.kind) {
    case 'merge':
      return S.status.op.merge;
    case 'rebase':
      return S.status.op.rebase(Math.min(op.step + 1, op.total), op.total);
    case 'cherryPick':
      return S.status.op.cherryPick;
    case 'revert':
      return S.status.op.revert;
    case 'bisect':
      return S.status.op.bisect;
    case 'am':
      return S.status.op.am;
  }
}

/** 상태 항목이 영역에 속하는지 */
export function entryInArea(e: StatusEntry, staged: boolean): boolean {
  if (e.conflict) {
    return false;
  }
  if (staged) {
    return !['unmodified', 'untracked', 'ignored'].includes(e.index);
  }
  return !['unmodified', 'ignored'].includes(e.worktree);
}

/** 이 세션에서 거는 진행 중 작업 명령 */
export type OwnOpCommand = 'continue' | 'skip' | 'abort';

/** 저장하지 않은 충돌 편집(초안)을 버린 까닭: 밖에서 해결됨, 또는 이 세션의 작업 명령 (W19) */
export type DraftDropCause = 'external' | OwnOpCommand;

/**
 * 초안을 버렸을 때의 알림 제목 (W19): 밖에서 해결된 경우와 이 세션의 Continue·Skip·Abort 로 충돌이 사라진 경우의
 * 문구를 가른다 (중단했는데 "밖에서 해결" 이라고 알리지 않게)
 */
export function draftDroppedTitle(path: string, cause: DraftDropCause): string {
  switch (cause) {
    case 'external':
      return S.conflict.externallyResolved(path);
    case 'abort':
      return S.conflict.droppedByAbort(path);
    case 'skip':
      return S.conflict.droppedBySkip(path);
    case 'continue':
      return S.conflict.droppedByContinue(path);
  }
}

/**
 * branch 업데이트 결과의 알림 (BR-09, 저장소 탭): 갱신하면 `development ← commit 39개`(성공), 이미 최신·로컬이 앞섬은
 * 안내, 갈라져 옮기지 않았으면 안내에 수를 적는다
 */
export function branchUpdateNotice(name: string, result: BranchUpdate): Notice {
  const t = S.branches.update;
  switch (result.kind) {
    case 'updated':
      return { kind: 'success', title: t.moved(name, result.commits) };
    case 'upToDate':
      return { kind: 'info', title: t.upToDateOf(name) };
    case 'ahead':
      return { kind: 'info', title: t.ahead(name, result.commits) };
    case 'diverged':
      return { kind: 'info', title: t.diverged(name, result.ahead, result.behind) };
  }
}

const EMPTY_SEARCH: SearchState = {
  open: false,
  query: '',
  rows: [],
  total: 0,
  truncated: false,
  cursor: 0,
  advanced: null,
};

/** 세션 스토어 생성 옵션 */
export interface SessionStoreOptions {
  /**
   * 프로필 (W13). `light` 면 그래프 API 를 부르지 않고 생성 때 읽기를 `STARTUP_LOADS` 의 `light` 항목만 돌린다.
   * 기본은 `full`(저장소 탭)
   */
  profile?: SessionProfile;
  /**
   * 슬롯에 문서를 열었다 — 그 문서를 보이게 하라 (W20). diff 는 파일을 열 때(`openFile`·`openCommitFile`·
   * `openRangeFile`), conflict 는 충돌을 열기 시작할 때(`openConflict`, 읽기를 기다리지 않는다) 부른다. 세션 스토어는
   * 화면 틀을 모른다 — 어느 탭이 무엇을 보일지는 받는 쪽(앱 스토어)이 정한다. 슬롯을 채운 뒤에 부르므로 받는 쪽은
   * 이미 파생된 문서를 찾을 수 있다
   */
  onRevealDoc?: (slot: SessionDocSlot) => void;
  /**
   * 커밋으로 갔다 — 로그를 보이게 하라 (W20, 계획의 `onRevealLog()`). `jumpToCommit` 이 그 행으로 스크롤을 건 뒤
   * 부른다. 저장소 탭은 Git 도구 창의 로그 탭을 연다 (W21 — 에디터의 문서는 그대로 둔다)
   */
  onRevealLog?: () => void;
}

/**
 * 세션 스토어를 만들 때 도는 읽기 (W13 의 프로필 옵션). `light` 가 참인 것만 가벼운 세션에서 돌고, 나머지는
 * 승격할 때 돈다. 전체 프로필은 이 순서대로 모두 돈다. 폴더 탭에 기능을 더하는 슬라이스가 그 기능이 읽는 것만 참으로
 * 바꾼다 — 지금 참인 것은 폴더 탭의 충돌 편집기 탭(W15)이 머리줄에 쓰는 머지 도구 이름뿐이다
 */
const STARTUP_LOADS: readonly { load: (st: SessionState) => Promise<void>; light: boolean }[] = [
  // undo/redo 목록: 툴바·⌘Z 는 저장소 탭에만 있다
  { load: (st) => st.loadUndo(), light: false },
  // 백업 ref: 저장소 탭 브랜치 트리의 백업 그룹 (W22)
  { load: (st) => st.loadBackups(), light: false },
  // 커밋 메시지 템플릿: 커밋 폼 (W14 가 폴더 탭에 올린다)
  { load: (st) => st.loadCommitTemplates(), light: false },
  // 서브모듈: 저장소 탭 Project 도구 창의 구조(행 장식·머리 메뉴, W25)와 push 전 서브모듈 미push 확인
  { load: (st) => st.loadSubmodules(), light: false },
  // 서명 설정: 커밋 폼 (W14)
  { load: (st) => st.loadSigningInfo(), light: false },
  // 성능 제안: 로그 위의 배너 (`PerfBanner`)
  { load: (st) => st.checkPerf(), light: false },
  // 원격 프로젝트: Pull Requests 도구 창을 보일 수 있는지와 그 내용 (W24, 호스팅 API 를 부른다)
  { load: (st) => st.loadRemoteProject(), light: false },
  // 모듈: 기억한 범위가 있으면 그래프 질의를 바꾼다 (그래프 API — 가벼운 세션에서는 거부된다)
  { load: (st) => st.loadModules(), light: false },
  // 충돌 레이더: branch 12개의 병합을 미리 계산한다 (비싸다. 브랜치 트리의 로컬 branch 배지, W22)
  { load: (st) => st.loadRadar(), light: false },
  // 격리 병합 정보: 저장소 탭의 띠
  { load: (st) => st.loadIsolated(), light: false },
  // 머지 도구 이름: 충돌 화면. 폴더 탭의 충돌 편집기 탭도 같은 머리줄을 쓴다 (W15)
  { load: (st) => st.loadMergeTool(), light: true },
  // 검증·워크트리 초기화 명령: 커밋·워크트리 만들기 (W14)
  { load: (st) => st.loadCommands(), light: false },
  // 스태시 목록(출처 경로 포함): 저장소 탭 Commit 도구 창의 Stash 탭 (W23 — 옛 사이드바는 마운트될 때 읽었다). 그 뒤로는
  // `refsChanged` 가 다시 읽는다
  { load: (st) => st.loadStashes(), light: false },
];

/**
 * 세션 스토어를 만든다. `open_repo`·`folder_open_repo_session` 응답으로 초기 상태를 채운다. 가벼운 프로필은
 * 그래프 API 를 부르지 않는다 (그래프 이벤트도 오지 않는다)
 */
export function createSessionStore(
  opened: RepoOpened,
  client: IpcClient,
  cache: GraphRangeCache,
  options: SessionStoreOptions = {},
): SessionStore {
  const id = opened.session;
  const profile = options.profile ?? 'full';
  /** 저장된 레이아웃 설정이 기본값이 아니면 코어에 알린다 (git 없이 재배치). 그래프 API 라 전체 프로필에서만 */
  const syncLayoutPrefs = (prefs: GraphLayoutPrefs) => {
    if (!isDefaultLayoutPrefs(prefs)) {
      void client.setGraphLayoutPrefs(id, prefs).catch(() => {});
    }
  };
  // 저장소 탭의 Project 도구 창 (W21): 루트는 세션의 작업 트리다 (파일 API 가 세션 id 로 정한다, FS-01)
  const fileTree = createFileTree({
    list: (dir, limit) => client.fsListDir(id, dir, limit),
    read: (path) => client.fsReadFile(id, path),
  });
  /**
   * 펼친 디렉터리를 다시 나열한다 (계획 5.4 "자체 작업 뒤"·새로고침·창 포커스). 아직 한 번도 읽지 않은 트리(가벼운 세션,
   * Project 도구 창을 열지 않은 탭)는 읽기를 시작하지 않는다
   */
  const reloadFiles = async () => {
    if (fileTree.getState().dirs[''] !== undefined) {
      await fileTree.getState().reload();
    }
  };
  const store = createStore<SessionState>()((set, get) => {
    /** 장시간 명령 상태를 부분 갱신한다 */
    const patchOp = (opId: number, patch: Partial<OperationState>) => {
      const current = get().operations[opId];
      if (!current) {
        return;
      }
      set({ operations: { ...get().operations, [opId]: { ...current, ...patch } } });
    };

    /**
     * 쓰기 동작을 실행한다. 실패하면 힌트를 대화상자(`pendingHint`)로 돌리거나 `actionError` 에 남긴다.
     * 돌려주는 값은 성공 시 결과, 실패 시 undefined
     */
    const run = async <T>(
      fn: () => Promise<T>,
      toHint?: (
        hint: NonNullable<Extract<ReturnType<typeof toIpcError>, { kind: 'gitFailed' }>['hint']>,
      ) => PendingHint | null,
      /** gitFailed 가 아닌 오류를 대화상자로 돌린다 */
      errorHint?: (err: ReturnType<typeof toIpcError>) => PendingHint | null,
    ): Promise<T | undefined> => {
      set({ actionError: null, busy: true, lastOutcome: null });
      try {
        return await fn();
      } catch (e) {
        const err = toIpcError(e);
        const fromError = errorHint?.(err) ?? null;
        if (fromError) {
          set({ pendingHint: fromError });
          return undefined;
        }
        if (err.kind === 'nestedRepos') {
          set({ pendingHint: { kind: 'nestedRepo', paths: err.paths } });
          return undefined;
        }
        if (err.kind === 'localBranchTracksOther') {
          const oid =
            get().refs.labels.find((l) => l.fullName === `refs/remotes/${err.remote}/${err.name}`)
              ?.target ?? null;
          set({
            pendingHint: {
              kind: 'remoteBranchTaken',
              local: err.local,
              remote: err.remote,
              name: err.name,
              upstream: err.upstream ?? null,
              oid,
            },
          });
          return undefined;
        }
        if (err.kind === 'gitFailed' && err.hint) {
          const hint = (toHint ? toHint(err.hint) : null) ?? defaultHint(err.hint);
          if (hint) {
            set({ pendingHint: hint });
            return undefined;
          }
        }
        set({ actionError: describeError(e) });
        return undefined;
      } finally {
        set({ busy: false });
      }
    };

    // 그래프 질의 요청 차례 (W26): 가장 나중에 보낸 요청의 `invalidFilter` 만 오류로 보인다
    let querySeq = 0;
    // 작성자 후보 요청 차례: 새 요청·ref 변경마다 올려 늦게 온 옛 응답을 버린다
    let authorsSeq = 0;
    // 모듈 범위를 바꾸는 중인 흐름 수 (`selectModule`·`loadModules`). 그사이 받아들여진 다른 질의로 모듈 범위를 풀지 않는다
    let moduleScopeChanging = 0;

    /** 작성자 후보를 낡은 것으로 본다 (ref 변경). 읽는 중이던 응답은 버리고 다음에 열 때 다시 읽는다. 목록은 남긴다 */
    const invalidateAuthors = () => {
      authorsSeq += 1;
      const authors = get().graphAuthors;
      if (authors.state !== 'idle') {
        set({ graphAuthors: { ...authors, state: 'idle', error: null } });
      }
    };

    /**
     * 범위의 두 출처를 맞춘다 (W26): Project 도구 창의 띠·행 배지·머리 메뉴는 `moduleScope`, 그래프는 `graphQuery.pathScope`
     * 를 본다. 받아들여진 경로 범위가 그 모듈 하나(`[moduleScope]`)가 아니면(경로를 풀거나 고침, 모두 지우기·초기화,
     * 다른 경로) 모듈 범위를 풀고 코어에 기억한 범위도 지운다. 모듈을 고르는 흐름(`selectModule`·`loadModules`)이 도는
     * 동안에는 맞추지 않는다 — 그 흐름이 두 값을 함께 바꾼다
     */
    const syncModuleScope = () => {
      const { moduleScope, graphQuery } = get();
      if (moduleScopeChanging > 0 || moduleScope === null) {
        return;
      }
      const paths = graphQuery.pathScope;
      if (paths.length === 1 && paths[0] === moduleScope) {
        return;
      }
      set({ moduleScope: null });
      void client.moduleScopeSet(id, null).catch(() => {});
    };

    /** 병합류 결과를 기록한다 */
    let radarTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * ref 가 바뀌면 1.5초 뒤 레이더를 다시 계산한다 (연속 변경은 한 번으로). 가벼운 세션은 레이더를 보이는 곳이
     * 없어 계산하지 않는다 (승격하면 생성 읽기로 한 번 돈다)
     */
    const scheduleRadar = () => {
      if (get().profile === 'light') {
        return;
      }
      if (radarTimer) {
        clearTimeout(radarTimer);
      }
      radarTimer = setTimeout(() => {
        radarTimer = null;
        void get().loadRadar();
      }, 1500);
    };

    /** 열린 미리보기를 (다시) 계산한다 */
    const loadPreview = async () => {
      const p = get().preview;
      if (!p) {
        return;
      }
      try {
        const result = await client.mergePreview(id, p.reference, [], p.includeWip);
        const now = get().preview;
        if (now && now.reference === p.reference) {
          set({ preview: { ...now, loading: false, result, file: null, error: null } });
        }
      } catch (e) {
        const now = get().preview;
        if (now) {
          set({ preview: { ...now, loading: false, error: describeError(e) } });
        }
      }
    };

    const outcome = async (fn: () => Promise<OpOutcome>, errorHint?: Parameters<typeof run>[2]) => {
      const r = await run(fn, undefined, errorHint);
      if (r) {
        set({ lastOutcome: r });
      }
    };

    /** 현재 연 파일의 diff 를 (다시) 읽는다 */
    const loadDiff = async (target: FileTarget, full: boolean) => {
      set({ diffLoading: true, diffError: null });
      try {
        const { ignoreWhitespace, context } = get().diffOptions;
        const opts = { ignoreWhitespace, context };
        let diff: FileDiff | null;
        if (target.range) {
          diff = await client.compareFileDiff(
            id,
            target.range.base,
            target.range.newer,
            false,
            target.path,
            opts,
            full,
          );
        } else if (target.commit) {
          diff = await client.commitFileDiff(
            id,
            target.commit,
            target.path,
            target.oldPath ?? null,
            full,
            opts,
          );
        } else {
          diff = await client.workTreeDiff(id, target.path, target.staged, full, opts);
        }
        const current = get().selectedFile;
        if (
          current &&
          current.path === target.path &&
          current.staged === target.staged &&
          current.commit === target.commit &&
          current.range?.base === target.range?.base &&
          current.range?.newer === target.range?.newer
        ) {
          set({ diff, diffLoading: false });
        }
      } catch (e) {
        set({ diff: null, diffLoading: false, diffError: describeError(e) });
      }
    };

    /** 아바타 요청 중인 이메일 (중복 요청 방지) */
    const avatarPending = new Set<string>();

    /** PR 목록을 처음 읽은 원격 프로젝트 (`계정/경로`). 다른 프로젝트가 되면 다시 읽는다 (`ensurePullRequests`, W24) */
    let prsLoadedFor: string | null = null;

    /** 검색 차례. 새 검색·닫기마다 올려 늦게 온 응답을 버린다 */
    let searchSeq = 0;

    /** 응답을 기다리는 사용자 검색을 다시 돌린다. 재로드되면 그 응답의 행 번호가 낡기 때문이다 */
    let retryUserSearch: (() => void) | null = null;

    /** 범위 계산 차례. 다른 선택이 끼어들면 올려 늦게 끝난 계산을 버린다 */
    let rangeSeq = 0;

    /** 상세에 보이는 커밋의 포함 branch (CD-03). 언제 읽고 무엇을 버리는지는 공용 지연 읽기가 정한다 */
    const containing = createContainingLoader<string>({
      keyOf: (oid) => oid,
      fetch: (oid) => client.commitContainingRefs(id, oid),
      publish: (entry) => set({ containing: entry }),
      describeError,
    });

    /** 범위를 지울 때의 상태 변경. 그 범위의 diff 도 근거를 잃으므로 함께 닫는다 */
    const rangeCleared = (): Partial<SessionState> => {
      const { selectedFile } = get();
      return {
        range: null,
        ...(selectedFile?.range ? { selectedFile: null, diff: null, diffError: null } : {}),
      };
    };

    /** 검색 응답을 반영한다. `keep` 이면 번호만 맞추고 스크롤하지 않는다 */
    const applySearch = (
      r: { rows: number[]; total: number; truncated: boolean },
      fields: Pick<SearchState, 'query' | 'advanced'>,
      keep: boolean,
    ) => {
      retryUserSearch = null;
      const first = r.rows[0];
      set({
        search: {
          open: true,
          ...fields,
          rows: r.rows,
          total: r.total,
          truncated: r.truncated,
          cursor: keep ? Math.min(get().search.cursor, Math.max(r.rows.length - 1, 0)) : 0,
        },
        ...(!keep && first !== undefined ? { scrollToRow: first } : {}),
      });
    };

    /** 저장 중인 충돌 경로. 저장으로 충돌이 사라져도 "밖에서 해결" 로 알리지 않는다 */
    let savingConflict: string | null = null;

    /**
     * 이 세션이 건 작업 명령 (Continue·Skip·Abort, W19). 그 명령으로 충돌이 사라져 초안을 버리면 "밖에서 해결" 이 아니라
     * 그 명령을 사유로 알린다. 명령이 도는 동안 온 상태 변경은 그 명령의 것이다 — 코어는 쓰기 뒤 상태를 다시 읽어 알린
     * 다음에 응답한다. 응답이 상태 변경보다 먼저 닿았으면(성공했는데 아직 못 받았으면) 그다음 한 번까지 그 명령의 것으로 본다
     */
    let ownOp: { cmd: OwnOpCommand; seen: boolean; done: boolean } | null = null;

    /**
     * 결과를 스스로 알리는 tag 원격 작업(push·원격 삭제·덮어쓰기·가져오기)이 도는 중인 수 (`quietly`). 그동안 시작된 kind
     * `push`·`fetch` op 는 끝 토스트(오래 걸림·실패)를 띄우지 않는다 — 같은 결과를 두 번 알리지 않게. 이벤트 통로가 명령
     * 응답과 달라 op 의 끝 이벤트는 응답보다 늦게 올 수 있으므로, 시작 때 op 번호를 기억해 끝 이벤트에서 지운다
     */
    let quietDepth = 0;
    const quietOps = new Set<number>();
    /** 결과를 스스로 알리는 원격 명령을 돌린다 (`quietDepth`) */
    const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
      quietDepth += 1;
      try {
        return await fn();
      } finally {
        quietDepth -= 1;
      }
    };

    /**
     * 원격 tag 보고서의 차례 (B5). 늦게 끝난 옛 요청이 새 값을 덮지 않게, 원격마다 마지막으로 반영한 차례보다 뒤에 시작한
     * 다시 받기만 반영한다. 확인(네트워크)은 끝난 시점에 차례를 받아 늘 반영한다 — 그 전에 시작한 다시 받기는 옛 캐시다
     */
    let tagSeq = 0;
    const tagApplied: Record<string, number> = {};

    /**
     * 보고서 하나를 반영한다. 확인한 적도 실패한 적도 없는 빈 보고서면 그 원격을 지운다 (캐시가 비워졌다). 바뀐 것이 없으면
     * (값이 같은 보고서, 없던 원격을 지우기) 상태를 그대로 둔다 — `tagReports` 참조가 같아 트리·문서가 다시 그리지 않는다
     */
    const applyTagReport = (remote: string, report: TagSyncReport | null) => {
      const reports = get().tagReports;
      const old = reports[remote];
      const keep =
        report !== null &&
        ((report.checkedAt !== null && report.checkedAt !== undefined) || !!report.lastError);
      if (keep && report) {
        if (old === undefined || !sameTagReport(old, report)) {
          set({ tagReports: { ...reports, [remote]: report } });
        }
      } else if (old !== undefined) {
        const { [remote]: _old, ...rest } = reports;
        set({ tagReports: rest });
      }
    };

    // ref 가 바뀌면 보고서를 네트워크 없이 다시 받는다 (연속 변경은 한 번으로, 받은 보고서가 있을 때만)
    let tagReloadTimer: ReturnType<typeof setTimeout> | null = null;
    /** ref 변경 뒤 보고서 다시 받기를 미룬다 (TG-08 무효화가 코어 캐시에 반영된 값을 읽는다) */
    const scheduleTagReload = () => {
      if (Object.keys(get().tagReports).length === 0) {
        return;
      }
      if (tagReloadTimer) {
        clearTimeout(tagReloadTimer);
      }
      tagReloadTimer = setTimeout(() => {
        tagReloadTimer = null;
        void get().reloadRemoteTags();
      }, 300);
    };

    /**
     * 이름 충돌 안내에 두 commit 을 채운다 (TG-02 B): 단일 조회로 원격 commit 을 받아, 안내가 아직 그대로면 바꾼다. 조회가
     * 실패하면 commit 없이 안내만 남는다
     */
    const fillTagExists = async (hint: Extract<PendingHint, { kind: 'tagExists' }>) => {
      try {
        const found = await client.lookupRemoteTags(id, hint.remote, hint.names);
        const labels = get().refs.labels;
        const commits = hint.names.map((name): TagCommitPair => {
          const remote = found.find((t) => t.name === name);
          return {
            name,
            local: labels.find((l) => l.fullName === `refs/tags/${name}`)?.target ?? null,
            remote: remote ? (remote.peeled ?? remote.object) : null,
            remoteObject: remote?.object ?? null,
          };
        });
        if (get().pendingHint === hint) {
          set({ pendingHint: { ...hint, commits } });
        }
        void get().reloadRemoteTags();
      } catch {
        // 조회 실패: 안내는 commit 없이 그대로 둔다
      }
    };

    // 로컬 tag 목록 읽기의 차례 (늦게 온 옛 응답이 새 목록을 덮지 않게)
    let tagListSeq = 0;

    /**
     * 결과를 스스로 알리는 tag 원격 명령을 busy 한 번으로 돌린다 (가져오기·일괄 작업): 명령 전체가 실패해도 `run` 의 오류 줄로
     * 보내지 않고 그 오류를 돌려준다 — 부른 쪽이 알맞은 안내를 고른다
     */
    const runTagCommand = async (
      fn: () => Promise<TagRefResult[]>,
    ): Promise<{ results: TagRefResult[] | null; error: unknown }> => {
      let error: unknown = null;
      const results = await run(async () => {
        try {
          return await quietly(fn);
        } catch (e) {
          error = e;
          return null;
        }
      });
      return { results: results ?? null, error };
    };

    /** 작업 명령을 돌린다 (`ownOp` 를 세우고 끝나면 정리한다) */
    const runOwnOp = async (cmd: OwnOpCommand, fn: () => Promise<unknown>) => {
      const mark = { cmd, seen: false, done: false };
      ownOp = mark;
      await fn();
      if (ownOp === mark) {
        const ok = get().actionError === null && get().pendingHint === null;
        if (mark.seen || !ok) {
          ownOp = null;
        } else {
          mark.done = true;
        }
      }
    };

    /** 충돌에서 빠진 경로의 초안을 지운다. 저장 중이 아닌 초안이 사라지면 사유(`cause`)와 함께 알린다 */
    const pruneDrafts = (entries: readonly StatusEntry[], cause: DraftDropCause) => {
      const drafts = get().conflictDrafts;
      const paths = Object.keys(drafts);
      if (paths.length === 0) {
        return;
      }
      const conflicted = new Set(entries.filter((e) => e.conflict).map((e) => e.path));
      const gone = paths.filter((p) => !conflicted.has(p));
      if (gone.length === 0) {
        return;
      }
      const rest = { ...drafts };
      for (const p of gone) {
        delete rest[p];
        if (p !== savingConflict) {
          notifyHub.notify({ kind: 'info', title: draftDroppedTitle(p, cause) });
        }
      }
      set({ conflictDrafts: rest });
    };

    /** undo·redo 가 건드리지 않은 ref 를 알린다 */
    const noteSkipped = (skipped: readonly string[]) => {
      if (skipped.length > 0) {
        notifyHub.notify({
          kind: 'info',
          title: S.safety.undoSkipped,
          message: skipped.join(', '),
        });
      }
    };

    /** 스태시의 현재 번호. 사라졌으면 오류를 던져 아무것도 건드리지 않게 한다 */
    const stashIndexOf = async (oid: string): Promise<number> => {
      const stashes = await client.listStashes(id);
      const found = stashes.find((s) => s.info.oid === oid);
      if (!found) {
        throw new IpcClientError({ kind: 'internal', message: S.stash.gone });
      }
      return found.info.index;
    };

    /** 커밋 상세를 읽는다 */
    const loadDetail = async (oid: string) => {
      set({ detailLoading: true });
      try {
        const detail = await client.commitDetail(id, oid);
        if (get().selectedCommit === oid) {
          set({ detail, detailLoading: false });
          // 서명 검증은 따로 (gpg 가 느릴 수 있다, CHG-08)
          void client
            .commitSignature(id, oid)
            .then((sig) => {
              if (get().selectedCommit === oid) {
                set({ detailSignature: sig });
              }
            })
            .catch(() => {});
        }
      } catch (e) {
        if (get().selectedCommit === oid) {
          set({ detail: null, detailLoading: false, actionError: describeError(e) });
        }
      }
    };

    return {
      id,
      path: opened.info.workTree,
      profile,
      fileTree,
      reloadFiles,
      nestedRepos: opened.nestedRepos ?? [],
      superproject: opened.superproject ?? null,
      submodules: [],
      conflict: null,
      conflictLoading: false,
      conflictDrafts: {},
      undoState: { entries: [], redoCount: 0 },
      backups: [],
      reflogOpen: false,
      reflogRef: '',
      reflog: [],
      fileBackups: null,
      commitTemplates: [],
      worktreeWips: [],
      rebasePlan: null,
      name: repoNameOf(opened.info.workTree),
      refs: opened.state.refs,
      status: opened.state.status,
      op: opened.state.op ?? null,
      generation: 0,
      totalRows: 0,
      loadState: 'opening',
      commitGraphSuggested: false,
      reloading: false,
      reloadError: null,
      operations: {},
      operationOrder: [],
      log: [],

      selectedCommit: null,
      wipSelected: true,
      selectedFile: null,
      diffMode: 'unified',
      diff: null,
      diffLoading: false,
      diffError: null,
      actionError: null,
      detail: null,
      detailLoading: false,
      containing: null,
      search: EMPTY_SEARCH,
      scrollToRow: null,
      pendingJump: null,
      pendingHint: null,
      busy: false,
      tagReports: {},
      tagChecking: [],
      tagList: null,
      lastOutcome: null,
      pullMode: 'default',
      stashes: [],
      stashView: null,
      diffOptions: readPref(PREF_DIFF_OPTIONS, DEFAULT_DIFF_OPTIONS),
      graphQuery: DEFAULT_GRAPH_QUERY,
      filterError: null,
      graphAuthors: { state: 'idle', list: null, error: null },
      layoutPrefs: readPref(PREF_GRAPH_LAYOUT, DEFAULT_LAYOUT_PREFS),
      graphView: readPref(PREF_GRAPH_VIEW, DEFAULT_GRAPH_VIEW),
      graphColumns: readPref(PREF_GRAPH_COLUMNS, DEFAULT_GRAPH_COLUMNS),
      blame: null,
      fileHistory: null,
      compare: null,
      range: null,
      signingInfo: null,
      commitSign: null,
      secretHits: null,
      perfSuggestion: null,
      repoSettings: null,
      shallow: opened.info.shallow,
      detailSignature: null,
      remoteProject: null,
      pullRequests: [],
      prsLoading: false,
      prsError: null,
      avatars: {},
      submoduleLog: null,
      modules: [],
      moduleScope: null,
      preview: null,
      rebasePreview: null,
      radar: [],
      isolatedBranch: null,
      conflictLabels: null,
      origins: null,
      mergeTool: null,
      rerere: { enabled: false, autoupdate: false, resolvedPaths: [] },
      kept: [],
      renameConflicts: [],
      rules: [],
      ruleResults: null,
      review: null,
      assistDialog: null,
      reapplyOfferedFor: null,
      verifyCommand: null,
      worktreeInitCommand: null,
      lfs: null,

      commitMessage: '',
      commitAmend: false,
      commitNoVerify: false,
      committing: false,
      commitError: null,
      lastCommitOpId: null,
      lastCommitHash: null,

      promote() {
        if (get().profile === 'full') {
          return;
        }
        set({ profile: 'full' });
        const st = get();
        for (const step of STARTUP_LOADS) {
          if (!step.light) {
            void step.load(st);
          }
        }
        syncLayoutPrefs(st.layoutPrefs);
      },

      applyEvent(event) {
        const s = get();
        /** 보관해 둔 커밋 이동을 실행한다 (로드·재로드 완료 시) */
        const runPendingJump = () => {
          const oid = get().pendingJump;
          if (oid) {
            set({ pendingJump: null });
            void get().jumpToCommit(oid);
          }
        };
        switch (event.type) {
          case 'graphLoadStarted':
            if (event.generation < s.generation) {
              return;
            }
            set({ generation: event.generation, loadState: 'streaming' });
            return;
          case 'graphFirstChunk':
          case 'graphProgress':
            if (event.generation < s.generation || s.loadState === 'complete') {
              return;
            }
            cache.setTotalRows(event.rows, false);
            set({ generation: event.generation, totalRows: event.rows, loadState: 'streaming' });
            return;
          case 'graphLoadFinished':
            if (event.generation < s.generation || s.loadState === 'complete') {
              return;
            }
            cache.setTotalRows(event.rows, true);
            cache.invalidateAll();
            set({
              generation: event.generation,
              totalRows: event.rows,
              loadState: 'complete',
              commitGraphSuggested: event.commitGraphSuggested,
            });
            runPendingJump();
            return;
          case 'graphLoadFailed':
            if (event.generation < s.generation) {
              return;
            }
            set({ generation: event.generation, loadState: 'error', error: event.message });
            return;
          case 'graphReloaded':
            cache.setTotalRows(event.rows, true);
            cache.invalidateAll();
            set({
              generation: event.generation,
              totalRows: event.rows,
              loadState: 'complete',
              reloading: false,
              reloadError: null,
              range: null,
            });
            runPendingJump();
            // 사용자 검색이 도는 중이면 그 요청을 잇고, 아니면 결과만 새로 받는다.
            // 재로드는 사용자가 시킨 일이 아니므로 보던 위치를 첫 결과로 옮기지 않는다
            if (retryUserSearch) {
              retryUserSearch();
            } else if (s.search.open && s.search.advanced) {
              void get().runAdvancedSearch(s.search.advanced, { keepPosition: true });
            } else if (s.search.open && s.search.query) {
              void get().runSearch(s.search.query, { keepPosition: true });
            }
            if (s.selectedCommit) {
              void loadDetail(s.selectedCommit);
            }
            return;
          case 'graphReloadFailed':
            set({ reloading: false, reloadError: S.error.reloadFailed(event.message) });
            return;
          case 'graphQueryAdjusted':
            set({ graphQuery: event.query });
            notifyHub.notify({
              kind: 'info',
              title: S.graph.queryAdjusted,
              message: event.dropped.join(', '),
            });
            return;
          case 'statusChanged': {
            set({ status: event.status, op: event.op ?? null });
            // 충돌 수가 바뀌면 이름 변경 묶음·rerere·보관 해결을 다시 읽는다 (D2)
            const conflictedNow = event.status.summary.conflicted;
            if (conflictedNow !== s.status.summary.conflicted) {
              if (conflictedNow > 0) {
                void get().loadRenameConflicts();
                void get().loadRerere();
              } else {
                set({ renameConflicts: [], rerere: { ...s.rerere, resolvedPaths: [] } });
              }
              void get().loadKept();
            }
            void get().loadSubmodules();
            void get().loadWorktreeWips();
            const open = s.conflict;
            if (open && !event.status.entries.some((e) => e.path === open.path && e.conflict)) {
              set({ conflict: null });
            }
            // 이 세션의 작업 명령이 만든 변경이면 그 명령이 초안을 버린 사유다 (W19)
            const mark = ownOp;
            pruneDrafts(event.status.entries, mark?.cmd ?? 'external');
            if (mark !== null) {
              mark.seen = true;
              if (mark.done && ownOp === mark) {
                ownOp = null;
              }
            }
            const target = s.selectedFile;
            // 커밋·범위 diff 는 작업 트리 상태와 무관하다
            if (target && !target.commit && !target.range) {
              const stillThere = event.status.entries.some(
                (e) => e.path === target.path && entryInArea(e, target.staged),
              );
              if (stillThere) {
                void loadDiff(target, false);
              } else {
                set({ selectedFile: null, diff: null });
              }
            }
            return;
          }
          case 'refsChanged':
            set({ refs: event.refs });
            // 포함 branch 는 ref 가 바뀌면 낡는다 (CD-03). 작성자 후보(이력 전체)도 새 커밋·fetch 로 바뀔 수 있다 (W26)
            containing.invalidate();
            invalidateAuthors();
            scheduleRadar();
            void get().loadStashes();
            void get().loadUndo();
            void get().loadBackups();
            void get().loadWorktreeWips();
            // checkout·pull·merge·reset 처럼 ref 를 옮기는 작업은 작업 트리 파일도 바꾼다 (W21 Project 도구 창)
            void reloadFiles();
            scheduleTagReload();
            return;
          case 'operationStarted':
            if ((event.kind === 'push' || event.kind === 'fetch') && quietDepth > 0) {
              quietOps.add(event.opId);
            }
            set({
              operations: {
                ...s.operations,
                [event.opId]: {
                  id: event.opId,
                  kind: event.kind,
                  label: event.label,
                  phase: '',
                  percent: null,
                  message: '',
                  output: [],
                  done: false,
                  ok: false,
                  cancelled: false,
                  lockLeft: false,
                  startedAt: Date.now(),
                },
              },
              operationOrder: [...s.operationOrder, event.opId],
              ...(event.kind === 'commit' ? { lastCommitOpId: event.opId } : {}),
            });
            return;
          case 'operationProgress':
            patchOp(event.opId, {
              phase: event.phase,
              percent: event.percent ?? null,
              message: event.message,
            });
            return;
          case 'operationOutput': {
            const op = s.operations[event.opId];
            if (!op) {
              return;
            }
            const line = event.stderr ? `!${event.text}` : event.text;
            const output =
              op.output.length >= OUTPUT_CAPACITY
                ? [...op.output.slice(-OUTPUT_CAPACITY + 1), line]
                : [...op.output, line];
            patchOp(event.opId, { output });
            return;
          }
          case 'operationFinished':
            patchOp(event.opId, {
              done: true,
              ok: event.ok,
              cancelled: event.cancelled,
              message: event.message,
              lockLeft: event.lockLeft,
            });
            // 오래 걸린 작업·실패는 알린다 (UX-09). 결과를 스스로 알리는 tag 작업의 op(`quietOps`)와 원격 tag 확인
            // (kind `tagCheck` — 결과는 보고서의 `lastError`·안내가 보인다, D15)는 뺀다
            {
              const op = s.operations[event.opId];
              const quiet = quietOps.delete(event.opId);
              if (
                op &&
                !quiet &&
                op.kind !== 'tagCheck' &&
                !event.cancelled &&
                (!event.ok || Date.now() - op.startedAt >= LONG_OP_MS)
              ) {
                notifyHub.notify({
                  kind: event.ok ? 'success' : 'error',
                  title: event.ok ? S.notify.opDone(op.label) : S.notify.opFailed(op.label),
                  message: event.message || undefined,
                  os: true,
                });
              }
            }
            return;
          case 'autoFetched':
            notifyHub.notify({
              kind: 'info',
              title: S.notify.autoFetched(event.refs.length),
              message: event.refs.slice(0, 5).join(', '),
              os: true,
            });
            return;
          case 'commandLogged':
            set({ log: prependCapped(s.log, event.record) });
            return;
        }
      },

      async refresh() {
        try {
          await client.refreshRepo(id);
        } catch (e) {
          set({ reloadError: describeError(e) });
        }
      },

      async reloadGraph() {
        set({ reloading: true, reloadError: null });
        try {
          await client.reloadGraph(id);
        } catch (e) {
          set({ reloading: false, reloadError: describeError(e) });
        }
      },

      async cancelOperation(opId) {
        try {
          return await client.cancelOperation(opId);
        } catch {
          return false;
        }
      },

      dismissOperation(opId) {
        const rest = { ...get().operations };
        delete rest[opId];
        set({ operations: rest, operationOrder: get().operationOrder.filter((o) => o !== opId) });
      },

      resolveRow(oid) {
        return client.findRow(id, oid).catch(() => null);
      },

      selectWip() {
        // 스태시 보기(Commit 도구 창 Stash 탭)는 건드리지 않는다 — 로그 선택과 독립이다 (W23)
        rangeSeq += 1;
        set({
          wipSelected: true,
          selectedCommit: null,
          detail: null,
          ...rangeCleared(),
        });
      },

      showContaining(oid) {
        containing.show(oid);
      },

      retryContaining() {
        containing.retry();
      },

      selectCommit(oid) {
        rangeSeq += 1;
        if (get().selectedCommit === oid) {
          // 범위의 기준 커밋을 다시 고르면 단일 커밋 선택으로 돌아온다 (상세는 이미 있다)
          if (get().range) {
            set(rangeCleared());
          }
          return;
        }
        // 스태시 보기는 건드리지 않는다 (W23 — 스태시 상세가 Commit 도구 창으로 옮겨 가 로그 선택과 독립이다)
        set({
          selectedCommit: oid,
          wipSelected: false,
          detail: null,
          detailSignature: null,
          ...rangeCleared(),
        });
        void loadDetail(oid);
      },

      async openFile(path, staged) {
        const target = { path, staged, commit: null };
        set({ selectedFile: target, diff: null });
        options.onRevealDoc?.('diff');
        await loadDiff(target, false);
      },

      async openCommitFile(oid, path, oldPath = null) {
        const target = { path, staged: false, commit: oid, oldPath };
        set({ selectedFile: target, diff: null });
        options.onRevealDoc?.('diff');
        await loadDiff(target, false);
      },

      closeFile() {
        set({ selectedFile: null, diff: null, diffError: null });
      },

      setDiffMode(mode) {
        set({ diffMode: mode });
      },

      async loadFullDiff() {
        const target = get().selectedFile;
        if (target) {
          await loadDiff(target, true);
        }
      },

      clearActionError() {
        set({ actionError: null });
      },

      consumeScroll() {
        set({ scrollToRow: null });
      },

      jumpToCommitWhenLoaded(oid) {
        if (get().loadState === 'complete') {
          void get().jumpToCommit(oid);
        } else {
          set({ pendingJump: oid });
        }
      },

      async jumpToCommit(oid) {
        const row = await get().resolveRow(oid);
        if (row !== null) {
          set({ scrollToRow: row });
          options.onRevealLog?.();
          get().selectCommit(oid);
        }
      },

      stage(paths) {
        return run(() => client.stagePaths(id, paths)).then(() => {});
      },

      unstage(paths) {
        return run(() => client.unstagePaths(id, paths)).then(() => {});
      },

      stageAll() {
        return run(() => client.stageAll(id)).then(() => {});
      },

      unstageAll() {
        return run(() => client.unstageAll(id)).then(() => {});
      },

      discard(paths) {
        return run(() => client.discardPaths(id, paths)).then((r) => {
          if (r !== undefined) {
            notifyHub.notify({ kind: 'info', title: S.safety.discardBackedUp });
          }
        });
      },

      rollback(paths) {
        return run(() => client.rollbackPaths(id, paths)).then((r) => {
          if (r !== undefined) {
            notifyHub.notify({ kind: 'info', title: S.safety.discardBackedUp });
          }
        });
      },

      applyLines(selection) {
        const target = get().selectedFile;
        if (!target || target.commit) {
          return Promise.resolve();
        }
        const { ignoreWhitespace, context } = get().diffOptions;
        return run(() =>
          client.stageLines(id, target.path, selection, target.staged, {
            ignoreWhitespace,
            context,
          }),
        ).then(() => {});
      },

      applyHunk(hunk) {
        return get().applyLines([{ hunk, lines: [] }]);
      },

      discardLines(selection) {
        const target = get().selectedFile;
        if (!target || target.staged || target.commit) {
          return Promise.resolve();
        }
        const { ignoreWhitespace, context } = get().diffOptions;
        return run(() =>
          client.discardLines(id, target.path, selection, { ignoreWhitespace, context }),
        ).then((r) => {
          if (r !== undefined && r !== null) {
            notifyHub.notify({ kind: 'info', title: S.safety.discardBackedUp });
          }
        });
      },

      discardHunk(hunk) {
        return get().discardLines([{ hunk, lines: [] }]);
      },

      setCommitMessage(message) {
        set({ commitMessage: message, commitError: null });
      },

      async setCommitAmend(on) {
        set({ commitAmend: on });
        if (on && get().commitMessage.trim() === '') {
          try {
            const last = await client.lastCommitMessage(id);
            if (get().commitAmend && get().commitMessage.trim() === '') {
              set({ commitMessage: last });
            }
          } catch {
            // 메시지를 못 읽어도 amend 자체는 가능하다
          }
        }
      },

      setCommitNoVerify(on) {
        set({ commitNoVerify: on });
      },

      async commit(opts) {
        const s = get();
        if (s.committing || s.commitMessage.trim() === '') {
          return false;
        }
        set({ committing: true, commitError: null, lastCommitHash: null });
        try {
          // 비밀 정보 스캔 (CHG-09): 적중이 있으면 멈추고 경고를 보여 준다
          if (!opts?.ignoreSecrets) {
            const hits = await client.scanStagedSecrets(id).catch(() => []);
            if (hits.length > 0) {
              set({ committing: false, secretHits: hits });
              return false;
            }
          }
          const hash = await client.commit(id, {
            message: s.commitMessage.trimEnd(),
            amend: s.commitAmend,
            noVerify: s.commitNoVerify,
            sign: s.commitSign,
            allowConflictMarkers: opts?.allowConflictMarkers ?? false,
          });
          set({
            committing: false,
            commitMessage: '',
            commitAmend: false,
            lastCommitHash: hash,
            secretHits: null,
          });
          return true;
        } catch (e) {
          const err = toIpcError(e);
          if (err.kind === 'conflictMarkers') {
            set({
              committing: false,
              pendingHint: {
                kind: 'conflictMarkers',
                files: err.files,
                retry: { kind: 'commit', ignoreSecrets: true },
              },
            });
            return false;
          }
          set({ committing: false, commitError: describeError(e) });
          return false;
        }
      },

      async commitMessageOf(oid) {
        try {
          return await client.commitMessage(id, oid);
        } catch (e) {
          set({ actionError: describeError(e) });
          return null;
        }
      },

      setSearchOpen(open) {
        if (!open) {
          searchSeq += 1;
          retryUserSearch = null;
        }
        set({ search: open ? { ...get().search, open: true } : EMPTY_SEARCH });
      },

      async runSearch(query, opts) {
        const keep = opts?.keepPosition ?? false;
        const current = get().search;
        searchSeq += 1;
        const seq = searchSeq;
        if (query.trim() === '') {
          retryUserSearch = null;
          set({ search: { ...EMPTY_SEARCH, open: current.open } });
          return;
        }
        if (!keep) {
          retryUserSearch = () => void get().runSearch(query);
        }
        try {
          const r = await client.searchCommits(
            id,
            query,
            { subject: true, author: true, hash: true },
            SEARCH_LIMIT,
          );
          if (seq !== searchSeq) {
            return;
          }
          applySearch(r, { query, advanced: null }, keep);
        } catch (e) {
          if (seq === searchSeq) {
            retryUserSearch = null;
            set({ actionError: describeError(e) });
          }
        }
      },

      searchStep(delta) {
        const s = get().search;
        if (s.rows.length === 0) {
          return;
        }
        const cursor = (s.cursor + delta + s.rows.length) % s.rows.length;
        const row = s.rows[cursor];
        set({ search: { ...s, cursor }, ...(row !== undefined ? { scrollToRow: row } : {}) });
      },

      async runAdvancedSearch(query, opts) {
        const keep = opts?.keepPosition ?? false;
        searchSeq += 1;
        const seq = searchSeq;
        if (!keep) {
          retryUserSearch = () => void get().runAdvancedSearch(query);
        }
        try {
          const r = await client.searchAdvanced(id, query, SEARCH_LIMIT);
          if (seq !== searchSeq) {
            return;
          }
          applySearch(r, { query: get().search.query, advanced: query }, keep);
        } catch (e) {
          if (seq === searchSeq) {
            retryUserSearch = null;
            set({ actionError: describeError(e) });
          }
        }
      },

      setDiffOptions(patch) {
        const next = { ...get().diffOptions, ...patch };
        set({ diffOptions: next });
        writePref(PREF_DIFF_OPTIONS, next);
        // 코어 옵션이 바뀌면 열린 diff·비교·blame 을 다시 읽는다
        if (patch.ignoreWhitespace !== undefined || patch.context !== undefined) {
          const target = get().selectedFile;
          if (target) {
            void loadDiff(target, false);
          }
          const c = get().compare;
          if (c?.path) {
            void get().compareSelectFile(c.path);
          }
          const b = get().blame;
          if (b && patch.ignoreWhitespace !== undefined) {
            void get().openBlame(b.path, b.rev);
          }
        }
      },

      async setGraphQuery(query) {
        const seq = ++querySeq;
        // 잘못된 정규식은 `run` 의 알림(`actionError`)이 아니라 필터 바의 안내로: 표식으로 돌려받는다
        const result = await run(async (): Promise<{ invalid: string | null }> => {
          try {
            await client.setGraphQuery(id, query);
            return { invalid: null };
          } catch (e) {
            if (toIpcError(e).kind === 'invalidFilter') {
              return { invalid: describeError(e) };
            }
            throw e;
          }
        });
        if (result === undefined) {
          return;
        }
        if (result.invalid !== null) {
          // 코어는 질의를 바꾸지 않았고 다시 읽지도 않는다: 받아들여진 질의(`graphQuery`)가 그대로다. 더 나중 요청이 있으면
          // 그 요청의 결과가 정한다
          if (seq === querySeq) {
            set({ filterError: result.invalid });
          }
          return;
        }
        set({
          graphQuery: query,
          range: null,
          ...(seq === querySeq ? { filterError: null } : {}),
        });
        syncModuleScope();
      },

      clearFilterError() {
        if (get().filterError !== null) {
          set({ filterError: null });
        }
      },

      loadGraphAuthors(force) {
        // 가벼운 세션은 그래프가 없다 (코어가 `GraphUnavailable`)
        if (get().profile !== 'full') {
          return;
        }
        const authors = get().graphAuthors;
        if (!force && (authors.state === 'ready' || authors.state === 'loading')) {
          return;
        }
        const seq = ++authorsSeq;
        set({ graphAuthors: { ...authors, state: 'loading', error: null } });
        client.graphAuthors(id).then(
          (list) => {
            if (seq === authorsSeq) {
              set({ graphAuthors: { state: 'ready', list, error: null } });
            }
          },
          (e: unknown) => {
            if (seq === authorsSeq) {
              set({
                graphAuthors: { ...get().graphAuthors, state: 'error', error: describeError(e) },
              });
            }
          },
        );
      },

      async setGraphLayoutPrefs(prefs) {
        set({ layoutPrefs: prefs });
        writePref(PREF_GRAPH_LAYOUT, prefs);
        await run(async () => {
          await client.setGraphLayoutPrefs(id, prefs);
          return true;
        });
      },

      setGraphViewPrefs(patch) {
        const next = { ...get().graphView, ...patch };
        set({ graphView: next });
        writePref(PREF_GRAPH_VIEW, next);
      },

      setGraphColumns(columns) {
        set({ graphColumns: columns });
        writePref(PREF_GRAPH_COLUMNS, columns);
      },

      async openBlame(path, rev) {
        set({ blame: { path, rev, lines: [], loading: true, error: null } });
        try {
          const lines = await client.blame(id, path, rev, get().diffOptions.ignoreWhitespace);
          const b = get().blame;
          if (b && b.path === path && b.rev === rev) {
            set({ blame: { ...b, lines, loading: false } });
          }
        } catch (e) {
          const b = get().blame;
          if (b && b.path === path && b.rev === rev) {
            set({ blame: { ...b, loading: false, error: describeError(e) } });
          }
        }
      },

      closeBlame() {
        set({ blame: null });
      },

      async openFileHistory(path) {
        set({ fileHistory: { path, entries: [], loading: true } });
        try {
          const entries = await client.fileHistory(id, path, HISTORY_LIMIT);
          if (get().fileHistory?.path === path) {
            set({ fileHistory: { path, entries, loading: false } });
          }
        } catch (e) {
          set({ fileHistory: null, actionError: describeError(e) });
        }
      },

      closeFileHistory() {
        set({ fileHistory: null });
      },

      async openCompare(a, b, threeDot) {
        set({
          compare: {
            a,
            b,
            threeDot,
            files: [],
            path: null,
            diff: null,
            loading: true,
            diffLoading: false,
          },
        });
        try {
          const files = await client.compareRefs(id, a, b, threeDot);
          const c = get().compare;
          if (c && c.a === a && c.b === b && c.threeDot === threeDot) {
            set({ compare: { ...c, files, loading: false } });
          }
        } catch (e) {
          set({ compare: null, actionError: describeError(e) });
        }
      },

      async compareSelectFile(path) {
        const c = get().compare;
        if (!c) {
          return;
        }
        if (path === null) {
          set({ compare: { ...c, path: null, diff: null } });
          return;
        }
        set({ compare: { ...c, path, diff: null, diffLoading: true } });
        try {
          const { ignoreWhitespace, context } = get().diffOptions;
          const diff = await client.compareFileDiff(
            id,
            c.a,
            c.b,
            c.threeDot,
            path,
            { ignoreWhitespace, context },
            true,
          );
          const now = get().compare;
          if (now && now.path === path) {
            set({ compare: { ...now, diff, diffLoading: false } });
          }
        } catch (e) {
          const now = get().compare;
          if (now) {
            set({ compare: { ...now, diffLoading: false }, actionError: describeError(e) });
          }
        }
      },

      closeCompare() {
        set({ compare: null });
      },

      async selectRange(row) {
        const anchor = get().selectedCommit;
        if (!anchor || anchor === row.oid) {
          get().selectCommit(row.oid);
          return;
        }
        rangeSeq += 1;
        const seq = rangeSeq;
        const anchorRow = await get().resolveRow(anchor);
        // 기다리는 사이 다른 것을 골랐으면 (기준 커밋을 다시 고른 경우 포함) 이 범위는 유효하지 않다
        if (seq !== rangeSeq || get().selectedCommit !== anchor) {
          return;
        }
        if (anchorRow === null) {
          get().selectCommit(row.oid);
          return;
        }
        // 행 번호가 작을수록 최신 (토폴로지 순서)
        const anchorNewer = anchorRow < row.row;
        const from = anchorNewer ? anchorRow : row.row;
        const to = anchorNewer ? row.row : anchorRow;
        const newer = anchorNewer ? anchor : row.oid;
        const older = anchorNewer ? row.oid : anchor;
        set({ range: { from, to, newer, older, base: '', files: [], loading: true } });
        try {
          const r = await client.rangeFiles(id, newer, older);
          const cur = get().range;
          if (cur && cur.newer === newer && cur.older === older) {
            set({ range: { ...cur, base: r.base, files: r.files, loading: false } });
          }
        } catch (e) {
          set({ range: null, actionError: describeError(e) });
        }
      },

      clearRange() {
        set({ range: null });
      },

      async openRangeFile(path) {
        const r = get().range;
        if (!r || r.loading) {
          return;
        }
        const target: FileTarget = {
          path,
          staged: false,
          commit: null,
          range: {
            base: r.base,
            newer: r.newer,
            label: S.diff.rangeLabel(shortHash(r.older), shortHash(r.newer)),
          },
        };
        set({ selectedFile: target, diff: null });
        options.onRevealDoc?.('diff');
        await loadDiff(target, false);
      },

      async openDifftool(target) {
        // 도구가 닫힐 때까지 걸리므로 busy 로 묶지 않는다
        try {
          await client.openDifftool(id, target);
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      async loadSigningInfo() {
        try {
          set({ signingInfo: await client.signingInfo(id) });
        } catch {
          // 설정을 못 읽어도 커밋은 된다
        }
      },

      setCommitSign(sign) {
        set({ commitSign: sign });
      },

      dismissSecrets() {
        set({ secretHits: null });
      },

      async addSecretIgnore(ignore) {
        try {
          const list = await client.secretIgnores();
          await client.secretIgnoresSet([...list, ignore]);
          const hits = await client.scanStagedSecrets(id);
          set({ secretHits: hits.length > 0 ? hits : null });
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      async checkPerf() {
        try {
          const p = await client.perfStatus(id);
          set({ perfSuggestion: p.suggested ? p : null });
        } catch {
          // 제안일 뿐
        }
      },

      async enablePerf() {
        await run(() => client.enablePerf(id));
        set({ perfSuggestion: null });
        if (get().repoSettings) {
          await get().openRepoSettings();
        }
      },

      dismissPerf() {
        set({ perfSuggestion: null });
      },

      async openRepoSettings() {
        void get().loadCommands();
        void get().loadLfs();
        try {
          set({ repoSettings: await client.repoSettings(id) });
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      closeRepoSettings() {
        set({ repoSettings: null });
      },

      async saveUser(name, email) {
        const ok = await run(async () => {
          await client.setUser(id, name, email);
          return true;
        });
        if (ok) {
          await get().openRepoSettings();
        }
      },

      async saveGitignore(text) {
        const ok = await run(async () => {
          await client.writeGitignore(id, text);
          return true;
        });
        if (ok) {
          await get().openRepoSettings();
        }
      },

      async applyProfile(profileId) {
        const ok = await run(async () => {
          await client.applyProfile(id, profileId);
          return true;
        });
        if (ok && get().repoSettings) {
          await get().openRepoSettings();
        }
      },

      async loadRemoteProject() {
        try {
          set({ remoteProject: await client.hostingRemoteProject(id) });
        } catch {
          set({ remoteProject: null });
        }
      },

      async loadPullRequests() {
        set({ prsLoading: true, prsError: null });
        try {
          set({ pullRequests: await client.pullRequests(id), prsLoading: false });
        } catch (e) {
          set({ prsLoading: false, prsError: describeError(e) });
        }
      },

      async ensurePullRequests() {
        const project = get().remoteProject;
        const key = project?.accountId ? `${project.accountId}/${project.project}` : null;
        if (key === null || key === prsLoadedFor) {
          return;
        }
        prsLoadedFor = key;
        await get().loadPullRequests();
      },

      async createPullRequest(spec) {
        try {
          const pr = await client.createPullRequest(id, spec);
          notifyHub.notify({ kind: 'success', title: S.pr.created(pr.number ?? 0) });
          return pr;
        } catch (e) {
          set({ actionError: describeError(e) });
          return null;
        }
      },

      async checkoutPullRequest(number, worktree) {
        const branch = await run(() => client.checkoutPullRequest(id, number, worktree));
        if (branch) {
          notifyHub.notify({ kind: 'success', title: S.pr.checkedOut(branch) });
        }
        return branch ?? null;
      },

      async prTemplates() {
        try {
          return await client.prTemplates(id);
        } catch {
          return [];
        }
      },

      requestAvatars(emails) {
        const known = get().avatars;
        const unseen = [...new Set(emails)].filter(
          (e): e is string => !!e && !(e in known) && !avatarPending.has(e),
        );
        for (const email of unseen.slice(0, 50)) {
          avatarPending.add(email);
          void client
            .avatar(email)
            .then((uri) => set({ avatars: { ...get().avatars, [email]: uri } }))
            .catch(() => set({ avatars: { ...get().avatars, [email]: null } }))
            .finally(() => avatarPending.delete(email));
        }
      },

      async unshallow() {
        const still = await run(() => client.unshallow(id));
        if (still !== undefined) {
          set({ shallow: still });
          if (get().repoSettings) {
            await get().openRepoSettings();
          }
        }
      },

      checkout(target, stashFirst = false) {
        return run(
          () => client.checkout(id, target, stashFirst),
          (hint) => {
            if (hint.kind === 'dirtyWorkTree') {
              return { kind: 'dirtyWorkTree', files: hint.files, target };
            }
            if (hint.kind === 'branchCheckedOutElsewhere') {
              const name = target.kind === 'branch' ? target.name : '';
              return { kind: 'branchElsewhere', path: hint.path, name };
            }
            return null;
          },
        ).then(() => {});
      },

      createBranch(name, start, checkout) {
        return run(() => client.createBranch(id, name, start, checkout)).then(() => {});
      },

      renameBranch(oldName, newName) {
        return run(() => client.renameBranch(id, oldName, newName)).then(() => {});
      },

      deleteBranch(name, force) {
        return run(
          () => client.deleteBranch(id, name, force),
          (hint) => (hint.kind === 'notFullyMerged' ? { kind: 'notFullyMerged', name } : null),
        ).then(() => {});
      },

      deleteRemoteBranch(remote, name) {
        return run(() => client.deleteRemoteBranch(id, remote, name)).then(() => {});
      },

      setUpstream(branch, upstream) {
        return run(() => client.setUpstream(id, branch, upstream)).then(() => {});
      },

      updateBranch(name) {
        return run(() => client.updateBranch(id, name)).then((r) => {
          if (r !== undefined) {
            notifyHub.notify(branchUpdateNotice(name, r));
          }
        });
      },

      createTag(name, target, message, sign = false) {
        return run(() => client.createTag(id, name, target, message, sign)).then(() => {});
      },

      async pushTags(remote, names) {
        const results = await run(
          () => quietly(() => client.pushTags(id, remote, names)),
          // 명령 전체가 이름 충돌로 거부된 경우의 대비책 (보통은 tag 별 결과로 온다)
          (hint) => (hint.kind === 'remoteTagExists' ? { kind: 'tagExists', remote, names } : null),
        );
        if (results === undefined) {
          return undefined;
        }
        const exists = results.filter((r) => r.status === 'rejectedExists').map((r) => r.name);
        const others = results.filter(
          (r) => !isTagSuccess(r.status) && r.status !== 'rejectedExists',
        );
        if (exists.length > 0) {
          const hint = { kind: 'tagExists' as const, remote, names: exists };
          set({ pendingHint: hint });
          void fillTagExists(hint);
        }
        if (others.length > 0) {
          set({ actionError: S.tag.pushFailed(remote, tagFailureList(others)) });
        }
        const [only] = results;
        if (exists.length === 0 && others.length === 0 && only) {
          notifyHub.notify(
            results.length > 1
              ? { kind: 'success', title: S.tag.pushedMany(results.length, remote) }
              : only.status === 'upToDate'
                ? { kind: 'info', title: S.tag.upToDate(only.name, remote) }
                : { kind: 'success', title: S.tag.pushed(only.name, remote) },
          );
        }
        // 코어가 push 결과로 캐시를 고쳤다 — 네트워크 없이 표시를 바꾼다 (TG-09 ⑤)
        void get().reloadRemoteTags();
        return results;
      },

      async deleteTagsScoped(names, scope, opts) {
        if (names.length === 0 || (!scope.local && scope.remotes.length === 0)) {
          return undefined;
        }
        const localLabel = (name: string) =>
          get().refs.labels.find((l) => l.fullName === `refs/tags/${name}`);
        const summary = await run(() =>
          runTagDelete(names, scope, {
            deleteRemote: (remote, items) =>
              quietly(() => client.deleteRemoteTags(id, remote, items)),
            deleteLocal: (list) => client.deleteLocalTags(id, list),
            localCommit: (name) => localLabel(name)?.target ?? null,
            onDiverged: opts?.onDiverged,
            isLocal: (name) => localLabel(name) !== undefined,
            describe: describeError,
          }),
        );
        if (summary === undefined) {
          return undefined;
        }
        if (opts?.silent) {
          // 문서 안 작업: 결과 칸이 보인다 (TG-12 ③)
          void get().reloadRemoteTags();
          return summary;
        }
        if (tagDeleteComplete(summary)) {
          const places = tagDeletePlaces(scope);
          const [only] = summary.names;
          notifyHub.notify({
            kind: 'success',
            title:
              summary.names.length === 1 && only
                ? S.tag.del.done(only, places)
                : S.tag.del.doneMany(summary.names.length, places),
          });
        } else if (!summary.cancelled || tagDeleteChangedAnything(summary)) {
          set({ actionError: tagDeleteProblems(summary) });
        }
        void get().reloadRemoteTags();
        return summary;
      },

      async checkRemoteTags(remotes) {
        const known = get().refs.remotes.map((r) => r.name);
        const list = (remotes ?? known).filter(
          (r) => known.includes(r) && !get().tagChecking.includes(r),
        );
        if (list.length === 0) {
          return;
        }
        set({ tagChecking: [...get().tagChecking, ...list] });
        await Promise.all(
          list.map(async (remote) => {
            try {
              const report = await client.remoteTags(id, remote, true);
              // 끝난 시점의 차례: 그 전에 시작한 다시 받기(옛 캐시)가 늦게 와도 덮지 않는다
              tagApplied[remote] = ++tagSeq;
              applyTagReport(remote, report);
            } catch (e) {
              // 조회 실패는 거부가 아니라 보고서의 lastError 로 온다. 거부는 취소(조용히)와 원격 문제(오류 줄)뿐이다
              if (toIpcError(e).kind !== 'cancelled') {
                set({ actionError: describeError(e) });
              }
            } finally {
              set({ tagChecking: get().tagChecking.filter((r) => r !== remote) });
            }
          }),
        );
      },

      async loadTagList() {
        const seq = ++tagListSeq;
        try {
          const list = await client.tagList(id);
          if (seq === tagListSeq) {
            set({ tagList: list });
          }
        } catch {
          // 목록은 보조 정보다 (종류·날짜·제목 열) — 실패하면 이전 값을 둔다
        }
      },

      async fetchTags(remote, names, overwrite) {
        const { results, error } = await runTagCommand(() =>
          client.fetchTags(id, remote, names, overwrite),
        );
        void get().reloadRemoteTags();
        if (results === null) {
          // 원격에 없는 이름이 섞이면 git 이 전체를 멈춘다 (아무것도 받지 않음) — 다시 확인 후 다시 시도 (TG-11 ④)
          set({
            actionError: isMissingRemoteRef(error)
              ? S.tag.fetchRecheck(remote)
              : describeError(error),
          });
          return undefined;
        }
        const failed = results.filter((r) => !isTagSuccess(r.status));
        if (failed.length > 0) {
          set({ actionError: S.tag.fetchFailed(remote, tagFailureList(failed)) });
        } else {
          const [only] = results;
          notifyHub.notify({
            kind: 'success',
            title:
              results.length === 1 && only
                ? S.tag.fetched(only.name, remote, overwrite)
                : S.tag.fetchedMany(results.length, remote),
          });
        }
        return results;
      },

      async replaceRemoteTags(remote, items) {
        const { results, error } = await runTagCommand(() =>
          client.replaceRemoteTags(id, remote, items),
        );
        void get().reloadRemoteTags();
        if (results === null) {
          set({ actionError: describeError(error) });
          return undefined;
        }
        const failed = results.filter((r) => !isTagSuccess(r.status));
        if (failed.length > 0) {
          set({ actionError: S.tag.replaceFailed(remote, tagFailureList(failed)) });
        } else {
          const [only] = results;
          notifyHub.notify({
            kind: 'success',
            title:
              results.length === 1 && only
                ? S.tag.replaced(only.name, remote)
                : S.tag.replacedMany(results.length, remote),
          });
        }
        return results;
      },

      async runTagBatch(op) {
        const call = (): Promise<TagRefResult[]> => {
          switch (op.kind) {
            case 'push':
              return client.pushTags(id, op.remote, op.names);
            case 'fetch':
              return client.fetchTags(id, op.remote, op.names, op.overwrite);
            case 'replace':
              return client.replaceRemoteTags(id, op.remote, op.items);
          }
        };
        const { results, error } = await runTagCommand(call);
        void get().reloadRemoteTags();
        if (results !== null) {
          return { results, error: null };
        }
        return {
          results: [],
          error:
            op.kind === 'fetch' && isMissingRemoteRef(error)
              ? S.tag.fetchRecheck(op.remote)
              : describeError(error),
        };
      },

      async reloadRemoteTags(opts) {
        const known = get().refs.remotes.map((r) => r.name);
        // 사라진 원격의 보고서는 버린다
        for (const remote of Object.keys(get().tagReports)) {
          if (!known.includes(remote)) {
            applyTagReport(remote, null);
          }
        }
        const list = opts?.all ? known : Object.keys(get().tagReports);
        await Promise.all(
          list.map(async (remote) => {
            const seq = ++tagSeq;
            try {
              const report = await client.remoteTags(id, remote, false);
              if (seq > (tagApplied[remote] ?? 0)) {
                tagApplied[remote] = seq;
                applyTagReport(remote, report);
              }
            } catch {
              // 다시 받기는 네트워크가 없다 — 실패는 원격이 사라진 경우뿐이고 다음 ref 변경이 정리한다
            }
          }),
        );
      },

      merge(reference, mode) {
        return outcome(() => client.merge(id, reference, mode));
      },

      rebase(onto, autostash) {
        return outcome(() => client.rebase(id, onto, autostash));
      },

      cherryPick(oids) {
        return outcome(() => client.cherryPick(id, oids));
      },

      revert(oids) {
        return outcome(() => client.revert(id, oids));
      },

      reset(target, mode) {
        return run(() => client.reset(id, target, mode)).then(() => {});
      },

      opContinue(allowConflictMarkers = false) {
        return runOwnOp('continue', () =>
          outcome(
            () => client.opContinue(id, allowConflictMarkers),
            (err) =>
              err.kind === 'conflictMarkers'
                ? { kind: 'conflictMarkers', files: err.files, retry: { kind: 'opContinue' } }
                : null,
          ),
        );
      },

      opSkip() {
        return runOwnOp('skip', () => outcome(() => client.opSkip(id)));
      },

      opAbort() {
        return runOwnOp('abort', () => run(() => client.opAbort(id)));
      },

      async commitGraphWrite() {
        const r = await run(() => client.commitGraphWrite(id));
        if (r !== undefined) {
          set({ commitGraphSuggested: false });
        }
      },

      dismissCommitGraph() {
        set({ commitGraphSuggested: false });
      },

      dismissHint() {
        set({ pendingHint: null });
      },

      setPullMode(mode) {
        set({ pullMode: mode });
      },

      fetch(remote, prune) {
        return run(() => client.fetch(id, remote, prune)).then(() => {});
      },

      pull() {
        return run(async () => {
          await client.pull(id, get().pullMode);
          return true;
        }).then((ok) => ok === true);
      },

      async push(spec, opts) {
        const full: PushSpec = {
          remote: null,
          setUpstream: false,
          tags: false,
          forceWithLease: false,
          confirmUpstreamMismatch: false,
          rememberUpstreamMismatch: false,
          ...spec,
        };
        if (!opts?.skipSubmoduleCheck && get().submodules.length > 0) {
          const items = await client.submoduleUnpushed(id).catch(() => []);
          if (items.length > 0) {
            set({ pendingHint: { kind: 'submoduleUnpushed', items, spec: full } });
            return false;
          }
        }
        const ok = await run(
          async () => {
            await client.push(id, full);
            return true;
          },
          (hint) => {
            switch (hint.kind) {
              case 'nonFastForward':
              case 'staleInfo':
              case 'noUpstream':
                return { kind: hint.kind, spec: full };
              // 서버 거부(`remoteRejected`, hook 등)는 강제 push 로 풀리지 않는다 — 대화상자 없이 오류 줄에 서버 사유를
              // 보인다 (`describeError`, TG-07)
              default:
                return null;
            }
          },
          (err) =>
            err.kind === 'pushUpstreamMismatch'
              ? {
                  kind: 'pushUpstreamMismatch',
                  local: err.local,
                  remote: err.remote,
                  upstream: err.upstream,
                  spec: full,
                }
              : null,
        );
        return ok === true;
      },

      remoteAdd(name, url) {
        return run(() => client.remoteAdd(id, name, url)).then(() => {});
      },

      remoteRename(oldName, newName) {
        return run(() => client.remoteRename(id, oldName, newName)).then(() => {});
      },

      remoteRemove(name) {
        return run(() => client.remoteRemove(id, name)).then(() => {});
      },

      remoteSetUrl(name, url) {
        return run(() => client.remoteSetUrl(id, name, url)).then(() => {});
      },

      async loadStashes() {
        try {
          const stashes = await client.listStashes(id);
          set({ stashes });
          const view = get().stashView;
          if (view) {
            // 보고 있는 stash 의 번호도 함께 갱신한다 (번호는 위치라서 목록이 바뀌면 달라진다)
            const fresh = stashes.find((s) => s.info.oid === view.entry.info.oid);
            set({ stashView: fresh ? { ...view, entry: fresh } : null });
          }
        } catch {
          // 목록을 못 읽어도 refs.stashes 로 표시는 된다
        }
      },

      stashPush(message, includeUntracked, stagedOnly, paths) {
        return run(() => client.stashPush(id, message, includeUntracked, stagedOnly, paths)).then(
          () => {},
        );
      },

      stashApply(oid) {
        return run(async () => {
          await client.stashApply(id, await stashIndexOf(oid));
          return true;
        }).then((ok) => ok === true);
      },

      stashPop(oid) {
        return run(async () => {
          await client.stashPop(id, await stashIndexOf(oid));
          return true;
        }).then((ok) => ok === true);
      },

      stashDrop(oid) {
        return run(async () => {
          await client.stashDrop(id, await stashIndexOf(oid));
          return true;
        }).then((ok) => ok === true);
      },

      async selectStash(entry) {
        // 로그의 선택(커밋·WIP·범위)과 상세는 건드리지 않는다 (W23 — 스태시 상세는 Commit 도구 창 Stash 탭에 있다)
        set({ stashView: { entry, files: [] } });
        try {
          const files = await client.stashFiles(id, entry.info.oid);
          if (get().stashView?.entry.info.oid === entry.info.oid) {
            set({ stashView: { entry, files } });
          }
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      async suggestWorktreePath(branch) {
        try {
          return await client.suggestWorktreePath(id, branch);
        } catch {
          return null;
        }
      },

      async worktreeAdd(path, source) {
        const created = await run(() => client.worktreeAdd(id, path, source));
        if (created) {
          // 초기화 명령 (WT-07)
          const r = await client.runWorktreeInit(id, created).catch(() => null);
          if (r) {
            notifyHub.notify({
              kind: r.ok ? 'success' : 'error',
              title: S.verify.initTitle,
              message: r.ok ? S.verify.initOk : `${S.verify.initFailed}: ${r.output.slice(-300)}`,
              os: true,
            });
          }
        }
        return created ?? null;
      },

      async worktreeRemoveCheck(path) {
        const r = await run(() => client.worktreeRemoveCheck(id, path));
        return r ?? null;
      },

      worktreeRemove(path, force, deleteBranch) {
        return run(() => client.worktreeRemove(id, path, force, deleteBranch)).then(() => {});
      },

      worktreePrune() {
        return run(() => client.worktreePrune(id)).then(() => {});
      },

      async loadSubmodules() {
        try {
          const submodules = await client.submodules(id);
          set({ submodules });
        } catch {
          // 서브모듈 없는 저장소면 빈 목록
        }
      },

      async loadSubmoduleLog(path, old, newOid) {
        try {
          const log = await client.submodulePointerLog(id, path, old, newOid);
          set({ submoduleLog: { path, old, new: newOid, log } });
        } catch {
          set({ submoduleLog: null });
        }
      },

      async submoduleAdd(url, path, branch) {
        await run(() => client.submoduleAdd(id, url, path, branch));
        await get().loadSubmodules();
      },

      async submoduleAdopt(path) {
        await run(() => client.submoduleAdopt(id, path));
        await get().loadSubmodules();
      },

      async submoduleRemove(path) {
        await run(() => client.submoduleRemove(id, path));
        await get().loadSubmodules();
      },

      async submoduleSetBranch(path, branch) {
        await run(() => client.submoduleSetBranch(id, path, branch));
      },

      async submoduleUpdateRemote(path, mode) {
        await run(() => client.submoduleUpdateRemote(id, path, mode));
        await get().loadSubmodules();
      },

      async submoduleSync() {
        await run(() => client.submoduleSync(id));
      },

      async submoduleBatch(op, paths) {
        const r = await run(() => client.submoduleBatch(id, op, paths));
        if (r) {
          notifyHub.notify({
            kind: r.failed > 0 ? 'error' : 'success',
            title: `${r.label}: ${S.folder.batch.result(r.succeeded, r.skipped, r.failed)}`,
          });
        }
        await get().loadSubmodules();
        return r ?? null;
      },

      async loadModules() {
        try {
          const [modules, scope] = await Promise.all([client.modules(id), client.moduleScope(id)]);
          // 기억한 범위가 있고 그래프가 아직 전체면 적용한다 (MOD-05). 그래프가 이미 다른 질의면 적용하지 않으므로, 그때는
          // 경로 범위가 바로 그 모듈일 때만 범위로 보인다 (W26 — 띠가 그래프와 다른 말을 하지 않게. 코어에 기억한 범위는
          // 지우지 않는다: 사용자가 푼 것이 아니다)
          const graphQuery = get().graphQuery;
          const apply = scope !== null && isDefaultGraphQuery(graphQuery);
          const matches =
            scope !== null &&
            graphQuery.pathScope.length === 1 &&
            graphQuery.pathScope[0] === scope;
          set({ modules, moduleScope: apply || matches ? scope : null });
          if (apply) {
            moduleScopeChanging += 1;
            try {
              await get().setGraphQuery({ ...get().graphQuery, pathScope: [scope] });
            } finally {
              moduleScopeChanging -= 1;
            }
          }
        } catch {
          // 모듈 정보가 없어도 된다
        }
      },

      async selectModule(path) {
        // 두 출처(모듈 범위·경로 범위)를 함께 바꾸는 흐름: 그사이 받아들여진 다른 질의로 방금 고른 모듈을 풀지 않는다 (W26)
        moduleScopeChanging += 1;
        try {
          set({ moduleScope: path });
          await client.moduleScopeSet(id, path).catch(() => {});
          await get().setGraphQuery({ ...get().graphQuery, pathScope: path ? [path] : [] });
        } finally {
          moduleScopeChanging -= 1;
        }
      },

      async addManualModule(name, path) {
        try {
          const o = await client.moduleOverrides(id);
          await client.moduleOverridesSet(id, {
            added: [...o.added, { name, path, kind: 'manual' }],
            hidden: o.hidden.filter((h) => h !== path),
          });
          await get().loadModules();
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      async openMergePreview(reference) {
        set({
          preview: {
            reference,
            includeWip: false,
            loading: true,
            result: null,
            simulate: null,
            simulating: false,
            file: null,
            error: null,
          },
        });
        await loadPreview();
      },

      closeMergePreview() {
        set({ preview: null });
      },

      async previewSetWip(includeWip) {
        const p = get().preview;
        if (!p) {
          return;
        }
        set({ preview: { ...p, includeWip, loading: true, simulate: null } });
        await loadPreview();
      },

      async previewSimulate() {
        const p = get().preview;
        if (!p) {
          return;
        }
        set({ preview: { ...p, simulating: true } });
        try {
          const simulate = await client.mergeSimulate(id, p.reference, p.includeWip);
          const now = get().preview;
          if (now) {
            set({ preview: { ...now, simulate, simulating: false } });
          }
        } catch (e) {
          const now = get().preview;
          if (now) {
            set({ preview: { ...now, simulating: false, error: describeError(e) } });
          }
        }
      },

      async previewOpenFile(path) {
        const p = get().preview;
        if (!p?.result) {
          return;
        }
        try {
          const content = await client.previewFile(id, p.result.tree, path);
          const now = get().preview;
          if (now) {
            set({ preview: { ...now, file: { path, content } } });
          }
        } catch (e) {
          const now = get().preview;
          if (now) {
            set({ preview: { ...now, error: describeError(e) } });
          }
        }
      },

      async previewRun(strategy, mode) {
        const p = get().preview;
        if (!p) {
          return;
        }
        set({ preview: null });
        await outcome(() => client.mergeWithOptions(id, p.reference, mode, strategy));
      },

      async openRebasePreview(onto) {
        set({ rebasePreview: { onto, loading: true, steps: [], error: null } });
        try {
          const steps = await client.rebasePreview(id, onto);
          const now = get().rebasePreview;
          if (now && now.onto === onto) {
            set({ rebasePreview: { ...now, loading: false, steps } });
          }
        } catch (e) {
          const now = get().rebasePreview;
          if (now) {
            set({ rebasePreview: { ...now, loading: false, error: describeError(e) } });
          }
        }
      },

      closeRebasePreview() {
        set({ rebasePreview: null });
      },

      async loadRadar() {
        try {
          const radar = await client.conflictRadar(id, 12, false);
          set({ radar });
        } catch {
          // 레이더는 없어도 된다
        }
      },

      async isolatedMerge(reference, mode) {
        const r = await run(() => client.isolatedMerge(id, reference, mode));
        if (!r) {
          return null;
        }
        notifyHub.notify({
          kind: r.outcome === 'clean' ? 'success' : 'info',
          title: S.preview.isolatedTitle,
          message: r.outcome === 'clean' ? S.preview.isolatedClean : S.preview.isolatedConflicts,
        });
        return r.worktree;
      },

      async loadIsolated() {
        const isolatedBranch = await client.isolatedInfo(id).catch(() => null);
        set({ isolatedBranch });
      },

      async isolatedApply() {
        const main = await run(() => client.isolatedApply(id));
        if (main) {
          notifyHub.notify({
            kind: 'success',
            title: S.preview.isolatedTitle,
            message: S.preview.isolatedApplied,
          });
        }
        return main ?? null;
      },

      async isolatedDiscard() {
        const main = await run(() => client.isolatedDiscard(id));
        if (main) {
          notifyHub.notify({
            kind: 'info',
            title: S.preview.isolatedTitle,
            message: S.preview.isolatedDiscarded,
          });
        }
        return main ?? null;
      },

      async loadConflictOrigins(path) {
        set({ origins: { path, loading: true, data: null } });
        try {
          const data = await client.conflictOrigins(id, path);
          const now = get().origins;
          if (now?.path === path) {
            set({ origins: { path, loading: false, data } });
          }
        } catch (e) {
          set({ origins: null, actionError: describeError(e) });
        }
      },

      async loadMergeTool() {
        set({ mergeTool: await client.mergeToolName(id).catch(() => null) });
      },

      async openMergetool(path) {
        await run(() => client.openMergetool(id, path));
      },

      async loadRerere() {
        try {
          set({ rerere: await client.rerereStatus(id) });
        } catch {
          // 없어도 된다
        }
      },

      async rerereSet(enabled, autoupdate) {
        await run(() => client.rerereSet(id, enabled, autoupdate));
        await get().loadRerere();
      },

      async rerereForget(path) {
        await run(() => client.rerereForget(id, path));
        await get().loadRerere();
      },

      async loadKept() {
        try {
          const kept = await client.keptResolutions(id);
          set({ kept });
          const current = kept.filter((k) => k.matchesCurrent);
          const key = current[0]?.opKey ?? null;
          const st = get();
          if (
            key &&
            st.status.summary.conflicted > 0 &&
            st.reapplyOfferedFor !== key &&
            st.pendingHint === null
          ) {
            set({
              reapplyOfferedFor: key,
              pendingHint: { kind: 'reapplyResolutions', count: current.length },
            });
          }
        } catch {
          // 없어도 된다
        }
      },

      async reapplyKept() {
        const n = await run(() => client.reapplyResolutions(id));
        if (n !== undefined) {
          notifyHub.notify({
            kind: 'success',
            title: S.assist.reviewTitle,
            message: S.assist.reapplied(n),
          });
        }
      },

      async keptClear() {
        await run(() => client.keptClear(id));
        set({ kept: [] });
      },

      async loadRenameConflicts() {
        try {
          set({ renameConflicts: await client.renameConflicts(id) });
        } catch {
          // 없어도 된다
        }
      },

      async resolveRename(rc, keep) {
        const kept = await run(() => client.resolveRename(id, rc, keep));
        if (kept) {
          await get().loadRenameConflicts();
          if (get().renameConflicts.length === 0) {
            set({ assistDialog: null });
          }
          await get().openConflict(kept);
        }
      },

      async loadRules() {
        try {
          set({ rules: await client.conflictRules(id) });
        } catch {
          // 없어도 된다
        }
      },

      async saveRules(rules) {
        const r = await run(() => client.conflictRulesSet(id, rules).then(() => true));
        if (r) {
          set({ rules });
        }
      },

      async applyRules() {
        const results = await run(() => client.conflictRulesApply(id));
        if (!results) {
          return;
        }
        set({ ruleResults: results });
        const ok = results.filter((x) => x.ok).length;
        notifyHub.notify({
          kind: ok === results.length ? 'success' : 'info',
          title: S.assist.rulesTitle,
          message:
            results.length === 0 ? S.assist.rulesNone : S.assist.rulesApplied(ok, results.length),
        });
      },

      async openReview(path) {
        set({
          review: {
            title: S.assist.reviewTitle,
            subtitle: S.assist.reviewSubtitle(path),
            text: '',
            note: null,
            emptyText: S.assist.reviewSame,
            loading: true,
            error: null,
          },
        });
        try {
          const r = await client.resolutionReview(id, path);
          const now = get().review;
          if (now) {
            set({
              review: {
                ...now,
                text: r.diff,
                note: r.autoHadConflicts ? S.assist.reviewAutoConflicts : null,
                loading: false,
              },
            });
          }
        } catch (e) {
          const now = get().review;
          if (now) {
            set({ review: { ...now, loading: false, error: describeError(e) } });
          }
        }
      },

      async openRemergeDiff(oid) {
        set({
          review: {
            title: S.assist.remergeTitle,
            subtitle: oid.slice(0, 10),
            text: '',
            note: null,
            emptyText: S.assist.remergeEmpty,
            loading: true,
            error: null,
          },
        });
        try {
          const text = await client.remergeDiff(id, oid);
          const now = get().review;
          if (now) {
            set({ review: { ...now, text, loading: false } });
          }
        } catch (e) {
          const now = get().review;
          if (now) {
            set({ review: { ...now, loading: false, error: describeError(e) } });
          }
        }
      },

      closeReview() {
        set({ review: null });
      },

      openAssistDialog(kind) {
        set({ assistDialog: kind, ruleResults: null });
        if (kind === 'rules') {
          void get().loadRules();
        }
      },

      closeAssistDialog() {
        set({ assistDialog: null });
      },

      async loadCommands() {
        const [verifyCommand, worktreeInitCommand] = await Promise.all([
          client.verifyCommand(id).catch(() => null),
          client.worktreeInitCommand(id).catch(() => null),
        ]);
        set({ verifyCommand, worktreeInitCommand });
      },

      async saveVerifyCommand(cmd) {
        const v = cmd?.trim() ? cmd.trim() : null;
        const r = await run(() => client.verifyCommandSet(id, v).then(() => true));
        if (r) {
          set({ verifyCommand: v });
        }
      },

      async saveWorktreeInitCommand(cmd) {
        const v = cmd?.trim() ? cmd.trim() : null;
        const r = await run(() => client.worktreeInitCommandSet(id, v).then(() => true));
        if (r) {
          set({ worktreeInitCommand: v });
        }
      },

      async runVerify() {
        const cmd = get().verifyCommand ?? '';
        set({
          review: {
            title: S.verify.title,
            subtitle: cmd,
            text: '',
            note: null,
            emptyText: '',
            loading: true,
            error: null,
          },
        });
        try {
          const r = await client.runVerify(id);
          const now = get().review;
          if (now) {
            set({
              review: {
                ...now,
                text: r.output,
                note: r.timedOut
                  ? S.verify.timedOut
                  : r.ok
                    ? S.verify.ok(r.elapsedMs ?? 0)
                    : S.verify.failed(r.status ?? null),
                loading: false,
              },
            });
          }
          notifyHub.notify({
            kind: r.ok ? 'success' : 'error',
            title: S.verify.title,
            message: r.timedOut
              ? S.verify.timedOut
              : r.ok
                ? S.verify.ok(r.elapsedMs ?? 0)
                : S.verify.failed(r.status ?? null),
            os: true,
          });
        } catch (e) {
          const now = get().review;
          if (now) {
            set({ review: { ...now, loading: false, error: describeError(e) } });
          }
        }
      },

      async loadLfs() {
        try {
          set({ lfs: await client.lfsStatus(id) });
        } catch {
          // git-lfs 가 없으면 없는 대로
        }
      },

      async lfsInstall() {
        await run(() => client.lfsInstall(id));
        await get().loadLfs();
      },

      async lfsTrack(pattern) {
        await run(() => client.lfsTrack(id, pattern));
        await get().loadLfs();
      },

      async lfsUntrack(pattern) {
        await run(() => client.lfsUntrack(id, pattern));
        await get().loadLfs();
      },

      async lfsLock(path) {
        await run(() => client.lfsLock(id, path));
        await get().loadLfs();
      },

      async lfsUnlock(path, force) {
        await run(() => client.lfsUnlock(id, path, force));
        await get().loadLfs();
      },

      async hideModule(path) {
        try {
          const o = await client.moduleOverrides(id);
          await client.moduleOverridesSet(id, {
            added: o.added.filter((m) => m.path !== path),
            hidden: [...new Set([...o.hidden, path])],
          });
          if (get().moduleScope === path) {
            await get().selectModule(null);
          }
          await get().loadModules();
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      async pushSubmodulesThenPush(spec) {
        const r = await get().submoduleBatch({ kind: 'push' }, []);
        if (r && r.failed === 0) {
          await get().push(spec, { skipSubmoduleCheck: true });
        }
      },

      async submoduleUpdate(recursive) {
        await run(() => client.submoduleUpdate(id, recursive));
        await get().loadSubmodules();
      },

      async openConflict(path) {
        set({ conflictLoading: true, selectedFile: null, diff: null, actionError: null });
        options.onRevealDoc?.('conflict');
        try {
          const payload = await client.conflictFile(id, path);
          set({
            conflict: { path, payload },
            conflictLoading: false,
            conflictLabels: payload.labels,
          });
        } catch (e) {
          set({ conflict: null, conflictLoading: false, actionError: describeError(e) });
        }
      },

      closeConflict() {
        set({ conflict: null });
      },

      async saveConflict(content, opts) {
        const open = get().conflict;
        if (!open) {
          return false;
        }
        const force = opts?.force ?? false;
        const allowConflictMarkers = opts?.allowConflictMarkers ?? false;
        if (!force) {
          const compare = await client.syntaxCompare(id, open.path, content).catch(() => null);
          if (compare?.newErrors) {
            set({
              pendingHint: {
                kind: 'syntaxErrors',
                path: open.path,
                content,
                compare,
                allowConflictMarkers,
              },
            });
            return false;
          }
        }
        savingConflict = open.path;
        try {
          const r = await run(
            () => client.resolveFile(id, open.path, content, allowConflictMarkers).then(() => true),
            undefined,
            (err) =>
              err.kind === 'conflictMarkers'
                ? {
                    kind: 'conflictMarkers',
                    files: err.files,
                    retry: { kind: 'saveConflict', content, force },
                  }
                : null,
          );
          if (r === true) {
            get().setConflictDraft(open.path, null);
          }
          return r === true;
        } finally {
          savingConflict = null;
        }
      },

      setConflictDraft(path, draft) {
        const drafts = get().conflictDrafts;
        if (draft) {
          set({ conflictDrafts: { ...drafts, [path]: draft } });
        } else if (path in drafts) {
          const rest = { ...drafts };
          delete rest[path];
          set({ conflictDrafts: rest });
        }
      },

      pickSide(path, side) {
        return run(() => client.resolveSide(id, path, side)).then(() => {});
      },

      resolveDelete(path, keep) {
        return run(() => client.resolveDelete(id, path, keep)).then(() => {});
      },

      unresolve(path, mode) {
        return run(() => client.unresolve(id, path, mode)).then(() => {});
      },

      async loadUndo() {
        try {
          set({ undoState: await client.undoState(id) });
        } catch {
          // 없어도 된다
        }
      },

      async undo() {
        const r = await run(() => client.undo(id));
        if (r) {
          set({ lastOutcome: null });
          noteSkipped(r.skipped);
        }
        await get().loadUndo();
      },

      async redo() {
        const r = await run(() => client.redo(id));
        if (r) {
          noteSkipped(r.skipped);
        }
        await get().loadUndo();
      },

      async loadBackups() {
        try {
          set({ backups: await client.backups(id) });
        } catch {
          // 없어도 된다
        }
      },

      async openFileBackups() {
        try {
          set({ fileBackups: await client.listBackups(id, FILE_BACKUP_LIMIT) });
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      closeFileBackups() {
        set({ fileBackups: null });
      },

      async restoreFileBackup(backupId) {
        const r = await run(async () => {
          await client.restoreBackup(id, backupId);
          return true;
        });
        if (r !== true) {
          return false;
        }
        const path = get().fileBackups?.find((b) => b.id === backupId)?.relPath ?? '';
        notifyHub.notify({ kind: 'success', title: S.safety.fileBackupRestored(path) });
        return true;
      },

      async backupRestore(backup, newBranch) {
        await run(() => client.backupRestore(id, backup, newBranch));
      },

      async backupDelete(backup) {
        await run(() => client.backupDelete(id, backup));
        await get().loadBackups();
      },

      setReflogOpen(open) {
        set({ reflogOpen: open });
        if (open) {
          void get().loadReflog(get().reflogRef);
        }
      },

      async loadReflog(reference) {
        set({ reflogRef: reference });
        try {
          set({
            reflog: await client.reflog(id, reference.trim() === '' ? null : reference.trim(), 500),
          });
        } catch (e) {
          set({ reflog: [], actionError: describeError(e) });
        }
      },

      async reflogRestore(oid, newBranch) {
        await run(() => client.reflogRestore(id, oid, newBranch));
      },

      worktreeLock(path, reason) {
        return run(() => client.worktreeLock(id, path, reason)).then(() => {});
      },

      worktreeUnlock(path) {
        return run(() => client.worktreeUnlock(id, path)).then(() => {});
      },

      ignoreAdd(patterns) {
        return run(() => client.ignoreAdd(id, patterns)).then(() => {});
      },

      async loadCommitTemplates() {
        try {
          set({ commitTemplates: await client.commitTemplates(id) });
        } catch {
          // 없어도 된다
        }
      },

      async removeIndexLock() {
        await run(() => client.removeIndexLock(id));
      },

      async loadWorktreeWips() {
        if (get().refs.worktrees.length < 2) {
          if (get().worktreeWips.length > 0) {
            set({ worktreeWips: [] });
          }
          return;
        }
        try {
          set({ worktreeWips: await client.worktreeWips(id) });
        } catch {
          // 없어도 된다
        }
      },

      async openRebasePlan(onto) {
        set({ actionError: null });
        try {
          const { commits, hasMerges } = await client.rebasePlanCommits(id, onto);
          set({ rebasePlan: { onto, commits, hasMerges } });
        } catch (e) {
          set({ actionError: describeError(e) });
        }
      },

      closeRebasePlan() {
        set({ rebasePlan: null });
      },

      async runRebasePlan(plan) {
        const r = await run(() => client.rebaseInteractive(id, plan));
        if (r !== undefined) {
          set({ lastOutcome: r, rebasePlan: null });
          return true;
        }
        return false;
      },

      async rewordCommit(oid, message) {
        await outcome(() => client.rewordCommit(id, oid, message));
      },

      async squashIntoParent(oid) {
        await outcome(() => client.squashIntoParent(id, oid));
      },

      /**
       * 범위 합치기 준비: 범위 기준(`older^`, 첫 commit 이면 `--root`)에서 HEAD 까지의 plan 목록을 읽어 검사하고, 범위
       * commit 의 메시지 전체를 읽어 초안을 만든다. 범위 diff 를 읽는 중이면 기준을 아직 몰라 하지 않는다 (메뉴도 꺼져 있다)
       */
      async prepareSquashRange() {
        const r = get().range;
        if (!r || r.loading) {
          return null;
        }
        set({ actionError: null });
        try {
          const onto = squashRangeOnto(r.base);
          const info = await client.rebasePlanCommits(id, onto);
          const check = checkSquashRange(info, onto, r.older, r.newer, rangeRowCount(r));
          if (!check.ok) {
            set({ actionError: check.reason });
            return null;
          }
          const messages = await Promise.all(
            check.target.range.map((c) => client.commitMessage(id, c.oid)),
          );
          // 읽는 사이 범위를 풀거나 바꿨으면 이 준비는 버린다
          const now = get().range;
          if (!now || now.older !== r.older || now.newer !== r.newer) {
            return null;
          }
          return { ...check.target, draft: squashRangeDraft(messages) };
        } catch (e) {
          set({ actionError: describeError(e) });
          return null;
        }
      },

      /**
       * 범위 합치기 실행: 기존 인터랙티브 rebase 경로(실행 전 branch 백업·Undo 항목, 충돌·멈춤은 진행 띠)로 돈다. 실행하면
       * 범위(와 그 diff)를 푼다. 깨끗이 끝나면 새 commit(기준 위의 첫 commit)으로 로그를 옮긴다 — 그래프 재로드가 아직이면
       * 재로드가 끝날 때(`pendingJump`), 이미 끝났으면 바로
       */
      async squashRange(target, message) {
        const result = await run(() =>
          client.rebaseInteractive(id, buildSquashRangePlan(target, message)),
        );
        if (result === undefined) {
          return false;
        }
        rangeSeq += 1;
        set({ lastOutcome: result, ...rangeCleared() });
        if (result !== 'clean') {
          return true;
        }
        try {
          const after = await client.rebasePlanCommits(id, target.onto);
          const oid = after.commits[0]?.oid;
          if (oid) {
            set({ pendingJump: oid });
            if ((await get().resolveRow(oid)) !== null && get().pendingJump === oid) {
              set({ pendingJump: null });
              await get().jumpToCommit(oid);
            }
          }
        } catch {
          // 새 commit 으로 옮기는 것은 덤이다 — 합치기는 이미 끝났다
        }
        return true;
      },
    };
  });
  // 생성 때 읽기: 전체 프로필은 모두, 가벼운 프로필은 `light` 항목만 (나머지는 승격할 때)
  const initial = store.getState();
  for (const step of STARTUP_LOADS) {
    if (profile === 'full' || step.light) {
      void step.load(initial);
    }
  }
  if (profile === 'full') {
    syncLayoutPrefs(initial.layoutPrefs);
  }
  return store;
}
