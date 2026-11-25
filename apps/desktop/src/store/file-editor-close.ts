import type { SessionId } from '@mgit/ipc';
import { create } from 'zustand';
import { fileEditors } from './file-editor-store';

export interface FileCloseTarget {
  session: SessionId;
  path?: string;
}

type CloseChoice = 'retry' | 'discard' | 'cancel';

interface FileCloseState {
  pending: { paths: string[]; resolve: (choice: CloseChoice) => void } | null;
  choose: (choice: CloseChoice) => void;
}

/** 파일 저장 실패의 닫기 확인을 앱 수명 동안 유지한다. */
export const useFileCloseStore = create<FileCloseState>((set, get) => ({
  pending: null,
  choose(choice) {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(choice);
  },
}));

let closing = false;

/** 닫을 범위의 저장을 완료하고, 실패하면 재시도·폐기·취소를 기다린다. */
export async function guardFileEditorClose(targets?: readonly FileCloseTarget[]): Promise<boolean> {
  if (closing) return false;
  closing = true;
  const scopes = targets ?? [{ session: undefined, path: undefined }];
  try {
    for (;;) {
      let saved = true;
      for (const scope of scopes) {
        if (!(await fileEditors.flush(scope.session, scope.path))) saved = false;
      }
      if (saved) {
        if (scopes.some((scope) => fileEditors.hasDirty(scope.session, scope.path))) continue;
        return true;
      }
      const paths = [
        ...new Set(
          scopes.flatMap((scope) =>
            fileEditors
              .documents(scope.session, scope.path)
              .filter((doc) => doc.dirty)
              .map((doc) => doc.path),
          ),
        ),
      ];
      const choice = await new Promise<CloseChoice>((resolve) => {
        useFileCloseStore.setState({ pending: { paths, resolve } });
      });
      if (choice === 'cancel') return false;
      if (choice === 'discard') {
        for (const scope of scopes) await fileEditors.discard(scope.session, scope.path);
        return true;
      }
    }
  } finally {
    closing = false;
  }
}
