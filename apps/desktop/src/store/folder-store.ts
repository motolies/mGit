import type { GraphScrollAnchor } from '@mgit/graph-view';
import {
  type AuthorList,
  type AutoFetchedRepo,
  type BatchOp,
  type BatchResult,
  type BranchDeleteTarget,
  type CloneBatchRequest,
  type CommitDetail,
  type DiffDocument,
  type DiffOptions,
  EMPTY_COMMIT_FILTER,
  type FolderBranch,
  type FolderBranches,
  type FolderOpened,
  type FolderSettings,
  type FoundRepo,
  folderTimelineSource,
  type GraphLayoutPrefs,
  type GraphQuery,
  GraphRangeCache,
  type GraphRevs,
  type GroupInfo,
  type IndexTarget,
  type IndexWriteResult,
  type IpcClient,
  isListModeQuery,
  type RepoChanges,
  type RepoCommitMessage,
  type RepoSummary,
  type SessionEvent,
  type TimelineInfo,
  toIpcError,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { createStore, type StoreApi } from 'zustand';
import { commandFailed, type FolderLogEntry, prependCapped } from './command-log';
import { type ContainingEntry, createContainingLoader } from './containing-loader';
import { describeError } from './errors';
import { createFileTree, type FileTreeStore, type SelectionSet } from './file-tree';
import { notifyHub } from './notify';
import { dirSpace, groupSpace, type RootSpace } from './root-space';

/**
 * 대시보드 필터 (하나만 고른다): 전체 / 변경 있음 / 뒤처짐(받을 것) / 보낼 것 있음 / 업스트림 없음(branch 는 있는데
 * 업스트림이 없음 — 분리 HEAD·상태를 못 읽은 줄은 빠진다) / stash 있음 / 진행 중
 */
export type FolderFilter =
  | 'all'
  | 'changed'
  | 'behind'
  | 'ahead'
  | 'noUpstream'
  | 'stashed'
  | 'inProgress';
export type FolderSort = 'name' | 'changed' | 'behind' | 'stash';

/** 폴더 stage·unstage 의 방향 (Commit 도구 창의 체크 = stage, 해제 = unstage) */
export type IndexOp = 'stage' | 'unstage';

/** 저장소 하나에 돌고 있는 stage·unstage (W14). 끝나고 다시 읽은 값이 실릴 때까지 남는다 */
export interface IndexWriteInFlight {
  op: IndexOp;
  target: IndexTarget;
}

/**
 * stage·unstage 의 결과: 끝났음(코어 결과 — 건너뛴 충돌 경로 포함) / 같은 저장소에 이미 돌고 있거나 일괄 작업 중이라
 * 부르지 않았음 / 실패(사유)
 */
export type IndexWriteOutcome =
  | { kind: 'done'; result: IndexWriteResult }
  | { kind: 'busy' }
  | { kind: 'failed'; error: string };

/** 감시 이벤트가 몰릴 때 요약 재조회를 묶는 시간 */
const REFRESH_DEBOUNCE_MS = 400;
/** ref 변경 뒤 타임라인 재로드를 묶는 시간 */
const TIMELINE_DEBOUNCE_MS = 1500;
/** 폴더 설정을 아직 못 읽었을 때의 주기 재조회 간격 (MR-03) */
const DEFAULT_AUTO_REFRESH_MS = 60_000;

/** 주기 재조회 간격 (ms). 폴더 설정의 초 단위 값을 따르고 0 이면 주기 재조회를 끈다 (MR-11) */
export function autoRefreshMs(settings: Pick<FolderSettings, 'autoRefreshSecs'> | null): number {
  const secs = settings?.autoRefreshSecs;
  return secs === null || secs === undefined ? DEFAULT_AUTO_REFRESH_MS : Math.max(0, secs) * 1000;
}

/** 타임라인 기본 질의: 날짜순 전체 */
export const DEFAULT_TIMELINE_QUERY: GraphQuery = {
  revs: { kind: 'all' },
  hideRemotes: false,
  pathScope: [],
  sort: 'date',
  firstParent: false,
  noMerges: false,
  filter: EMPTY_COMMIT_FILTER,
};

/**
 * 타임라인 레이아웃 설정의 처음 값 (코어 `GraphLayoutPrefs::default` — 폴더를 열 때마다 코어도 이 값에서 시작한다).
 * 타임라인이 지키는 것은 긴 엣지 접기뿐이다 (고정 레인·ref 색은 타임라인 레이아웃이 쓰지 않는다: `timeline_options`)
 */
export const DEFAULT_TIMELINE_PREFS: GraphLayoutPrefs = {
  pinHead: true,
  refColors: true,
  collapseLongEdges: true,
};

/**
 * 로그 필터의 작성자 후보 (W17). 드롭다운을 열 때 읽고(`loadTimelineAuthors`), 저장소 범위·ref 가 바뀌거나 재스캔하면
 * 낡은 것으로 보고(`idle`) 다음에 열 때 다시 읽는다. `list` 는 다시 읽는 동안에도 남겨 단추의 이름 표시에 쓴다
 */
export interface TimelineAuthors {
  state: 'idle' | 'loading' | 'ready' | 'error';
  list: AuthorList | null;
  error: string | null;
}

/** 타임라인 정보의 저장소 범위 (경로). 범위가 없으면(전부) 빈 목록 */
export function scopeOfInfo(info: TimelineInfo): string[] {
  return info.scoped ? info.repos.filter((r) => r.inScope).map((r) => r.path) : [];
}

/** 선택이 새 저장소 범위에도 남는지. 선택이 없거나 범위가 전부면 남는다 */
export function selectionInScope(
  selected: TimelineSelection | null,
  scope: readonly string[],
): boolean {
  return selected === null || scope.length === 0 || scope.includes(selected.repoPath);
}

/** 두 경로 목록이 같은 집합인지 */
function samePaths(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((p) => set.has(p));
}

/** 작업 기록의 상한 (폴더 탭마다, 메모리에만 둔다) */
export const TASK_HISTORY_CAPACITY = 100;

/** 작업 기록 한 줄의 종류: 일괄 작업 / 일괄 commit / 자동 fetch */
export type TaskKind = 'batch' | 'commit' | 'autoFetch';

/**
 * 작업 기록 한 줄 (Git 도구 창의 작업 기록 탭). 일괄 작업·commit 은 결과(`result`)나 실행하지 못한 사유(`error`)를,
 * 자동 fetch 는 바뀌었거나 실패한 저장소(`autoFetch`)를 담는다. `repeat` 은 같은 실패만 이어진 자동 fetch 를 한 줄로
 * 합친 횟수다 (없으면 1번)
 */
export interface TaskEntry {
  id: number;
  kind: TaskKind;
  label: string;
  /** 시작·끝 시각 (epoch ms). 합친 자동 fetch 줄은 끝 시각만 마지막 것으로 바뀐다 */
  startedAt: number;
  finishedAt: number;
  result: BatchResult | null;
  error: string | null;
  autoFetch?: AutoFetchedRepo[];
  repeat?: number;
  /**
   * 일괄 작업을 실행한 인자 (작업과 넘긴 대상 경로, 빈 목록 = 전부). "실패한 저장소만 다시 실행"이 쓴다. 기록은 메모리에만
   * 있어 앱을 다시 켜면 함께 사라진다 (오래된 인자가 남지 않는다). commit·자동 fetch 줄에는 없다
   */
  request?: { op: BatchOp; repos: string[] };
  /**
   * 여러 저장소 clone 줄의 요청 (상위 폴더·대상·옵션). "실패한 저장소만 다시 실행" 이 실패·취소된 대상으로 clone 창을 다시
   * 연다. 메모리에만 있다
   */
  clone?: CloneBatchRequest;
  /** 일괄 명령 줄의 저장소별 출력을 지웠다 (오래된 기록 — `pruneCommandOutputs`). 종료 코드·소요 시간은 남는다 */
  outputsDropped?: boolean;
}

/** 저장소별 출력을 남기는 일괄 명령 기록 수. 그보다 오래된 일괄 명령 줄은 출력만 지운다 (저장소마다 1 MiB 까지라 쌓이면 크다) */
export const COMMAND_OUTPUT_KEEP = 5;

/**
 * 작업 기록에서 최근 `keep` 개를 넘는 일괄 명령 줄의 출력(stdout·stderr)을 지운다 (순수 함수). 종료 코드·소요 시간·잘림
 * 표시는 남기고 `outputsDropped` 를 켠다. 바꿀 것이 없으면 같은 줄 객체를 그대로 둔다
 */
export function pruneCommandOutputs(
  history: readonly TaskEntry[],
  keep: number = COMMAND_OUTPUT_KEEP,
): TaskEntry[] {
  let seen = 0;
  return history.map((entry) => {
    if (!entry.result?.results.some((r) => r.command)) {
      return entry;
    }
    seen++;
    if (seen <= keep || entry.outputsDropped) {
      return entry;
    }
    return {
      ...entry,
      outputsDropped: true,
      result: {
        ...entry.result,
        results: entry.result.results.map((r) =>
          r.command ? { ...r, command: { ...r.command, stdout: '', stderr: '' } } : r,
        ),
      },
    };
  });
}

/** 자동 fetch 에서 실패한 저장소 경로들 */
function autoFetchFailures(repos: readonly AutoFetchedRepo[]): string[] {
  return repos.filter((r) => (r.error ?? null) !== null).map((r) => r.path);
}

/** 자동 fetch 결과에 바뀐 ref 가 하나도 없는지 (실패만 있다) */
function autoFetchQuiet(repos: readonly AutoFetchedRepo[]): boolean {
  return repos.every((r) => r.refs.length === 0);
}

/**
 * 자동 fetch 줄을 작업 기록에 더한다 (순수 함수). 바뀐 ref 없이 실패만 있고, 실패한 저장소가 가장 최근 자동 fetch 줄
 * (그 줄도 실패만)과 같으면 새 줄을 만들지 않는다 — 그 줄을 맨 위로 올리고 끝 시각·저장소 결과·반복 수만 바꾼다.
 * 간격마다 같은 실패가 쌓이지 않게 한다. 그 밖에는 최신을 앞에 붙이고 상한을 넘는 오래된 줄을 버린다
 */
export function appendAutoFetch(
  history: readonly TaskEntry[],
  entry: TaskEntry,
  cap: number = TASK_HISTORY_CAPACITY,
): TaskEntry[] {
  const repos = entry.autoFetch ?? [];
  const index = history.findIndex((e) => e.kind === 'autoFetch');
  const last = history[index];
  const lastRepos = last?.autoFetch ?? [];
  if (
    last &&
    autoFetchQuiet(repos) &&
    autoFetchQuiet(lastRepos) &&
    samePaths(autoFetchFailures(repos), autoFetchFailures(lastRepos))
  ) {
    const merged: TaskEntry = {
      ...last,
      finishedAt: entry.finishedAt,
      autoFetch: repos,
      repeat: (last.repeat ?? 1) + 1,
    };
    return [merged, ...history.slice(0, index), ...history.slice(index + 1)];
  }
  return prependCapped(history, entry, cap);
}

/** 실행하지 못한 일괄 작업의 라벨 (성공·부분 실패는 코어가 결과에 준 라벨을 쓴다) */
function batchOpLabel(op: BatchOp): string {
  return S.folder.history.ops[op.kind];
}

/** 두 ref 범위가 같은지 (종류와 이름 순서까지) */
function sameRevsValue(a: GraphRevs, b: GraphRevs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 브랜치 더블클릭이 건 범위의 기억 (`focusTimelineBranch`): 건 ref 범위, 건 저장소 범위, 걸기 전의 저장소 범위.
 * ref 범위가 다른 것으로 바뀌면 저장소 범위를 걸기 전으로 되돌린다 — 그 사이 사용자가 저장소 범위를 바꿨으면 기억을
 * 버린다 (사용자가 고른 범위를 덮어쓰지 않는다)
 */
interface BranchFocusScope {
  revs: GraphRevs;
  scope: string[];
  before: string[];
}

/**
 * 타임라인에서 고른 커밋. 저장소는 경로로 가리킨다 — 타임라인 행의 저장소 번호는 재스캔으로 저장소
 * 집합이 바뀌면 밀리지만 경로는 그대로라, 다시 읽힌 뒤에도 같은 커밋을 가리킨다. 커밋 상세·diff
 * (`folderCommitDetail`·`folderCommitFileDiff`)도 이 경로로 묻는다
 */
export interface TimelineSelection {
  repoPath: string;
  oid: string;
}

/** 요청한 저장소 범위와 현재 표시 데이터의 범위가 다른지 비교한다. 빈 범위와 전체 명시 선택은 같다. */
export function timelineScopePending(info: TimelineInfo | null, scope: readonly string[]): boolean {
  return (
    info?.repos.some(
      (repo) => repo.inScope !== (scope.length === 0 || scope.includes(repo.path)),
    ) ?? false
  );
}

/** 타임라인 행의 저장소 번호 → 저장소 경로 (번호 == 순번 == `info.repos[].index`). 모르면 null */
export function timelineRepoPath(
  info: TimelineInfo | null,
  repo: number | null | undefined,
): string | null {
  if (info === null || repo === null || repo === undefined) {
    return null;
  }
  return info.repos.find((r) => r.index === repo)?.path ?? null;
}

/** 두 선택이 같은 커밋 행인지 (저장소 경로와 커밋이 모두 같다) */
export function sameSelection(a: TimelineSelection | null, b: TimelineSelection | null): boolean {
  return a !== null && b !== null && a.repoPath === b.repoPath && a.oid === b.oid;
}

/**
 * 고른 커밋의 상세 (LG-07, CD-02). 저장소 세션 없이 폴더 API 로 읽는다 (CD-05). `of` 는 이 상세가 어느
 * 선택의 것인지다 — 선택이 바뀌면 새로 읽고, 늦게 온 옛 응답은 버린다
 */
export interface TimelineDetail {
  of: TimelineSelection;
  state: 'loading' | 'ready' | 'error';
  detail: CommitDetail | null;
  error: string | null;
}

/**
 * 로그에서 보이라고 한 커밋 (W19). blame·파일 히스토리의 해시, 상세의 부모·자식, 충돌 탭의 출처 커밋처럼 로그 밖에서 커밋을
 * 고를 때 쓴다 (로그 행을 직접 누를 때는 쓰지 않는다 — 스크롤을 건드리지 않는다)
 */
export interface TimelineReveal {
  /** 요청 차례 (요청마다 오른다. 늦게 온 옛 찾기 응답을 버린다) */
  seq: number;
  of: TimelineSelection;
  /**
   * `finding` = 지금 질의·범위의 로그에서 찾는 중(로그가 아직 없거나 읽는 중이면 다 읽은 뒤 찾는다), `found` = 그 행이 있다
   * (`row`), `missing` = 지금 질의·범위의 로그에 없다
   */
  state: 'finding' | 'found' | 'missing';
  row: number | null;
  /** `found` 인 행으로 로그가 스크롤했는지 (`ackTimelineReveal`). 로그 탭이 나중에 마운트돼도 한 번 스크롤한다 */
  scrolled: boolean;
}

/** 통합 타임라인 상태 (MR-12) */
export interface TimelineState {
  /** 열어 본 적이 있는지 (처음 탭을 켤 때 로드) */
  opened: boolean;
  cache: GraphRangeCache;
  totalRows: number;
  generation: number;
  loadState: 'idle' | 'loading' | 'complete' | 'error';
  error: string | null;
  info: TimelineInfo | null;
  /**
   * 적용한 질의 (필터 포함). 바꾸면 곧바로 이 값이 되고(필터 바가 고른 값을 바로 보인다) 코어가 잘못된 정규식으로
   * 거부하면 마지막으로 받아들여진 질의로 되돌아간다 (`filterError`)
   */
  query: GraphQuery;
  /**
   * 저장소 범위 (W16 `folderTimelineScopeSet`: 질의 밖의 별도 상태). 저장소 경로, 빈 목록 = 전부. 바꾸면 곧바로 이
   * 값이 되고, 타임라인 정보를 다시 받으면 코어의 범위(`inScope`·`scoped`)로 맞춘다 (재스캔으로 범위의 저장소가
   * 모두 사라지면 코어가 전부로 되돌린다)
   */
  scope: string[];
  /** 텍스트 필터를 적용하지 못한 사유 (잘못된 정규식, `invalidFilter`). 입력을 고치거나 질의를 다시 바꾸면 빈다 */
  filterError: string | null;
  /**
   * 지금 그린 데이터가 그래프 선 없는 목록 모드인지 (`isListModeQuery`). 로그 뷰를 이 값마다 따로 마운트해 레인 폭이
   * 남지 않게 한다 (뷰는 레인 폭을 줄이지 않는다). 그 질의의 데이터가 왔을 때 바뀐다
   */
  listMode: boolean;
  /**
   * 질의·범위를 바꾼 뒤 보던 커밋(스크롤 기준)이 새 결과에 없어 맨 위로 가야 할 때마다 오른다. 로그 탭이 이 값이
   * 바뀌면 맨 위로 스크롤한다 (있으면 뷰가 스스로 그 커밋으로 간다, LG-10)
   */
  scrollReset: number;
  /** 레이아웃 설정 (보기 옵션의 "긴 엣지 접기") */
  prefs: GraphLayoutPrefs;
  /** 로그 필터의 작성자 후보 */
  authors: TimelineAuthors;
  /** 선택한 커밋 (저장소 경로, 커밋). 질의를 바꾸면 비운다. 범위를 바꾸면 그 저장소가 범위에서 빠질 때만 비운다 */
  selected: TimelineSelection | null;
  /**
   * 로그에서 보이라고 한 커밋 (W19, `revealTimelineCommit`). 선택이 다른 커밋으로 바뀌거나 질의·범위가 바뀌면 빈다
   */
  reveal: TimelineReveal | null;
  /**
   * 선택한 커밋의 상세. 선택과 함께 비고, 타임라인이 다시 읽혀도(재로드·재스캔) 선택이 같으면 다시 읽지 않는다
   */
  detail: TimelineDetail | null;
  /**
   * 상세 칸에 보이는 커밋을 포함하는 branch (CD-03). 상세와 따로 뒤늦게 읽는다(`showContaining`). `of` 가
   * 지금 보이는 커밋과 다르면 쓰지 않는다
   */
  containing: ContainingEntry<TimelineSelection> | null;
}

/** 멀티 저장소 폴더 탭 상태 (MR-01~04) */
export interface FolderState {
  id: number;
  /** 세션 키. 폴더 탭은 폴더의 절대 경로, 그룹 탭은 `mgit-group:<id>` 다 (경로 변환은 `space` 로 한다) */
  path: string;
  /**
   * 파일 경로 공간 (MR-13): 트리의 루트 기준 상대 경로와 절대 경로를 잇는다. 폴더 탭은 폴더 디렉터리 하나
   * (`dirSpace(path)`), 그룹 탭은 별칭 공간(`groupSpace`)이다. 그룹 멤버가 바뀔 때만 새 객체가 된다
   */
  space: RootSpace;
  /** 그룹 탭이면 그룹 모습(이름·멤버 상태 — `groupChanged` 로 바뀐다). 폴더 탭은 null */
  group: GroupInfo | null;
  /** 탭 이름. 폴더는 폴더 이름, 그룹은 그룹 이름 */
  name: string;
  repos: FoundRepo[];
  summaries: RepoSummary[];
  /**
   * 브랜치 목록 (PF-03). 아직 못 읽었으면 null. 통합 타임라인과 무관하게 폴더를 열자마자 읽으므로
   * 로그 로드가 끝나기 전에도 브랜치 트리를 그릴 수 있다 (BT-06)
   */
  branches: FolderBranches | null;
  loading: boolean;
  error: string | null;
  filter: FolderFilter;
  sort: FolderSort;
  /** 마지막 요약 시각 (epoch ms) */
  refreshedAt: number | null;
  /// C1 일괄 작업·통합 변경·설정 (커밋 검색은 W17 에서 로그 필터 바로 옮겼다)
  /** "폴더 설정" 대화상자가 열려 있는지 (W12: 개요 탭·프로젝트 트리 루트 메뉴·Project 머리줄이 연다) */
  settingsOpen: boolean;
  batchRunning: boolean;
  /** 도는 일괄 작업의 진행. `opId` 는 취소에 쓰는 코어 작업 id (시작 이벤트가 오기 전이면 없다) */
  batchProgress: { opId: number; label: string; phase: string; percent: number | null } | null;
  /** 일괄 작업 취소를 요청했고 아직 끝나지 않았다 (취소 단추를 끈다) */
  batchCancelling: boolean;
  /**
   * 작업 기록 (Git 도구 창의 작업 기록 탭): 끝난 일괄 작업·commit 과 자동 fetch. 최신이 앞이고 상한은
   * `TASK_HISTORY_CAPACITY`. 메모리에만 두어 폴더 탭을 닫으면 사라진다
   */
  taskHistory: TaskEntry[];
  changes: RepoChanges[];
  changesLoading: boolean;
  /** 변경 목록을 (전부) 읽지 못한 사유 (Commit 도구 창의 오류 상태). 다시 읽으면 비운다 */
  changesError: string | null;
  /**
   * 저장소 경로 → 돌고 있는 stage·unstage (W14, Commit 도구 창). 호출이 끝나고 그 저장소를 다시 읽은 뒤에 빠진다 —
   * 화면은 그동안 그 줄을 "처리 중"으로 보이고 그 저장소의 체크를 막는다 (낙관적 표시를 하지 않는다)
   */
  indexWrites: Readonly<Record<string, IndexWriteInFlight>>;
  settings: FolderSettings | null;
  /// G2 통합 타임라인
  timeline: TimelineState;
  /**
   * 폴더의 파일 트리 (W11, PT-03·08). 만든 뒤 바뀌지 않는 별도 스토어다 — 펼침·선택·나열 상태는 그 안에 있다.
   * 다시 읽기는 이 스토어가 건다: 창 포커스, 재스캔(`folderRescanned`·다시 스캔), 일괄 작업 뒤 (주기 재조회는 걸지 않는다)
   */
  fileTree: FileTreeStore;
  /// W19 ② 폴더 콘솔 (WS-12)
  /**
   * 이 폴더의 저장소에서 돈 쓰기·네트워크 명령의 기록 (`folderCommandLogged`). 최신이 앞이고 상한은 저장소 탭과 같은
   * `LOG_CAPACITY`. 상태를 읽는 명령은 코어가 보내지 않는다. 폴더 탭을 닫으면 사라진다
   */
  commandLog: FolderLogEntry[];
  /** 콘솔을 좁혀 보는 저장소 (기록의 대표 경로). null 이면 전부. 탭을 오가도 남는다 */
  commandLogRepo: string | null;
  /** 콘솔을 보지 않는 동안 쌓인 실패한 명령 수 (콘솔 탭 이름 옆 표시). 콘솔을 보면 0 이 된다 */
  commandLogUnseenFailures: number;

  applyEvent(event: SessionEvent): void;
  /** 콘솔을 그 저장소의 기록으로 좁힌다 (null = 전부) */
  setCommandLogRepo(repo: string | null): void;
  /**
   * 콘솔을 보기 시작한다 (콘솔 탭의 내용이 그려질 때). 지금까지 쌓인 안 본 실패를 비우고, 보는 동안 온 실패는 세지 않는다.
   * 돌려준 함수로 그만 본다 (여러 번 불러도 한 번만 센다)
   */
  viewCommandLog(): () => void;
  /**
   * 요약·브랜치(와 읽어 둔 변경 목록)를 전부 다시 읽는다. 이미 전부 읽는 중이면 그 읽기가 끝나기를 기다린다.
   * 감시 이벤트(`folderChanged`)는 이 함수를 거치지 않고 바뀐 저장소만 다시 읽는다 (PF-02)
   */
  refresh(): Promise<void>;
  /**
   * 그 저장소들의 요약·브랜치·변경을 감시 이벤트와 같은 디바운스·부분 갱신으로 다시 읽는다 (W13). 폴더가 쓰는
   * 저장소 세션의 상태가 바뀌었을 때 — 작업 트리만 바꾸는 쓰기는 `folderChanged` 가 오지 않는다
   */
  refreshRepos(paths: readonly string[]): void;
  /**
   * 창 포커스·주기 재조회를 켠다 (MR-03). 돌려준 함수로 끈다. 간격은 폴더 설정을 따르고 설정이 바뀌면
   * 다시 맞춘다. 폴더 화면이 떠 있는 동안 화면 쪽에서 켜 둔다 (어느 문서를 보고 있든 요약이 갱신된다)
   */
  startAutoRefresh(): () => void;
  rescan(): Promise<void>;
  setFilter(filter: FolderFilter): void;
  setSort(sort: FolderSort): void;
  setSettingsOpen(open: boolean): void;
  /**
   * 고른 저장소의 절대 경로들 (WS-09, PT-07): 프로젝트 트리의 선택(`fileTree` 의 `selection`) 중 저장소 디렉터리인
   * 행. 출처는 트리 선택 하나다 — 개요 탭의 체크박스·브랜치 트리·툴바의 일괄 작업이 모두 이것을 본다.
   * 저장소 목록 순서. 화면은 `useSelectedRepos` 로 구독한다
   */
  selectedRepos(): string[];
  /** 그 저장소를 트리 선택에 넣거나 뺀다 (개요 탭 체크박스). 다른 선택은 그대로다 */
  toggleSelect(path: string): void;
  /** 고른 저장소를 정확히 이 목록으로 맞춘다 (저장소가 아닌 트리 선택은 그대로다) */
  setSelected(paths: readonly string[]): void;
  /**
   * 일괄 작업을 실행한다. `repos` 를 주지 않으면 고른 저장소(`selectedRepos()`)가 대상이다.
   * 어느 쪽이든 빈 목록은 "전부"를 뜻한다. 실행하지 못했으면 null (사유는 `error`). 끝나면 결과나 사유를 작업 기록에
   * 남긴다 (이미 일괄 작업 중이라 부르지 않았으면 남기지 않는다)
   */
  inspectIntegration(
    reference: string,
    repos: readonly string[],
  ): ReturnType<IpcClient['folderIntegrationPreview']>;
  /**
   * 일괄 스태시 묶음 (최근 묶음부터): 저장소들의 stash 목록에서 묶음 표시를 모은다. 빈 목록은 전부. 작업 기록과 상관없이
   * 저장소에서 읽는다 (일괄 스태시 꺼내기의 묶음 고르기·저장소 체크 목록)
   */
  listStashBatches(repos: readonly string[]): ReturnType<IpcClient['folderStashBatches']>;
  runBatch(op: BatchOp, repos?: readonly string[]): Promise<BatchResult | null>;
  /**
   * 도는 일괄 작업을 취소한다 (`cancelOperation`). 아직 시작하지 않은 저장소는 "취소됨", 실행 중이던 fetch·push 는 멈추고
   * 나머지 실행 중 작업은 끝까지 둔다 — 결과는 `runBatch` 가 평소처럼 돌려준다. 도는 작업이 없거나 이미 취소를 요청했으면
   * 아무것도 하지 않는다 (중복 클릭·끝난 직후 클릭). 코어가 받았는지를 돌려준다
   */
  cancelBatch(): Promise<boolean>;
  inspectRemoteBranchDeletion(remote: string, name: string): Promise<BranchDeleteTarget[]>;
  /** 작업 기록을 비운다 (작업 기록 탭의 "기록 지우기") */
  clearTaskHistory(): void;
  /**
   * 끝난 여러 저장소 clone 을 작업 기록에 남긴다 (clone 은 폴더 밖에서 시작해 끝난 뒤 이 폴더 탭을 연다). 요청을 함께 남겨
   * "실패한 저장소만 다시 실행" 이 쓴다
   */
  recordClone(result: BatchResult, request: CloneBatchRequest, startedAt: number): void;
  loadChanges(): Promise<void>;
  /**
   * 변경 목록을 아직 읽지 않았으면 한 번 읽는다 (프로젝트 트리의 파일 상태 색, PT-06). 한 번 읽은 뒤에는 전체
   * 갱신과 저장소별 부분 갱신(`folderChanged`)이 함께 다시 읽는다
   */
  ensureChanges(): void;
  /**
   * 저장소 하나를 stage·unstage 한다 (W14, `folderStage`·`folderUnstage`). 같은 저장소에 이미 돌고 있거나 일괄 작업
   * (일괄 커밋 포함) 중이면 부르지 않는다(`busy`). 빈 경로 목록은 보내지 않는다(아무것도 하지 않은 결과). 코어가 쓰기를
   * 돌렸으면 그 저장소의 요약·브랜치·변경을 곧바로 다시 읽고(감시 이벤트의 디바운스를 기다리지 않는다) 그 값이 실린
   * 뒤에 끝난다. 실패하면 상태를 바꾸지 않고 사유를 돌려준다
   */
  writeIndex(repo: string, op: IndexOp, target: IndexTarget): Promise<IndexWriteOutcome>;
  /**
   * 일괄 커밋 (`folderCommit`). 실행 중에는 `batchRunning` 이다. 끝나면 대상 저장소의 요약·브랜치·변경을 다시 읽은
   * 뒤에 결과를 돌려준다 (Commit and Push 의 push 확인창이 새 ahead 를 보도록). 부르지 못했으면 null. 결과나 사유를
   * 작업 기록에 남긴다. `repoMessages` 의 저장소는 자기 메시지로 커밋한다 (없으면 모두 공통 메시지 — 옛 호출 그대로)
   */
  commitAll(
    repos: string[],
    message: string,
    stageAll: boolean,
    repoMessages?: RepoCommitMessage[],
  ): Promise<BatchResult | null>;
  loadSettings(): Promise<void>;
  /** 성공 여부. 실패 사유는 `error` 에 남긴다 */
  saveSettings(settings: FolderSettings): Promise<boolean>;
  /** 타임라인 탭을 처음 켤 때: 코어에 열기를 요청하고 정보를 받는다 */
  openTimeline(): Promise<void>;
  reloadTimeline(): Promise<void>;
  /** 타임라인 정보를 다시 받는다. 저장소 범위를 바꾸는 요청이 돌고 있지 않으면 범위도 코어의 값으로 맞춘다 */
  refreshTimelineInfo(): Promise<void>;
  /**
   * 질의(필터 포함)를 바꾼다. 곧바로 그 질의가 되고 선택·상세를 비운다(읽는 중으로 표시). 코어가 잘못된 정규식으로
   * 거부하면(`invalidFilter`) 마지막으로 받아들여진 질의와 그때의 선택으로 되돌리고 사유를 `filterError` 에 둔다 —
   * 로그는 다시 읽히지 않았으므로 이전 결과가 그대로다
   */
  setTimelineQuery(query: GraphQuery): Promise<void>;
  /**
   * 저장소 범위를 바꾼다 (빈 목록 = 전부, "이 저장소만 보기"). 곧바로 그 범위가 되고, 고른 커밋의 저장소가 범위에서
   * 빠지면 선택을 비운다. 작성자 후보는 낡은 것으로 본다. 실패하면 이전 범위로 되돌리고 사유를 `error` 에 둔다
   */
  setTimelineScope(repos: readonly string[]): Promise<void>;
  /**
   * 브랜치 더블클릭·Enter: ref 범위와 저장소 범위를 함께 건다 (그 branch 와 기본 branch, 그 branch 가 있는 저장소). 걸기
   * 전의 저장소 범위를 기억했다가, 뒤에 ref 범위가 다른 것으로 바뀌면(클릭·HEAD 행·다른 더블클릭·branch 필터 해제)
   * 그 범위로 되돌린다. 그 사이 사용자가 저장소 범위를 직접 바꿨으면 되돌리지 않는다. 더블클릭이 이어지면 처음 걸기
   * 전의 범위를 계속 기억한다
   */
  focusTimelineBranch(revs: GraphRevs, repos: readonly string[]): Promise<void>;
  /** 타임라인 레이아웃 설정을 바꾼다 (보기 옵션의 긴 엣지 접기). 실패하면 이전 값으로 되돌린다 */
  setTimelinePrefs(prefs: GraphLayoutPrefs): Promise<void>;
  /** 필터 오류 표시를 지운다 (입력을 고쳤을 때) */
  clearFilterError(): void;
  /**
   * 작성자 후보를 읽는다 (드롭다운을 열 때). `force` 가 아니면 이미 읽었거나 읽는 중인 후보를 그대로 쓴다. 마지막
   * 요청의 응답만 반영하고, 그사이 범위가 바뀌었으면 응답을 버린다
   */
  loadTimelineAuthors(force: boolean): void;
  /**
   * 타임라인의 커밋을 고르고 그 상세를 읽는다 (LG-07). 저장소는 경로로 준다 (행의 번호는 `timelineRepoPath`
   * 로 바꾼다). 이미 고른 커밋이면 아무것도 하지 않는다 — 상세를 읽지 못했던 경우만 다시 읽는다.
   * 빠르게 여러 행을 고르면 마지막 선택의 응답만 반영한다
   */
  selectTimelineRow(repoPath: string, oid: string): void;
  clearTimelineSelection(repoPath: string, oid: string): void;
  /**
   * 로그 밖에서 커밋을 고르고 로그에서 그 행을 보이게 한다 (W19: blame·히스토리 해시, 상세의 부모·자식, 충돌 탭의 출처).
   * 고르기는 `selectTimelineRow` 와 같고, 지금 질의·범위의 로그에서 행을 찾아 `timeline.reveal` 에 둔다 — 찾으면 로그 탭이
   * 그 행으로 스크롤하고, 없으면 로그 위에 "지금 필터에는 없는 커밋" 안내가 뜬다. 로그를 아직 열지 않았거나 읽는 중이면
   * 다 읽은 뒤 찾는다
   */
  revealTimelineCommit(repoPath: string, oid: string): void;
  /** 로그가 `seq` 의 찾은 행으로 스크롤했다 */
  ackTimelineReveal(seq: number): void;
  /**
   * 다음 질의·범위 변경의 첫 데이터가 오면 그 커밋을 다시 고르고 보이게 한다 (W19 "필터 지우고 보기": 필터를 지우면
   * 선택이 비므로 다 읽은 뒤 다시 고른다). 부르는 쪽이 이어서 질의·범위를 바꾼다
   */
  revealOnNextLoad(target: TimelineSelection): void;
  /** 고른 커밋의 상세를 다시 읽는다 (오류 뒤 "다시 시도") */
  reloadTimelineDetail(): void;
  /**
   * 상세 칸에 지금 보이는 커밋을 알린다 (null = 없음, CD-03). 짧은 디바운스 뒤에 포함 branch 를 읽고 —
   * 로그를 빠르게 훑는 동안은 읽지 않는다 — 읽어 둔 커밋은 다시 읽지 않는다. 그 저장소의 ref 가 바뀌면
   * (`folderChanged` 의 refs, 재스캔, 전체 갱신에서 브랜치 목록이 달라짐) 읽어 둔 것을 버리고 지금 보이는
   * 커밋만 다시 읽는다
   */
  showContaining(selection: TimelineSelection | null): void;
  /** 지금 보이는 커밋의 포함 branch 를 바로 다시 읽는다 (시간 초과·오류 뒤 "다시 시도") */
  retryContaining(): void;
  /**
   * 폴더 저장소의 커밋 파일 diff 를 읽는다 (커밋 diff 탭의 로더, CD-05: 저장소 세션을 만들지 않는다).
   * 변경이 없어도 양쪽 원문과 확정된 비교 기준을 반환한다.
   */
  readCommitFileDiff(
    repoPath: string,
    oid: string,
    path: string,
    oldPath: string | null,
    full: boolean,
    options: DiffOptions,
  ): Promise<DiffDocument>;
  /**
   * 커밋의 지금 행 번호를 타임라인에서 다시 찾는다 (LG-10: 다시 읽힌 뒤 보던 커밋 근처에 머문다).
   * 같은 커밋이 저장소마다 한 행씩 있을 수 있어 저장소 번호가 필요하다. 못 찾으면 null
   */
  resolveTimelineRow(oid: string, repo: number | null): Promise<number | null>;
  /**
   * 로그의 스크롤 기준(맨 위에 보이던 커밋)을 기억한다. 로그 탭이 내려갔다 다시 올라와도(콘솔 탭 왕복,
   * 도구 창 숨김, 다른 탭 전환) 보던 자리에서 시작하게 한다. 스크롤할 때마다 불리므로 구독 상태 밖에 둔다
   */
  rememberTimelineAnchor(anchor: GraphScrollAnchor): void;
  /** 기억해 둔 스크롤 기준. 없으면 null */
  timelineAnchor(): GraphScrollAnchor | null;
  dispose(): void;
}

export type FolderStore = StoreApi<FolderState>;

/**
 * 트리 선택 중 저장소 디렉터리인 행의 절대 경로들 (PT-07, WS-09). `root` 는 트리 루트(폴더)의 절대 경로, 순서는
 * 저장소 목록 순서. 루트 밖의 저장소는 트리에 행이 없으므로 고를 수 없다. 디렉터리 하나인 공간의
 * `selectedRepoPathsIn` 이다
 */
export function selectedRepoPaths(
  root: string,
  repos: readonly FoundRepo[],
  selection: SelectionSet,
): string[] {
  return selectedRepoPathsIn(dirSpace(root), repos, selection);
}

/** `selectedRepoPaths` 의 경로 공간 판 (MR-13): 저장소 행의 트리 경로를 공간의 `toRel` 로 찾는다 */
export function selectedRepoPathsIn(
  space: RootSpace,
  repos: readonly FoundRepo[],
  selection: SelectionSet,
): string[] {
  return repos.flatMap((repo) => {
    const rel = space.toRel(repo.path);
    return rel !== null && selection[rel] === true ? [repo.path] : [];
  });
}

/**
 * 업스트림이 없는 branch 인지: 현재 branch 가 있고(분리 HEAD 아님) 상태를 읽었는데 앞섬·뒤처짐이 없다 (코어는 업스트림이
 * 없으면 `ahead` 를 비운다). 일괄 push 가 새 업스트림을 지정해 게시할 저장소다
 */
export function lacksUpstream(s: RepoSummary): boolean {
  return (
    (s.branch ?? null) !== null &&
    !s.detached &&
    (s.error ?? null) === null &&
    (s.ahead === null || s.ahead === undefined)
  );
}

/** 필터·정렬을 적용한 목록 (순수 함수, 테스트 대상). stash 수가 없는 줄은 0 개로 본다 */
export function visibleSummaries(
  summaries: readonly RepoSummary[],
  filter: FolderFilter,
  sort: FolderSort,
): RepoSummary[] {
  const filtered = summaries.filter((s) => {
    switch (filter) {
      case 'changed':
        return s.changed > 0;
      case 'behind':
        return (s.behind ?? 0) > 0;
      case 'ahead':
        return (s.ahead ?? 0) > 0;
      case 'noUpstream':
        return lacksUpstream(s);
      case 'stashed':
        return (s.stashCount ?? 0) > 0;
      case 'inProgress':
        return s.op !== null && s.op !== undefined;
      default:
        return true;
    }
  });
  const byName = (a: RepoSummary, b: RepoSummary) => a.name.localeCompare(b.name);
  switch (sort) {
    case 'changed':
      return filtered.sort((a, b) => b.changed - a.changed || byName(a, b));
    case 'behind':
      return filtered.sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0) || byName(a, b));
    case 'stash':
      return filtered.sort((a, b) => (b.stashCount ?? 0) - (a.stashCount ?? 0) || byName(a, b));
    default:
      return filtered.sort(byName);
  }
}

/**
 * 다시 읽은 저장소의 줄을 기존 목록에 합친다 (요약·변경 공용, PF-02). 물어본 저장소(`asked`)의 옛 줄은
 * 버리고 새로 받은 줄로 바꾼다 — 받은 것이 없으면 그 저장소는 목록에서 빠진다 (변경이 없어진 저장소).
 * 코어의 순서(경로순)를 지킨다
 */
export function mergeByRepo<T extends { path: string }>(
  prev: readonly T[],
  next: readonly T[],
  asked: readonly string[],
): T[] {
  const replaced = new Set([...asked, ...next.map((row) => row.path)]);
  return [...prev.filter((row) => !replaced.has(row.path)), ...next].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** 브랜치 정렬: 로컬 먼저, 이름순 (코어의 순서와 같다) */
function compareBranches(a: FolderBranch, b: FolderBranch): number {
  return Number(a.remote) - Number(b.remote) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * 일부 저장소만 다시 읽은 브랜치 목록을 기존 목록에 합친다 (PF-02). 응답에 든 저장소(`part.repos`)의
 * 옛 정보를 모두 걷어내고 새 정보를 넣는다 — 그 저장소에서 사라진 브랜치는 그 저장소 표시가 빠지고,
 * 어느 저장소에도 남지 않은 브랜치는 목록에서 빠진다. 저장소 순서는 기존 순서를 지킨다
 */
export function mergeFolderBranches(
  prev: FolderBranches | null,
  part: FolderBranches,
): FolderBranches {
  if (prev === null) {
    return part;
  }
  const fresh = new Map(part.repos.map((repo) => [repo.path, repo]));
  const repos = [
    ...prev.repos.map((repo) => fresh.get(repo.path) ?? repo),
    ...part.repos.filter((repo) => !prev.repos.some((old) => old.path === repo.path)),
  ];
  const order = new Map(repos.map((repo, index) => [repo.path, index]));
  const key = (branch: FolderBranch) => `${branch.remote ? 'r' : 'l'}:${branch.name}`;
  const merged = new Map<string, FolderBranch>();
  for (const branch of prev.branches) {
    merged.set(key(branch), {
      ...branch,
      repos: branch.repos.filter((repo) => !fresh.has(repo.path)),
    });
  }
  for (const branch of part.branches) {
    const kept = merged.get(key(branch));
    merged.set(key(branch), { ...branch, repos: [...(kept?.repos ?? []), ...branch.repos] });
  }
  const branches = [...merged.values()]
    .filter((branch) => branch.repos.length > 0)
    .map((branch) => ({
      ...branch,
      repos: [...branch.repos].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)),
    }))
    .sort(compareBranches);
  return { repos, branches };
}

/** 저장소별 브랜치 상태의 서명 (HEAD·브랜치 이름·현재·추적 수치). 같으면 그 저장소의 ref 가 그대로라고 본다 */
function branchSignatures(branches: FolderBranches): Map<string, string> {
  const lines = new Map<string, string[]>(
    branches.repos.map((repo) => [repo.path, [JSON.stringify(repo.head)]]),
  );
  for (const branch of branches.branches) {
    for (const repo of branch.repos) {
      lines
        .get(repo.path)
        ?.push(
          `${branch.remote ? 'r' : 'l'}:${branch.name}:${repo.current}:${repo.upstream}:${repo.ahead}:${repo.behind}:${repo.gone}`,
        );
    }
  }
  return new Map([...lines].map(([path, list]) => [path, list.sort().join('\n')]));
}

/**
 * 두 브랜치 목록 사이에 브랜치 상태가 달라진 저장소들 (포함 branch 무효화용, CD-03). 이전 목록이 없으면(처음
 * 읽음) 빈 목록이다. 감시 이벤트를 놓쳤을 때 전체 갱신이 ref 변경을 알아채는 길이다
 */
export function changedBranchRepos(prev: FolderBranches | null, next: FolderBranches): string[] {
  if (prev === null) {
    return [];
  }
  const before = branchSignatures(prev);
  const after = branchSignatures(next);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
}

/** 다시 읽을 대상: 전부 또는 저장소 경로들 */
type RefreshTarget = 'all' | ReadonlySet<string>;

/** 다시 읽을 대상 둘을 합친다. 전부가 하나라도 있으면 전부다 */
function mergeTargets(
  a: RefreshTarget | null,
  b: RefreshTarget | readonly string[],
): RefreshTarget {
  if (a === 'all' || b === 'all') {
    return 'all';
  }
  return new Set([...(a ?? []), ...b]);
}

/** 브랜치 목록을 읽지 못했을 때의 빈 목록 ("읽는 중" 으로 남지 않게 한다) */
const NO_BRANCHES: FolderBranches = { repos: [], branches: [] };

/** 경로의 마지막 요소 */
function nameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 폴더 스토어를 만든다. 열자마자 요약과 브랜치 목록을 한 번 읽는다 (타임라인은 로그 탭이 처음 보일 때 연다) */
export function createFolderStore(opened: FolderOpened, client: IpcClient): FolderStore {
  const id = opened.session;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timelineTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // 감시 이벤트가 디바운스 동안 모아 둔 대상, 읽기를 기다리는 대상, 지금 읽는 대상
  let debounced: RefreshTarget | null = null;
  let queued: RefreshTarget | null = null;
  let inflight: RefreshTarget | null = null;
  let draining: Promise<void> | null = null;
  // 변경 목록을 한 번이라도 읽었는지. 읽은 적이 없으면 부분 갱신으로 반쪽 목록을 만들지 않는다
  let changesLoaded = false;
  // 로그의 스크롤 기준. 화면을 다시 그릴 값이 아니라서 스토어 상태에 넣지 않는다
  let timelineAnchor: GraphScrollAnchor | null = null;
  // 커밋 상세 요청 차례. 새 선택·선택 해제마다 올려 늦게 온 옛 응답을 버린다
  let detailSeq = 0;
  // 질의 변경 요청 차례와 코어가 마지막으로 받아들인 질의 (잘못된 정규식이면 이 질의로 되돌린다)
  let querySeq = 0;
  let confirmedSeq = 0;
  let confirmedQuery: GraphQuery = DEFAULT_TIMELINE_QUERY;
  // 저장소 범위 변경 요청 차례와 도는 요청 수 (도는 동안은 타임라인 정보로 범위를 덮어쓰지 않는다)
  let scopeSeq = 0;
  let scopeInflight = 0;
  let scopeRequest: Promise<void> | null = null;
  let confirmedScope: string[] = [];
  let scopeAwaitingData = false;
  // 브랜치 더블클릭이 건 저장소 범위의 기억 (없으면 null). 화면이 그릴 값이 아니라 스토어 상태에 넣지 않는다
  let branchFocus: BranchFocusScope | null = null;
  // 작성자 후보 요청 차례. 새 요청·범위 변경마다 올려 늦게 온 옛 응답을 버린다
  let authorsSeq = 0;
  // 질의·범위를 바꿀 때마다 오르는 값과, 마지막으로 그린 데이터가 어느 값의 것인지 (바뀐 뒤 처음 온 데이터에서
  // 스크롤 기준을 다시 찾는다)
  let queryEpoch = 0;
  let shownEpoch = 0;
  // 로그에서 보이기 요청 차례와, 다음 질의·범위 변경의 첫 데이터에서 다시 고를 커밋 ("필터 지우고 보기")
  let revealSeq = 0;
  let pendingReveal: TimelineSelection | null = null;
  // 콘솔을 보고 있는 화면 수 (0 이면 실패한 명령을 안 본 실패로 센다)
  let logViewers = 0;
  // 작업 기록 줄의 id (폴더 탭마다 오른다)
  let taskSeq = 0;
  const timelineCache = new GraphRangeCache(folderTimelineSource(client, id));
  const fileTree = createFileTree({
    list: (dir, limit) => client.fsListDir(id, dir, limit),
    read: (path) => client.fsReadFile(id, path),
  });
  /** 파일 트리의 펼친 디렉터리를 다시 나열한다 (열린 파일 보기도 따라 다시 읽는다) */
  const reloadFiles = () => void fileTree.getState().reload();
  const store = createStore<FolderState>()((set, get) => {
    /**
     * 대상 저장소의 요약·브랜치(와 읽어 둔 변경 목록)를 다시 읽어 합친다. 전부면 통째로 바꾼다.
     * 일부만 읽다 실패하면(그사이 재스캔으로 저장소가 사라진 경우 등) 전부 다시 읽도록 예약한다
     */
    const reload = async (target: RefreshTarget) => {
      // 지금 목록에 없는 저장소는 묻지 않는다 (코어가 목록 밖 경로를 거부한다)
      const known = new Set(get().repos.map((repo) => repo.path));
      const asked = target === 'all' ? [] : [...target].filter((path) => known.has(path));
      const partial = target !== 'all';
      if (partial && asked.length === 0) {
        return;
      }
      const [summaries, branches, changes] = await Promise.allSettled([
        client.folderSummaries(id, asked),
        client.folderBranches(id, asked),
        changesLoaded ? client.folderChanges(id, asked) : Promise.resolve(null),
      ]);
      if (disposed) {
        return;
      }
      const failed = [summaries, branches, changes].some((r) => r.status === 'rejected');
      if (partial && failed) {
        queued = 'all';
        return;
      }
      const patch: Partial<FolderState> = {};
      if (summaries.status === 'fulfilled') {
        patch.summaries = partial
          ? mergeByRepo(get().summaries, summaries.value, asked)
          : summaries.value;
        patch.refreshedAt = Date.now();
        patch.error = null;
      } else {
        patch.error = describeError(summaries.reason);
      }
      if (branches.status === 'fulfilled') {
        patch.branches = partial
          ? mergeFolderBranches(get().branches, branches.value)
          : branches.value;
        // 전체 갱신(포커스·주기·수동)에서 브랜치 상태가 달라진 저장소는 포함 branch 를 다시 읽는다. 부분 갱신은
        // 그 앞의 `folderChanged` 가 이미 무효화했다
        if (!partial) {
          const changed = new Set(changedBranchRepos(get().branches, branches.value));
          if (changed.size > 0) {
            containing.invalidate((key) => changed.has(key.repoPath));
          }
        }
      } else {
        patch.branches = get().branches ?? NO_BRANCHES;
        patch.error = describeError(branches.reason);
      }
      if (changes.status === 'fulfilled' && changes.value !== null) {
        patch.changes = partial ? mergeByRepo(get().changes, changes.value, asked) : changes.value;
        patch.changesError = null;
      } else if (changes.status === 'rejected') {
        patch.changesError = describeError(changes.reason);
      }
      set(patch);
    };

    /**
     * 기다리는 대상을 차례로 읽는다. 한 번에 하나만 돌고, 도는 동안 더해진 대상은 이어서 읽는다.
     * 돌려주는 약속은 기다리는 대상이 모두 끝났을 때 풀린다
     */
    const drain = (): Promise<void> => {
      if (disposed) {
        return Promise.resolve();
      }
      draining ??= (async () => {
        set({ loading: true });
        while (queued !== null && !disposed) {
          inflight = queued;
          queued = null;
          await reload(inflight);
        }
        inflight = null;
        if (!disposed) {
          set({ loading: false });
        }
      })().finally(() => {
        draining = null;
      });
      return draining;
    };

    /**
     * 대상을 디바운스 뒤 읽도록 모은다 (PF-02). 짧은 시간에 여러 저장소가 바뀌면 모아서 한 번에 읽고, 전부가 섞이면
     * 전부 읽는다. 감시 이벤트와 저장소 세션의 상태 변경(`refreshRepos`)이 같은 길을 쓴다
     */
    const scheduleReload = (target: RefreshTarget | readonly string[]) => {
      debounced = mergeTargets(debounced, target);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (debounced !== null) {
          queued = mergeTargets(queued, debounced);
          debounced = null;
          void drain();
        }
      }, REFRESH_DEBOUNCE_MS);
    };

    /**
     * 그 저장소들을 지금 다시 읽고 끝날 때까지 기다린다 (쓰기 뒤 확정, W14). 디바운스에 모여 있던 대상도 함께 읽는다 —
     * 같은 쓰기의 감시 이벤트(`folderChanged`)가 이미 와 있으면 그 예약을 당겨 한 번만 읽는다
     */
    const reloadNow = (paths: readonly string[]): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queued = mergeTargets(mergeTargets(queued, debounced ?? []), paths);
      debounced = null;
      return drain();
    };

    /** 타임라인 상태 일부만 바꾼다 */
    const patchTimeline = (patch: Partial<TimelineState>) =>
      set({ timeline: { ...get().timeline, ...patch } });

    /**
     * 끝난 일괄 작업·commit·여러 저장소 clone 을 작업 기록 맨 앞에 남긴다. 결과가 있으면 코어의 라벨을, 없으면 `label` 을
     * 쓴다. 다시 실행에 쓸 인자(일괄 작업 `request`, clone `clone`)가 있으면 함께 남긴다
     */
    const recordTask = (
      kind: 'batch' | 'commit',
      label: string,
      startedAt: number,
      outcome: { result: BatchResult } | { error: string },
      extra: Pick<TaskEntry, 'request' | 'clone'> = {},
    ) => {
      const result = 'result' in outcome ? outcome.result : null;
      const entry: TaskEntry = {
        id: ++taskSeq,
        kind,
        label: result?.label || label,
        startedAt,
        finishedAt: Date.now(),
        result,
        error: 'error' in outcome ? outcome.error : null,
        ...(extra.request ? { request: extra.request } : {}),
        ...(extra.clone ? { clone: extra.clone } : {}),
      };
      set({
        taskHistory: pruneCommandOutputs(
          prependCapped(get().taskHistory, entry, TASK_HISTORY_CAPACITY),
        ),
      });
    };

    /**
     * 폴더 자동 fetch 결과 (`folderAutoFetched`): 작업 기록에 남기고(같은 실패만 이어지면 한 줄로 합친다), 바뀐 원격 ref
     * 가 있으면 저장소 탭의 자동 fetch 와 같은 꼴로 알린다 (`저장소: ref` 를 앞 5개까지). 바뀐 저장소의 다시 읽기는 앞서 온
     * `folderChanged` 가 맡는다
     */
    const recordAutoFetch = (repos: readonly AutoFetchedRepo[]) => {
      const now = Date.now();
      const list = repos.map((r) => ({ ...r, error: r.error ?? null }));
      const entry: TaskEntry = {
        id: ++taskSeq,
        kind: 'autoFetch',
        label: S.folder.history.autoFetch,
        startedAt: now,
        finishedAt: now,
        result: null,
        error: null,
        autoFetch: list,
      };
      set({ taskHistory: appendAutoFetch(get().taskHistory, entry) });
      const changed = list.flatMap((r) => r.refs.map((ref) => `${r.name}: ${ref}`));
      if (changed.length > 0) {
        notifyHub.notify({
          kind: 'info',
          title: S.notify.autoFetched(changed.length),
          message: changed.slice(0, 5).join(', '),
          os: true,
        });
      }
    };

    // 상세 칸에 보이는 커밋의 포함 branch (CD-03). 언제 읽고 무엇을 버리는지는 공용 지연 읽기가 정한다
    const containing = createContainingLoader<TimelineSelection>({
      keyOf: (key) => `${key.repoPath}\u0000${key.oid}`,
      fetch: (key) => client.folderCommitContainingRefs(id, key.repoPath, key.oid),
      publish: (entry) => {
        if (!disposed) {
          patchTimeline({ containing: entry });
        }
      },
      describeError,
    });

    /** 작성자 후보를 낡은 것으로 본다 (범위·ref 변경, 재스캔). 읽는 중이던 응답은 버리고 다음에 열 때 다시 읽는다 */
    const invalidateAuthors = () => {
      authorsSeq += 1;
      const authors = get().timeline.authors;
      if (authors.state !== 'idle') {
        patchTimeline({ authors: { ...authors, state: 'idle', error: null } });
      }
    };

    /**
     * 질의·범위를 바꾼 뒤 처음 온 데이터에서 기억해 둔 스크롤 기준(보던 커밋)을 다시 찾는다 (LG-10). 있으면 그 행 번호로
     * 고치고, 없으면 기준을 버리고 맨 위로 가게 한다. 목록 모드가 바뀌어 로그 뷰가 다시 마운트되는 경우는 이 결과로
     * 시작하도록 찾은 뒤에 모드를 바꾼다 (뷰는 마운트할 때의 기준 행 번호에서 시작한다)
     */
    const settleAnchor = async (listMode: boolean) => {
      const epoch = shownEpoch;
      const anchor = timelineAnchor;
      const row = anchor === null ? null : await get().resolveTimelineRow(anchor.oid, anchor.repo);
      if (disposed || epoch !== shownEpoch) {
        return;
      }
      timelineAnchor = anchor === null || row === null ? null : { ...anchor, row };
      const lost = anchor !== null && row === null;
      patchTimeline({
        listMode,
        ...(lost ? { scrollReset: get().timeline.scrollReset + 1 } : {}),
      });
    };

    /**
     * 찾는 중인 보이기 요청(`reveal.state === 'finding'`)의 행을 지금 로그에서 찾는다 (W19). 로그를 다 읽지 않았으면 기다린다
     * (다 읽으면 `timelineLoaded` 가 다시 부른다). 그 저장소가 로그에 없거나(범위 밖) 행이 없으면 `missing`. 그사이 새 요청이
     * 오거나 요청이 비면 응답을 버린다
     */
    const findReveal = async () => {
      const t = get().timeline;
      const reveal = t.reveal;
      if (reveal === null || reveal.state !== 'finding' || t.loadState !== 'complete' || !t.info) {
        return;
      }
      const repo = t.info.repos.find((r) => r.path === reveal.of.repoPath);
      const row =
        repo && repo.inScope !== false
          ? await client.folderTimelineFindRow(id, repo.index, reveal.of.oid).catch(() => null)
          : null;
      const now = get().timeline.reveal;
      if (disposed || now?.seq !== reveal.seq) {
        return;
      }
      patchTimeline({
        reveal: { ...now, state: row === null ? 'missing' : 'found', row, scrolled: false },
      });
    };

    /** 타임라인 데이터가 왔다 (첫 로드 완료·다시 읽힘): 행 수를 바꾸고, 질의가 바뀐 뒤 처음이면 스크롤 기준을 맞춘다 */
    const timelineLoaded = (generation: number, rows: number) => {
      timelineCache.setTotalRows(rows, true);
      timelineCache.invalidateAll({ discardRows: scopeAwaitingData });
      const listMode = isListModeQuery(get().timeline.query);
      const changed = shownEpoch !== queryEpoch;
      shownEpoch = queryEpoch;
      patchTimeline({
        loadState: 'complete',
        generation,
        totalRows: rows,
        error: null,
        ...(changed ? {} : { listMode }),
      });
      // ref 이동·삭제로 그래프가 바뀌면 같은 선택의 상세도 새 타임라인에서 읽는다.
      // loadDetail의 차례가 이전 세대에서 읽던 상세 응답을 폐기한다.
      get().reloadTimelineDetail();
      // 정보(저장소 번호·범위)를 받은 뒤에 찾는다 — 처음 열 때는 정보가 이 데이터와 함께 온다
      void get()
        .refreshTimelineInfo()
        .then(() => findReveal());
      if (changed) {
        // 스크롤 기준을 맞춘 뒤에 다시 고른다 ("필터 지우고 보기": 맨 위로 가는 것보다 그 커밋으로 가는 것이 나중이다)
        void settleAnchor(listMode).then(() => {
          const target = pendingReveal;
          pendingReveal = null;
          if (target !== null && !disposed) {
            get().revealTimelineCommit(target.repoPath, target.oid);
          }
        });
      }
    };

    /** 고른 커밋의 상세를 읽는다. 그사이 선택이 바뀌었으면(차례가 지났으면) 응답을 버린다 */
    const loadDetail = async (of: TimelineSelection) => {
      const seq = ++detailSeq;
      patchTimeline({ detail: { of, state: 'loading', detail: null, error: null } });
      try {
        const detail = await client.folderCommitDetail(id, of.repoPath, of.oid);
        if (seq === detailSeq && !disposed) {
          patchTimeline({ detail: { of, state: 'ready', detail, error: null } });
        }
      } catch (e) {
        if (seq === detailSeq && !disposed) {
          patchTimeline({
            detail: { of, state: 'error', detail: null, error: describeError(e) },
          });
        }
      }
    };

    return {
      id,
      path: opened.path,
      space: opened.group ? groupSpace(opened.group) : dirSpace(opened.path),
      group: opened.group ?? null,
      name: opened.group?.name ?? nameOf(opened.path),
      repos: opened.repos,
      summaries: [],
      branches: null,
      loading: false,
      error: null,
      filter: 'all',
      sort: 'name',
      refreshedAt: null,
      settingsOpen: false,
      batchRunning: false,
      batchProgress: null,
      batchCancelling: false,
      taskHistory: [],
      changes: [],
      changesLoading: false,
      changesError: null,
      indexWrites: {},
      settings: null,
      timeline: {
        opened: false,
        cache: timelineCache,
        totalRows: 0,
        generation: 0,
        loadState: 'idle',
        error: null,
        info: null,
        query: DEFAULT_TIMELINE_QUERY,
        scope: [],
        filterError: null,
        listMode: false,
        scrollReset: 0,
        prefs: DEFAULT_TIMELINE_PREFS,
        authors: { state: 'idle', list: null, error: null },
        selected: null,
        reveal: null,
        detail: null,
        containing: null,
      },
      fileTree,
      commandLog: [],
      commandLogRepo: null,
      commandLogUnseenFailures: 0,

      applyEvent(event) {
        const t = get().timeline;
        if (event.type === 'folderCommandLogged') {
          // 폴더 콘솔 (W19 ②): 최신을 앞에 쌓는다. 콘솔을 보고 있지 않으면 실패를 콘솔 탭 표시로 센다
          const unseen = logViewers === 0 && commandFailed(event.record);
          set({
            commandLog: prependCapped(get().commandLog, { repo: event.repo, record: event.record }),
            ...(unseen ? { commandLogUnseenFailures: get().commandLogUnseenFailures + 1 } : {}),
          });
          return;
        }
        if (event.type === 'folderRescanned') {
          // 저장소 집합이 바뀌었다: 읽어 둔 포함 branch·작성자 후보를 모두 버린다
          containing.invalidate();
          invalidateAuthors();
          set({ repos: event.repos });
          void get().refresh();
          reloadFiles();
          return;
        }
        if (event.type === 'groupChanged') {
          // 그룹 멤버 상태가 바뀌었다 (재스캔 = 멤버 재확인, 바로 앞 `folderRescanned` 가 목록·트리를 다시 읽었다). 멤버
          // (별칭·경로)가 같으면 공간은 그대로 두어 공간을 참조로 기억하는 화면이 다시 계산하지 않게 한다
          const before = get().group;
          const sameMembers =
            before !== null &&
            before.members.length === event.group.members.length &&
            before.members.every(
              (m, i) =>
                m.alias === event.group.members[i]?.alias &&
                m.path === event.group.members[i]?.path,
            );
          set({
            group: event.group,
            name: event.group.name,
            ...(sameMembers ? {} : { space: groupSpace(event.group) }),
          });
          return;
        }
        // 통합 타임라인: 폴더 세션 id 로 오는 그래프 이벤트
        if (event.type === 'graphLoadStarted') {
          patchTimeline({ loadState: 'loading', generation: event.generation, error: null });
          return;
        }
        if (event.type === 'graphLoadFinished' || event.type === 'graphReloaded') {
          if (event.generation < t.generation) {
            return;
          }
          timelineLoaded(event.generation, event.rows);
          return;
        }
        if (event.type === 'graphLoadFailed' || event.type === 'graphReloadFailed') {
          patchTimeline({ loadState: 'error', error: event.message });
          return;
        }
        if (event.type === 'graphFirstChunk' || event.type === 'graphProgress') {
          return;
        }
        if (event.type === 'operationStarted' && event.kind === 'batch') {
          set({
            batchRunning: true,
            batchProgress: { opId: event.opId, label: event.label, phase: '', percent: null },
          });
          return;
        }
        if (event.type === 'operationProgress') {
          const p = get().batchProgress;
          if (p) {
            set({ batchProgress: { ...p, phase: event.phase, percent: event.percent ?? null } });
          }
          return;
        }
        if (event.type === 'operationFinished') {
          set({ batchRunning: false, batchProgress: null, batchCancelling: false });
          return;
        }
        if (event.type === 'folderAutoFetched') {
          recordAutoFetch(event.repos);
          return;
        }
        if (event.type === 'folderChanged') {
          // 바뀐 저장소만 다시 읽는다 (PF-02). 짧은 시간에 여러 저장소가 바뀌면 모아서 한 번에 읽고,
          // 어느 저장소인지 모르는 이벤트가 섞이면 전부 읽는다
          const repo = event.repo ?? null;
          scheduleReload(repo === null ? 'all' : [repo]);
          // ref 가 바뀌면 그 저장소(모르면 전부)의 포함 branch 가 낡는다 (CD-03). 새 커밋이 들어왔을 수 있으므로
          // 작성자 후보도 다음에 열 때 다시 읽는다
          if (event.refs) {
            containing.invalidate((key) => repo === null || key.repoPath === repo);
            invalidateAuthors();
          }
          // ref 가 바뀌었고 타임라인을 열어 둔 상태면 묶어서 다시 읽는다
          if (event.refs && t.opened) {
            if (timelineTimer) {
              clearTimeout(timelineTimer);
            }
            timelineTimer = setTimeout(() => {
              timelineTimer = null;
              void get().reloadTimeline();
            }, TIMELINE_DEBOUNCE_MS);
          }
        }
      },

      setCommandLogRepo(repo) {
        set({ commandLogRepo: repo });
      },

      viewCommandLog() {
        logViewers += 1;
        if (get().commandLogUnseenFailures !== 0) {
          set({ commandLogUnseenFailures: 0 });
        }
        let stopped = false;
        return () => {
          if (!stopped) {
            stopped = true;
            logViewers -= 1;
          }
        };
      },

      refreshRepos(paths) {
        if (!disposed && paths.length > 0) {
          scheduleReload(paths);
        }
      },

      refresh() {
        // 이미 전부 읽는 중이면 한 번 더 읽지 않고 그 읽기를 기다린다 (재스캔의 이벤트와 응답이 겹칠 때)
        if (inflight !== 'all') {
          queued = 'all';
        }
        return drain();
      },

      startAutoRefresh() {
        const tick = () => void get().refresh();
        // 창 포커스는 요약과 함께 파일 트리도 다시 읽는다. 주기 재조회는 요약만 읽는다 (파일 트리는 감시하지 않는다)
        const onFocus = () => {
          tick();
          reloadFiles();
        };
        let interval: ReturnType<typeof setInterval> | null = null;
        let armedMs: number | null = null;
        /** 설정의 간격으로 타이머를 건다. 간격이 그대로면 건드리지 않는다 */
        const arm = () => {
          const ms = autoRefreshMs(get().settings);
          if (ms === armedMs) {
            return;
          }
          armedMs = ms;
          if (interval) {
            clearInterval(interval);
          }
          interval = ms > 0 ? setInterval(tick, ms) : null;
        };
        arm();
        window.addEventListener('focus', onFocus);
        const unsubscribe = store.subscribe(arm);
        return () => {
          window.removeEventListener('focus', onFocus);
          unsubscribe();
          if (interval) {
            clearInterval(interval);
          }
        };
      },

      async rescan() {
        try {
          const repos = await client.folderRescan(id);
          set({ repos });
          reloadFiles();
          await get().refresh();
        } catch (e) {
          set({ error: describeError(e) });
        }
      },

      setFilter(filter) {
        set({ filter });
      },

      setSort(sort) {
        set({ sort });
      },

      setSettingsOpen(open) {
        set({ settingsOpen: open });
      },

      selectedRepos() {
        return selectedRepoPathsIn(get().space, get().repos, fileTree.getState().selection);
      },

      toggleSelect(path) {
        const rel = get().space.toRel(path);
        if (rel !== null) {
          fileTree.getState().markSelected([rel], fileTree.getState().selection[rel] !== true);
        }
      },

      setSelected(paths) {
        const { space, repos } = get();
        const want = new Set(paths);
        const rels = (keep: boolean) =>
          repos.flatMap((repo) => {
            const rel = space.toRel(repo.path);
            return rel !== null && want.has(repo.path) === keep ? [rel] : [];
          });
        // 동작은 매번 스토어의 지금 상태를 읽는다 (두 번째 호출이 첫 번째의 결과 위에 얹힌다)
        const { markSelected } = fileTree.getState();
        markSelected(rels(false), false);
        markSelected(rels(true), true);
      },

      inspectRemoteBranchDeletion(remote, name) {
        return client.inspectFolderRemoteBranchDeletion(id, remote, name);
      },

      inspectIntegration(reference, repos) {
        return client.folderIntegrationPreview(id, reference, [...repos]);
      },

      listStashBatches(repos) {
        return client.folderStashBatches(id, [...repos]);
      },

      async runBatch(op, repos) {
        if (get().batchRunning) {
          return null;
        }
        const startedAt = Date.now();
        const request = { op, repos: [...(repos ?? get().selectedRepos())] };
        set({ batchRunning: true, error: null });
        try {
          const r = await client.folderBatch(id, op, request.repos);
          set({ batchRunning: false, batchProgress: null, batchCancelling: false });
          recordTask('batch', batchOpLabel(op), startedAt, { result: r }, { request });
          return r;
        } catch (e) {
          const error = describeError(e);
          set({ batchRunning: false, batchProgress: null, batchCancelling: false, error });
          recordTask('batch', batchOpLabel(op), startedAt, { error }, { request });
          return null;
        } finally {
          // pull·checkout 등은 작업 트리 파일을 바꾼다. 실패해도 일부 저장소에서는 바뀌었을 수 있다
          reloadFiles();
        }
      },

      async cancelBatch() {
        const progress = get().batchProgress;
        if (!progress || get().batchCancelling) {
          return false;
        }
        set({ batchCancelling: true });
        let accepted = false;
        try {
          accepted = await client.cancelOperation(progress.opId);
        } catch {
          accepted = false;
        }
        // 코어가 받지 않았으면(이미 끝남) 단추를 되살린다. 받았으면 끝 이벤트·결과가 푼다
        if (!accepted && get().batchProgress?.opId === progress.opId) {
          set({ batchCancelling: false });
        }
        return accepted;
      },

      clearTaskHistory() {
        set({ taskHistory: [] });
      },

      recordClone(result, request, startedAt) {
        recordTask('batch', result.label, startedAt, { result }, { clone: request });
      },

      async loadChanges() {
        changesLoaded = true;
        set({ changesLoading: true });
        try {
          set({
            changes: await client.folderChanges(id),
            changesLoading: false,
            changesError: null,
          });
        } catch (e) {
          set({
            changesLoading: false,
            error: describeError(e),
            changesError: describeError(e),
          });
        }
      },

      ensureChanges() {
        if (!changesLoaded && !disposed) {
          void get().loadChanges();
        }
      },

      async writeIndex(repo, op, target) {
        if (get().indexWrites[repo] !== undefined || get().batchRunning || disposed) {
          return { kind: 'busy' };
        }
        // 빈 경로 목록은 "전부"가 아니라 아무것도 하지 않는다 — 보내지도 않는다
        if (target.kind === 'paths' && target.paths.length === 0) {
          return { kind: 'done', result: { ran: false, skipped: [] } };
        }
        set({ indexWrites: { ...get().indexWrites, [repo]: { op, target } } });
        try {
          const result =
            op === 'stage'
              ? await client.folderStage(id, repo, target)
              : await client.folderUnstage(id, repo, target);
          if (result.ran) {
            await reloadNow([repo]);
          }
          return { kind: 'done', result };
        } catch (e) {
          return { kind: 'failed', error: describeError(e) };
        } finally {
          const { [repo]: _done, ...rest } = get().indexWrites;
          set({ indexWrites: rest });
        }
      },

      async commitAll(repos, message, stageAll, repoMessages) {
        const startedAt = Date.now();
        set({ batchRunning: true, error: null });
        try {
          // 저장소별 메시지가 없으면 옛 모양 그대로 부른다
          const r = await (repoMessages === undefined
            ? client.folderCommit(id, repos, message, stageAll)
            : client.folderCommit(id, repos, message, stageAll, repoMessages));
          // 대상 저장소를 다시 읽은 뒤에 끝낸다: 커밋된 줄이 빠지고 ahead 가 오른 값이 실린 다음에 체크·버튼을 푼다
          await reloadNow(r.results.map((row) => row.path));
          set({ batchRunning: false });
          recordTask('commit', S.folder.history.ops.commit, startedAt, { result: r });
          return r;
        } catch (e) {
          const error = describeError(e);
          set({ batchRunning: false, error });
          recordTask('commit', S.folder.history.ops.commit, startedAt, { error });
          return null;
        }
      },

      async loadSettings() {
        try {
          set({ settings: await client.folderSettings(id) });
        } catch {
          // 기본값으로 둔다
        }
      },

      async saveSettings(settings) {
        try {
          await client.folderSettingsSet(id, settings);
          set({ settings, error: null });
          return true;
        } catch (e) {
          set({ error: describeError(e) });
          return false;
        }
      },

      async openTimeline() {
        const t = get().timeline;
        if (t.opened) {
          return;
        }
        set({ timeline: { ...t, opened: true, loadState: 'loading' } });
        try {
          const info = await client.folderTimelineOpen(id);
          const cur = get().timeline;
          if (info.finished) {
            timelineCache.setTotalRows(info.rows, true);
            timelineCache.invalidateAll();
            shownEpoch = queryEpoch;
          }
          set({
            timeline: {
              ...cur,
              info,
              ...(info.finished
                ? {
                    loadState: 'complete',
                    totalRows: info.rows,
                    generation: info.generation,
                    listMode: isListModeQuery(cur.query),
                  }
                : {}),
            },
          });
          // 열기 전에 보이라고 한 커밋 (로그 탭을 처음 열며 blame 해시를 누른 경우 등)
          void findReveal();
        } catch (e) {
          set({ timeline: { ...get().timeline, loadState: 'error', error: describeError(e) } });
        }
      },

      async reloadTimeline() {
        // 다시 읽는 동안은 읽는 중으로 보인다 (코어는 다시 읽기에 시작 이벤트를 보내지 않는다)
        if (get().timeline.opened) {
          patchTimeline({ loadState: 'loading' });
        }
        try {
          await client.folderTimelineReload(id);
        } catch (e) {
          patchTimeline({ loadState: 'error', error: describeError(e) });
        }
      },

      async refreshTimelineInfo() {
        const seq = scopeSeq;
        const generation = get().timeline.generation;
        try {
          const info = await client.folderTimelineInfo(id);
          if (disposed || seq !== scopeSeq || generation !== get().timeline.generation) {
            return;
          }
          // 범위를 바꾸는 요청이 돌고 있지 않으면 코어의 범위로 맞춘다 (재스캔으로 범위가 풀린 경우 등)
          const scope = scopeOfInfo(info);
          const current = get().timeline.scope;
          const sameEffectiveScope = !timelineScopePending(info, current);
          if (sameEffectiveScope) scopeAwaitingData = false;
          // 전체 명시 선택과 빈 범위는 같은 결과다. 응답의 축약 표현으로 사용자가 고른 체크를 지우지 않는다.
          // 재스캔으로 선택한 저장소가 사라졌거나 실제 범위가 달라졌을 때만 코어 범위로 맞춘다.
          const knownPaths = new Set(info.repos.map((repo) => repo.path));
          const syncScope =
            scopeInflight === 0 &&
            !scopeAwaitingData &&
            (!sameEffectiveScope || current.some((path) => !knownPaths.has(path)));
          if (syncScope) confirmedScope = scope;
          patchTimeline({ info, ...(syncScope ? { scope } : {}) });
        } catch {
          // 정보는 다음 이벤트에서 다시 받는다
        }
      },

      async setTimelineQuery(query) {
        // 더블클릭이 건 범위에서 ref 범위가 바뀌면 저장소 범위를 걸기 전으로 (사용자가 그 사이 바꿨으면 그대로)
        const focus = branchFocus;
        if (focus !== null && !sameRevsValue(query.revs, focus.revs)) {
          branchFocus = null;
          const now = get().timeline.scope;
          if (samePaths(now, focus.scope) && !samePaths(now, focus.before)) {
            void get().setTimelineScope(focus.before);
          }
        }
        const seq = ++querySeq;
        const before = get().timeline;
        queryEpoch += 1;
        // 선택이 비므로 읽는 중인 상세도 버린다
        detailSeq += 1;
        patchTimeline({
          query,
          selected: null,
          reveal: null,
          detail: null,
          filterError: null,
          ...(before.opened ? { loadState: 'loading' as const } : {}),
        });
        try {
          await client.folderTimelineQuerySet(id, query);
          if (seq > confirmedSeq) {
            confirmedSeq = seq;
            confirmedQuery = query;
          }
        } catch (e) {
          // 더 나중 요청이 있으면 그 요청의 결과가 정한다
          if (disposed || seq !== querySeq) {
            return;
          }
          if (toIpcError(e).kind !== 'invalidFilter') {
            patchTimeline({ loadState: 'error', error: describeError(e) });
            return;
          }
          // 코어는 질의를 바꾸지 않았고 다시 읽지도 않는다: 받아들여진 질의와 그때의 선택·상세로 되돌린다
          const restore = before.query === confirmedQuery ? before.selected : null;
          patchTimeline({
            query: confirmedQuery,
            filterError: describeError(e),
            loadState: before.loadState,
            selected: restore,
            detail: restore !== null && before.detail?.state === 'ready' ? before.detail : null,
          });
          if (restore !== null && before.detail?.state !== 'ready') {
            void loadDetail(restore);
          }
        }
      },

      async setTimelineScope(repos) {
        const seq = ++scopeSeq;
        const before = get().timeline;
        const scope = [...repos];
        // 사용자가 더블클릭이 건 저장소 범위를 바꿨다: 그 값을 존중해 뒤에 되돌리지 않는다
        if (branchFocus !== null && !samePaths(scope, branchFocus.scope)) {
          branchFocus = null;
        }
        queryEpoch += 1;
        const keep = selectionInScope(before.selected, scope);
        if (!keep) {
          detailSeq += 1;
        }
        // 범위에 든 저장소가 바뀌면 작성자 후보도 바뀐다
        invalidateAuthors();
        // 고른 커밋을 남기면 보이기 요청은 새 범위의 로그에서 다시 찾는다 (다 읽은 뒤). 차례를 올려 옛 범위의 찾기 응답을 버린다
        const reveal = before.reveal === null ? null : { ...before.reveal, seq: ++revealSeq };
        patchTimeline({
          scope,
          ...(keep ? {} : { selected: null, detail: null }),
          reveal: keep && reveal !== null ? { ...reveal, state: 'finding', row: null } : null,
          ...(before.opened ? { loadState: 'loading' as const } : {}),
        });
        scopeInflight += 1;
        scopeAwaitingData = true;
        const previous = scopeRequest;
        // 연속 체크는 직렬화하고 아직 보내지 않은 중간 선택은 건너뛴다.
        const request = (async () => {
          if (previous) await previous;
          if (disposed || seq !== scopeSeq) return;
          await client.folderTimelineScopeSet(id, scope);
          confirmedScope = scope;
        })();
        scopeRequest = request.catch(() => {});
        try {
          await request;
        } catch (e) {
          if (!disposed && seq === scopeSeq) {
            scopeAwaitingData = false;
            patchTimeline({
              scope: confirmedScope,
              loadState:
                get().timeline.info?.finished &&
                !timelineScopePending(get().timeline.info, confirmedScope)
                  ? 'complete'
                  : 'error',
              error: describeError(e),
            });
          }
        } finally {
          scopeInflight -= 1;
        }
      },

      async focusTimelineBranch(revs, repos) {
        const tl = get().timeline;
        // 더블클릭이 이어지면(앞 더블클릭의 저장소 범위 그대로) 처음 걸기 전의 범위를 계속 기억한다
        const before =
          branchFocus !== null && samePaths(tl.scope, branchFocus.scope)
            ? branchFocus.before
            : [...tl.scope];
        const scope = [...repos];
        // 아래 두 요청이 기억을 지우거나 되돌리지 않게 비워 두고, 요청을 낸 뒤에 새로 기억한다
        branchFocus = null;
        const work: Promise<void>[] = [];
        if (!samePaths(tl.scope, scope)) {
          work.push(get().setTimelineScope(scope));
        }
        if (!sameRevsValue(tl.query.revs, revs)) {
          work.push(get().setTimelineQuery({ ...tl.query, revs }));
        }
        branchFocus = { revs, scope, before };
        await Promise.all(work);
      },

      async setTimelinePrefs(prefs) {
        const before = get().timeline;
        patchTimeline({ prefs, ...(before.opened ? { loadState: 'loading' as const } : {}) });
        try {
          await client.folderTimelinePrefsSet(id, prefs);
        } catch (e) {
          if (!disposed) {
            patchTimeline({
              prefs: before.prefs,
              loadState: before.loadState,
              error: describeError(e),
            });
          }
        }
      },

      clearFilterError() {
        if (get().timeline.filterError !== null) {
          patchTimeline({ filterError: null });
        }
      },

      loadTimelineAuthors(force) {
        const authors = get().timeline.authors;
        if (!force && (authors.state === 'ready' || authors.state === 'loading')) {
          return;
        }
        const seq = ++authorsSeq;
        patchTimeline({ authors: { ...authors, state: 'loading', error: null } });
        client.folderTimelineAuthors(id).then(
          (list) => {
            if (!disposed && seq === authorsSeq) {
              patchTimeline({ authors: { state: 'ready', list, error: null } });
            }
          },
          (e: unknown) => {
            if (!disposed && seq === authorsSeq) {
              patchTimeline({
                authors: { ...get().timeline.authors, state: 'error', error: describeError(e) },
              });
            }
          },
        );
      },

      clearTimelineSelection(repoPath, oid) {
        if (!sameSelection(get().timeline.selected, { repoPath, oid })) return;
        detailSeq += 1;
        patchTimeline({ selected: null, detail: null });
      },

      selectTimelineRow(repoPath, oid) {
        const next: TimelineSelection = { repoPath, oid };
        const { selected, detail, reveal } = get().timeline;
        // 다른 커밋을 고르면 그 전 보이기 요청(과 "필터에 없는 커밋" 안내)은 끝난다
        if (reveal !== null && !sameSelection(reveal.of, next)) {
          revealSeq += 1;
          patchTimeline({ reveal: null });
        }
        if (sameSelection(selected, next) && detail !== null && detail.state !== 'error') {
          return;
        }
        patchTimeline({ selected: next });
        void loadDetail(next);
      },

      revealTimelineCommit(repoPath, oid) {
        get().selectTimelineRow(repoPath, oid);
        revealSeq += 1;
        patchTimeline({
          reveal: {
            seq: revealSeq,
            of: { repoPath, oid },
            state: 'finding',
            row: null,
            scrolled: false,
          },
        });
        void findReveal();
      },

      ackTimelineReveal(seq) {
        const reveal = get().timeline.reveal;
        if (reveal?.seq === seq && !reveal.scrolled) {
          patchTimeline({ reveal: { ...reveal, scrolled: true } });
        }
      },

      revealOnNextLoad(target) {
        pendingReveal = target;
      },

      reloadTimelineDetail() {
        const selected = get().timeline.selected;
        if (selected !== null) {
          void loadDetail(selected);
        }
      },

      showContaining(selection) {
        containing.show(selection);
      },

      retryContaining() {
        containing.retry();
      },

      readCommitFileDiff(repoPath, oid, path, oldPath, full, options) {
        return client.folderCommitFileDiffDocument(id, repoPath, oid, path, oldPath, full, options);
      },

      resolveTimelineRow(oid, repo) {
        if (repo === null) {
          return Promise.resolve(null);
        }
        return client.folderTimelineFindRow(id, repo, oid).catch(() => null);
      },

      rememberTimelineAnchor(anchor) {
        timelineAnchor = anchor;
      },

      timelineAnchor() {
        return timelineAnchor;
      },

      dispose() {
        disposed = true;
        detailSeq += 1;
        authorsSeq += 1;
        containing.dispose();
        fileTree.getState().dispose();
        debounced = null;
        queued = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (timelineTimer) {
          clearTimeout(timelineTimer);
          timelineTimer = null;
        }
      },
    };
  });
  // 첫 요약을 읽은 뒤 하위 저장소의 보관 기간이 지난 백업 ref·폐기 백업을 조용히 정리한다 (#18·#26). 코어가 저장소마다
  // 하루 한 번만, 낮은 동시성으로 돌며 실패해도 알리지 않는다
  void store
    .getState()
    .refresh()
    .then(() => (disposed ? undefined : client.folderPruneBackupsDaily(id)))
    .catch(() => {});
  void store.getState().loadSettings();
  return store;
}
