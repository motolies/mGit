import { type DiffActions, type DiffMode, type DiffNavigation, DiffView } from '@mgit/diff-view';
import type { DiffOptions, FileDiff, SubmodulePointerLog } from '@mgit/ipc';
import { Button, formatDateTime, S, shortHash } from '@mgit/ui';
import { registerCommand } from '../../command-registry';
import styles from './DiffPane.module.css';

/** Diff 본문의 구간 이동을 앱 공통 명령에 연결한다 */
function registerNavigation(element: HTMLElement, navigation: DiffNavigation) {
  const cleanups = (
    [
      ['diff.nextHunk', 1],
      ['diff.previousHunk', -1],
    ] as const
  ).map(([id, direction]) =>
    registerCommand(id, element.closest<HTMLElement>('[data-diff-pane]') ?? element, {
      enabled: () => navigation.available,
      run: () => navigation.moveHunk(direction),
    }),
  );
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/** 문자열 → 범위 안의 정수 */
function clampInt(text: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(text, 10);
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/** diff 보기 옵션 (DIFF-03). 공백 무시·문맥은 코어가, 줄바꿈·탭 폭은 뷰가 쓴다 */
export interface DiffPaneOptions extends DiffOptions {
  wrap: boolean;
  tabWidth: number;
}

export interface DiffPaneViewProps {
  /** 머리에 보일 경로 (구문 강조 언어도 이 경로로 고른다) */
  path: string;
  /** 머리 오른쪽의 영역 표시 (`commit a1b2c3d4`, `staged`, 범위 등) */
  areaLabel: string;
  /** 머리 아래 안내 한 줄 (머지 commit 의 비교 기준 등) */
  note?: string;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** 있으면 오류 줄에 "다시 시도" 를 둔다 */
  onRetry?: () => void;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  options: DiffPaneOptions;
  onOptionsChange: (patch: Partial<DiffPaneOptions>) => void;
  /** 잘린 diff 의 전체를 요청 ("전체 보기") */
  onLoadFull: () => void;
  /** 있으면 머리 왼쪽에 "← 그래프로" (저장소 탭의 가운데 diff 화면) */
  onBack?: () => void;
  /** 있으면 외부 diff 도구 버튼 (저장소 세션이 필요하다) */
  onDifftool?: () => void;
  /** 있으면 hunk·줄 단위 stage·되돌리기 (쓰기 동작). 읽기 전용 diff 는 주지 않는다 */
  actions?: DiffActions;
  /** 서브모듈 포인터 diff 면 그 사이의 commit 목록 (SUB-04) */
  submoduleLog?: SubmodulePointerLog | null;
}

/**
 * diff 화면 (DIFF-01·02·03): 머리(경로·영역·보기 옵션) + diff. 스토어를 모르고 받은 값과 동작만 그린다 —
 * stage·되돌리기·외부 도구·서브모듈·"← 그래프로" 는 주어졌을 때만 그린다. 저장소 탭의 세션 diff 와
 * 폴더 탭의 읽기 전용 커밋 diff 탭이 함께 쓴다
 */
export function DiffPaneView({
  path,
  areaLabel,
  note,
  diff,
  loading,
  error,
  onRetry,
  mode,
  onModeChange,
  options,
  onOptionsChange,
  onLoadFull,
  onBack,
  onDifftool,
  actions,
  submoduleLog,
}: DiffPaneViewProps) {
  return (
    <div className={styles.pane} data-diff-pane>
      <header className={styles.header}>
        {onBack ? <Button onClick={onBack}>← {S.diff.back}</Button> : null}
        <span className={styles.path} title={path}>
          {path}
        </span>
        <span className={styles.area}>{areaLabel}</span>
        <span className={styles.options}>
          <label className={styles.opt}>
            <input
              type="checkbox"
              checked={options.ignoreWhitespace}
              onChange={(e) => onOptionsChange({ ignoreWhitespace: e.target.checked })}
            />
            {S.diff.ignoreWhitespace}
          </label>
          <label className={styles.opt}>
            {S.diff.context}
            <input
              type="number"
              className={styles.num}
              min={0}
              max={99}
              value={options.context}
              onChange={(e) => onOptionsChange({ context: clampInt(e.target.value, 0, 99, 3) })}
            />
          </label>
          <label className={styles.opt}>
            <input
              type="checkbox"
              checked={options.wrap}
              onChange={(e) => onOptionsChange({ wrap: e.target.checked })}
            />
            {S.diff.wrap}
          </label>
          <label className={styles.opt}>
            {S.diff.tabWidth}
            <select
              className={styles.num}
              value={options.tabWidth}
              onChange={(e) => onOptionsChange({ tabWidth: clampInt(e.target.value, 1, 16, 4) })}
            >
              {[2, 4, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {onDifftool ? <Button onClick={onDifftool}>{S.history.difftool}</Button> : null}
        </span>
      </header>
      {note ? <div className={styles.note}>{note}</div> : null}
      {error ? (
        <div className={styles.error}>
          {error}
          {onRetry ? <Button onClick={onRetry}>{S.diff.retry}</Button> : null}
        </div>
      ) : null}
      {submoduleLog ? (
        <div className={styles.submoduleLog}>
          <div className={styles.submoduleHead}>
            {S.submodule.pointerLog(submoduleLog.commits.length)}
            {submoduleLog.reversed ? ` ${S.submodule.pointerReversed}` : ''}
          </div>
          {submoduleLog.missing ? (
            <div className={styles.error}>{S.submodule.pointerMissing}</div>
          ) : (
            <ul className={styles.submoduleList}>
              {submoduleLog.commits.map((c) => (
                <li key={c.oid} className={styles.submoduleItem}>
                  <span className={styles.mono}>{shortHash(c.oid)}</span>
                  <span className={styles.submoduleSubject}>{c.subject}</span>
                  <span className={styles.muted}>
                    {c.author} · {formatDateTime(c.time ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className={styles.body}>
        <DiffView
          onNavigationReady={registerNavigation}
          diff={diff}
          path={path}
          mode={mode}
          onModeChange={onModeChange}
          loading={loading}
          wrap={options.wrap}
          tabWidth={options.tabWidth}
          onLoadFull={onLoadFull}
          actions={actions}
        />
      </div>
    </div>
  );
}
