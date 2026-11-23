import '@mgit/ui/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
  // 폴더·파일 드래그앤드롭으로 열기 (REPO-01). 목 모드는 Tauri API 가 없다
  if (mockRowCount() === 0) {
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'drop') {
          void useAppStore.getState().openPaths(e.payload.paths);
        }
      }),
    );
  }

  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void bootstrap();
