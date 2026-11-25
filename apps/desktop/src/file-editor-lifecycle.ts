import { flushSettings, hasPendingSettings } from '@mgit/storage';
import { guardFileEditorClose } from './store/file-editor-close';
import { fileEditors } from './store/file-editor-store';

/** 네이티브 창 닫기와 앱 종료 모두 저장 확인을 거친 뒤 창을 파괴한다. */
export async function installFileEditorLifecycle(native: boolean): Promise<void> {
  const refresh = () => {
    void fileEditors.refreshAll();
  };
  window.addEventListener('focus', refresh);
  window.setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 2000);
  window.addEventListener('beforeunload', (event) => {
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
