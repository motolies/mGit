// 빠른 열기(⌘P)의 파일 목록 캐시. 목록은 세션마다 한 번 받아 두고, 디스크의 파일 집합이 바뀌었을 수 있다는
// 신호(표지)가 바뀐 뒤 처음 열 때만 다시 받는다. 표지는 따로 구독하지 않고 열 때 지금 스토어 값과 견준다 —
// 편집기의 외부 변경 감지(`session-registry`)가 보는 것과 같은 값이다.
import type { SessionId, WorkspaceFileList } from '@mgit/ipc';
import { getFolderStore, getSessionStore } from '../../store';

/** 받아 둔 목록이 아직 맞는지 가리는 값들. 모두 같은 값·같은 객체면 바뀐 신호가 없었던 것이다 */
export type FilesStamp = readonly unknown[];

/**
 * 세션의 지금 표지. 파일 트리 epoch 는 창 포커스·새로고침·재스캔·일괄 작업·Project 트리의 파일 작업 뒤에 오른다.
 * 폴더 탭은 저장소 목록(재스캔)과 요약(하위 저장소 `.git` 감시 이벤트·주기 재조회), 저장소 탭은 작업 트리 상태(감시
 * 이벤트)를 함께 본다. 그룹 탭은 멤버 상태(`groupChanged` — 사라지거나 돌아온 멤버의 파일이 빠지거나 든다)도 본다.
 * 세션을 모르면 빈 표지라 처음 받은 목록을 계속 쓴다
 */
export function filesStamp(session: SessionId): FilesStamp {
  const folder = getFolderStore(session)?.getState();
  if (folder) {
    const base = ['folder', folder.fileTree.getState().epoch, folder.repos, folder.summaries];
    return folder.group ? [...base, folder.group] : base;
  }
  const repo = getSessionStore(session)?.getState();
  if (repo) return ['repo', repo.fileTree.getState().epoch, repo.status];
  return [];
}

/** 두 표지가 같은지 */
function sameStamp(a: FilesStamp, b: FilesStamp): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** 다시 받게 만드는 표지 (어떤 표지와도 같지 않다) */
const STALE: FilesStamp = [Symbol('stale')];

interface Entry {
  stamp: FilesStamp;
  /** 마지막으로 다 받은 목록 (낡았을 수 있다) */
  list: WorkspaceFileList | null;
  /** 받는 중인 요청 */
  request: Promise<WorkspaceFileList> | null;
}

/** 세션별 파일 목록. 경로 문자열 배열만 들고 있다 */
export class FileListCache {
  private entries = new Map<SessionId, Entry>();

  /** 마지막으로 받은 목록 (낡았어도). 새 목록을 받는 동안 바로 보여 줄 때 쓴다 */
  peek(session: SessionId): WorkspaceFileList | null {
    return this.entries.get(session)?.list ?? null;
  }

  /** 지금 받는 중인지 */
  isLoading(session: SessionId): boolean {
    return this.entries.get(session)?.request != null;
  }

  /**
   * 표지가 같고 받아 둔(또는 받는 중인) 목록이 있으면 그것을, 아니면 `fetch` 로 새로 받는다. 늦게 끝난 옛 요청은
   * 캐시를 덮지 않는다. 취소돼 일부만 받았거나 실패하면 다음에 다시 받는다
   */
  load(
    session: SessionId,
    stamp: FilesStamp,
    fetch: () => Promise<WorkspaceFileList>,
  ): Promise<WorkspaceFileList> {
    const entry = this.entries.get(session);
    if (entry && sameStamp(entry.stamp, stamp)) {
      if (entry.request) return entry.request;
      if (entry.list) return Promise.resolve(entry.list);
    }
    const next: Entry = { stamp, list: entry?.list ?? null, request: null };
    const request = fetch().then(
      (list) => {
        if (this.entries.get(session) === next) {
          next.request = null;
          next.list = list;
          if (list.cancelled) next.stamp = STALE;
        }
        return list;
      },
      (cause: unknown) => {
        if (this.entries.get(session) === next) {
          next.request = null;
          next.stamp = STALE;
        }
        throw cause;
      },
    );
    next.request = request;
    this.entries.set(session, next);
    return request;
  }

  /** 다음에 열 때 다시 받게 한다 (받아 둔 목록은 그동안 그대로 보여 준다) */
  invalidate(session: SessionId): void {
    const entry = this.entries.get(session);
    if (entry) entry.stamp = STALE;
  }

  /** 닫힌 세션의 목록을 버린다 */
  retain(alive: (session: SessionId) => boolean): void {
    for (const session of [...this.entries.keys()])
      if (!alive(session)) this.entries.delete(session);
  }

  /** 모두 버린다 (테스트용) */
  clear(): void {
    this.entries.clear();
  }
}

/** 앱 전체가 함께 쓰는 빠른 열기 목록 */
export const fileListCache = new FileListCache();
