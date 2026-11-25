import { type DiffActions, type DiffMode, type DiffNavigation, DiffView } from '@mgit/diff-view';
import type { DiffDocument, FileDiff, SubmodulePointerLog } from '@mgit/ipc';
import { Button, formatDateTime, S, shortHash } from '@mgit/ui';
import { useCallback, useState } from 'react';
import { registerCommand } from '../../command-registry';
import type { DiffViewOptions } from '../../store/session-store';
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
export type DiffPaneOptions = DiffViewOptions;

export interface DiffPaneViewProps {
  /** 머리에 보일 경로 (구문 강조 언어도 이 경로로 고른다) */
  path: string;
  /** 머리 오른쪽의 영역 표시 (`commit a1b2c3d4`, `staged`, 범위 등) */
  areaLabel: string;
  /** 머리 아래 안내 한 줄 (머지 commit 의 비교 기준 등) */
  note?: string;
  diff: FileDiff | null;
  document?: DiffDocument | null;
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
  document,
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
  const [navigation, setNavigation] = useState<DiffNavigation | null>(null);
  /** 현재 변경 위치를 도구 모음에 반영하고 키보드 명령과 같은 이동 동작을 사용한다. */
  const onNavigationReady = useCallback((element: HTMLElement, next: DiffNavigation) => {
    setNavigation(next);
    return registerNavigation(element, next);
  }, []);
  return (
    <div className={styles.pane} data-diff-pane>
      <header className={styles.header}>
        {onBack ? <Button onClick={onBack}>← {S.diff.back}</Button> : null}
        <span className={styles.path} title={path}>
          {path}
        </span>
        <span className={styles.area}>{areaLabel}</span>
        {onDifftool ? <Button onClick={onDifftool}>{S.history.difftool}</Button> : null}
      </header>
      <div className={styles.options} role="toolbar" aria-label={S.diff.viewToolbar}>
        <span className={styles.segment}>
          <Button aria-pressed={mode === 'split'} onClick={() => onModeChange('split')}>
            {S.diff.split}
          </Button>
          <Button aria-pressed={mode === 'unified'} onClick={() => onModeChange('unified')}>
            {S.diff.unified}
          </Button>
        </span>
        <span className={styles.segment}>
          <Button
            aria-pressed={options.fullFile}
            onClick={() => onOptionsChange({ fullFile: true })}
          >
            {S.diff.fullFile}
          </Button>
          <Button
            aria-pressed={!options.fullFile}
            onClick={() => onOptionsChange({ fullFile: false })}
          >
            {S.diff.contextOnly}
          </Button>
        </span>
        <label className={styles.opt}>
          <input
            type="checkbox"
            checked={options.ignoreWhitespace}
            onChange={(e) => onOptionsChange({ ignoreWhitespace: e.target.checked })}
          />
          {S.diff.ignoreWhitespace}
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
          <input
            type="checkbox"
            checked={options.horizontalSync}
            onChange={(e) => onOptionsChange({ horizontalSync: e.target.checked })}
          />
          {S.diff.horizontalSync}
        </label>
        <label className={styles.opt}>
          {S.diff.highlight}
          <select
            className={styles.select}
            value={options.highlightMode}
            onChange={(e) =>
              onOptionsChange({ highlightMode: e.target.value as DiffPaneOptions['highlightMode'] })
            }
          >
            <option value="character">{S.diff.highlightCharacter}</option>
            <option value="word">{S.diff.highlightWord}</option>
            <option value="line">{S.diff.highlightLine}</option>
          </select>
        </label>
        <span className={styles.segment}>
          <Button
            title={`${S.diff.previousChange} (Shift+F7)`}
            disabled={loading || !diff || !navigation?.available}
            onClick={() => navigation?.moveHunk(-1)}
          >
            ↑ {S.diff.previousChange}
          </Button>
          <span aria-live="polite">
            {loading || !diff ? 0 : (navigation?.current ?? 0)} /{' '}
            {loading || !diff ? 0 : (navigation?.total ?? 0)}
          </span>
          <Button
            title={`${S.diff.nextChange} (F7)`}
            disabled={loading || !diff || !navigation?.available}
            onClick={() => navigation?.moveHunk(1)}
          >
            ↓ {S.diff.nextChange}
          </Button>
        </span>
        <details className={styles.viewOptions}>
          <summary>{S.diff.viewOptions}</summary>
          <div className={styles.optionPopup}>
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
              {S.diff.tabWidth}
              <select
                className={styles.num}
                value={options.tabWidth}
                onChange={(e) => onOptionsChange({ tabWidth: clampInt(e.target.value, 1, 16, 4) })}
              >
                {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      </div>
      {document?.limitReason ? (
        <div className={styles.note}>
          {document.limitReason === 'line-limit'
            ? S.diff.lineLimit(document.old.lineCount, document.new.lineCount)
            : document.limitReason === 'unsupported-file-type'
              ? S.diff.unsupportedFileType
              : document.limitReason === 'non-utf8'
                ? S.diff.nonUtf8
                : document.limitReason === 'binary'
                  ? S.diff.binaryTextUnavailable
                  : document.limitReason}
          {document.limitReason === 'line-limit' ? (
            <Button onClick={onLoadFull} disabled={loading}>
              {S.diff.loadFullFile}
            </Button>
          ) : null}
        </div>
      ) : null}
      {document &&
      options.ignoreWhitespace &&
      !document.diff.hunks.length &&
      !document.limitReason ? (
        <div className={styles.note}>{S.diff.noWhitespaceChanges}</div>
      ) : null}
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
          onNavigationReady={onNavigationReady}
          diff={diff}
          document={document}
          fullFile={options.fullFile}
          horizontalSync={options.horizontalSync}
          highlightMode={options.highlightMode}
          hideModeControls
          path={path}
          mode={mode}
          onModeChange={onModeChange}
          loading={loading}
          wrap={options.wrap}
          tabWidth={options.tabWidth}
          onLoadFull={onLoadFull}
          actions={loading ? undefined : actions}
        />
      </div>
    </div>
  );
}
