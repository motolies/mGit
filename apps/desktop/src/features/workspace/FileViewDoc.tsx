import { useEffect, useState } from 'react';
import { describeError, useFileTree, useWorkspace } from '../../store';
import type { FileViewTarget } from '../../store/workspace-store';
import { type FileLoad, FileView, type FileViewRepoTools } from './FileView';

export type { FileViewRepoTools } from './FileView';

const LOADING: FileLoad = { state: 'loading' };

/**
 * 에디터 공간의 파일 보기 탭 (ED-04): 활성 탭의 파일 트리 스토어로 파일을 읽어 화면에 넘긴다. 보이는 탭만
 * 마운트되므로 탭이 다시 활성화되면 다시 읽고, 파일 트리가 디스크를 다시 볼 때(새로고침·창 포커스·재스캔·일괄
 * 작업 뒤, `epoch`)도 다시 읽는다. 다시 읽는 동안 이전 내용을 그대로 보여 깜빡이지 않고, 스크롤 위치는
 * 워크스페이스 스토어에 기억해 탭을 오가도 돌아온다. 늦게 온 옛 응답은 버린다. 저장소 안 파일이면 컨테이너가
 * 넘긴 히스토리·Blame 진입(`repoTools`)을 머리줄에 둔다 (W13)
 */
export function FileViewDoc({
  doc,
  repoTools = null,
}: {
  doc: FileViewTarget & { id: string };
  repoTools?: FileViewRepoTools | null;
}) {
  const tree = useFileTree((t) => ({ read: t.readFile, epoch: t.epoch }));
  const ws = useWorkspace((w) => ({
    remember: w.rememberDocScroll,
    recall: w.docScrollTop,
  }));
  const [load, setLoad] = useState<FileLoad>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const read = tree?.read;
  const epoch = tree?.epoch ?? 0;
  const { path } = doc;

  // 대상·디스크 차례·다시 시도가 바뀔 때마다 읽는다. 정리 함수가 그 뒤에 온 옛 응답을 버린다
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch·attempt 는 같은 요청을 다시 보내는 신호다
  useEffect(() => {
    if (!read) {
      return;
    }
    let live = true;
    read(path).then(
      (file) => {
        if (live) {
          setLoad({ state: 'loaded', file });
        }
      },
      (e: unknown) => {
        if (live) {
          setLoad({ state: 'error', error: describeError(e) });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [read, path, epoch, attempt]);

  if (!ws) {
    return null;
  }
  return (
    <FileView
      path={path}
      load={load}
      repoTools={repoTools}
      onRetry={() => {
        setLoad(LOADING);
        setAttempt((n) => n + 1);
      }}
      initialScrollTop={ws.recall(doc.id)}
      onScrollTopChange={(top) => ws.remember(doc.id, top)}
    />
  );
}
