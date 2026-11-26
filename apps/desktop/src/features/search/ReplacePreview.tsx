import type {
  IpcClient,
  ReplaceFilePreview,
  ReplaceOutcome,
  ReplacePattern,
  ReplacePreview,
  ReplaceUndoOutcome,
  SessionId,
} from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useModal } from '../../components/use-modal';
import { editorDrafts } from '../../store/editor-drafts';
import { describeError } from '../../store/errors';
import { fileEditors } from '../../store/file-editor-store';
import { tabSpace } from '../../store/session-space';
import styles from './ReplacePreview.module.css';
import {
  EMPTY_SELECTION,
  holdDrafts,
  lineSegments,
  type ReplaceSegment,
  type ReplaceSelection,
  replaceChoices,
  replaceReport,
  selectedMatches,
  selectionTotals,
  toggleFile,
  toggleMatch,
  undoReport,
} from './replace';

/** 바꾸기 창을 여는 요청: 찾고 바꿀 것과 내용 검색의 범위·경로 필터 */
export interface ReplaceRequest {
  pattern: ReplacePattern;
  pathFilter: string;
  scope: string;
}

/** 줄 조각을 그린다: 지워지는 글자는 `<del>`, 들어가는 글자는 `<ins>` */
function Segments({ parts }: { parts: readonly ReplaceSegment[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'del' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 조각은 순서가 정체성이다.
          <del key={i}>{part.text}</del>
        ) : part.kind === 'ins' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 조각은 순서가 정체성이다.
          <ins key={i}>{part.text}</ins>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 조각은 순서가 정체성이다.
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** 파일 하나: 파일 체크, 바뀌는 줄의 전·후, 일치마다 체크 */
function FileBlock({
  file,
  selection,
  onChange,
  disabled,
}: {
  file: ReplaceFilePreview;
  selection: ReplaceSelection;
  onChange: (next: ReplaceSelection) => void;
  disabled: boolean;
}) {
  const fileOff = selection.files.has(file.path);
  const off = selection.matches.get(file.path);
  return (
    <li className={styles.file}>
      <label className={styles.fileHead} title={file.path}>
        <input
          type="checkbox"
          aria-label={S.workspaceSearch.replaceFile(file.path)}
          checked={!fileOff}
          disabled={disabled}
          onChange={() => onChange(toggleFile(selection, file.path))}
        />
        <span className={styles.path}>{file.path}</span>
        <small>{S.workspaceSearch.replaceMatchCount(selectedMatches(file, selection))}</small>
      </label>
      <ul className={styles.lines} data-off={fileOff || undefined}>
        {file.lines.map((line) => {
          const { before, after } = lineSegments(line, off);
          return (
            <li key={line.line}>
              <fieldset className={styles.row} aria-label={S.workspaceSearch.replaceBefore}>
                <small className={styles.number}>{line.line}</small>
                <code className={styles.before}>
                  {line.cutStart ? '…' : ''}
                  <Segments parts={before} />
                  {line.cutEnd ? '…' : ''}
                </code>
              </fieldset>
              <fieldset className={styles.row} aria-label={S.workspaceSearch.replaceAfter}>
                <small className={styles.number} />
                <code className={styles.after}>
                  {line.cutStart ? '…' : ''}
                  <Segments parts={after} />
                  {line.cutEnd ? '…' : ''}
                </code>
              </fieldset>
              <div className={styles.matches}>
                {line.matches.map((m) => (
                  <label key={m.index}>
                    <input
                      type="checkbox"
                      checked={!off?.has(m.index)}
                      disabled={disabled || fileOff}
                      onChange={() => onChange(toggleMatch(selection, file.path, m.index))}
                    />
                    {S.workspaceSearch.replaceMatch(line.text.slice(m.start, m.end), m.replacement)}
                  </label>
                ))}
              </div>
              {line.hidden > 0 ? (
                <small className={styles.note}>
                  {S.workspaceSearch.replaceHiddenInLine(line.hidden)}
                </small>
              ) : null}
            </li>
          );
        })}
      </ul>
      {file.hiddenLines > 0 ? (
        <small className={styles.note}>
          {S.workspaceSearch.replaceHiddenLines(file.hiddenLines)}
        </small>
      ) : null}
    </li>
  );
}

/** 경로와 사유 목록 */
function PathList({ title, items }: { title: string; items: { path: string; text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.section} aria-label={title}>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item.path} title={item.path}>
            <span className={styles.path}>{item.path}</span> <small>{item.text}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 저장하지 않은(저장 중 포함) 편집기 초안이 있는 파일의 탭 공간 경로 (그룹은 `별칭/…`, 미리보기·적용 경로와 같은 공간).
 * 그룹 탭인데 공간을 아직 모르면(폴더 스토어 없음) 없다
 */
function draftPaths(session: SessionId, key: string): string[] {
  const space = tabSpace(session, key);
  return space ? editorDrafts(space, { includeSaving: true }).map((d) => d.path) : [];
}

/**
 * 여러 파일 바꾸기 (⌘⌥F 의 바꾸기): 미리보기(파일·일치 체크로 빼기) → 적용 → 결과 요약과 되돌리기. 미리보기는 코어가
 * 검색과 같은 정규식 엔진으로 만들고, 적용은 파일마다 revision 을 다시 확인한다 — 미리본 뒤 바뀐 파일·편집기에 저장하지
 * 않은 변경이 있는 파일은 건너뛰고 사유를 보인다. 적용·되돌리기 뒤에는 열린 편집기를 곧바로 다시 읽는다 (N6)
 */
export function ReplacePreviewDialog({
  client,
  session,
  root,
  request,
  onClose,
  onApplied,
}: {
  client: IpcClient;
  session: SessionId;
  /**
   * 세션 키 (저장소·폴더는 루트 절대 경로, 가상 그룹은 `mgit-group:<id>`). 탭 경로 공간으로 편집기 초안을 미리보기와 같은
   * 공간 경로(그룹은 `별칭/…`)로 바꾼다
   */
  root: string;
  request: ReplaceRequest;
  onClose: () => void;
  /** 파일을 바꾸거나 되돌린 뒤 (검색 결과를 다시 읽는다) */
  onApplied: () => void;
}) {
  const ref = useModal(true);
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<ReplaceSelection>(EMPTY_SELECTION);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ReplaceOutcome[] | null>(null);
  const [undone, setUndone] = useState<ReplaceUndoOutcome[] | null>(null);
  const pending = useRef<string | null>(null);
  // 창을 열 때 한 번 미리보기를 받는다. 닫히면 진행 중인 찾기를 취소한다
  useEffect(() => {
    let live = true;
    const id = `replace-${session}-${Date.now()}`;
    pending.current = id;
    const drafts = draftPaths(session, root);
    client
      .workspaceReplacePreview(session, id, { ...request, drafts })
      .then(
        (next) => {
          if (live) setPreview(next);
        },
        (cause: unknown) => {
          if (live) setError(describeError(cause));
        },
      )
      .finally(() => {
        if (pending.current === id) pending.current = null;
      });
    return () => {
      live = false;
      if (pending.current === id) void client.workspaceSearchCancel(session, id).catch(() => {});
    };
  }, [client, session, root, request]);
  const totals = useMemo(
    () => (preview ? selectionTotals(preview, selection) : { files: 0, matches: 0 }),
    [preview, selection],
  );
  const report = useMemo(() => (outcomes ? replaceReport(outcomes) : null), [outcomes]);

  /** 고른 파일을 바꾼다. 미리본 뒤 초안이 생긴 파일은 보내지 않고 건너뛴 것으로 보인다 */
  const apply = async () => {
    if (!preview) return;
    const { send, held } = holdDrafts(
      replaceChoices(preview, selection),
      draftPaths(session, root),
    );
    setBusy(true);
    setError('');
    try {
      const done =
        send.length > 0
          ? await client.workspaceReplaceApply(session, { pattern: request.pattern, files: send })
          : [];
      setOutcomes([...done, ...held]);
      void fileEditors.refreshAll();
      onApplied();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 바꾼 파일을 백업 사본으로 되돌린다 (바꾼 뒤 또 바뀐 파일은 코어가 건너뛴다) */
  const undo = async () => {
    if (!report) return;
    setBusy(true);
    setError('');
    try {
      setUndone(await client.workspaceReplaceUndo(session, report.undo));
      void fileEditors.refreshAll();
      onApplied();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const reasons = S.workspaceSearch.replaceReasons;
  const undoSummary = undone ? undoReport(undone) : null;
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={S.workspaceSearch.replaceTitle}
      onClose={onClose}
      onKeyDown={(event) => {
        // 검색 창의 Esc(창 닫기)로 번지지 않게 한다. 바꾸기 창은 dialog 기본 동작으로 닫힌다
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <div className={styles.box}>
        <header className={styles.header}>
          <strong>{S.workspaceSearch.replaceTitle}</strong>
          <code className={styles.pattern}>
            {request.pattern.text} → {request.pattern.replacement}
          </code>
          <Button size="compact" onClick={onClose}>
            {S.workspaceSearch.replaceClose}
          </Button>
        </header>
        {error ? <div role="alert">{error}</div> : null}
        {report ? (
          <div className={styles.body}>
            <div role="status">
              {S.workspaceSearch.replaceDone(report.files, report.matches)}{' '}
              {report.files > 0 ? S.workspaceSearch.replaceBackupNote : ''}
            </div>
            {undoSummary ? (
              <div role="status">
                {S.workspaceSearch.replaceUndone(undoSummary.restored)}{' '}
                {undoSummary.changed.length > 0 ? S.workspaceSearch.replaceUndoChanged : ''}
              </div>
            ) : null}
            <PathList
              title={S.workspaceSearch.replaceSkippedTitle}
              items={report.skipped.map((o) => ({ path: o.path, text: reasons[o.reason] }))}
            />
            <PathList
              title={S.workspaceSearch.replaceFailedTitle}
              items={[...report.failed, ...(undoSummary?.failed ?? [])].map((o) => ({
                path: o.path,
                text: o.message,
              }))}
            />
          </div>
        ) : preview ? (
          <div className={styles.body}>
            <div role="status">
              {preview.files.length === 0
                ? S.workspaceSearch.replaceNone
                : S.workspaceSearch.replaceTotals(
                    preview.files.length,
                    preview.files.reduce((n, f) => n + f.matches, 0),
                  )}{' '}
              {preview.truncated ? S.workspaceSearch.replaceTruncated(preview.files.length) : ''}{' '}
              {preview.unreadable > 0
                ? S.workspaceSearch.replaceUnreadable(preview.unreadable)
                : ''}
            </div>
            <ul className={styles.files}>
              {preview.files.map((file) => (
                <FileBlock
                  key={file.path}
                  file={file}
                  selection={selection}
                  onChange={setSelection}
                  disabled={busy}
                />
              ))}
            </ul>
            <PathList
              title={S.workspaceSearch.replaceExcluded}
              items={preview.excluded.map((e) => ({ path: e.path, text: reasons[e.reason] }))}
            />
          </div>
        ) : error ? null : (
          <div role="status">{S.workspaceSearch.replaceLoading}</div>
        )}
        <footer className={styles.footer}>
          {busy ? <span role="status">{S.workspaceSearch.replaceWorking}</span> : null}
          {preview && !report ? (
            <Button
              variant="primary"
              disabled={busy || totals.files === 0}
              onClick={() => void apply()}
            >
              {S.workspaceSearch.replaceApply(totals.files, totals.matches)}
            </Button>
          ) : null}
          {report && report.undo.length > 0 && !undone ? (
            <Button disabled={busy} onClick={() => void undo()}>
              {S.workspaceSearch.replaceUndo}
            </Button>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}
