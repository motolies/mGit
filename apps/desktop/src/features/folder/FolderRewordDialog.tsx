import { Button, S, shortHash, useNativeDialog } from '@mgit/ui';
import { useId } from 'react';
import { repoNameOf, useSessionOf } from '../../store';
import {
  finishRewordRequest,
  type RewordRequest,
  saveRewordRequest,
  useRewordRequest,
} from '../../store/reword-request';
import styles from './FolderRewordDialog.module.css';

/** 폴더 안의 고정 대상 편집창. 실패·렌더 갱신에도 세션에 보관한 초안을 유지한다. */
function Editor({ request }: { request: RewordRequest }) {
  const editor = useSessionOf(request.sessionId, (state) => state.rewordEditor);
  const patch = useSessionOf(request.sessionId, (state) => state.patchRewordEditor);
  const saving = editor?.phase === 'saving';
  const cancel = () => {
    if (!saving) finishRewordRequest(request);
  };
  const { ref, dialogProps } = useNativeDialog(editor !== null, cancel);
  const title = useId();
  const input = useId();
  return (
    <dialog ref={ref} {...dialogProps} className={styles.dialog} aria-labelledby={title}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveRewordRequest(request);
        }}
      >
        <h2 id={title}>{S.menu.reword}</h2>
        <p>{S.shortcuts.rewordTarget(repoNameOf(request.repoPath), shortHash(request.oid))}</p>
        {editor?.phase === 'loading' ? (
          <p role="status">{S.diff.loading}</p>
        ) : (
          <>
            <label htmlFor={input}>{S.rebase.message}</label>
            <textarea
              id={input}
              autoFocus
              rows={12}
              value={editor?.message ?? ''}
              disabled={saving}
              onChange={(event) => patch(request.token, { message: event.target.value })}
            />
          </>
        )}
        {editor?.error ? (
          <p role="alert" className={styles.error}>
            {editor.error}
          </p>
        ) : null}
        {saving ? <p role="status">{S.shortcuts.rewordRunning}</p> : null}
        <div className={styles.actions}>
          <Button type="button" disabled={saving} onClick={cancel}>
            {S.confirm.cancel}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={editor?.phase !== 'editing' || !editor.message.trim()}
          >
            {S.dialog.apply}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** 다른 폴더나 저장소 탭으로 요청이 흘러가지 않도록 소유 폴더에서만 렌더한다. */
export function FolderRewordDialog({ folderId }: { folderId: number }) {
  const request = useRewordRequest((state) => state.request);
  return request?.folderId === folderId ? (
    <Editor key={`${request.sessionId}:${request.token}`} request={request} />
  ) : null;
}
