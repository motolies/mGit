// 폴더 탭의 작업 기록 (Git 도구 창의 작업 기록 탭): 끝난 일괄 작업·commit 과 자동 fetch 를 끝난 시각과 함께 최신 순으로
// 보인다. 개요 탭에 남던 결과 목록을 옮긴 것이다 — 끝날 때의 요약은 토스트가 맡고, 저장소별 결과는 줄을 펼쳐 본다.

import type { AutoFetchedRepo, RepoResult } from '@mgit/ipc';
import { Button, formatTime, S } from '@mgit/ui';
import { memo, type ReactNode, useCallback, useRef, useState } from 'react';
import { getFolderStore, type TaskEntry, useAppStore, useFolder } from '../../store';
import {
  type BatchClonePreset,
  batchCloneFlow,
  cloneRetryCount,
  cloneRetryPreset,
} from '../home/batch-clone';
import { batchSummary, repoResultState, useBatchReport } from './batch-report';
import { type RetryPlan, retryFailed, retryPlan } from './batch-retry';
import { stashBatchOfEntry } from './batch-stash';
import { CommandResults } from './CommandOutput';
import { useFolderBatchFlows } from './FolderBatchBar';
import styles from './TaskHistoryPanel.module.css';

/** 줄이 실패를 담았는지: 실행하지 못했거나, 실패한 저장소가 있다 */
export function taskFailed(entry: TaskEntry): boolean {
  if (entry.error !== null) {
    return true;
  }
  if (entry.result) {
    return entry.result.failed > 0;
  }
  return (entry.autoFetch ?? []).some((r) => (r.error ?? null) !== null);
}

/** 줄의 요약: 일괄 작업·commit 은 결과의 수(`batchSummary`), 자동 fetch 는 갱신·실패한 저장소 수 */
export function taskSummary(entry: TaskEntry): string {
  if (entry.kind === 'autoFetch') {
    const repos = entry.autoFetch ?? [];
    return S.folder.history.autoFetchSummary(
      repos.filter((r) => r.refs.length > 0).length,
      repos.filter((r) => (r.error ?? null) !== null).length,
    );
  }
  return entry.result ? batchSummary(entry.result) : S.folder.history.notRun;
}

/** 펼쳐 볼 것이 있는지: 저장소별 결과나 실행하지 못한 사유 */
function hasDetails(entry: TaskEntry): boolean {
  return (
    entry.error !== null ||
    (entry.result?.results.length ?? 0) > 0 ||
    (entry.autoFetch?.length ?? 0) > 0
  );
}

/** 저장소 한 줄의 상태 표시 (`data-state`): 취소됨 / 건너뜀 / 성공 / 실패 */
function repoStateOf(r: RepoResult): 'ok' | 'skipped' | 'failed' | 'cancelled' {
  if (r.cancelled) {
    return 'cancelled';
  }
  if (r.skipped) {
    return 'skipped';
  }
  return r.ok ? 'ok' : 'failed';
}

/** 저장소 한 줄: 이름, 상태 글자, (있으면) 메시지 */
function RepoLine({
  name,
  state,
  text,
  message,
}: {
  name: string;
  state: 'ok' | 'skipped' | 'failed' | 'cancelled';
  text: string;
  message?: string | null;
}) {
  return (
    <li className={styles.repo} data-state={state}>
      <span className={styles.repoName} title={name}>
        {name}
      </span>
      <span className={styles.repoState} title={text}>
        {text}
      </span>
      {message ? (
        <span className={styles.repoMsg} title={message}>
          {message}
        </span>
      ) : null}
    </li>
  );
}

/** 자동 fetch 저장소 한 줄: 바뀐 원격 ref 들, 실패면 "실패" 와 사유 */
function autoFetchLine(r: AutoFetchedRepo) {
  const error = r.error ?? null;
  return (
    <RepoLine
      key={r.path}
      name={r.name}
      state={error === null ? 'ok' : 'failed'}
      text={error === null ? r.refs.join(', ') : S.folder.batch.failed}
      message={error}
    />
  );
}

/** 일괄 명령 줄인지 (저장소별 종료 코드·출력을 보이는 줄) */
function isCommandEntry(entry: TaskEntry): boolean {
  return entry.request?.op.kind === 'runCommand';
}

/**
 * 펼친 줄의 내용: 저장소별 결과(일괄 작업·commit·자동 fetch — 일괄 명령은 종료 코드와 출력까지) 또는 실행하지 못한
 * 사유
 */
function TaskDetails({ entry, id }: { entry: TaskEntry; id: string }) {
  if (entry.result && entry.result.results.length > 0 && isCommandEntry(entry)) {
    return (
      <CommandResults
        id={id}
        results={entry.result.results}
        dropped={entry.outputsDropped === true}
      />
    );
  }
  if (entry.result && entry.result.results.length > 0) {
    return (
      <ul id={id} className={styles.details}>
        {entry.result.results.map((r) => (
          <RepoLine
            key={r.path}
            name={r.name}
            state={repoStateOf(r)}
            text={repoResultState(r)}
            message={r.message}
          />
        ))}
      </ul>
    );
  }
  if (entry.autoFetch && entry.autoFetch.length > 0) {
    return (
      <ul id={id} className={styles.details}>
        {entry.autoFetch.map(autoFetchLine)}
      </ul>
    );
  }
  return (
    <p id={id} className={styles.errorText}>
      {entry.error}
    </p>
  );
}

/**
 * 기록 한 줄: 끝난 시각, 라벨, 요약, (합친 자동 fetch 면) 반복 수. 펼칠 것이 있으면 라벨·요약이 펼침 단추가 되고
 * (`aria-expanded`), 펼치면 저장소별 결과가 줄 아래에 보인다. 실패를 담은 줄은 요약이 강조된다(요약 글자로도 전한다).
 * 다시 실행할 수 있는 줄(실패·취소된 저장소가 있는 일괄 작업·여러 저장소 clone)은 끝에 "실패한 저장소만 다시 실행" 단추가, 저장에 성공한
 * 저장소가 있는 일괄 스태시 저장 줄은 "이 묶음 꺼내기" 단추가 붙는다 — 일괄 작업이 도는 동안 꺼진다. 기록·실행 중 여부가
 * 그대로면 다시 그리지 않는다. `initiallyOpen` 이면 펼친 채로 시작한다 (방금 끝난 일괄 명령의 출력을 바로 보인다)
 */
const TaskRow = memo(function TaskRow({
  entry,
  running,
  initiallyOpen = false,
  onRetry,
  onRetryClone,
  onPopBatch,
}: {
  entry: TaskEntry;
  running: boolean;
  initiallyOpen?: boolean;
  onRetry: (plan: RetryPlan) => void;
  onRetryClone: (preset: BatchClonePreset) => void;
  onPopBatch: (batch: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const plan = retryPlan(entry);
  // 여러 저장소 clone 줄: 실패·취소된 대상으로 clone 창을 다시 연다 (같은 상위 폴더·옵션)
  const clonePreset = cloneRetryPreset(entry);
  const stashBatch = stashBatchOfEntry(entry);
  const detailsId = `task-history-${entry.id}`;
  const expandable = hasDetails(entry);
  const repeat = entry.repeat ?? 1;
  const content: ReactNode = (
    <>
      {expandable ? (
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      ) : null}
      <span className={styles.label}>{entry.label}</span>
      <span className={styles.summary}>{taskSummary(entry)}</span>
      {repeat > 1 ? (
        <span className={styles.repeat} title={S.folder.history.repeatTip(repeat)}>
          <span aria-hidden="true">{S.folder.history.repeat(repeat)}</span>
          <span className={styles.srOnly}>{S.folder.history.repeatTip(repeat)}</span>
        </span>
      ) : null}
    </>
  );
  return (
    <li
      className={styles.row}
      data-kind={entry.kind}
      data-failed={taskFailed(entry) ? 'true' : 'false'}
    >
      <span className={styles.time}>{formatTime(entry.finishedAt)}</span>
      {expandable ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {content}
        </button>
      ) : (
        <span className={styles.toggle}>{content}</span>
      )}
      {plan ? (
        <Button
          disabled={running}
          onClick={() => onRetry(plan)}
          title={
            plan.mode === 'direct'
              ? S.folder.history.retryDirectTip
              : S.folder.history.retryConfirmTip
          }
        >
          {S.folder.history.retryFailed(plan.targets.length)}
        </Button>
      ) : null}
      {clonePreset ? (
        <Button
          disabled={running}
          onClick={() => onRetryClone(clonePreset)}
          title={S.folder.history.retryConfirmTip}
        >
          {S.folder.history.retryFailed(cloneRetryCount(clonePreset))}
        </Button>
      ) : null}
      {stashBatch !== null ? (
        <Button
          disabled={running}
          onClick={() => onPopBatch(stashBatch)}
          title={S.folder.history.popBatchTip}
        >
          {S.folder.history.popBatch}
        </Button>
      ) : null}
      {open && expandable ? <TaskDetails entry={entry} id={detailsId} /> : null}
    </li>
  );
});

/** 빈 기록 (같은 배열을 돌려 다시 그리지 않게) */
const NO_HISTORY: readonly TaskEntry[] = [];

/**
 * 작업 기록 탭의 내용 (폴더 탭): 머리(제목·수·기록 지우기)와 최신 순 목록. 기록이 없으면 안내 글자를 보인다. 폴더 탭이
 * 아니면 그리지 않는다. 줄 수는 상한(`TASK_HISTORY_CAPACITY`)으로 묶여 있어 가상 스크롤 없이 모두 그린다
 */
export function TaskHistoryPanel() {
  const entries = useFolder((f) => f.taskHistory) ?? NO_HISTORY;
  const clear = useFolder((f) => f.clearTaskHistory);
  const folderId = useFolder((f) => f.id);
  const flows = useFolderBatchFlows(useBatchReport());
  // 줄이 다시 그려지지 않게 다시 실행 함수는 하나로 두고, 누른 순간의 흐름·요약을 읽는다
  const flowsRef = useRef(flows);
  flowsRef.current = flows;
  const retry = useCallback(
    (plan: RetryPlan) => {
      const summaryOf = (path: string) =>
        folderId === null
          ? undefined
          : getFolderStore(folderId)
              ?.getState()
              .summaries.find((s) => s.path === path);
      void retryFailed(flowsRef.current, plan, summaryOf);
    },
    [folderId],
  );
  // 여러 저장소 clone 줄의 다시 실행: 실패·취소된 대상을 채운 clone 창을 같은 상위 폴더로 다시 연다
  const retryClone = useCallback((preset: BatchClonePreset) => {
    const app = useAppStore.getState();
    void batchCloneFlow(
      flowsRef.current.dialogs,
      {
        pickDirectory: app.pickDirectory,
        cloneRepositories: app.cloneRepositories,
        notice: app.notice,
      },
      preset,
    );
  }, []);
  // 일괄 스태시 저장 줄의 "이 묶음 꺼내기": 폴더의 모든 저장소에서 그 묶음을 찾아 꺼내기 확인 창을 연다
  const popBatch = useCallback((batch: string) => {
    void flowsRef.current.stashPop([], { batch });
  }, []);
  if (!clear) {
    return null;
  }
  const t = S.folder.history;
  return (
    <section className={styles.panel} aria-label={t.title}>
      <div className={styles.head}>
        <span className={styles.title}>{t.title}</span>
        <span className={styles.count}>{t.count(entries.length)}</span>
        <span className={styles.spacer} />
        <Button disabled={entries.length === 0} onClick={clear}>
          {t.clear}
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className={styles.empty}>{t.empty}</div>
      ) : (
        <ul className={styles.list} aria-label={t.title}>
          {entries.map((entry, index) => (
            <TaskRow
              key={entry.id}
              entry={entry}
              running={flows.running}
              // 맨 위(가장 최근)의 일괄 명령 줄은 펼쳐서 시작한다 — 실행하면 이 탭이 열려 출력이 바로 보인다
              initiallyOpen={index === 0 && isCommandEntry(entry)}
              onRetry={retry}
              onRetryClone={retryClone}
              onPopBatch={popBatch}
            />
          ))}
        </ul>
      )}
      {flows.dialogs.element}
    </section>
  );
}
