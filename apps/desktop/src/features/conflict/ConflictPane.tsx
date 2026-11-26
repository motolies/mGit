import type { ConflictPayload, SessionId } from '@mgit/ipc';
import { conflictBlocks, MergeEditor } from '@mgit/merge-editor';
import { Button, ConfirmDialog, formatDateTime, S, shortHash } from '@mgit/ui';
import { useRef, useState } from 'react';
import { EditorZoomControls, useEditorZoom } from '../../components/EditorZoom';
import { type SessionState, useAppStore, useSession, useSessionOf } from '../../store';
import { conflictDraftKey } from '../../store/workspace-store';
import styles from './ConflictPane.module.css';
import { type LinePick, LinePickDialog } from './LinePickDialog';
import { OriginsPanel } from './OriginsPanel';

/** 충돌 화면이 읽는 세션 상태와 동작 (최상위 필드만 읽는다 — 화면 테스트가 이 필드들로 세션을 흉내 낸다) */
function pickConflict(st: SessionState) {
  return {
    conflict: st.conflict,
    loading: st.conflictLoading,
    close: st.closeConflict,
    save: st.saveConflict,
    origins: st.origins,
    loadOrigins: st.loadConflictOrigins,
    mergeTool: st.mergeTool,
    openMergetool: st.openMergetool,
    rerere: st.rerere,
    rerereForget: st.rerereForget,
    jump: st.jumpToCommit,
    verifyCommand: st.verifyCommand,
    runVerify: st.runVerify,
    repoPath: st.path,
    drafts: st.conflictDrafts,
    setDraft: st.setConflictDraft,
    busy: st.busy,
    pickSide: st.pickSide,
    resolveDelete: st.resolveDelete,
  };
}

type ConflictSlice = ReturnType<typeof pickConflict>;

/** 텍스트 편집이 아닌 충돌 (바이너리·서브모듈·삭제/추가): 한쪽 선택 (CF-11·12). 화면을 그린 세션에 대고 고른다 */
function SidePickPane({
  payload,
  s,
}: {
  payload: ConflictPayload;
  s: Pick<ConflictSlice, 'busy' | 'pickSide' | 'resolveDelete'>;
}) {
  const f = payload.file;
  const kind = f.kind;
  const isDelete =
    kind === 'deletedByUs' ||
    kind === 'deletedByThem' ||
    kind === 'addedByUs' ||
    kind === 'addedByThem';
  const note = f.binary
    ? S.conflict.binary
    : f.submodule
      ? S.conflict.submodule
      : isDelete
        ? S.conflict.deleteConflict(
            kind === 'deletedByUs' || kind === 'addedByThem'
              ? payload.labels.ours
              : payload.labels.theirs,
          )
        : '';
  return (
    <div className={styles.sidePick}>
      <p className={styles.note}>{note}</p>
      {isDelete ? (
        <div className={styles.choices}>
          <Button
            variant="primary"
            disabled={s.busy}
            onClick={() => void s.resolveDelete(f.path, true)}
          >
            {S.conflict.keepFile}
          </Button>
          <Button disabled={s.busy} onClick={() => void s.resolveDelete(f.path, false)}>
            {S.conflict.deleteFile}
          </Button>
        </div>
      ) : (
        <div className={styles.choices}>
          <Button
            variant="primary"
            disabled={s.busy}
            onClick={() => void s.pickSide(f.path, 'ours')}
          >
            {S.conflict.pickOurs(payload.labels.ours)}
          </Button>
          <Button disabled={s.busy} onClick={() => void s.pickSide(f.path, 'theirs')}>
            {S.conflict.pickTheirs(payload.labels.theirs)}
          </Button>
        </div>
      )}
      {f.submodule && payload.submoduleSides ? (
        <div className={styles.preview}>
          {(
            [
              ['ours', payload.submoduleSides.ours ?? null, payload.labels.ours],
              ['theirs', payload.submoduleSides.theirs ?? null, payload.labels.theirs],
              [
                'base',
                payload.submoduleSides.base ?? null,
                payload.labels.base ?? S.submodule.sides.base,
              ],
            ] as const
          ).map(([key, c, label]) => (
            <pre key={key} className={styles.pre}>
              <b>{label}</b>
              {'\n'}
              {c
                ? `${shortHash(c.oid)} ${c.subject}\n${c.author} · ${formatDateTime(c.time ?? 0)}`
                : '—'}
            </pre>
          ))}
        </div>
      ) : null}
      {!f.binary && !f.submodule ? (
        <div className={styles.preview}>
          {payload.ours != null ? (
            <pre className={styles.pre}>
              <b>{payload.labels.ours}</b>
              {'\n'}
              {payload.ours}
            </pre>
          ) : null}
          {payload.theirs != null ? (
            <pre className={styles.pre}>
              <b>{payload.labels.theirs}</b>
              {'\n'}
              {payload.theirs}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 충돌 해결 화면의 몸통 (세션 컨테이너 공용): 받은 세션 상태로 텍스트면 3-way 편집기, 아니면 한쪽 선택을 그린다.
 * `docMode` 면 폴더 탭의 충돌 편집기 탭이다 (ED-06) — "← 목록으로" 대신 탭 닫기를 쓰고, 출처 커밋을 누르면 그래프 대신
 * `onJump` 로 간다 (가벼운 세션은 그래프를 읽지 않는다)
 */
function ConflictPaneBody({
  s,
  docMode = false,
  onJump,
}: {
  s: ConflictSlice;
  docMode?: boolean;
  onJump?: (oid: string) => void;
}) {
  const openTerminal = useAppStore((st) => st.openTerminal);
  const [showOrigins, setShowOrigins] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoom = useEditorZoom(zoomRef);
  const [linePick, setLinePick] = useState<LinePick | null>(null);
  // 이어서/처음부터 (CF-07): 파일별 답. 파일이 바뀌면 다시 묻는다
  const [choice, setChoice] = useState<{ path: string; worktree: boolean } | null>(null);
  // 초안을 버리면 편집기를 새로 연다
  const [editorEpoch, setEditorEpoch] = useState(0);
  const path = s.conflict?.path ?? null;

  if (!s.conflict) {
    return <div className={styles.empty}>{s.loading ? S.conflict.loading : ''}</div>;
  }
  const { payload } = s.conflict;
  const doc = payload.doc;
  // 같은 충돌의 초안만 쓴다 (rebase 다음 단계의 같은 경로는 다른 충돌이다). 탭의 초안 표시와 같은 열쇠
  const draftKey = conflictDraftKey(payload.file);
  const saved = path ? s.drafts[path] : undefined;
  const draft = saved?.key === draftKey ? saved : null;
  const answered = choice?.path === path ? choice : null;
  const asking = doc !== null && payload.worktreeModified && draft === null && answered === null;
  const useWorktree = answered?.worktree ?? false;
  /** 답을 기억한다 */
  const answer = (worktree: boolean) => setChoice(path === null ? null : { path, worktree });
  return (
    <div ref={zoomRef} className={styles.pane}>
      <header className={styles.header}>
        <EditorZoomControls />
        {docMode ? null : <Button onClick={s.close}>← {S.conflict.back}</Button>}
        <span className={styles.path} title={path ?? ''}>
          {path}
        </span>
        <span className={styles.kind}>{S.conflict.kind[payload.file.kind]}</span>
        {path && s.rerere.resolvedPaths.includes(path) ? (
          <>
            <span className={styles.kind} title={S.assist.rerereResolved}>
              rerere
            </span>
            <Button onClick={() => void s.rerereForget(path)}>{S.assist.rerereForget}</Button>
          </>
        ) : null}
        <Button
          onClick={() => {
            const next = !showOrigins;
            setShowOrigins(next);
            if (next && path) {
              void s.loadOrigins(path);
            }
          }}
        >
          {S.assist.origins}
        </Button>
        {s.verifyCommand ? (
          <Button onClick={() => void s.runVerify()}>{S.verify.run}</Button>
        ) : null}
        <Button
          onClick={() =>
            openTerminal(s.repoPath, undefined, s.verifyCommand ? `${s.verifyCommand}\n` : null)
          }
        >
          {s.verifyCommand ? S.terminal.verifyInTerminal : S.terminal.openHere}
        </Button>
        {s.mergeTool && path ? (
          <Button onClick={() => void s.openMergetool(path)}>
            {S.assist.mergetool(s.mergeTool)}
          </Button>
        ) : null}
      </header>
      {showOrigins ? (
        <OriginsPanel
          origins={s.origins?.path === path ? s.origins.data : null}
          labels={payload.labels}
          loading={s.origins?.path === path ? s.origins.loading : true}
          onJump={(oid) => (onJump ? onJump(oid) : void s.jump(oid))}
        />
      ) : null}
      <div className={styles.body}>
        {doc ? (
          asking ? null : (
            <MergeEditor
              fontSize={zoom.fontSize}
              key={`${path}:${useWorktree ? 'wt' : 'doc'}:${editorEpoch}`}
              path={path ?? ''}
              doc={doc}
              labels={payload.labels}
              initialText={useWorktree ? (payload.worktree ?? null) : null}
              initialDraft={draft}
              onSave={s.save}
              onDraftChange={(d) => {
                if (path !== null) {
                  s.setDraft(path, { ...d, key: draftKey });
                }
              }}
              onDiscardDraft={() => {
                if (path !== null) {
                  s.setDraft(path, null);
                }
                setChoice(null);
                setEditorEpoch((n) => n + 1);
              }}
              auto={payload.auto}
              classLabel={(c) => S.assist.blockClass[c]}
              onLinePick={(index, apply) => {
                const block = conflictBlocks(doc)[index];
                if (block) {
                  setLinePick({ index, block, apply });
                }
              }}
            />
          )
        ) : (
          <SidePickPane payload={payload} s={s} />
        )}
      </div>
      <LinePickDialog pick={linePick} labels={payload.labels} onClose={() => setLinePick(null)} />
      <ConfirmDialog
        open={asking}
        title={S.conflict.continueTitle}
        message={S.conflict.continueMessage}
        confirmLabel={S.conflict.continueYes}
        secondaryLabel={S.conflict.continueFresh}
        onSecondary={() => answer(false)}
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
      />
    </div>
  );
}

/** 중앙 충돌 해결 화면 (저장소 탭, MRG-06): 범위 세션(그 탭의 세션)의 열린 충돌을 그린다. 머리 왼쪽에 "← 목록으로" */
export function ConflictPane() {
  return <ConflictPaneBody s={useSession(pickConflict)} />;
}

/**
 * 정해 준 세션의 충돌 화면 (폴더 탭의 충돌 편집기 탭, ED-06·W15). 범위 세션(활성 저장소)이 아니라 문서의 저장소 세션에
 * 대고 저장·한쪽 고르기·남기기/지우기를 한다 — 활성 저장소가 잠겨 다른 저장소를 가리키고 있어도 화면에 보이는 그 파일·그
 * 저장소에만 닿는다. 탭 닫기가 "← 목록으로" 를 대신한다. `onJump` 는 출처 커밋을 눌렀을 때 (폴더 로그에서 고르기)
 */
export function SessionConflictPane({
  sessionId,
  onJump,
}: {
  sessionId: SessionId;
  onJump: (oid: string) => void;
}) {
  return <ConflictPaneBody s={useSessionOf(sessionId, pickConflict)} docMode onJump={onJump} />;
}
