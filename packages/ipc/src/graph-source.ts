import type { IpcClient } from './client';
import type { GraphWindow, SessionId } from './types';

/** 그래프 범위 데이터 출처. JSON ↔ 바이너리 전송 형식 전환은 이 인터페이스 뒤에서 한다 */
export interface GraphSource {
  fetchWindow(start: number, count: number): Promise<GraphWindow>;
}

/** 세션 하나에 묶인 Tauri `graph_window` 호출 */
export function tauriGraphSource(client: IpcClient, session: SessionId): GraphSource {
  return {
    fetchWindow: (start, count) => client.graphWindow(session, start, count),
  };
}

/** 폴더 세션의 통합 타임라인 `folder_timeline_window` 호출 (MR-12) */
export function folderTimelineSource(client: IpcClient, folder: SessionId): GraphSource {
  return {
    fetchWindow: (start, count) => client.folderTimelineWindow(folder, start, count),
  };
}
