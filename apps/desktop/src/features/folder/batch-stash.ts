// 폴더 일괄 스태시 (셋째 묶음 G). 저장: 메시지·미추적 파일 포함을 받아 같은 묶음 id 로 저장소마다 `stash push` 한다. 꺼내기:
// 묶음을 고르고(여럿일 때) 그 묶음의 스태시가 남은 저장소를 체크 목록으로 받아 저장소마다 apply 후 drop 한다. 묶음은 코어가
// stash 메시지 끝에 붙인 표시(`[mgit-batch:<id>]`)로 저장소의 stash 목록에서 다시 모으므로, 작업 기록이 사라져도(앱 재시작)
// 꺼낼 수 있다. 흐름은 `useFolderBatchFlows` 가 넘긴 실행·대화상자·목록 읽기로 돈다.

import type { BatchOp, BatchResult, StashBatch } from '@mgit/ipc';
import { formatDateTime, requireChecked, S } from '@mgit/ui';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import { describeError, type TaskEntry } from '../../store';
import type { Notice } from '../../store/notify';
import { hasPendingDraft } from './batch-drafts';

/** 묶음 id 를 만든다: 지금 시각(36진)에 난수 세 자리를 붙인다. 코어가 받는 글자(영문 소문자·숫자)만 쓴다 */
export function newStashBatchId(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const tail = Math.floor(random() * 36 ** 3)
    .toString(36)
    .padStart(3, '0');
  return `${now.toString(36)}${tail}`;
}

/** 묶음의 이름: 저장할 때 적은 메시지, 없으면 `메시지 없음 (<id>)` */
export function stashBatchName(batch: Pick<StashBatch, 'id' | 'message'>): string {
  return batch.message.trim() === '' ? S.folder.batch.stashBatchUnnamed(batch.id) : batch.message;
}

/** 묶음 고르기 칸의 한 줄: `이름 — 저장소 N개 · 시각` */
export function stashBatchOption(batch: StashBatch): string {
  return S.folder.batch.stashBatchOption(
    stashBatchName(batch),
    batch.repos.length,
    formatDateTime(batch.time),
  );
}

/** 일괄 저장 확인 창을 다시 열 때 채울 값 ("실패한 저장소만 다시 실행" — 같은 묶음으로 이어 저장한다) */
export interface StashSavePreset {
  batch: string;
  message: string;
  includeUntracked: boolean;
}

/** 일괄 꺼내기에서 고를 묶음 (작업 기록의 "이 묶음 꺼내기", 실패한 저장소만 다시 실행) */
export interface StashPopPreset {
  batch: string;
}

/** 일괄 스태시 흐름이 쓰는 것 (`useFolderBatchFlows` 가 넘긴다) */
export interface StashFlowDeps {
  dialogs: Pick<ReturnType<typeof useDialogs>, 'prompt'>;
  /** 일괄 작업 실행. 이미 실행 중이거나 실행하지 못했으면 null */
  run: (op: BatchOp, paths: readonly string[]) => Promise<BatchResult | null>;
  /** 확인 창의 대상 표기 (수와 저장소 이름) */
  describe: (paths: readonly string[]) => string;
  /** 대상 중 편집기 초안이 있는 저장소 이름 (빈 목록 = 전부). 저장 확인 창에 미리 알린다 */
  draftedNames: (paths: readonly string[]) => string[];
  /** 묶음 목록 읽기 (폴더 스토어 `listStashBatches`, 빈 목록 = 전부) */
  listBatches: (paths: readonly string[]) => Promise<StashBatch[]>;
  /** 폴더 설정에서 뺀 저장소 이름 (누른 순간의 값) */
  excluded: () => readonly string[];
  notice: (notice: Notice) => void;
}

/**
 * 일괄 스태시 저장: 메시지(선택)와 미추적 파일 포함(처음엔 꺼짐 — 일괄 pull·checkout 은 미추적 파일로 건너뛰지 않는다)을
 * 받아 새 묶음 id 로(다시 실행이면 그 묶음으로) 실행한다. 대상은 넘긴 경로(빈 목록 = 전부)이고, 변경이 없거나 진행 중
 * 작업이 있는 저장소는 코어가 사유와 함께 건너뛴다. 취소하면 실행하지 않는다. 저장하지 않은 편집기 초안은 스태시에
 * 들어가지 않고 저장 뒤 다시 쓰이므로, 대상에 초안이 있으면 확인 창에 알리고 실행(`deps.run`)이 막는다
 */
export async function saveBatchStash(
  deps: StashFlowDeps,
  paths: readonly string[],
  preset?: StashSavePreset,
): Promise<BatchResult | null> {
  const t = S.folder.batch;
  const drafted = deps.draftedNames(paths);
  const values = await deps.dialogs.prompt({
    title: t.stashSaveTitle,
    message: [
      t.stashSaveMessage(deps.describe(paths)),
      ...(drafted.length > 0 ? [t.draftsNote(drafted.join(', '))] : []),
    ].join('\n'),
    fields: [
      { key: 'message', label: S.stash.message, initial: preset?.message ?? '' },
      {
        key: 'untracked',
        label: S.stash.includeUntracked,
        type: 'checkbox',
        initial: preset?.includeUntracked ?? false,
        note: t.stashUntrackedNote,
      },
    ],
    confirmLabel: t.stashSaveRun,
  });
  if (!values) {
    return null;
  }
  const message = str(values, 'message');
  return deps.run(
    {
      kind: 'stashPush',
      batch: preset?.batch ?? newStashBatchId(),
      message: message === '' ? null : message,
      includeUntracked: bool(values, 'untracked'),
    },
    paths,
  );
}

/** 저장소 체크 칸의 키 (다른 칸의 키와 겹치지 않게 접두를 붙인다) */
function repoKey(path: string): string {
  return `repo:${path}`;
}

/**
 * 일괄 스태시 꺼내기: 대상 저장소(빈 목록 = 전부)의 stash 목록에서 묶음을 모아, 여럿이면 고르게 하고(최근 묶음이 처음
 * 값), 그 묶음의 스태시가 남은 저장소를 체크 목록으로 보인다 (`이름: stash@{n} (branch)`, 처음엔 모두 체크, 폴더 설정에서
 * 뺀 저장소와 편집기 초안이 있는 저장소는 사유와 함께 꺼진 칸). 체크한 저장소에서만 꺼낸다. `preset` 이 있으면 그 묶음만
 * 본다. 꺼낼 묶음이 없으면 알리고 끝낸다
 */
export async function popBatchStash(
  deps: StashFlowDeps,
  paths: readonly string[],
  preset?: StashPopPreset,
): Promise<BatchResult | null> {
  const t = S.folder.batch;
  let batches: StashBatch[];
  try {
    batches = await deps.listBatches(paths);
  } catch (error) {
    deps.notice({ kind: 'error', title: t.stashListFailed, message: describeError(error) });
    return null;
  }
  if (preset) {
    batches = batches.filter((b) => b.id === preset.batch);
  }
  let batch = batches[0];
  if (!batch) {
    deps.notice({ kind: 'info', title: preset ? t.stashBatchGone : t.stashNone });
    return null;
  }
  if (batches.length > 1) {
    const picked = await deps.dialogs.prompt({
      title: t.stashPickTitle,
      message: t.stashPickMessage,
      fields: [
        {
          key: 'batch',
          label: t.stashBatch,
          type: 'select',
          initial: batch.id,
          options: batches.map((b) => ({ value: b.id, label: stashBatchOption(b) })),
        },
      ],
      confirmLabel: t.stashPickNext,
    });
    const chosen = picked ? batches.find((b) => b.id === str(picked, 'batch')) : undefined;
    if (!chosen) {
      return null;
    }
    batch = chosen;
  }
  const excluded = deps.excluded();
  const rows = batch.repos.map((repo) => ({
    ...repo,
    reason: excluded.includes(repo.name)
      ? t.excluded
      : hasPendingDraft(repo.path)
        ? S.folder.integration.pendingEditor
        : null,
  }));
  const eligible = rows.filter((repo) => repo.reason === null);
  const values = await deps.dialogs.prompt({
    title: t.stashPopTitle(stashBatchName(batch)),
    message: t.stashPopMessage,
    fields: rows.map((repo) => ({
      key: repoKey(repo.path),
      label: t.stashPopRepo(repo.name, repo.index, repo.branch ?? null),
      type: 'checkbox' as const,
      initial: repo.reason === null,
      disabled: repo.reason !== null,
      ...(repo.reason !== null ? { note: repo.reason } : {}),
      group: t.repoGroup(rows.length),
    })),
    validate: requireChecked(
      eligible.map((repo) => repoKey(repo.path)),
      eligible.length === 0 ? S.folder.integration.noneEligible : t.noneChecked,
    ),
    confirmLabel: t.stashPopRun,
  });
  if (!values) {
    return null;
  }
  const checked = eligible.filter((repo) => bool(values, repoKey(repo.path))).map((r) => r.path);
  // 빈 목록은 코어에서 "전부"를 뜻한다. 아무것도 고르지 않았으면 실행하지 않는다
  if (checked.length === 0) {
    return null;
  }
  return deps.run({ kind: 'stashPop', batch: batch.id }, checked);
}

/**
 * 작업 기록 줄에서 꺼낼 수 있는 묶음: 일괄 스태시 저장 줄이고 저장에 성공한 저장소가 하나 이상일 때 그 묶음 id. 아니면
 * null (단추를 그리지 않는다)
 */
export function stashBatchOfEntry(entry: TaskEntry): string | null {
  const op = entry.request?.op;
  if (entry.kind !== 'batch' || op?.kind !== 'stashPush' || !entry.result) {
    return null;
  }
  return entry.result.results.some((r) => r.ok && !r.skipped) ? op.batch : null;
}
