// 작업 진행 띠 (WS-10, W15)의 순수 판정: 줄 만들기, 버튼 조건, 중단 확인창, 실행 결과 분류, 충돌 해결 진입. 저장소 탭의
// 띠(W21 — 작업 줄과 격리 병합 줄)도 버튼 조건·문구·확인창을 여기서 가져다 쓴다 — 두 화면의 뜻이 어긋나지 않게 한 곳에
// 둔다.
//
// 띠의 한 줄 = 진행 중인 작업이 있는 저장소 하나. 출처는 폴더 요약(종류·충돌 수)과, 그 저장소의 세션이 장부에 있으면
// 세션 상태(rebase 단계·충돌 수·도는 쓰기·보관한 해결)다. 세션이 더 새 값이므로 있으면 세션을 믿는다 — 세션이 "작업
// 없음"이라고 하면 요약이 다시 읽히기 전이라도 줄을 뺀다.

import type {
  InProgressOp,
  OpKind,
  RepoChanges,
  RepoSummary,
  StatusEntry,
  StatusSummary,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { opLabel, type SessionState } from '../../store';
import { sessionBusy } from '../../store/repo-sessions';
import { opBadgeText } from '../project/project-rows';

/** 띠가 한 번에 보이는 줄 수. 더 많으면 띠 안에서 스크롤한다 (화면 틀을 밀어내지 않게) */
export const OP_BAND_MAX_ROWS = 3;

/** 띠의 줄 수에 따른 모양: 보이는 줄 수와 스크롤로 가려진 줄 수 */
export function opBandOverflow(count: number): { visible: number; hidden: number } {
  const visible = Math.min(count, OP_BAND_MAX_ROWS);
  return { visible, hidden: count - visible };
}

/** 띠가 읽는 세션 상태 (장부에 그 저장소의 세션이 있을 때) */
export interface OpBandSession {
  op: InProgressOp | null;
  conflicted: number;
  /** 쓰기가 도는 중 (`busy`) */
  busy: boolean;
  /** 지금 작업에 다시 적용할 수 있는 보관한 해결 수 (중단 확인창이 알린다) */
  kept: number;
  /** 세션 상한에서 놓으면 안 되는 세션인지 (`sessionBusy` — 작업·초안·보이는 대화상자) */
  pinned: boolean;
}

/** 세션 상태에서 띠가 읽는 값을 고른다 (`useLedgerSessions` 의 선택자 — 얕은 비교로 안정된다) */
export function pickOpBandSession(st: SessionState): OpBandSession {
  return {
    op: st.op,
    conflicted: st.status.summary.conflicted,
    busy: st.busy,
    kept: st.kept.filter((k) => k.matchesCurrent).length,
    pinned: sessionBusy(st),
  };
}

/** 띠의 한 줄 */
export interface OpBandRow {
  repoPath: string;
  repoName: string;
  /** 저장소 색 번호 (`--graph-lane-N`) */
  color: number;
  kind: OpKind;
  /** `REBASING 2/5` 처럼. 세션이 없으면 요약이 아는 만큼(`REBASING`) */
  label: string;
  conflicts: number;
  /** 그 저장소의 세션에서 쓰기가 도는 중 */
  busy: boolean;
  kept: number;
  /** 요약을 읽지 못한 사유 (세션이 진행 중이라고 알 때만 줄이 있다) */
  error: string | null;
}

/**
 * 띠의 줄들 (폴더 요약 순서): 세션이 있으면 세션의 작업·충돌 수, 없으면 요약의 것. 작업이 없으면 줄이 없다. 요약을
 * 읽지 못한 저장소는 요약이 작업을 모르므로 세션이 진행 중이라고 알 때만 줄이 있다
 */
export function opBandRows(
  summaries: readonly RepoSummary[],
  sessions: Readonly<Record<string, OpBandSession>>,
): OpBandRow[] {
  return summaries.flatMap((summary): OpBandRow[] => {
    const session = sessions[summary.path];
    const kind = session ? (session.op?.kind ?? null) : (summary.op ?? null);
    if (kind === null) {
      return [];
    }
    return [
      {
        repoPath: summary.path,
        repoName: summary.name,
        color: summary.color,
        kind,
        label: session?.op ? (opLabel(session.op) ?? opBadgeText(kind)) : opBadgeText(kind),
        conflicts: session ? session.conflicted : summary.conflicted,
        busy: session?.busy ?? false,
        kept: session?.kept ?? 0,
        error: summary.error ?? null,
      },
    ];
  });
}

/**
 * 작업 하나의 버튼 조건 (폴더 띠·저장소 띠 공용): Skip 은 rebase·cherry-pick·revert 에만 있다. Continue 는 쓰기가 도는 중이거나
 * 충돌이 남았으면 꺼지고(사유), Skip·Abort 는 쓰기가 도는 중에만 꺼진다. `hint` 는 충돌 수에 따른 안내 문구다
 */
export function opControls(
  kind: OpKind,
  conflicts: number,
  busy: boolean,
): {
  canSkip: boolean;
  continueDisabled: boolean;
  /** Continue 가 꺼진 사유 (툴팁). 쓰기가 도는 중이거나 켜져 있으면 null */
  continueReason: string | null;
  hint: string;
} {
  return {
    canSkip: kind === 'rebase' || kind === 'cherryPick' || kind === 'revert',
    continueDisabled: busy || conflicts > 0,
    continueReason: conflicts > 0 ? S.opBand.continueBlocked(conflicts) : null,
    hint: conflicts > 0 ? S.op.conflicts(conflicts) : S.op.noConflicts,
  };
}

/**
 * 작업 한 줄의 칸 (W19). 여러 줄 띠에서는 같은 칸이 줄마다 같은 열에 놓인다 — 그 줄에 없는 칸(merge 의 Skip, 충돌이 없는
 * 줄의 충돌 수·충돌 해결)은 자리만 비우므로 Continue·Skip·Abort 열이 어긋나지 않는다. 저장소 탭의 띠도 같은 격자다
 * (W21 — 격리 병합 줄이 같은 열을 나눠 쓴다, `ISOLATED_ROW_COLUMNS`)
 */
export const OP_ROW_SLOTS = [
  'subject',
  'label',
  'count',
  'hint',
  'resolve',
  'continue',
  'skip',
  'abort',
] as const;
export type OpRowSlot = (typeof OP_ROW_SLOTS)[number];

/** 칸의 열 번호 (띠의 격자, 1부터) */
export function opSlotColumn(slot: OpRowSlot): number {
  return OP_ROW_SLOTS.indexOf(slot) + 1;
}

/**
 * 그 줄에 그릴 칸 (차례대로): 대상 이름은 `subject` 가 있을 때, 충돌 수·충돌 해결은 충돌 해결 동작이 있고 충돌이 있을 때,
 * Skip 은 건너뛸 수 있는 작업일 때 (`opControls`)
 */
export function opRowSlots(input: {
  kind: OpKind;
  conflicts: number;
  subject: boolean;
  resolvable: boolean;
}): OpRowSlot[] {
  const resolving = input.resolvable && input.conflicts > 0;
  const { canSkip } = opControls(input.kind, input.conflicts, false);
  return OP_ROW_SLOTS.filter((slot) => {
    switch (slot) {
      case 'subject':
        return input.subject;
      case 'count':
      case 'resolve':
        return resolving;
      case 'skip':
        return canSkip;
      default:
        return true;
    }
  });
}

/** 중단 확인창의 내용 (격리 병합 "버리기"의 확인창도 같은 모양이다) */
export interface AbortConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  danger: true;
}

/**
 * 중단 확인창 (폴더 띠·저장소 띠 공용): 저장소 탭은 지금 문구 그대로, 여러 저장소의 띠는 어느 저장소의 어떤 작업을
 * 중단하는지와 무엇을 잃는지를 밝힌다. 보관한 해결이 있으면 재적용 제안을 함께 알린다
 */
export function abortConfirm(input: {
  kind: OpKind;
  kept: number;
  /** 대상 저장소 이름. 없으면 저장소 탭의 문구 */
  repoName?: string;
}): AbortConfirm {
  const kept = input.kept > 0 ? ` ${S.op.abortKept(input.kept)}` : '';
  const kind = S.opBand.kind[input.kind];
  return input.repoName === undefined
    ? {
        title: S.op.abortTitle,
        message: `${S.op.abortMessage}${kept}`,
        confirmLabel: S.op.abort,
        danger: true,
      }
    : {
        title: S.opBand.abortTitle(input.repoName, kind),
        message: `${S.opBand.abortMessage}${kept}`,
        confirmLabel: S.op.abort,
        danger: true,
      };
}

/** 띠에서 거는 동작 */
export type OpCommand = 'continue' | 'skip' | 'abort';

/** 동작 하나의 결과 */
export type OpRunResult =
  /** 세션을 쓸 수 없어 실행하지 않았다 (사유는 앱 스토어가 알렸다) */
  | { kind: 'notRun' }
  /** 끝났다 (작업이 마쳐졌거나 중단됐다) */
  | { kind: 'done' }
  /** 이어 간 다음 단계에서 다시 충돌했다 */
  | { kind: 'conflicts' }
  /** 확인이 필요한 힌트가 섰다 (대화상자가 뜬다) */
  | { kind: 'hint' }
  | { kind: 'failed'; message: string };

/**
 * 실행이 끝난 뒤 세션 상태로 결과를 가른다: 힌트가 섰으면 대화상자 몫, 오류가 남았으면 실패, 병합 결과가 충돌이면 다시
 * 충돌, 그 밖은 끝남. 세션의 쓰기는 시작할 때 오류·결과를 비우므로 이번 실행의 것이다
 */
export function opRunResult(
  after: Pick<SessionState, 'actionError' | 'pendingHint' | 'lastOutcome'>,
): OpRunResult {
  if (after.pendingHint !== null) {
    return { kind: 'hint' };
  }
  if (after.actionError !== null) {
    return { kind: 'failed', message: after.actionError };
  }
  return after.lastOutcome === 'conflicts' ? { kind: 'conflicts' } : { kind: 'done' };
}

/** 변경 목록에서 충돌 파일 경로들 (저장소 기준 상대 경로, 목록 순서) — 저장소 탭은 세션의 상태 목록을 그대로 넘긴다 */
export function conflictPaths(entries: readonly StatusEntry[]): string[] {
  return entries.filter((e) => e.conflict !== null && e.conflict !== undefined).map((e) => e.path);
}

/** 폴더 변경 목록에서 그 저장소의 충돌 파일 경로들 (저장소 기준 상대 경로, 목록 순서) */
export function conflictPathsOf(changes: readonly RepoChanges[], repoPath: string): string[] {
  return conflictPaths(changes.find((rc) => rc.path === repoPath)?.entries ?? []);
}

/** "충돌 해결"(과 충돌 수 단추)이 여는 곳: 충돌 파일 하나의 머지 편집기 탭 / Commit 도구 창의 충돌 목록 */
export type ConflictResolveTarget = { kind: 'file'; path: string } | { kind: 'list' };

/**
 * "충돌 해결"이 열 곳 (폴더 띠·저장소 띠 공용): 충돌 파일이 하나면 그 파일의 머지 편집기 탭, 여럿이면(또는 상태를
 * 아직 읽지 못해 모르면) Commit 도구 창의 충돌 목록
 */
export function conflictResolveTarget(paths: readonly string[]): ConflictResolveTarget {
  const only = paths.length === 1 ? paths[0] : undefined;
  return only === undefined ? { kind: 'list' } : { kind: 'file', path: only };
}

/** "충돌 해결" 단추의 툴팁: 무엇이 열리는지 */
export function conflictResolveTitle(target: ConflictResolveTarget, conflicts: number): string {
  return target.kind === 'file' ? S.opBand.resolveOne : S.opBand.resolveMany(conflicts);
}

/** 저장소 탭 띠의 작업 줄 (W21): 그 탭 세션의 진행 중인 작업 */
export interface RepoOpRow {
  kind: OpKind;
  /** `REBASING 2/5` */
  label: string;
  conflicts: number;
  busy: boolean;
  /** 중단 확인창이 알릴 보관한 해결 수 */
  kept: number;
}

/**
 * 저장소 탭 띠의 작업 줄 (W21): 세션에 진행 중인 작업이 있으면 그 라벨·충돌 수·도는 쓰기. 없으면 null — 출처는 세션의
 * `op` 다 (옛 그래프 위 진행 중 작업 배너와 같다). 그래프 로드 상태와는 무관하다
 */
export function repoOpRow(s: Omit<OpBandSession, 'pinned'>): RepoOpRow | null {
  if (s.op === null) {
    return null;
  }
  return {
    kind: s.op.kind,
    label: opLabel(s.op) ?? opBadgeText(s.op.kind),
    conflicts: s.conflicted,
    busy: s.busy,
    kept: s.kept,
  };
}

/** 저장소 탭 띠의 격리 병합 줄 (W21, 계획 7.2절 — 옛 사이드바의 격리 병합 띠) */
export interface IsolatedRow {
  /** 격리 병합의 임시 branch */
  branch: string;
  /** "메인에 반영"을 막는 사유. null 이면 반영할 수 있다 */
  applyBlocked: string | null;
}

/**
 * 격리 병합 줄 (격리 워크트리 탭일 때만): 반영은 쓰기가 도는 중이거나, 진행 중인 작업(merge 가 끝나지 않음)이 있거나,
 * 작업 트리에 변경(staged·unstaged·untracked·충돌)이 남았으면 막는다 — 코어가 그런 반영을 거부한다 (옛 사이드바와 같은
 * 조건·같은 사유 문구)
 */
export function isolatedRow(s: {
  isolatedBranch: string | null;
  busy: boolean;
  op: InProgressOp | null;
  summary: Pick<StatusSummary, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>;
}): IsolatedRow | null {
  if (s.isolatedBranch === null) {
    return null;
  }
  const dirty = s.summary.staged + s.summary.unstaged + s.summary.untracked + s.summary.conflicted;
  const blocked = s.busy || s.op !== null || dirty > 0;
  return {
    branch: s.isolatedBranch,
    applyBlocked: blocked ? S.preview.isolatedApplyBlocked : null,
  };
}

/** 격리 병합 "버리기"의 확인창 (옛 사이드바 문구 그대로) */
export function isolatedDiscardConfirm(): AbortConfirm {
  return {
    title: S.preview.isolatedTitle,
    message: S.preview.isolatedDiscardConfirm,
    confirmLabel: S.preview.isolatedDiscard,
    danger: true,
  };
}

/**
 * 격리 줄의 칸이 놓일 띠의 열: 라벨·안내는 작업 줄과 같은 열, "메인에 반영"은 Continue 열, "버리기"는 Abort 열 — 같은
 * 열의 단추는 같은 뜻(이어 가기·버리기)이다. 작업 줄과 함께 있어도 열이 어긋나지 않는다
 */
export const ISOLATED_ROW_COLUMNS = {
  label: 'label',
  hint: 'hint',
  apply: 'continue',
  discard: 'abort',
} as const satisfies Record<string, OpRowSlot>;
