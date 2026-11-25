import { App } from './App';
import { FileEditorCloseDialog } from './features/workspace/FileEditorCloseDialog';
import { useAppStore } from './store';

/**
 * 화면 언어를 key 로 앱을 그리는 루트 (다국어 L3). 언어가 바뀌면 앱 트리를 다시 마운트해 모든 문구를 새 사전으로 그린다.
 * 스토어(세션·commit 메시지·충돌 초안 등)는 React 밖이라 그대로고, 컴포넌트 안의 상태만 처음으로 돌아간다
 */
export function Root() {
  const uiLocale = useAppStore((s) => s.uiLocale);
  return (
    <>
      <App key={uiLocale} />
      <FileEditorCloseDialog />
    </>
  );
}
