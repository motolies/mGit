import { Channel } from '@tauri-apps/api/core';
import { commands } from './bindings';
import type {
  AdvancedSearch,
  AppEvent,
  AuthorList,
  BackupRecord,
  BackupRef,
  BatchOp,
  BatchResult,
  BlameLine,
  BranchDeleteTarget,
  BranchDeletionResult,
  BranchUpdate,
  ChangedFile,
  CheckoutTarget,
  CloneRequest,
  CommandLogRecord,
  CommandRun,
  CommitDetail,
  CommitSpec,
  CommitTemplate,
  ConflictFile,
  ConflictOrigins,
  ConflictPayload,
  ConflictRule,
  ConflictSide,
  ContainingRefs,
  CreatePr,
  DeviceCodes,
  DiffDocument,
  DiffOptions,
  DifftoolTarget,
  ExternalApps,
  ExternalKind,
  FileDiff,
  FolderBranches,
  FolderOpened,
  FolderSettings,
  FoundRepo,
  FsClipboard,
  FsDirListing,
  FsEditableFile,
  FsExternalInput,
  FsFile,
  FsImage,
  FsOperationDecision,
  FsOperationPlan,
  FsOperationProgress,
  FsOperationRequest,
  FsOperationResult,
  FsSaveResult,
  FsSource,
  GitignoreTemplate,
  GitVersionInfo,
  GraphLayoutPrefs,
  GraphQuery,
  GraphWindow,
  HistoryEntry,
  HostingAccount,
  HostingUrls,
  HostKind,
  IndexTarget,
  IndexWriteResult,
  IpcError,
  IsolatedMerge,
  KeptResolution,
  LfsStatus,
  LineSelection,
  LocalTag,
  MarkerHit,
  MergeMode,
  MergePreview,
  Module,
  ModuleOverrides,
  OauthConfig,
  OpOutcome,
  PerfStatus,
  Profile,
  PrTemplate,
  PtyEvent,
  PullMode,
  PullRequest,
  PushSpec,
  RadarEntry,
  RangeFiles,
  RebasePlan,
  RebasePlanInfo,
  RebaseStepPreview,
  RecentEntry,
  ReflogEntry,
  RemoteProject,
  RemoteTag,
  RenameConflict,
  RepoChanges,
  RepoOpened,
  RepoPage,
  RepoSessionRelease,
  RepoSettings,
  RepoState,
  RepoSummary,
  RerereStatus,
  ResetMode,
  ResolutionReview,
  RuleResult,
  SearchFields,
  SearchResult,
  SecretHit,
  SecretIgnore,
  SessionEvent,
  SessionId,
  SignatureStatus,
  SigningInfo,
  SshKeyInfo,
  StashEntry,
  SubmoduleInfo,
  SubmodulePointerLog,
  SubmoduleUnpushed,
  SyntaxCompare,
  TagDeleteItem,
  TagLeaseItem,
  TagRefResult,
  TagSyncReport,
  TimelineInfo,
  UndoOutcome,
  UndoState,
  UnresolveMode,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
  WorktreeRemoveCheck,
  WorktreeSource,
  WorktreeWip,
} from './types';

/** 커맨드 호출 인터페이스. Tauri 구현과 목 구현이 같은 모양을 가진다 */
export interface IpcClient {
  gitVersion(): Promise<GitVersionInfo>;
  /** 저장소를 연다. 세션 이벤트는 `onEvent` 로 push 된다 (open 이 끝나기 전에도 올 수 있다) */
  openRepo(path: string, onEvent: (event: SessionEvent) => void): Promise<RepoOpened>;
  graphWindow(session: SessionId, start: number, count: number): Promise<GraphWindow>;
  /** 커밋의 현재 행 번호. 그래프에 없으면 null */
  findRow(session: SessionId, oid: string): Promise<number | null>;
  repoState(session: SessionId): Promise<RepoState>;
  /** 사용자 새로고침. 바뀐 것은 이벤트로 온다 */
  refreshRepo(session: SessionId): Promise<void>;
  /** 그래프 강제 재로드. 완료는 `graphReloaded` 이벤트 */
  reloadGraph(session: SessionId): Promise<void>;
  cancelOperation(opId: number): Promise<boolean>;
  commandLogRecent(limit: number): Promise<CommandLogRecord[]>;
  closeRepo(session: SessionId): Promise<void>;

  // 변경 사항·스테이징·커밋 (S2)
  stagePaths(session: SessionId, paths: string[]): Promise<void>;
  unstagePaths(session: SessionId, paths: string[]): Promise<void>;
  stageAll(session: SessionId): Promise<void>;
  unstageAll(session: SessionId): Promise<void>;
  /** `options` 는 공백 무시·문맥 줄 수 (DIFF-03) */
  workTreeDiff(
    session: SessionId,
    path: string,
    staged: boolean,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<FileDiff | null>;
  workTreeDiffDocument(
    session: SessionId,
    path: string,
    staged: boolean,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<DiffDocument>;
  /**
   * 커밋 하나에서 파일 하나의 diff. 머지 커밋은 첫 부모 기준(상세의 파일 목록과 같다). `oldPath` 는 이름이
   * 바뀐 파일의 옛 경로(상세의 `ChangedFile.oldPath`)로, 주면 rename 으로 짝지어 실제 변경분만 나온다.
   * 모르면 null (새 경로만으로 묻는다 — rename 은 "추가"로 나온다)
   */
  commitFileDiff(
    session: SessionId,
    oid: string,
    path: string,
    oldPath: string | null,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<FileDiff | null>;
  commitFileDiffDocument(
    session: SessionId,
    oid: string,
    path: string,
    oldPath: string | null,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<DiffDocument>;
  stageLines(
    session: SessionId,
    path: string,
    selection: LineSelection[],
    unstage: boolean,
    /** 화면의 diff 옵션. `selection` 의 번호가 이 옵션 기준이다 */
    options: DiffOptions,
    expectedRevision?: string | null,
  ): Promise<void>;
  /** 백업 id 목록을 돌려준다 */
  discardPaths(session: SessionId, paths: string[]): Promise<number[]>;
  /** 경로(파일·폴더)의 변경을 HEAD 기준으로 되돌린다 (stage 된 변경 포함). 백업 id 목록을 돌려준다 */
  rollbackPaths(session: SessionId, paths: string[]): Promise<number[]>;
  discardLines(
    session: SessionId,
    path: string,
    selection: LineSelection[],
    /** 화면의 diff 옵션. `selection` 의 번호가 이 옵션 기준이다 */
    options: DiffOptions,
    expectedRevision?: string | null,
  ): Promise<number | null>;
  listBackups(session: SessionId, limit: number): Promise<BackupRecord[]>;
  restoreBackup(session: SessionId, id: number): Promise<void>;
  verifyStaged(session: SessionId): Promise<MarkerHit[]>;
  /** 새 HEAD 해시를 돌려준다. hook 출력은 `operationOutput` 이벤트 */
  commit(session: SessionId, spec: CommitSpec): Promise<string>;
  lastCommitMessage(session: SessionId): Promise<string>;
  commitMessage(session: SessionId, oid: string): Promise<string>;

  // 커밋 상세·검색·브랜치·병합 (S3)
  commitDetail(session: SessionId, oid: string): Promise<CommitDetail>;
  /**
   * 커밋을 포함하는 로컬·원격 브랜치와 HEAD 포함 여부 (CD-03). 커밋 상세와 따로 뒤늦게 부른다. 10초 안에
   * 끝나지 않으면 오류가 아니라 `timedOut: true`(목록은 빔)로 온다. 그 저장소에 없는 커밋은 `internal`
   */
  commitContainingRefs(session: SessionId, oid: string): Promise<ContainingRefs>;
  searchCommits(
    session: SessionId,
    query: string,
    fields: SearchFields,
    limit: number,
  ): Promise<SearchResult>;
  checkout(session: SessionId, target: CheckoutTarget, stashFirst: boolean): Promise<void>;
  createBranch(
    session: SessionId,
    name: string,
    start: string | null,
    checkout: boolean,
  ): Promise<void>;
  renameBranch(session: SessionId, oldName: string, newName: string): Promise<void>;
  deleteBranch(session: SessionId, name: string, force: boolean): Promise<void>;
  deleteRemoteBranch(session: SessionId, remote: string, name: string): Promise<void>;
  inspectRemoteBranchDeletion(
    session: SessionId,
    remote: string,
    name: string,
  ): Promise<BranchDeleteTarget>;
  inspectFolderRemoteBranchDeletion(
    session: SessionId,
    remote: string,
    name: string,
  ): Promise<BranchDeleteTarget[]>;
  deleteRemoteBranchWithLocals(
    session: SessionId,
    target: BranchDeleteTarget,
    deleteLocal: boolean,
  ): Promise<BranchDeletionResult>;
  forceDeleteLocalBranches(
    session: SessionId,
    target: BranchDeleteTarget,
  ): Promise<BranchDeletionResult>;
  setUpstream(session: SessionId, branch: string, upstream: string | null): Promise<void>;
  /** 로컬 branch 하나를 업스트림으로 fast-forward (BR-09). checkout 하지 않은 branch 도 갱신한다 */
  updateBranch(session: SessionId, name: string): Promise<BranchUpdate>;
  createTag(
    session: SessionId,
    name: string,
    target: string | null,
    message: string | null,
    sign?: boolean,
  ): Promise<void>;
  /**
   * tag 관리 (BR-06): 고른 원격으로 tag 들을 push 한다 (TG-01). 요청 순서대로 tag 마다 결과 하나. operation 이벤트(kind
   * `push`)가 붙는다. 첫 청크가 통째로 실패하면(인증·연결) `gitFailed` 로 거부된다
   */
  pushTags(session: SessionId, remote: string, names: string[]): Promise<TagRefResult[]>;
  /**
   * 고른 원격에서 tag 들을 지운다 (TG-04): 실행 직전에 조회하고 lease 로 지운다. 원격에 없으면 `alreadyAbsent`, 로컬과 다르면
   * `diverged`(`remoteOid`·`remoteCommit`) — 확인한 뒤 그 `remoteOid` 를 `expectedRemote` 로 넘겨 다시 부른다
   */
  deleteRemoteTags(
    session: SessionId,
    remote: string,
    items: TagDeleteItem[],
  ): Promise<TagRefResult[]>;
  /** 로컬 tag 들을 한 트랜잭션으로 지운다 (TG-06). undo 항목 하나 (`tag -d v1 v2 v3 (+N)`) */
  deleteLocalTags(session: SessionId, names: string[]): Promise<void>;
  /**
   * 원격 tag 를 로컬 것으로 덮어쓴다 (TG-15 "로컬 것으로 맞추기"): 항목마다 확인한 원격 객체(`expectedRemote`)로 lease 를 건
   * push 한 번. `pushed`(덮어씀)·`upToDate`·`rejectedStale`(그 사이 원격이 바뀜, 원격 그대로) 등. `--force` 단독 경로는 없고
   * undo 항목도 없다. operation 이벤트(kind `push`)
   */
  replaceRemoteTags(
    session: SessionId,
    remote: string,
    items: TagLeaseItem[],
  ): Promise<TagRefResult[]>;
  /**
   * 원격 tag 상태 보고서 (TG-08). `remote` 가 null 이면 업스트림의 원격 → origin → 첫 원격. `refresh` 면 원격을 조회하고
   * (operation 이벤트 kind `tagCheck` — 세션 busy 와 무관, 취소 가능), 아니면 네트워크 없이 캐시로 만든다. `checkedAt` 이
   * null 이면 확인한 적이 없다. 조회 실패는 거부가 아니라 이전 값 + `lastError` 로 온다
   */
  remoteTags(session: SessionId, remote: string | null, refresh: boolean): Promise<TagSyncReport>;
  /** 원격 tag 몇 개를 조회한다 (단일 조회, operation kind `tagCheck`). 원격에 있는 것만 요청 순서대로 */
  lookupRemoteTags(session: SessionId, remote: string, names: string[]): Promise<RemoteTag[]>;
  /**
   * 원격 tag 를 받아 온다 (TG-11). `overwrite` 면 로컬의 다른 tag 를 원격 것으로 바꾼다 (TG-15). 결과는 tag 마다
   * `fetched`·`upToDate`·`rejectedExists`(덮어쓰지 않음, `remoteOid` 는 원격 객체)·`unknown`. undo 항목 하나, operation
   * 이벤트(kind `fetch`). 원격에 없는 이름이 섞이면 git 이 전체를 멈춰 `gitFailed` 로 거부된다 (다시 확인 후 재시도)
   */
  fetchTags(
    session: SessionId,
    remote: string,
    names: string[],
    overwrite: boolean,
  ): Promise<TagRefResult[]>;
  /** 로컬 tag 목록 (TG-10 열·툴팁): 종류·날짜(epoch 초)·commit 제목·tag 제목·tagger. 이름순 */
  tagList(session: SessionId): Promise<LocalTag[]>;
  merge(session: SessionId, reference: string, mode: MergeMode): Promise<OpOutcome>;
  rebase(session: SessionId, onto: string, autostash: boolean): Promise<OpOutcome>;
  cherryPick(session: SessionId, oids: string[]): Promise<OpOutcome>;
  revert(session: SessionId, oids: string[]): Promise<OpOutcome>;
  reset(session: SessionId, target: string, mode: ResetMode): Promise<void>;
  opContinue(session: SessionId, allowConflictMarkers: boolean): Promise<OpOutcome>;
  opSkip(session: SessionId): Promise<OpOutcome>;
  opAbort(session: SessionId): Promise<void>;
  commitGraphWrite(session: SessionId): Promise<void>;

  // S4: 원격·동기화·스태시·워크트리
  remoteAdd(session: SessionId, name: string, url: string): Promise<void>;
  remoteRename(session: SessionId, oldName: string, newName: string): Promise<void>;
  remoteRemove(session: SessionId, name: string): Promise<void>;
  remoteSetUrl(session: SessionId, name: string, url: string): Promise<void>;
  fetch(session: SessionId, remote: string | null, prune: boolean): Promise<void>;
  pull(session: SessionId, mode: PullMode): Promise<void>;
  push(session: SessionId, spec: PushSpec): Promise<void>;
  listStashes(session: SessionId): Promise<StashEntry[]>;
  stashPush(
    session: SessionId,
    message: string | null,
    includeUntracked: boolean,
    stagedOnly: boolean,
    paths: string[],
  ): Promise<void>;
  stashApply(session: SessionId, index: number): Promise<void>;
  stashPop(session: SessionId, index: number): Promise<void>;
  stashDrop(session: SessionId, index: number): Promise<void>;
  stashFileDiffDocument(
    session: SessionId,
    oid: string,
    path: string,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<DiffDocument>;
  stashFiles(session: SessionId, oid: string): Promise<ChangedFile[]>;
  suggestWorktreePath(session: SessionId, branch: string): Promise<string>;
  worktreeAdd(session: SessionId, path: string, source: WorktreeSource): Promise<string>;
  worktreeRemoveCheck(session: SessionId, path: string): Promise<WorktreeRemoveCheck>;
  worktreeRemove(
    session: SessionId,
    path: string,
    force: boolean,
    deleteBranch: boolean,
  ): Promise<void>;
  worktreePrune(session: SessionId): Promise<void>;

  // S5: 저장소 관리·폴더·서브모듈·앱 이벤트
  /**
   * 폴더를 연다. `onEvent` 로 폴더 세션의 이벤트가 온다: 감시(`folderChanged`·`folderRescanned`), 통합 타임라인의 그래프
   * 이벤트, 일괄 작업 진행, 폴더 콘솔(`folderCommandLogged` — W19 ②: 폴더의 저장소에서 돈 쓰기·네트워크 명령. `repo` 는
   * 목록의 대표 경로, 읽기 명령은 오지 않는다), 자동 fetch 결과(`folderAutoFetched` — 원격 추적 ref 가 바뀌었거나 실패한
   * 저장소만, 바뀐 저장소는 그 앞에 `folderChanged` 가 따로 온다)
   */
  openFolder(path: string, onEvent: (event: SessionEvent) => void): Promise<FolderOpened>;
  /** `repos` 를 주면 그 저장소만 읽는다 (PF-02). 없거나 비면 전부. 폴더의 저장소가 아닌 경로는 거부된다 */
  folderSummaries(session: SessionId, repos?: readonly string[]): Promise<RepoSummary[]>;
  folderRescan(session: SessionId): Promise<FoundRepo[]>;
  /** 폴더 세션을 닫는다. 그 폴더만 잡고 있던 가벼운 세션도 함께 닫힌다 (승격된 탭의 세션은 남는다) */
  closeFolder(session: SessionId): Promise<void>;
  /**
   * W13: 폴더 저장소(`repo` = 폴더의 저장소 목록에 있는 경로, 워크트리는 그 자신)의 가벼운 세션을 연다.
   * 응답은 `openRepo` 와 같은 모양이고 `profile` 이 `light` — 그래프 메서드(`graphWindow`·`findRow`·검색·
   * 질의 변경)는 `graphUnavailable` 로 거부된다. 그 작업 트리가 이미 탭으로 열려 있으면 그 탭의 세션(`full`,
   * 잡지 않음)이 온다. `alreadyOpen` 이면 이벤트는 처음 연 쪽의 채널로만 간다. 한 폴더가 세 개를 잡고 있으면
   * `lightSessionLimit` 으로 거부된다
   */
  folderOpenRepoSession(
    session: SessionId,
    repo: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<RepoOpened>;
  /**
   * W13: 폴더가 가벼운 세션의 잡음을 푼다. 마지막 잡음이면 그 세션이 닫힌다(`profile: null`).
   * 이미 닫힘·안 잡음·승격된 세션은 아무것도 하지 않고 같은 모양으로 답한다 (오류 아님)
   */
  folderReleaseRepoSession(session: SessionId, repoSession: SessionId): Promise<RepoSessionRelease>;
  scanRepos(root: string): Promise<FoundRepo[]>;
  cloneRepo(request: CloneRequest, onEvent: (event: SessionEvent) => void): Promise<string>;
  initRepo(path: string, defaultBranch: string, template: string | null): Promise<string>;
  gitignoreTemplates(): Promise<GitignoreTemplate[]>;
  recentList(): Promise<RecentEntry[]>;
  recentPin(path: string, pinned: boolean): Promise<void>;
  recentRemove(path: string): Promise<void>;
  openTabsGet(): Promise<string[]>;
  openTabsSet(paths: string[]): Promise<void>;
  submodules(session: SessionId): Promise<SubmoduleInfo[]>;
  submoduleUpdate(session: SessionId, recursive: boolean): Promise<void>;
  takeStartupPaths(): Promise<string[]>;
  subscribeAppEvents(onEvent: (event: AppEvent) => void): Promise<void>;

  // S6: 충돌 해결
  conflicts(session: SessionId): Promise<ConflictFile[]>;
  conflictFile(session: SessionId, path: string): Promise<ConflictPayload>;
  resolveFile(
    session: SessionId,
    path: string,
    content: string,
    allowConflictMarkers: boolean,
  ): Promise<void>;
  resolveSide(session: SessionId, path: string, side: ConflictSide): Promise<void>;
  resolveDelete(session: SessionId, path: string, keep: boolean): Promise<void>;
  unresolve(session: SessionId, path: string, mode: UnresolveMode): Promise<void>;

  // S7: 자격 증명·외부 앱
  credentialReply(reqId: number, secret: string | null, remember: boolean): Promise<void>;
  credentialForget(target: string): Promise<void>;
  externalAppsGet(): Promise<ExternalApps>;
  externalAppsSet(apps: ExternalApps): Promise<void>;
  openExternal(kind: ExternalKind, path: string): Promise<void>;

  // 자동 fetch 간격 (RM-02, 앱 전체 값 하나 — 저장소 탭·폴더 탭 공용)
  /** 자동 fetch 간격 (분, 0 = 끔). 저장된 값이 없으면 5 */
  autoFetchGet(): Promise<number>;
  /**
   * 자동 fetch 간격을 저장하고 곧바로 적용한다 (분, 0~1440, 0 = 끔). 열린 저장소 탭과 폴더의 자동 fetch 가 새 간격으로
   * 다시 걸린다(타이머도 처음부터). 범위를 벗어나면 `internal` 오류다
   */
  autoFetchSet(minutes: number): Promise<void>;

  // 화면 언어 (다국어 L3)
  /** OS 의 화면 언어 (BCP 47 태그, 예: `ko-KR`). 읽지 못하면 null */
  systemLocale(): Promise<string | null>;
  /** Rust 가 만드는 화면 문구(오류·일괄 작업 라벨 등)의 언어를 바꾼다. 이미 만든 문구는 그대로다 */
  setLanguage(lang: 'ko' | 'en'): Promise<void>;

  // A1: 안전장치
  undoState(session: SessionId): Promise<UndoState>;
  undo(session: SessionId): Promise<UndoOutcome | null>;
  redo(session: SessionId): Promise<UndoOutcome | null>;
  backups(session: SessionId): Promise<BackupRef[]>;
  backupRestore(session: SessionId, backup: string, newBranch: string | null): Promise<void>;
  backupDelete(session: SessionId, backup: string): Promise<void>;
  reflog(session: SessionId, reference: string | null, limit: number): Promise<ReflogEntry[]>;
  reflogRestore(session: SessionId, oid: string, newBranch: string): Promise<void>;
  worktreeLock(session: SessionId, path: string, reason: string | null): Promise<void>;
  worktreeUnlock(session: SessionId, path: string): Promise<void>;
  ignoreAdd(session: SessionId, patterns: string[]): Promise<void>;
  commitTemplates(session: SessionId): Promise<CommitTemplate[]>;
  commitTemplatesSet(templates: CommitTemplate[]): Promise<void>;
  appCommitTemplates(): Promise<CommitTemplate[]>;
  removeIndexLock(session: SessionId): Promise<boolean>;

  // A2: 이력 수정
  rebasePlanCommits(session: SessionId, onto: string | null): Promise<RebasePlanInfo>;
  rebaseInteractive(session: SessionId, plan: RebasePlan): Promise<OpOutcome>;
  rewordCommit(session: SessionId, oid: string, message: string): Promise<OpOutcome>;
  squashIntoParent(session: SessionId, oid: string): Promise<OpOutcome>;
  worktreeWips(session: SessionId): Promise<WorktreeWip[]>;

  // diff·히스토리·그래프 질의 (A3)
  graphQuery(session: SessionId): Promise<GraphQuery>;
  /**
   * 질의를 바꾸고 다시 읽는다 (`graphReloaded`). `filter` 는 텍스트·해시·작성자·날짜 필터(LG-06) — 텍스트·작성자가
   * 있으면 목록 모드(선 없음). 잘못된 정규식이면 질의를 바꾸지 않고 `invalidFilter` 로 거부한다. 결과가 0개인
   * 필터는 오류가 아니라 0행 그래프다
   */
  setGraphQuery(session: SessionId, query: GraphQuery): Promise<void>;
  /**
   * 작성자 후보 (필터 바의 작성자 드롭다운): 필터와 무관하게 모든 ref 의 커밋 작성자를 이메일로 묶은 것.
   * 가벼운 세션은 `graphUnavailable`
   */
  graphAuthors(session: SessionId): Promise<AuthorList>;
  /** 레이아웃 설정 (고정 레인·ref 색·긴 엣지 접기). 바꾸면 git 없이 재배치된다 */
  graphLayoutPrefs(session: SessionId): Promise<GraphLayoutPrefs>;
  setGraphLayoutPrefs(session: SessionId, prefs: GraphLayoutPrefs): Promise<void>;
  blame(
    session: SessionId,
    path: string,
    rev: string | null,
    ignoreWhitespace: boolean,
  ): Promise<BlameLine[]>;
  resolveRevision(session: SessionId, rev: string): Promise<string>;
  blameContents(
    session: SessionId,
    path: string,
    text: string,
    ignoreWhitespace: boolean,
  ): Promise<BlameLine[]>;
  revisionFileContent(session: SessionId, rev: string, path: string): Promise<string | null>;
  compareLocalFiles(
    session: SessionId,
    base: string,
    drafts: [string, string][],
  ): Promise<{ base: string; files: ChangedFile[] }>;
  compareLocalDocument(
    session: SessionId,
    base: string,
    path: string,
    draft: string | null,
    options: DiffOptions,
    full: boolean,
  ): Promise<DiffDocument>;
  fileHistory(session: SessionId, path: string, limit: number): Promise<HistoryEntry[]>;
  comparisonCommits(
    session: SessionId,
    include: string,
    exclude: string,
  ): Promise<[[string, string, string][], boolean]>;
  compareRefs(session: SessionId, a: string, b: string, threeDot: boolean): Promise<ChangedFile[]>;
  compareFileDiff(
    session: SessionId,
    a: string,
    b: string,
    threeDot: boolean,
    path: string,
    options: DiffOptions,
    full: boolean,
  ): Promise<FileDiff | null>;
  compareFileDiffDocument(
    session: SessionId,
    a: string,
    b: string,
    threeDot: boolean,
    path: string,
    options: DiffOptions,
    full: boolean,
  ): Promise<DiffDocument>;
  rangeFiles(session: SessionId, newer: string, older: string): Promise<RangeFiles>;
  searchAdvanced(session: SessionId, query: AdvancedSearch, limit: number): Promise<SearchResult>;
  openDifftool(session: SessionId, target: DifftoolTarget): Promise<void>;

  // 설정·서명·비밀 스캔·알림 (A4)
  signingInfo(session: SessionId): Promise<SigningInfo>;
  commitSignature(session: SessionId, oid: string): Promise<SignatureStatus>;
  scanStagedSecrets(session: SessionId): Promise<SecretHit[]>;
  secretIgnores(): Promise<SecretIgnore[]>;
  secretIgnoresSet(list: SecretIgnore[]): Promise<void>;
  repoSettings(session: SessionId): Promise<RepoSettings>;
  setUser(session: SessionId, name: string, email: string): Promise<void>;
  writeGitignore(session: SessionId, text: string): Promise<void>;
  perfStatus(session: SessionId): Promise<PerfStatus>;
  enablePerf(session: SessionId): Promise<void>;
  /** 끝난 뒤 얕은지 여부 */
  unshallow(session: SessionId): Promise<boolean>;
  notify(title: string, body: string): Promise<void>;

  // 호스팅 계정·프로필·SSH 키·원격 저장소 (B1)
  hostingAccounts(): Promise<HostingAccount[]>;
  hostingOauth(): Promise<OauthConfig>;
  hostingOauthSet(config: OauthConfig): Promise<void>;
  hostingAddPat(kind: HostKind, host: string, token: string): Promise<HostingAccount>;
  hostingDeviceStart(kind: HostKind, host: string): Promise<DeviceCodes>;
  hostingDeviceFinish(kind: HostKind, host: string, codes: DeviceCodes): Promise<HostingAccount>;
  hostingRemove(id: string): Promise<void>;
  hostingRepos(accountId: string, page: number, search: string): Promise<RepoPage>;
  hostingUrls(kind: HostKind, host: string): Promise<HostingUrls>;
  profiles(): Promise<Profile[]>;
  profilesSet(list: Profile[]): Promise<Profile[]>;
  applyProfile(session: SessionId, profileId: string): Promise<void>;
  sshKeys(): Promise<SshKeyInfo[]>;
  sshKeygen(name: string, comment: string, passphrase: string): Promise<SshKeyInfo>;
  openUrl(url: string): Promise<void>;

  // PR/MR·아바타 (B2)
  hostingRemoteProject(session: SessionId): Promise<RemoteProject | null>;
  pullRequests(session: SessionId): Promise<PullRequest[]>;
  prTemplates(session: SessionId): Promise<PrTemplate[]>;
  createPullRequest(session: SessionId, spec: CreatePr): Promise<PullRequest>;
  /** 만든 브랜치 이름 */
  checkoutPullRequest(session: SessionId, number: number, worktree: string | null): Promise<string>;
  avatar(email: string): Promise<string | null>;

  // 멀티 저장소 일괄 (C1)
  folderSettings(session: SessionId): Promise<FolderSettings>;
  folderSettingsSet(session: SessionId, settings: FolderSettings): Promise<void>;
  /** `repos` 가 비면 전부 */
  folderBatch(session: SessionId, op: BatchOp, repos: string[]): Promise<BatchResult>;
  /** 변경이 있는 저장소만 온다. `repos` 를 주면 그 저장소만 읽는다 (PF-02). 없거나 비면 전부 */
  folderChanges(session: SessionId, repos?: readonly string[]): Promise<RepoChanges[]>;
  /**
   * 폴더의 브랜치 목록 (PF-03): 타임라인을 열지 않아도, 로드가 끝나기 전에도 답한다.
   * `repos` 를 주면 그 저장소(워크트리면 원 저장소)만 읽는다. 없거나 비면 전부
   */
  folderBranches(session: SessionId, repos?: readonly string[]): Promise<FolderBranches>;
  /**
   * 폴더 저장소의 경로들 또는 전부를 stage 한다 (`git add -A`, W14 — Commit 도구 창의 체크 = stage). 저장소 세션
   * 없이 폴더 세션 id + 저장소 경로로 부른다. `repo` 는 이 폴더의 저장소 경로(`folderChanges` 의 `path`)이고
   * 워크트리면 그 워크트리 자신의 index 에 쓴다. 대상은 `{kind:'paths', paths}`(작업 트리 기준 상대 경로, 디렉터리면
   * 그 아래 전부, 글자 그대로) 또는 `{kind:'all'}` — 빈 `paths` 는 전부가 아니라 아무것도 하지 않는다.
   * 충돌(unmerged) 경로는 건드리지 않고 `skipped` 로 알린다. 쓰기를 돌렸으면(`ran`) 그 저장소의 `folderChanged`
   * (`refs: false`)가 온다. 목록 밖 저장소·작업 트리 밖 경로는 git 전에 `internal`, 목록의 경로가 더는 저장소가
   * 아니면 `notARepository`, 대상 아래 미등록 하위 저장소는 `nestedRepos`, git 실패(없는 경로 등)는 `gitFailed`
   */
  folderStage(session: SessionId, repo: string, target: IndexTarget): Promise<IndexWriteResult>;
  /**
   * 폴더 저장소의 경로들 또는 전부를 unstage 한다 (체크 해제). HEAD 가 있으면 `git restore --staged`, 커밋이
   * 없으면 `git rm --cached`. 규칙·오류는 `folderStage` 와 같다 (미등록 하위 저장소 검사만 없다). 이름 변경은
   * 새 경로와 옛 경로(`origPath`)를 함께 넘겨야 둘 다 풀린다
   */
  folderUnstage(session: SessionId, repo: string, target: IndexTarget): Promise<IndexWriteResult>;
  folderCommit(
    session: SessionId,
    repos: string[],
    message: string,
    stageAll: boolean,
  ): Promise<BatchResult>;
  /** 통합 타임라인 (MR-12). 이벤트는 폴더 세션 id 로 `graph*` 가 온다 */
  folderTimelineOpen(session: SessionId): Promise<TimelineInfo>;
  folderTimelineInfo(session: SessionId): Promise<TimelineInfo>;
  folderTimelineReload(session: SessionId): Promise<void>;
  /** 질의(필터 포함)를 모든 저장소에 같게 건다. 잘못된 정규식이면 바꾸지 않고 `invalidFilter` */
  folderTimelineQuerySet(session: SessionId, query: GraphQuery): Promise<void>;
  /**
   * 저장소 범위 ("이 저장소들만 보기"). 빈 목록 = 전부. 범위 밖 저장소는 번호·색을 그대로 둔 채 행만 빠지고
   * `TimelineInfo.repos[].inScope` 가 거짓이 된다. 이 폴더의 저장소가 아닌 경로가 있으면 거부(`internal`)
   */
  folderTimelineScopeSet(session: SessionId, repos: string[]): Promise<void>;
  /** 폴더 타임라인의 작성자 후보 (범위에 든 저장소들의, 필터 없는 타임라인 범위의 작성자) */
  folderTimelineAuthors(session: SessionId): Promise<AuthorList>;
  folderTimelinePrefsSet(session: SessionId, prefs: GraphLayoutPrefs): Promise<void>;
  folderTimelineWindow(session: SessionId, start: number, count: number): Promise<GraphWindow>;
  /**
   * 타임라인에서 (저장소 번호, 커밋) 의 행. 번호는 재스캔으로 밀리므로 화면에 떠 있는 동안의 스크롤 기준에만
   * 쓴다 (오래 들고 있는 선택은 저장소 경로로 가리킨다)
   */
  folderTimelineFindRow(session: SessionId, repo: number, oid: string): Promise<number | null>;
  /**
   * 폴더 저장소의 커밋 상세 (CD-05): 저장소 세션 없이 폴더 세션 id + 저장소 경로로 읽는다. `repo` 는 이
   * 폴더의 저장소 경로(`TimelineInfo.repos[].path` 등)이고 워크트리 경로면 원 저장소로 읽는다. 목록 밖
   * 경로는 거부한다. 메타데이터·파일 목록은 `commitDetail` 과 같고, `row`·`children`·`refs` 는 통합
   * 타임라인 기준이다 — 타임라인에 그 저장소가 없으면(열기 전) 셋 다 비고, 지금 질의에 그 커밋이
   * 없으면 `row`·`children` 만 빈다
   */
  folderCommitDetail(session: SessionId, repo: string, oid: string): Promise<CommitDetail>;
  /**
   * 폴더 저장소의 커밋을 포함하는 브랜치 (`commitContainingRefs` 와 같은 결과·시간 상한, CD-03·CD-05).
   * 저장소 세션을 만들지 않는다. 워크트리 경로는 원 저장소로 읽고(HEAD 도 원 저장소의 것), 목록 밖 경로는 거부한다
   */
  folderCommitContainingRefs(
    session: SessionId,
    repo: string,
    oid: string,
  ): Promise<ContainingRefs>;
  /**
   * 폴더 저장소의 커밋 하나에서 파일 하나의 diff (`commitFileDiff` 와 같은 결과, `oldPath` 도 같다).
   * 변경이 없으면 null
   */
  folderCommitFileDiff(
    session: SessionId,
    repo: string,
    oid: string,
    path: string,
    oldPath: string | null,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<FileDiff | null>;
  folderCommitFileDiffDocument(
    session: SessionId,
    repo: string,
    oid: string,
    path: string,
    oldPath: string | null,
    full: boolean,
    options?: DiffOptions | null,
  ): Promise<DiffDocument>;

  // 파일 트리·파일 보기 (W10, FS-01~10). 루트는 세션이 정한다 — 저장소 세션은 작업 트리, 폴더 세션은
  // 폴더 경로. 경로는 그 루트 기준 상대 경로이고 `/` 로 잇는다. 루트 밖·`..`·`.`·절대 경로·`.git`(대소문자
  // 무시)·경로 중간의 심볼릭 링크는 `internal` 오류로 거부한다. 없음·권한 없음은 오류가 아니라 결과의 `kind`
  /**
   * 디렉터리 하나의 항목 (재귀 없음). `dir` 이 '' 이면 루트. `.git` 은 빠진다. 정렬은 디렉터리 먼저, 그다음
   * 대소문자 무시 이름순(같으면 대문자 먼저). 항목이 `limit`(기본 2,000, 1~50,000)을 넘으면 정렬한 앞에서
   * 자르고 `truncated`·`total` — "… N개 더 보기" 는 `limit` 을 올려 다시 부른다. 심볼릭 링크는 종류만 오고
   * 나열하면 거부된다. 결과: `listed` / `missing`(지워졌거나 디렉터리가 아님) / `denied`(권한 없음)
   */
  workspaceSearch(
    session: SessionId,
    request: string,
    query: WorkspaceSearchQuery,
  ): Promise<WorkspaceSearchResult>;
  workspaceSearchCancel(session: SessionId, request: string): Promise<void>;
  fsListDir(session: SessionId, dir: string, limit?: number | null): Promise<FsDirListing>;
  /**
   * 파일 하나를 텍스트로 읽는다 (상한 1 MiB). 결과: `text`(UTF-8, BOM·CRLF 그대로) / `binary`(앞 8,000
   * 바이트에 NUL) / `notUtf8` / `tooLarge`(본문 없음, 실제 크기와 상한) / `unsupported`(디렉터리·링크·FIFO 등,
   * 링크 대상은 읽지 않는다) / `missing` / `denied`
   */
  fsReadFile(session: SessionId, path: string): Promise<FsFile>;
  /** 세션 루트의 5 MiB 이하 이미지를 data URL로 읽는다. */
  fsReadImage(session: SessionId, path: string): Promise<FsImage>;
  /** 원문·파일 식별 키·revision을 조회한다. */
  fsReadEditableFile(session: SessionId, path: string): Promise<FsEditableFile>;
  /** 현재 revision과 같을 때만 작업 파일을 원자 교체한다. */
  fsSaveFile(
    session: SessionId,
    path: string,
    expectedRevision: string,
    text: string,
  ): Promise<FsSaveResult>;

  /** Project 파일 작업을 준비하고 충돌 목록을 반환한다. */
  fsPrepareOperation(request: FsOperationRequest): Promise<FsOperationPlan>;
  /** 준비 이후 경로 변경을 재검증하고 항목별로 실행한다. */
  fsExecuteOperation(id: string, decisions: FsOperationDecision[]): Promise<FsOperationResult>;
  /** 다음 안전한 항목 경계에서 실행을 취소한다. */
  fsCancelOperation(id: string): Promise<void>;
  /** 완료 항목 수와 현재 처리 경로를 조회한다. */
  fsOperationProgress(id: string): Promise<FsOperationProgress>;
  /** 실제 네이티브 drop 경로만 외부 입력 권한으로 등록한다. */
  fsRegisterDrop(paths: string[]): Promise<FsExternalInput>;
  /** 파일 URL clipboard를 읽고 내부 cut과 외부 복사를 구분한다. */
  fsClipboardRead(): Promise<FsClipboard | null>;
  /** 빈 목록은 clipboard를 해제한다. */
  fsClipboardWrite(sources: FsSource[], cut: boolean): Promise<void>;
  /** 시작 복구에서 보존한 복구본 안내를 한 번 읽는다. */
  fsRecoveryWarnings(): Promise<string[]>;

  // 서브모듈 관리 (C2)
  submodulePointerLog(
    session: SessionId,
    path: string,
    old: string | null,
    newOid: string,
  ): Promise<SubmodulePointerLog>;
  submoduleAdd(session: SessionId, url: string, path: string, branch: string | null): Promise<void>;
  submoduleAdopt(session: SessionId, path: string): Promise<void>;
  submoduleRemove(session: SessionId, path: string): Promise<void>;
  submoduleSetBranch(session: SessionId, path: string, branch: string | null): Promise<void>;
  submoduleUpdateRemote(
    session: SessionId,
    path: string | null,
    mode: string | null,
  ): Promise<void>;
  submoduleSync(session: SessionId): Promise<void>;
  submoduleBatch(session: SessionId, op: BatchOp, paths: string[]): Promise<BatchResult>;
  submoduleUnpushed(session: SessionId): Promise<SubmoduleUnpushed[]>;

  // 빌드 멀티 모듈 (C3)
  modules(session: SessionId): Promise<Module[]>;
  moduleOverrides(session: SessionId): Promise<ModuleOverrides>;
  moduleOverridesSet(session: SessionId, overrides: ModuleOverrides): Promise<void>;
  moduleScope(session: SessionId): Promise<string | null>;
  moduleScopeSet(session: SessionId, path: string | null): Promise<void>;

  // 충돌 예방 (D1)
  mergePreview(
    session: SessionId,
    reference: string,
    strategy: string[],
    includeWip: boolean,
  ): Promise<MergePreview>;
  mergeSimulate(
    session: SessionId,
    reference: string,
    includeWip: boolean,
  ): Promise<MergePreview[]>;
  previewFile(session: SessionId, tree: string, path: string): Promise<string>;
  conflictRadar(session: SessionId, max: number, includeWip: boolean): Promise<RadarEntry[]>;
  rebasePreview(session: SessionId, onto: string): Promise<RebaseStepPreview[]>;
  mergeWithOptions(
    session: SessionId,
    reference: string,
    mode: MergeMode,
    strategy: string[],
  ): Promise<OpOutcome>;
  isolatedMerge(session: SessionId, reference: string, mode: MergeMode): Promise<IsolatedMerge>;
  isolatedInfo(session: SessionId): Promise<string | null>;
  isolatedApply(session: SessionId): Promise<string>;
  isolatedDiscard(session: SessionId): Promise<string>;

  // 충돌 해결 보조 (D2)
  renameConflicts(session: SessionId): Promise<RenameConflict[]>;
  resolveRename(session: SessionId, conflict: RenameConflict, keep: ConflictSide): Promise<string>;
  conflictOrigins(session: SessionId, path: string): Promise<ConflictOrigins>;
  conflictRules(session: SessionId): Promise<ConflictRule[]>;
  conflictRulesSet(session: SessionId, rules: ConflictRule[]): Promise<void>;
  conflictRulesApply(session: SessionId): Promise<RuleResult[]>;
  mergeToolName(session: SessionId): Promise<string | null>;
  openMergetool(session: SessionId, path: string): Promise<void>;
  resolutionReview(session: SessionId, path: string): Promise<ResolutionReview>;
  remergeDiff(session: SessionId, oid: string): Promise<string>;
  keptResolutions(session: SessionId): Promise<KeptResolution[]>;
  reapplyResolutions(session: SessionId): Promise<number>;
  keptClear(session: SessionId): Promise<void>;
  rerereStatus(session: SessionId): Promise<RerereStatus>;
  rerereSet(session: SessionId, enabled: boolean, autoupdate: boolean): Promise<void>;
  rerereForget(session: SessionId, path: string): Promise<void>;

  // 해결 검증·명령·LFS·터미널 (D3)
  syntaxCompare(session: SessionId, path: string, content: string): Promise<SyntaxCompare | null>;
  verifyCommand(session: SessionId): Promise<string | null>;
  verifyCommandSet(session: SessionId, cmd: string | null): Promise<void>;
  runVerify(session: SessionId): Promise<CommandRun>;
  worktreeInitCommand(session: SessionId): Promise<string | null>;
  worktreeInitCommandSet(session: SessionId, cmd: string | null): Promise<void>;
  runWorktreeInit(session: SessionId, path: string): Promise<CommandRun | null>;
  lfsStatus(session: SessionId): Promise<LfsStatus>;
  lfsInstall(session: SessionId): Promise<void>;
  lfsTrack(session: SessionId, pattern: string): Promise<void>;
  lfsUntrack(session: SessionId, pattern: string): Promise<void>;
  lfsLock(session: SessionId, path: string): Promise<void>;
  lfsUnlock(session: SessionId, path: string, force: boolean): Promise<void>;
  ptyOpen(
    cwd: string,
    cols: number,
    rows: number,
    onEvent: (event: PtyEvent) => void,
  ): Promise<number>;
  ptyWrite(id: number, data: string): Promise<void>;
  ptyResize(id: number, cols: number, rows: number): Promise<void>;
  ptyClose(id: number): Promise<void>;
}

const IPC_ERROR_KINDS = new Set([
  'notARepository',
  'multiRepoFolder',
  'gitNotFound',
  'gitTooOld',
  'sessionNotFound',
  'gitFailed',
  'cancelled',
  'conflictMarkers',
  'nestedRepos',
  'localBranchTracksOther',
  'pushUpstreamMismatch',
  'graphUnavailable',
  'lightSessionLimit',
  'invalidFilter',
  'internal',
]);

/** 값이 Rust 쪽 `IpcError` 직렬화 형태인지 판별한다 */
export function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && IPC_ERROR_KINDS.has(kind);
}

/** 어떤 예외든 `IpcError` 로 정규화한다 */
export function toIpcError(value: unknown): IpcError {
  if (value instanceof IpcClientError) {
    return value.error;
  }
  if (isIpcError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return { kind: 'internal', message };
}

/** 커맨드가 거부됐을 때 throw 되는 예외. `error` 에 원래 `IpcError` 가 들어 있다 */
export class IpcClientError extends Error {
  readonly error: IpcError;

  constructor(error: IpcError) {
    super(`ipc ${error.kind}`);
    this.name = 'IpcClientError';
    this.error = error;
  }
}

/** 커맨드 호출을 감싸 거부를 `IpcClientError` 로 바꾼다 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new IpcClientError(toIpcError(e));
  }
}

/** `null` 을 돌려주는 커맨드를 `void` 로 감싼다 */
function voidCall(fn: () => Promise<unknown>): Promise<void> {
  return call(async () => {
    await fn();
  });
}

/** 실제 Tauri 커맨드를 호출하는 클라이언트 */
export function createTauriClient(): IpcClient {
  return {
    gitVersion: () => call(() => commands.gitVersion()),
    openRepo: (path, onEvent) => {
      const channel = new Channel<SessionEvent>();
      channel.onmessage = onEvent;
      return call(() => commands.openRepo(path, channel));
    },
    graphWindow: (session, start, count) => call(() => commands.graphWindow(session, start, count)),
    findRow: (session, oid) => call(() => commands.findRow(session, oid)),
    repoState: (session) => call(() => commands.repoState(session)),
    refreshRepo: (session) => voidCall(() => commands.refreshRepo(session)),
    reloadGraph: (session) => voidCall(() => commands.reloadGraph(session)),
    cancelOperation: (opId) => call(() => commands.cancelOperation(opId)),
    commandLogRecent: (limit) => call(() => commands.commandLogRecent(limit)),
    closeRepo: (session) => voidCall(() => commands.closeRepo(session)),

    stagePaths: (session, paths) => voidCall(() => commands.stagePaths(session, paths)),
    unstagePaths: (session, paths) => voidCall(() => commands.unstagePaths(session, paths)),
    stageAll: (session) => voidCall(() => commands.stageAll(session)),
    unstageAll: (session) => voidCall(() => commands.unstageAll(session)),
    workTreeDiff: (session, path, staged, full, options) =>
      call(() => commands.workTreeDiff(session, path, staged, full, options ?? null)),
    workTreeDiffDocument: (session, path, staged, full, options) =>
      call(() => commands.workTreeDiffDocument(session, path, staged, full, options ?? null)),
    commitFileDiff: (session, oid, path, oldPath, full, options) =>
      call(() => commands.commitFileDiff(session, oid, path, oldPath, full, options ?? null)),
    commitFileDiffDocument: (session, oid, path, oldPath, full, options) =>
      call(() =>
        commands.commitFileDiffDocument(session, oid, path, oldPath, full, options ?? null),
      ),
    stageLines: (session, path, selection, unstage, options, expectedRevision) =>
      voidCall(() =>
        commands.stageLines(session, path, selection, unstage, options, expectedRevision ?? null),
      ),
    discardPaths: (session, paths) => call(() => commands.discardPaths(session, paths)),
    rollbackPaths: (session, paths) => call(() => commands.rollbackPaths(session, paths)),
    discardLines: (session, path, selection, options, expectedRevision) =>
      call(() =>
        commands.discardLines(session, path, selection, options, expectedRevision ?? null),
      ),
    listBackups: (session, limit) => call(() => commands.listBackups(session, limit)),
    restoreBackup: (session, id) => voidCall(() => commands.restoreBackup(session, id)),
    verifyStaged: (session) => call(() => commands.verifyStaged(session)),
    commit: (session, spec) => call(() => commands.commit(session, spec)),
    lastCommitMessage: (session) => call(() => commands.lastCommitMessage(session)),
    commitMessage: (session, oid) => call(() => commands.commitMessage(session, oid)),

    commitDetail: (session, oid) => call(() => commands.commitDetail(session, oid)),
    commitContainingRefs: (session, oid) => call(() => commands.commitContainingRefs(session, oid)),
    searchCommits: (session, query, fields, limit) =>
      call(() =>
        commands.searchCommits(session, query, fields.subject, fields.author, fields.hash, limit),
      ),
    checkout: (session, target, stashFirst) =>
      voidCall(() => commands.checkout(session, target, stashFirst)),
    createBranch: (session, name, start, checkout) =>
      voidCall(() => commands.createBranch(session, name, start, checkout)),
    renameBranch: (session, oldName, newName) =>
      voidCall(() => commands.renameBranch(session, oldName, newName)),
    deleteBranch: (session, name, force) =>
      voidCall(() => commands.deleteBranch(session, name, force)),
    deleteRemoteBranch: (session, remote, name) =>
      voidCall(() => commands.deleteRemoteBranch(session, remote, name)),
    inspectRemoteBranchDeletion: (session, remote, name) =>
      call(() => commands.inspectRemoteBranchDeletion(session, remote, name)),
    inspectFolderRemoteBranchDeletion: (session, remote, name) =>
      call(() => commands.inspectFolderRemoteBranchDeletion(session, remote, name)),
    deleteRemoteBranchWithLocals: (session, target, deleteLocal) =>
      call(() => commands.deleteRemoteBranchWithLocals(session, target, deleteLocal)),
    forceDeleteLocalBranches: (session, target) =>
      call(() => commands.forceDeleteLocalBranches(session, target)),
    setUpstream: (session, branch, upstream) =>
      voidCall(() => commands.setUpstream(session, branch, upstream)),
    updateBranch: (session, name) => call(() => commands.updateBranch(session, name)),
    createTag: (session, name, target, message, sign) =>
      voidCall(() => commands.createTag(session, name, target, message, sign ?? false)),
    pushTags: (session, remote, names) => call(() => commands.pushTags(session, remote, names)),
    deleteRemoteTags: (session, remote, items) =>
      call(() => commands.deleteRemoteTags(session, remote, items)),
    deleteLocalTags: (session, names) => voidCall(() => commands.deleteLocalTags(session, names)),
    replaceRemoteTags: (session, remote, items) =>
      call(() => commands.replaceRemoteTags(session, remote, items)),
    remoteTags: (session, remote, refresh) =>
      call(() => commands.remoteTags(session, remote, refresh)),
    lookupRemoteTags: (session, remote, names) =>
      call(() => commands.lookupRemoteTags(session, remote, names)),
    fetchTags: (session, remote, names, overwrite) =>
      call(() => commands.fetchTags(session, remote, names, overwrite)),
    tagList: (session) => call(() => commands.tagList(session)),
    merge: (session, reference, mode) => call(() => commands.merge(session, reference, mode)),
    rebase: (session, onto, autostash) => call(() => commands.rebase(session, onto, autostash)),
    cherryPick: (session, oids) => call(() => commands.cherryPick(session, oids)),
    revert: (session, oids) => call(() => commands.revert(session, oids)),
    reset: (session, target, mode) => voidCall(() => commands.reset(session, target, mode)),
    opContinue: (session, allowConflictMarkers) =>
      call(() => commands.opContinue(session, allowConflictMarkers)),
    opSkip: (session) => call(() => commands.opSkip(session)),
    opAbort: (session) => voidCall(() => commands.opAbort(session)),
    commitGraphWrite: (session) => voidCall(() => commands.commitGraphWrite(session)),
    remoteAdd: (session, name, url) => voidCall(() => commands.remoteAdd(session, name, url)),
    remoteRename: (session, oldName, newName) =>
      voidCall(() => commands.remoteRename(session, oldName, newName)),
    remoteRemove: (session, name) => voidCall(() => commands.remoteRemove(session, name)),
    remoteSetUrl: (session, name, url) => voidCall(() => commands.remoteSetUrl(session, name, url)),
    fetch: (session, remote, prune) => voidCall(() => commands.fetch(session, remote, prune)),
    pull: (session, mode) => voidCall(() => commands.pull(session, mode)),
    push: (session, spec) => voidCall(() => commands.push(session, spec)),
    listStashes: (session) => call(() => commands.listStashes(session)),
    stashPush: (session, message, includeUntracked, stagedOnly, paths) =>
      voidCall(() => commands.stashPush(session, message, includeUntracked, stagedOnly, paths)),
    stashApply: (session, index) => voidCall(() => commands.stashApply(session, index)),
    stashPop: (session, index) => voidCall(() => commands.stashPop(session, index)),
    stashDrop: (session, index) => voidCall(() => commands.stashDrop(session, index)),
    stashFileDiffDocument: (session, oid, path, full, options) =>
      call(() => commands.stashFileDiffDocument(session, oid, path, full, options ?? null)),
    stashFiles: (session, oid) => call(() => commands.stashFiles(session, oid)),
    suggestWorktreePath: (session, branch) =>
      call(() => commands.suggestWorktreePath(session, branch)),
    worktreeAdd: (session, path, source) => call(() => commands.worktreeAdd(session, path, source)),
    worktreeRemoveCheck: (session, path) => call(() => commands.worktreeRemoveCheck(session, path)),
    worktreeRemove: (session, path, force, deleteBranch) =>
      voidCall(() => commands.worktreeRemove(session, path, force, deleteBranch)),
    worktreePrune: (session) => voidCall(() => commands.worktreePrune(session)),
    openFolder: (path, onEvent) => {
      const channel = new Channel<SessionEvent>();
      channel.onmessage = onEvent;
      return call(() => commands.openFolder(path, channel));
    },
    folderSummaries: (session, repos) =>
      call(() => commands.folderSummaries(session, [...(repos ?? [])])),
    folderRescan: (session) => call(() => commands.folderRescan(session)),
    closeFolder: (session) => voidCall(() => commands.closeFolder(session)),
    folderOpenRepoSession: (session, repo, onEvent) => {
      const channel = new Channel<SessionEvent>();
      channel.onmessage = onEvent;
      return call(() => commands.folderOpenRepoSession(session, repo, channel));
    },
    folderReleaseRepoSession: (session, repoSession) =>
      call(() => commands.folderReleaseRepoSession(session, repoSession)),
    scanRepos: (root) => call(() => commands.scanRepos(root)),
    cloneRepo: (request, onEvent) => {
      const channel = new Channel<SessionEvent>();
      channel.onmessage = onEvent;
      return call(() => commands.cloneRepo(request, channel));
    },
    initRepo: (path, defaultBranch, template) =>
      call(() => commands.initRepo(path, defaultBranch, template)),
    gitignoreTemplates: () => call(() => commands.gitignoreTemplates()),
    recentList: () => call(() => commands.recentList()),
    recentPin: (path, pinned) => voidCall(() => commands.recentPin(path, pinned)),
    recentRemove: (path) => voidCall(() => commands.recentRemove(path)),
    openTabsGet: () => call(() => commands.openTabsGet()),
    openTabsSet: (paths) => voidCall(() => commands.openTabsSet(paths)),
    submodules: (session) => call(() => commands.submodules(session)),
    submoduleUpdate: (session, recursive) =>
      voidCall(() => commands.submoduleUpdate(session, recursive)),
    takeStartupPaths: () => call(() => commands.takeStartupPaths()),
    subscribeAppEvents: (onEvent) => {
      const channel = new Channel<AppEvent>();
      channel.onmessage = onEvent;
      return voidCall(() => commands.subscribeAppEvents(channel));
    },
    conflicts: (session) => call(() => commands.conflicts(session)),
    conflictFile: (session, path) => call(() => commands.conflictFile(session, path)),
    resolveFile: (session, path, content, allowConflictMarkers) =>
      voidCall(() => commands.resolveFile(session, path, content, allowConflictMarkers)),
    resolveSide: (session, path, side) => voidCall(() => commands.resolveSide(session, path, side)),
    resolveDelete: (session, path, keep) =>
      voidCall(() => commands.resolveDelete(session, path, keep)),
    unresolve: (session, path, mode) => voidCall(() => commands.unresolve(session, path, mode)),
    credentialReply: (reqId, secret, remember) =>
      voidCall(() => commands.credentialReply(reqId, secret, remember)),
    credentialForget: (target) => voidCall(() => commands.credentialForget(target)),
    externalAppsGet: () => call(() => commands.externalAppsGet()),
    externalAppsSet: (apps) => voidCall(() => commands.externalAppsSet(apps)),
    openExternal: (kind, path) => voidCall(() => commands.openExternal(kind, path)),
    autoFetchGet: () => call(() => commands.autoFetchGet()),
    autoFetchSet: (minutes) => voidCall(() => commands.autoFetchSet(minutes)),
    systemLocale: () => call(() => commands.systemLocale()),
    setLanguage: (lang) => voidCall(() => commands.setLanguage(lang)),
    undoState: (session) => call(() => commands.undoState(session)),
    undo: (session) => call(() => commands.undo(session)),
    redo: (session) => call(() => commands.redo(session)),
    backups: (session) => call(() => commands.backups(session)),
    backupRestore: (session, backup, newBranch) =>
      voidCall(() => commands.backupRestore(session, backup, newBranch)),
    backupDelete: (session, backup) => voidCall(() => commands.backupDelete(session, backup)),
    reflog: (session, reference, limit) => call(() => commands.reflog(session, reference, limit)),
    reflogRestore: (session, oid, newBranch) =>
      voidCall(() => commands.reflogRestore(session, oid, newBranch)),
    worktreeLock: (session, path, reason) =>
      voidCall(() => commands.worktreeLock(session, path, reason)),
    worktreeUnlock: (session, path) => voidCall(() => commands.worktreeUnlock(session, path)),
    ignoreAdd: (session, patterns) => voidCall(() => commands.ignoreAdd(session, patterns)),
    commitTemplates: (session) => call(() => commands.commitTemplates(session)),
    commitTemplatesSet: (templates) => voidCall(() => commands.commitTemplatesSet(templates)),
    appCommitTemplates: () => call(() => commands.appCommitTemplates()),
    removeIndexLock: (session) => call(() => commands.removeIndexLock(session)),
    rebasePlanCommits: (session, onto) => call(() => commands.rebasePlanCommits(session, onto)),
    rebaseInteractive: (session, plan) => call(() => commands.rebaseInteractive(session, plan)),
    rewordCommit: (session, oid, message) =>
      call(() => commands.rewordCommit(session, oid, message)),
    squashIntoParent: (session, oid) => call(() => commands.squashIntoParent(session, oid)),
    worktreeWips: (session) => call(() => commands.worktreeWips(session)),
    graphQuery: (session) => call(() => commands.graphQuery(session)),
    setGraphQuery: (session, query) => voidCall(() => commands.setGraphQuery(session, query)),
    graphAuthors: (session) => call(() => commands.graphAuthors(session)),
    graphLayoutPrefs: (session) => call(() => commands.graphLayoutPrefs(session)),
    setGraphLayoutPrefs: (session, prefs) =>
      voidCall(() => commands.setGraphLayoutPrefs(session, prefs)),
    resolveRevision: (session, rev) => call(() => commands.resolveRevision(session, rev)),
    blameContents: (session, path, text, ignoreWhitespace) =>
      call(() => commands.blameContents(session, path, text, ignoreWhitespace)),
    revisionFileContent: (session, rev, path) =>
      call(() => commands.revisionFileContent(session, rev, path)),
    compareLocalFiles: (session, base, drafts) =>
      call(() => commands.compareLocalFiles(session, base, drafts)),
    compareLocalDocument: (session, base, path, draft, options, full) =>
      call(() => commands.compareLocalDocument(session, base, path, draft, options, full)),
    blame: (session, path, rev, ignoreWhitespace) =>
      call(() => commands.blame(session, path, rev, ignoreWhitespace)),
    fileHistory: (session, path, limit) => call(() => commands.fileHistory(session, path, limit)),
    comparisonCommits: (session, include, exclude) =>
      call(() => commands.comparisonCommits(session, include, exclude)),
    compareRefs: (session, a, b, threeDot) =>
      call(() => commands.compareRefs(session, a, b, threeDot)),
    compareFileDiff: (session, a, b, threeDot, path, options, full) =>
      call(() => commands.compareFileDiff(session, a, b, threeDot, path, options, full)),
    compareFileDiffDocument: (session, a, b, threeDot, path, options, full) =>
      call(() => commands.compareFileDiffDocument(session, a, b, threeDot, path, options, full)),
    rangeFiles: (session, newer, older) => call(() => commands.rangeFiles(session, newer, older)),
    searchAdvanced: (session, query, limit) =>
      call(() => commands.searchAdvanced(session, query, limit)),
    openDifftool: (session, target) => voidCall(() => commands.openDifftool(session, target)),
    signingInfo: (session) => call(() => commands.signingInfo(session)),
    commitSignature: (session, oid) => call(() => commands.commitSignature(session, oid)),
    scanStagedSecrets: (session) => call(() => commands.scanStagedSecrets(session)),
    secretIgnores: () => call(() => commands.secretIgnores()),
    secretIgnoresSet: (list) => voidCall(() => commands.secretIgnoresSet(list)),
    repoSettings: (session) => call(() => commands.repoSettings(session)),
    setUser: (session, name, email) => voidCall(() => commands.setUser(session, name, email)),
    writeGitignore: (session, text) => voidCall(() => commands.writeGitignore(session, text)),
    perfStatus: (session) => call(() => commands.perfStatus(session)),
    enablePerf: (session) => voidCall(() => commands.enablePerf(session)),
    unshallow: (session) => call(() => commands.unshallow(session)),
    notify: (title, body) => voidCall(() => commands.notify(title, body)),
    hostingAccounts: () => call(() => commands.hostingAccounts()),
    hostingOauth: () => call(() => commands.hostingOauth()),
    hostingOauthSet: (config) => voidCall(() => commands.hostingOauthSet(config)),
    hostingAddPat: (kind, host, token) => call(() => commands.hostingAddPat(kind, host, token)),
    hostingDeviceStart: (kind, host) => call(() => commands.hostingDeviceStart(kind, host)),
    hostingDeviceFinish: (kind, host, codes) =>
      call(() => commands.hostingDeviceFinish(kind, host, codes)),
    hostingRemove: (id) => voidCall(() => commands.hostingRemove(id)),
    hostingRepos: (accountId, page, search) =>
      call(() => commands.hostingRepos(accountId, page, search)),
    hostingUrls: (kind, host) => call(() => commands.hostingUrls(kind, host)),
    profiles: () => call(() => commands.profiles()),
    profilesSet: (list) => call(() => commands.profilesSet(list)),
    applyProfile: (session, profileId) => voidCall(() => commands.applyProfile(session, profileId)),
    sshKeys: () => call(() => commands.sshKeys()),
    sshKeygen: (name, comment, passphrase) =>
      call(() => commands.sshKeygen(name, comment, passphrase)),
    openUrl: (url) => voidCall(() => commands.openUrl(url)),
    hostingRemoteProject: (session) => call(() => commands.hostingRemoteProject(session)),
    pullRequests: (session) => call(() => commands.pullRequests(session)),
    prTemplates: (session) => call(() => commands.prTemplates(session)),
    createPullRequest: (session, spec) => call(() => commands.createPullRequest(session, spec)),
    checkoutPullRequest: (session, number, worktree) =>
      call(() => commands.checkoutPullRequest(session, number, worktree)),
    avatar: (email) => call(() => commands.avatar(email)),
    folderSettings: (session) => call(() => commands.folderSettings(session)),
    folderSettingsSet: (session, settings) =>
      voidCall(() => commands.folderSettingsSet(session, settings)),
    folderBatch: (session, op, repos) => call(() => commands.folderBatch(session, op, repos)),
    folderChanges: (session, repos) =>
      call(() => commands.folderChanges(session, [...(repos ?? [])])),
    folderBranches: (session, repos) =>
      call(() => commands.folderBranches(session, [...(repos ?? [])])),
    folderStage: (session, repo, target) => call(() => commands.folderStage(session, repo, target)),
    folderUnstage: (session, repo, target) =>
      call(() => commands.folderUnstage(session, repo, target)),
    folderCommit: (session, repos, message, stageAll) =>
      call(() => commands.folderCommit(session, repos, message, stageAll)),
    folderTimelineOpen: (session) => call(() => commands.folderTimelineOpen(session)),
    folderTimelineInfo: (session) => call(() => commands.folderTimelineInfo(session)),
    folderTimelineReload: (session) => voidCall(() => commands.folderTimelineReload(session)),
    folderTimelineQuerySet: (session, query) =>
      voidCall(() => commands.folderTimelineQuerySet(session, query)),
    folderTimelineScopeSet: (session, repos) =>
      voidCall(() => commands.folderTimelineScopeSet(session, repos)),
    folderTimelineAuthors: (session) => call(() => commands.folderTimelineAuthors(session)),
    folderTimelinePrefsSet: (session, prefs) =>
      voidCall(() => commands.folderTimelinePrefsSet(session, prefs)),
    folderTimelineWindow: (session, start, count) =>
      call(() => commands.folderTimelineWindow(session, start, count)),
    folderTimelineFindRow: (session, repo, oid) =>
      call(() => commands.folderTimelineFindRow(session, repo, oid)),
    folderCommitDetail: (session, repo, oid) =>
      call(() => commands.folderCommitDetail(session, repo, oid)),
    folderCommitContainingRefs: (session, repo, oid) =>
      call(() => commands.folderCommitContainingRefs(session, repo, oid)),
    folderCommitFileDiff: (session, repo, oid, path, oldPath, full, options) =>
      call(() =>
        commands.folderCommitFileDiff(session, repo, oid, path, oldPath, full, options ?? null),
      ),
    folderCommitFileDiffDocument: (session, repo, oid, path, oldPath, full, options) =>
      call(() =>
        commands.folderCommitFileDiffDocument(
          session,
          repo,
          oid,
          path,
          oldPath,
          full,
          options ?? null,
        ),
      ),
    fsPrepareOperation: (request) => call(() => commands.fsPrepareOperation(request)),
    fsExecuteOperation: (id, decisions) => call(() => commands.fsExecuteOperation(id, decisions)),
    fsCancelOperation: (id) => voidCall(() => commands.fsCancelOperation(id)),
    fsOperationProgress: (id) => call(() => commands.fsOperationProgress(id)),
    fsRegisterDrop: (paths) => call(() => commands.fsRegisterDrop(paths)),
    fsClipboardRead: () => call(() => commands.fsClipboardRead()),
    fsClipboardWrite: (sources, cut) => voidCall(() => commands.fsClipboardWrite(sources, cut)),
    fsRecoveryWarnings: () => call(() => commands.fsRecoveryWarnings()),
    workspaceSearch: (session, request, query) =>
      call(() => commands.workspaceSearch(session, request, query)),
    workspaceSearchCancel: (session, request) => commands.workspaceSearchCancel(session, request),
    fsListDir: (session, dir, limit) => call(() => commands.fsListDir(session, dir, limit ?? null)),
    fsReadFile: (session, path) => call(() => commands.fsReadFile(session, path)),
    fsReadImage: (session, path) => call(() => commands.fsReadImage(session, path)),
    fsReadEditableFile: (session, path) => call(() => commands.fsReadEditableFile(session, path)),
    fsSaveFile: (session, path, expectedRevision, text) =>
      call(() => commands.fsSaveFile(session, path, expectedRevision, text)),
    submodulePointerLog: (session, path, old, newOid) =>
      call(() => commands.submodulePointerLog(session, path, old, newOid)),
    submoduleAdd: (session, url, path, branch) =>
      voidCall(() => commands.submoduleAdd(session, url, path, branch)),
    submoduleAdopt: (session, path) => voidCall(() => commands.submoduleAdopt(session, path)),
    submoduleRemove: (session, path) => voidCall(() => commands.submoduleRemove(session, path)),
    submoduleSetBranch: (session, path, branch) =>
      voidCall(() => commands.submoduleSetBranch(session, path, branch)),
    submoduleUpdateRemote: (session, path, mode) =>
      voidCall(() => commands.submoduleUpdateRemote(session, path, mode)),
    submoduleSync: (session) => voidCall(() => commands.submoduleSync(session)),
    submoduleBatch: (session, op, paths) => call(() => commands.submoduleBatch(session, op, paths)),
    submoduleUnpushed: (session) => call(() => commands.submoduleUnpushed(session)),
    modules: (session) => call(() => commands.modules(session)),
    moduleOverrides: (session) => call(() => commands.moduleOverrides(session)),
    moduleOverridesSet: (session, overrides) =>
      voidCall(() => commands.moduleOverridesSet(session, overrides)),
    moduleScope: (session) => call(() => commands.moduleScope(session)),
    moduleScopeSet: (session, path) => voidCall(() => commands.moduleScopeSet(session, path)),
    mergePreview: (session, reference, strategy, includeWip) =>
      call(() => commands.mergePreview(session, reference, strategy, includeWip)),
    mergeSimulate: (session, reference, includeWip) =>
      call(() => commands.mergeSimulate(session, reference, includeWip)),
    previewFile: (session, tree, path) => call(() => commands.previewFile(session, tree, path)),
    conflictRadar: (session, max, includeWip) =>
      call(() => commands.conflictRadar(session, max, includeWip)),
    rebasePreview: (session, onto) => call(() => commands.rebasePreview(session, onto)),
    mergeWithOptions: (session, reference, mode, strategy) =>
      call(() => commands.mergeWithOptions(session, reference, mode, strategy)),
    isolatedMerge: (session, reference, mode) =>
      call(() => commands.isolatedMerge(session, reference, mode)),
    isolatedInfo: (session) => call(() => commands.isolatedInfo(session)),
    isolatedApply: (session) => call(() => commands.isolatedApply(session)),
    isolatedDiscard: (session) => call(() => commands.isolatedDiscard(session)),
    renameConflicts: (session) => call(() => commands.renameConflicts(session)),
    resolveRename: (session, conflict, keep) =>
      call(() => commands.resolveRename(session, conflict, keep)),
    conflictOrigins: (session, path) => call(() => commands.conflictOrigins(session, path)),
    conflictRules: (session) => call(() => commands.conflictRules(session)),
    conflictRulesSet: (session, rules) => voidCall(() => commands.conflictRulesSet(session, rules)),
    conflictRulesApply: (session) => call(() => commands.conflictRulesApply(session)),
    mergeToolName: (session) => call(() => commands.mergeToolName(session)),
    openMergetool: (session, path) => voidCall(() => commands.openMergetool(session, path)),
    resolutionReview: (session, path) => call(() => commands.resolutionReview(session, path)),
    remergeDiff: (session, oid) => call(() => commands.remergeDiff(session, oid)),
    keptResolutions: (session) => call(() => commands.keptResolutions(session)),
    reapplyResolutions: (session) => call(() => commands.reapplyResolutions(session)),
    keptClear: (session) => voidCall(() => commands.keptClear(session)),
    rerereStatus: (session) => call(() => commands.rerereStatus(session)),
    rerereSet: (session, enabled, autoupdate) =>
      voidCall(() => commands.rerereSet(session, enabled, autoupdate)),
    rerereForget: (session, path) => voidCall(() => commands.rerereForget(session, path)),
    syntaxCompare: (session, path, content) =>
      call(() => commands.syntaxCompare(session, path, content)),
    verifyCommand: (session) => call(() => commands.verifyCommand(session)),
    verifyCommandSet: (session, cmd) => voidCall(() => commands.verifyCommandSet(session, cmd)),
    runVerify: (session) => call(() => commands.runVerify(session)),
    worktreeInitCommand: (session) => call(() => commands.worktreeInitCommand(session)),
    worktreeInitCommandSet: (session, cmd) =>
      voidCall(() => commands.worktreeInitCommandSet(session, cmd)),
    runWorktreeInit: (session, path) => call(() => commands.runWorktreeInit(session, path)),
    lfsStatus: (session) => call(() => commands.lfsStatus(session)),
    lfsInstall: (session) => voidCall(() => commands.lfsInstall(session)),
    lfsTrack: (session, pattern) => voidCall(() => commands.lfsTrack(session, pattern)),
    lfsUntrack: (session, pattern) => voidCall(() => commands.lfsUntrack(session, pattern)),
    lfsLock: (session, path) => voidCall(() => commands.lfsLock(session, path)),
    lfsUnlock: (session, path, force) => voidCall(() => commands.lfsUnlock(session, path, force)),
    ptyOpen: (cwd, cols, rows, onEvent) => {
      const channel = new Channel<PtyEvent>();
      channel.onmessage = onEvent;
      return call(() => commands.ptyOpen(cwd, cols, rows, channel));
    },
    ptyWrite: (id, data) => voidCall(() => commands.ptyWrite(id, data)),
    ptyResize: (id, cols, rows) => voidCall(() => commands.ptyResize(id, cols, rows)),
    ptyClose: (id) => voidCall(() => commands.ptyClose(id)),
  };
}
