import { flushSettings, hasPendingSettings } from '@mgit/storage';
import { flushEditorTabSaves } from './store/editor-tabs-persist';
import { guardFileEditorClose } from './store/file-editor-close';
import { fileEditors } from './store/file-editor-store';

/** 네이티브 창 닫기와 앱 종료 모두 저장 확인을 거친 뒤 창을 파괴한다. */
export async function installFileEditorLifecycle(native: boolean): Promise<void> {
  // 창으로 돌아오면 모든 열린 파일의 원문을 다시 읽고, 2초 주기는 파일 표지가 바뀐 것만 읽는다 (N6)
  window.addEventListener('focus', () => {
    void fileEditors.refreshAll({ force: true });
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void fileEditors.refreshAll();
  }, 2000);
  window.addEventListener('beforeunload', (event) => {
    // 기다리던 편집기 탭 저장을 설정에 먼저 넣는다 (아래 확인이 설정 저장 대기를 함께 본다)
    flushEditorTabSaves();
    if (!fileEditors.hasDirty() && !hasPendingSettings()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  if (!native) return;
  const [{ getCurrentWindow }, { listen }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ]);
  const current = getCurrentWindow();
  let closing = false;
  /** 중복 종료 요청은 합치고 저장 실패 시 창을 유지한다. */
  const requestClose = async () => {
    if (closing) return;
    closing = true;
    try {
      if (await guardFileEditorClose()) {
        flushEditorTabSaves();
        await flushSettings();
        await current.destroy();
      }
    } catch (error) {
      window.dispatchEvent(new CustomEvent('mgit-settings-error', { detail: error }));
    } finally {
      closing = false;
    }
  };
  await current.onCloseRequested((event) => {
    event.preventDefault();
    void requestClose();
  });
  await listen('mgit-close-requested', () => void requestClose());
}
