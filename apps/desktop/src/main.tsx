import '@mgit/ui/tokens.css';
import './project-drop.css';
import { createTauriClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installFileEditorLifecycle } from './file-editor-lifecycle';
import { dropBlocked, highlightProjectDrop, projectDropTarget } from './project-drop';
import { Root } from './Root';
import { mockRowCount, useAppStore } from './store';
import { applyTheme, resolveTheme, watchSystemTheme } from './store/theme';

/**
 * 앱 진입점. 첫 렌더 전에 화면 언어를 정해 Rust 에 알리고(코어가 만드는 문구가 처음부터 그 언어로 오게), 테마를
 * 적용하고 git 버전을 읽은 뒤 React 루트를 마운트한다
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('#root element not found');
  }

  // 저장된 선호 → (system 이면 OS 로캘, 최대 1초·실패면 영어) → 문구·포맷·<html lang> 적용 → Rust 에 알림.
  // 언어를 알리기 전에 코어를 부르면 그 응답의 문구(.gitignore 템플릿 라벨 등)가 기본 언어로 오므로 bootstrap 보다 먼저 한다
  await useAppStore.getState().initLanguage();

  // 시스템 테마 변경은 선호가 system 일 때만 반영한다 (리스너는 앱 수명 동안 1회 등록)
  watchSystemTheme((dark) => {
    if (useAppStore.getState().theme === 'system') {
      applyTheme(resolveTheme('system', dark));
    }
  });
  void useAppStore.getState().bootstrap();
  await installFileEditorLifecycle(mockRowCount() === 0);
  // 폴더·파일 드래그앤드롭으로 열기 (REPO-01). 목 모드는 Tauri API 가 없다
  if (mockRowCount() === 0) {
    void Promise.all([import('@tauri-apps/api/webview'), import('@tauri-apps/api/window')]).then(
      async ([{ getCurrentWebview }, { getCurrentWindow }]) => {
        const client = createTauriClient();
        // 이전 실행에서 남은 복구본과 처리 실패를 시작할 때 사용자에게 알린다.
        for (const message of await client
          .fsRecoveryWarnings()
          .catch((error: unknown) => [error instanceof Error ? error.message : String(error)])) {
          useAppStore.getState().notice({ kind: 'error', title: S.textContext.recovery, message });
        }
        let dragEpoch = 0;
        await getCurrentWebview().onDragDropEvent(async (event) => {
          const epoch = ++dragEpoch;
          const payload = event.payload;
          if (payload.type === 'leave' || dropBlocked()) {
            highlightProjectDrop(null);
            return;
          }
          try {
            const scale = await getCurrentWindow().scaleFactor();
            if (payload.type !== 'drop' && epoch !== dragEpoch) return;
            const target = projectDropTarget(payload.position, scale);
            if (payload.type !== 'drop') {
              highlightProjectDrop(target);
              return;
            }
            highlightProjectDrop(null);
            if (!target) {
              await useAppStore.getState().openPaths(payload.paths);
              return;
            }
            const grant = await client.fsRegisterDrop(payload.paths);
            window.dispatchEvent(
              new CustomEvent('mgit-project-import', {
                detail: { session: target.session, directory: target.directory, ...grant },
              }),
            );
          } catch (error) {
            highlightProjectDrop(null);
            useAppStore.getState().notice({
              kind: 'error',
              title: S.textContext.importError,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
    );
  }

  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void bootstrap();
