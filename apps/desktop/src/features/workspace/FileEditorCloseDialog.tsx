import { ConfirmDialog, S } from '@mgit/ui';
import { useFileCloseStore } from '../../store/file-editor-close';

/** 저장되지 않은 일반 파일의 닫기 결정을 받는다. */
export function FileEditorCloseDialog() {
  const pending = useFileCloseStore((state) => state.pending);
  const choose = useFileCloseStore((state) => state.choose);
  return (
    <ConfirmDialog
      open={pending !== null}
      title={S.fileEditor.closeTitle}
      message={S.fileEditor.closeMessage}
      items={pending?.paths}
      confirmLabel={S.fileEditor.discardChanges}
      secondaryLabel={S.fileEditor.retrySave}
      danger
      onConfirm={() => choose('discard')}
      onSecondary={() => choose('retry')}
      onCancel={() => choose('cancel')}
    />
  );
}
