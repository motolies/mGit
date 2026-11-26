import { S } from '@mgit/ui';
/** 매 요청을 격리해 시간 초과 시 파서까지 종료한다. 문서에는 성공 결과만 전달한다. */
export function formatText(text: string, path: string, printWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./formatter.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(S.fileEditor.formatTimeout));
    }, 10000);
    worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => {
      finish();
      if (typeof event.data.text === 'string') resolve(event.data.text);
      else reject(new Error(event.data.error ?? S.fileEditor.formatFailed));
    };
    worker.onerror = () => {
      finish();
      reject(new Error(S.fileEditor.formatFailed));
    };
    worker.postMessage({ text, path, printWidth });
  });
}
