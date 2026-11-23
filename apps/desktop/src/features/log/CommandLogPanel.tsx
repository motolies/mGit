import type { CommandLogRecord } from '@mgit/ipc';
import { formatTime, isPrimaryModifier, S } from '@mgit/ui';
import { type CSSProperties, type KeyboardEvent, memo, useEffect, useMemo, useState } from 'react';
import { hasModifier, rovingIndex } from '../../components/roving';
import {
  commandFailed,
  type FolderLogEntry,
  type LogRepo,
  logRepoIndex,
  useAppStore,
  useFolder,
  useIsRepoTab,
  useSession,
} from '../../store';
import { activeTabKind } from '../../store/app-store';
import styles from './CommandLogPanel.module.css';

/** `git <args>` 형태의 복사용 문자열 (셸 인용은 공백이 있는 인자만) */
export function commandLine(record: CommandLogRecord): string {
  const quoted = record.args.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a));
  return `git ${quoted.join(' ')}`;
}

/** 콘솔 한 줄의 재료: 기록과, 폴더 탭이면 그 저장소 */
export interface CommandLogRow {
  record: CommandLogRecord;
  repo?: LogRepo;
}

/** 저장소 색 사각형 (`--graph-lane-N`). 색을 모르면 그리지 않는다 */
function RepoSwatch({ color }: { color: number | null }) {
  return color === null ? null : (
    <span
      className={styles.swatch}
      style={{ '--repo-color': `var(--graph-lane-${color})` } as CSSProperties}
    />
  );
}

/**
 * 로그 한 줄 (저장소 탭·폴더 탭 공용): 시각, 종류, 명령줄(누르면 stderr 펼치기), 걸린 시간·종료 상태, 복사. 실패한 명령은
 * 명령줄이 강조된다(종료 상태 글자로도 전한다). 폴더 탭이면 시각 뒤에 저장소 칸(색 사각형 + 이름)이 더해지고, 누르면 그
 * 저장소로 좁히거나(`active` 면) 전체로 돌아간다. 기록·저장소가 그대로면 다시 그리지 않는다 (콘솔에 기록이 쌓일 때 새
 * 줄만 그린다).
 * 키보드 (W19 ③): 줄 자체가 포커스를 받는다(목록 안에서 하나만 Tab 정지 — `stop`). 줄에서 Enter·Space = stderr
 * 펼치기(명령줄 누르기와 같다), ⌘C = 명령줄 복사, →·← = 줄 안의 단추(저장소 칸·명령줄·복사) 사이를 오간다
 */
const LogRow = memo(function LogRow({
  record,
  repo,
  active,
  onNarrow,
  index,
  stop,
  onFocusRow,
}: {
  record: CommandLogRecord;
  repo?: LogRepo;
  /** 이 저장소로 좁혀 보는 중인지 */
  active: boolean;
  onNarrow?: (repo: string | null) => void;
  /** 목록에서의 차례 (키보드 이동) */
  index: number;
  /** 이 줄이 목록의 Tab 정지인지 */
  stop: boolean;
  /** 줄이나 줄 안의 단추가 포커스를 받았다 (목록의 Tab 정지를 이 줄로) */
  onFocusRow: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const status = record.cancelled ? S.log.cancelled : S.log.exit(record.status ?? null);
  const failed = commandFailed(record);
  const hasStderr = Boolean(record.stderrTail);

  /** 명령줄을 클립보드에 복사한다 */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commandLine(record));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 클립보드 권한이 없으면 조용히 무시
    }
  };

  /** 줄의 키: 줄 자체에서 Enter·Space 펼치기, ⌘C 복사. →·← 는 줄과 줄 안의 단추 사이를 오간다 */
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    const row = e.currentTarget;
    const onRow = e.target === row;
    if (onRow && (e.key === 'Enter' || e.key === ' ') && !hasModifier(e)) {
      e.preventDefault();
      setOpen((v) => !v);
      return;
    }
    if (onRow && e.key.toLowerCase() === 'c' && isPrimaryModifier(e) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void copy();
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !hasModifier(e)) {
      const stops = [row, ...row.querySelectorAll<HTMLElement>('button')];
      const at = stops.indexOf(e.target as HTMLElement);
      const next = stops[at + (e.key === 'ArrowRight' ? 1 : -1)];
      if (at >= 0 && next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  /** 저장소 칸의 툴팁: 좁히기·되돌리기 안내, 워크트리에서 돈 명령이면 실제 작업 디렉터리 */
  const repoTip = (r: LogRepo) =>
    [
      active ? S.log.widenTip(r.name) : S.log.narrowTip(r.name),
      record.cwd !== r.path ? S.log.cwdTip(record.cwd) : null,
    ]
      .filter((line) => line !== null)
      .join('\n');

  return (
    // 줄이 포커스를 받는 목록 항목이다 (W19 ③ — 목록 하나가 Tab 정지 하나, 움직이는 tabindex). 키는 줄의 onKeyDown 이 맡는다
    <li
      className={styles.row}
      data-failed={failed ? 'true' : 'false'}
      data-repo={repo ? 'true' : undefined}
      data-log-index={index}
      tabIndex={stop ? 0 : -1}
      onFocus={() => onFocusRow(index)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.time}>{formatTime(record.startedAt)}</span>
      {repo ? (
        <button
          type="button"
          className={styles.repo}
          aria-pressed={active}
          title={repoTip(repo)}
          tabIndex={-1}
          onClick={() => onNarrow?.(active ? null : repo.path)}
        >
          <RepoSwatch color={repo.color} />
          <span className={styles.repoName}>{repo.name}</span>
        </button>
      ) : null}
      <span className={styles.kind}>{record.isWrite ? S.log.write : S.log.read}</span>
      <button
        type="button"
        className={styles.command}
        // stderr 가 있는 줄만 펼칠 것이 있다 (보조 기술에 펼침 상태로 알린다)
        aria-expanded={hasStderr ? open : undefined}
        tabIndex={-1}
        onClick={() => setOpen((v) => !v)}
        title={commandLine(record)}
      >
        {commandLine(record)}
      </button>
      <span className={styles.meta}>
        {S.log.elapsed(record.elapsedMs)} · {status}
      </span>
      <button type="button" className={styles.copy} tabIndex={-1} onClick={() => void copy()}>
        {copied ? S.log.copied : S.log.copy}
      </button>
      {open && record.stderrTail ? <pre className={styles.stderr}>{record.stderrTail}</pre> : null}
    </li>
  );
});

/** `CommandLogView` 의 입력 (props 전용 — 스토어를 모른다) */
export interface CommandLogViewProps {
  /** 보일 줄 (최신이 앞). 좁혀 보는 중이면 그 저장소의 줄만 담아 준다 */
  rows: readonly CommandLogRow[];
  /** 줄이 없을 때의 안내 */
  emptyText: string;
  /** 좁혀 보는 저장소. 있으면 목록 위에 표시와 "전체 보기" 가 붙는다 */
  narrowed?: LogRepo | null;
  /** 저장소 칸·"전체 보기"를 눌렀을 때 (null = 전체) */
  onNarrow?: (repo: string | null) => void;
}

/**
 * 명령 로그 목록 (Git 도구 창의 콘솔 탭 내용, SF-01). 머리(제목·숨기기)와 높이는 아래 도구 창 슬롯이 맡는다. 줄 수는
 * 탭마다 상한(`LOG_CAPACITY`)으로 묶여 있어 가상 스크롤 없이 모두 그린다
 */
export function CommandLogView({
  rows,
  emptyText,
  narrowed = null,
  onNarrow,
}: CommandLogViewProps) {
  // 목록의 Tab 정지인 줄 (W19 ③): 마지막으로 포커스를 받은 줄. 줄이 줄어 넘치면 끝 줄
  const [focusIndex, setFocusIndex] = useState(0);
  const stop = Math.min(focusIndex, Math.max(0, rows.length - 1));
  /** ↑↓·PageUp·PageDown·Home·End: 줄을 옮긴다 (끝에서 멈춘다). 줄 안의 단추에서 눌러도 줄로 간다 */
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (hasModifier(e)) {
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-log-index]');
    const at = Number(row?.getAttribute('data-log-index') ?? stop);
    const next = rovingIndex(e.key, at, rows.length, 'vertical', false);
    if (next === null) {
      return;
    }
    e.preventDefault();
    setFocusIndex(next);
    const target = e.currentTarget.querySelector<HTMLElement>(`[data-log-index="${next}"]`);
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  };
  return (
    <section className={styles.panel} aria-label={S.log.title}>
      {narrowed ? (
        <div className={styles.narrowBar}>
          <RepoSwatch color={narrowed.color} />
          <span className={styles.narrowText}>{S.log.narrowed(narrowed.name)}</span>
          <button type="button" className={styles.showAll} onClick={() => onNarrow?.(null)}>
            {S.log.showAll}
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className={styles.empty}>{emptyText}</div>
      ) : (
        // 목록의 키보드 이동: 줄 사이를 옮기는 화살표 키를 목록에서 받는다 (줄마다의 키는 줄이 맡는다)
        <ul className={styles.list} aria-label={S.log.title} onKeyDown={onKeyDown}>
          {rows.map((r, i) => (
            <LogRow
              key={r.record.id}
              record={r.record}
              repo={r.repo}
              active={narrowed !== null && r.repo?.path === narrowed.path}
              onNarrow={onNarrow}
              index={i}
              stop={i === stop}
              onFocusRow={setFocusIndex}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 빈 기록 (같은 배열을 돌려 다시 그리지 않게) */
const NO_LOG: readonly CommandLogRecord[] = [];
const NO_FOLDER_LOG: readonly FolderLogEntry[] = [];

/**
 * 저장소 탭의 콘솔: 그 세션에서 돈 git 명령(읽기·쓰기)을 최신 순으로. 저장소 탭이 아니면 비어 있다 — 폴더 탭의 숨은
 * 세션의 기록은 여기로 보이지 않는다 (W13 ③ 허용 목록. 폴더 탭은 `FolderCommandLog`)
 */
function RepoCommandLog() {
  const repoTab = useIsRepoTab();
  const sessionLog = useSession((s) => s.log);
  const log = repoTab ? sessionLog : NO_LOG;
  const rows = useMemo(() => log.map((record) => ({ record })), [log]);
  return <CommandLogView rows={rows} emptyText={S.log.empty} />;
}

/**
 * 폴더 탭의 콘솔 (W19 ②, WS-12): 폴더의 저장소에서 돈 쓰기·네트워크 명령. 줄마다 저장소 이름·색을 붙이고(요약에서),
 * 저장소 칸을 누르면 그 저장소의 줄로 좁힌다. 그려져 있는 동안은 콘솔을 보는 중으로 알린다 — 그동안의 실패는 콘솔 탭
 * 표시로 세지 않는다
 */
function FolderCommandLog() {
  const entries = useFolder((f) => f.commandLog) ?? NO_FOLDER_LOG;
  const summaries = useFolder((f) => f.summaries);
  const narrowedPath = useFolder((f) => f.commandLogRepo) ?? null;
  const setRepo = useFolder((f) => f.setCommandLogRepo);
  const view = useFolder((f) => f.viewCommandLog);
  useEffect(() => view?.(), [view]);
  const repoOf = useMemo(() => logRepoIndex(summaries ?? []), [summaries]);
  const rows = useMemo(
    () =>
      entries
        .filter((e) => narrowedPath === null || e.repo === narrowedPath)
        .map((e) => ({ record: e.record, repo: repoOf(e.repo) })),
    [entries, narrowedPath, repoOf],
  );
  const narrowed = narrowedPath === null ? null : repoOf(narrowedPath);
  return (
    <CommandLogView
      rows={rows}
      emptyText={narrowed ? S.log.repoEmpty(narrowed.name) : S.log.folderEmpty}
      narrowed={narrowed}
      onNarrow={setRepo ?? undefined}
    />
  );
}

/** 콘솔 탭의 내용: 폴더 탭이면 폴더의 기록, 아니면 저장소 탭 세션의 기록 */
export function CommandLogPanel() {
  const kind = useAppStore(activeTabKind);
  return kind === 'folder' ? <FolderCommandLog /> : <RepoCommandLog />;
}
