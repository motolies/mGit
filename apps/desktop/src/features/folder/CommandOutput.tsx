// 작업 기록의 일괄 명령(MR-14) 결과: 저장소마다 종료 코드·소요 시간과 표준 출력·표준 오류를 펼쳐 보고 복사한다. 출력은
// 터미널이 아니라 글자로 보이므로 색 등 제어 순서는 지운다 (`stripAnsi`).

import type { CommandOutput, RepoResult } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useState } from 'react';
import { commandStateText, repoResultState } from './batch-report';
import styles from './CommandOutput.module.css';
import { stripAnsi } from './git-command';

/** 출력을 클립보드에 넣는다 (실패는 조용히 넘긴다 — 다른 복사 동작과 같다) */
function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/** 저장소 하나의 복사할 글자: 표준 출력, (있으면) 빈 줄 뒤 표준 오류. 제어 순서는 지운다 */
export function commandOutputText(out: CommandOutput): string {
  const stdout = stripAnsi(out.stdout);
  const stderr = stripAnsi(out.stderr);
  if (stderr === '') {
    return stdout;
  }
  return stdout === '' ? stderr : `${stdout.endsWith('\n') ? stdout : `${stdout}\n`}\n${stderr}`;
}

/** 모든 저장소의 복사할 글자: 저장소마다 `== 이름 · 종료 상태 ==` 머리 뒤에 출력 (출력 칸이 없는 저장소는 상태만) */
export function commandOutputsText(results: readonly RepoResult[]): string {
  return results
    .map((r) => {
      const head = `== ${r.name} · ${r.command && !r.cancelled ? commandStateText(r.command) : repoResultState(r)} ==`;
      const body = r.command ? commandOutputText(r.command) : r.message;
      return body === '' ? head : `${head}\n${body.endsWith('\n') ? body : `${body}\n`}`;
    })
    .join('\n');
}

/** 저장소 하나의 상태 표시 (`data-state`): 취소됨 / 건너뜀 / 성공 / 실패 */
function stateOf(r: RepoResult): 'ok' | 'skipped' | 'failed' | 'cancelled' {
  if (r.cancelled) {
    return 'cancelled';
  }
  if (r.skipped) {
    return 'skipped';
  }
  return r.ok ? 'ok' : 'failed';
}

/** 출력 한 덩어리: 제목(표준 출력·표준 오류)과 잘림 안내, 글자 그대로의 내용 */
function Stream({ title, text, cut }: { title: string; text: string; cut: string | null }) {
  return (
    <section className={styles.stream} aria-label={title}>
      <div className={styles.streamHead}>
        <span className={styles.streamTitle}>{title}</span>
        {cut ? <span className={styles.cut}>{cut}</span> : null}
      </div>
      <pre className={styles.pre}>{text}</pre>
    </section>
  );
}

/**
 * 저장소 한 줄 (목록 항목): 이름, 종료 상태(또는 건너뜀·취소 사유), 출력 보기·숨기기와 복사 단추, 펼치면 표준 출력·표준
 * 오류. 출력이 있으면 처음부터 펼쳐 있다. 오래된 기록이라 출력을 지웠으면(`dropped`) 안내만 보인다
 */
export function CommandRepoItem({ result, dropped }: { result: RepoResult; dropped: boolean }) {
  const c = S.folder.command;
  const out = result.command ?? null;
  const stdout = out ? stripAnsi(out.stdout) : '';
  const stderr = out ? stripAnsi(out.stderr) : '';
  const hasOutput = !dropped && (stdout !== '' || stderr !== '');
  const [open, setOpen] = useState(hasOutput);
  const state = out && !result.cancelled ? commandStateText(out) : repoResultState(result);
  return (
    <li className={styles.repo} data-state={stateOf(result)}>
      <div className={styles.head}>
        <span className={styles.name} title={result.path}>
          {result.name}
        </span>
        <span className={styles.state} title={state}>
          {state}
        </span>
        {hasOutput ? (
          <>
            <Button size="compact" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? c.hideOutput : c.showOutput}
            </Button>
            <Button
              size="compact"
              onClick={() => out && copyText(commandOutputText(out))}
              title={c.copy}
            >
              {c.copy}
            </Button>
          </>
        ) : null}
      </div>
      {!out && result.message ? <p className={styles.message}>{result.message}</p> : null}
      {out && dropped ? <p className={styles.note}>{c.outputsDropped}</p> : null}
      {out && !dropped && !hasOutput ? <p className={styles.note}>{c.noOutput}</p> : null}
      {out && open && hasOutput ? (
        <div className={styles.body}>
          {stdout !== '' ? (
            <Stream
              title={c.stdout}
              text={stdout}
              cut={out.stdoutTruncated ? c.stdoutTruncated : null}
            />
          ) : null}
          {stderr !== '' ? (
            <Stream
              title={c.stderr}
              text={stderr}
              cut={out.stderrTruncated ? c.stderrTruncated : null}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * 일괄 명령 줄을 펼친 내용: 모든 저장소 출력 복사 단추와 저장소별 결과 목록. 출력을 지운 오래된 기록이면 복사 단추가 없다
 */
export function CommandResults({
  id,
  results,
  dropped,
}: {
  id: string;
  results: readonly RepoResult[];
  dropped: boolean;
}) {
  const c = S.folder.command;
  return (
    <div id={id} className={styles.results}>
      {dropped ? null : (
        <div className={styles.tools}>
          <Button size="compact" onClick={() => copyText(commandOutputsText(results))}>
            {c.copyAll}
          </Button>
        </div>
      )}
      <ul className={styles.list}>
        {results.map((r) => (
          <CommandRepoItem key={r.path} result={r} dropped={dropped} />
        ))}
      </ul>
    </div>
  );
}
