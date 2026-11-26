import type { FsOperationPlan, FsOperationRequest, FsOperationResult, IpcClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { guardFileEditorClose } from '../../store/file-editor-close';
import { type EditorFile, type EditorSource, fileEditors } from '../../store/file-editor-store';
import { baseName, innermostRepo, isWithin } from '../../store/fs-path';
import { remapGroupFileDocs, remapTreePaths } from '../../store/path-remap';
import type { RootSpace } from '../../store/root-space';
import { fileWorkspaceSessions, getSessionStore } from '../../store/session-registry';
import { tabSpace } from '../../store/session-space';
import { fileViewDoc } from '../../store/workspace-store';
import { flattenProjectTree, type ProjectTreeRow } from './project-tree-model';

/** 삭제된 기준 행 대신 남은 선택, 다음 항목, 이전 항목, 루트 순서로 고른다. */
export function selectionAfterTrash(
  rows: readonly ProjectTreeRow[],
  selected: string | null,
  selection: Readonly<Record<string, true>>,
  removed: readonly string[],
  anchor: string | null = selected,
): { selected: string | null; anchor: string | null; selection: Record<string, true> } {
  const survives = (path: string) => !removed.some((parent) => isWithin(path, parent));
  const remaining = Object.fromEntries(
    Object.keys(selection)
      .filter(survives)
      .map((id) => [id, true as const]),
  );
  if (selected === null || survives(selected))
    return {
      selected,
      anchor: anchor !== null && survives(anchor) ? anchor : selected,
      selection: remaining,
    };
  const index = rows.findIndex((row) => row.id === selected);
  const candidates = [
    ...rows.slice(index + 1),
    ...rows.slice(0, Math.max(0, index)).reverse(),
  ].filter((row) => row.kind === 'entry' && survives(row.id));
  const next = candidates.find((row) => remaining[row.id])?.id ?? candidates[0]?.id ?? '';
  return {
    selected: next,
    anchor: next,
    selection: { ...remaining, [next]: true },
  };
}

/** 열린 Project 세션의 경로 공간 (세션 키로 찾는다, `tabSpace`). 닫힌 그룹이면 null */
function projectSpace(session: { id: number; root: string }): RootSpace | null {
  return tabSpace(session.id, session.root);
}

/** 열린 Project 세션마다 경로 공간 (세션 id → 공간). 문서 별칭의 실제 경로를 얻는다 */
function sessionSpaces(): Map<number, RootSpace> {
  return new Map(
    fileWorkspaceSessions().flatMap((session) => {
      const space = projectSpace(session);
      return space ? [[session.id, space] as const] : [];
    }),
  );
}

/** 계획에 포함된 원본과 목적지의 열린 문서를 실제 경로로 수집한다. */
function affectedDocuments(plan: FsOperationPlan): EditorFile[] {
  const spaces = sessionSpaces();
  return fileEditors.documents().filter((doc) =>
    [...doc.sources.values()].some((source) => {
      const abs = spaces.get(source.session)?.toAbs(source.path);
      if (!abs) return false;
      return plan.items.some(
        (item) =>
          (item.source && isWithin(abs, item.source)) ||
          (item.destination && isWithin(abs, item.destination)),
      );
    }),
  );
}

/** 영향 문서의 저장을 완료한 뒤 변경된 revision을 반영하여 계획을 다시 계산한다. */
export async function prepareFileOperation(
  client: IpcClient,
  request: FsOperationRequest,
): Promise<FsOperationPlan | null> {
  const preliminary = await client.fsPrepareOperation(request);
  await fileEditors.settleOpening();
  const docs = affectedDocuments(preliminary);
  try {
    if (
      !(await guardFileEditorClose(
        docs.flatMap((doc) =>
          [...doc.sources.values()].map(({ session, path }) => ({ session, path })),
        ),
      ))
    )
      return null;
  } finally {
    await client.fsCancelOperation(preliminary.id);
  }
  return client.fsPrepareOperation(request);
}

/** 파일 구조 변경의 성공 결과만 모든 열린 Project의 문서에 반영한다. */
async function applyResults(
  client: IpcClient,
  plan: FsOperationPlan,
  result: FsOperationResult,
  docs: EditorFile[],
  destinationSession?: number,
  rowsBeforeTrash?: ReadonlyMap<number, readonly ProjectTreeRow[]>,
) {
  const sessions = fileWorkspaceSessions().flatMap((session) => {
    const space = projectSpace(session);
    return space ? [{ ...session, space }] : [];
  });
  const spaces = new Map(sessions.map((session) => [session.id, session.space]));
  const successes = result.items.filter((item) => item.status === 'committed');
  const repoPaths = [...new Set(sessions.flatMap((session) => session.repoPaths ?? []))];
  const moves = plan.kind === 'move' || plan.kind === 'rename';
  const mapped = (absolute: string): string | null => {
    const match = successes
      .filter((item) => item.source && isWithin(absolute, item.source))
      .sort((a, b) => (b.source?.length ?? 0) - (a.source?.length ?? 0))[0];
    if (!match) {
      // 파일로 교체된 기존 디렉터리의 하위 문서는 실제로 없어졌으므로 닫는다.
      const removed = successes.some(
        (item) =>
          item.destination &&
          !item.directory &&
          absolute !== item.destination &&
          isWithin(absolute, item.destination),
      );
      const becameDirectory = successes.some(
        (item) =>
          item.destination === absolute &&
          item.directory &&
          plan.items.some(
            (planned) => planned.destination === absolute && planned.conflict === 'type',
          ),
      );
      return removed || becameDirectory ? null : absolute;
    }
    if (plan.kind === 'trash') return null;
    return moves && match.destination && match.source
      ? `${match.destination}${absolute.slice(match.source.length)}`
      : absolute;
  };
  for (const doc of docs) {
    const old = [...doc.sources.values()];
    const first = old.find((source) => spaces.has(source.session));
    if (!first) continue;
    // 그룹 맨 위처럼 실제 경로가 없는 별칭은 파일 작업의 대상이 아니다
    const absolute = spaces.get(first.session)?.toAbs(first.path) ?? null;
    if (absolute === null) continue;
    const next = mapped(absolute);
    if (next && next !== absolute) {
      const sources: EditorSource[] = old.flatMap((source) => {
        const path = spaces.get(source.session)?.toRel(next) ?? null;
        return path === null ? [] : [{ ...source, path }];
      });
      const destination = sessions.find((session) => session.id === destinationSession);
      if (destination) {
        const path = destination.space.toRel(next);
        if (path !== null && !sources.some((source) => source.session === destination.id))
          sources.push({ client, session: destination.id, path });
      }
      try {
        await fileEditors.remap(doc, sources);
      } catch {
        // 파일 이동은 이미 끝났다. 편집 조회 실패가 다른 성공 경로의 반영까지 막지 않게 새 탭에서 재조회한다.
        for (const source of old) fileEditors.release(source.session, source.path);
      }
    } else if (
      next &&
      successes.some((item) => item.destination && isWithin(absolute, item.destination))
    ) {
      await fileEditors.reloadAfterReplacement(doc);
    }
  }
  for (const session of sessions) {
    const tree = session.tree.getState();
    const { space } = session;
    const remapTreePath = (path: string): string | null => {
      const absolute = space.toAbs(path);
      // 실제 경로가 없는 자리(그룹 맨 위)는 파일 작업으로 바뀌지 않는다
      if (absolute === null) return path;
      const next = mapped(absolute);
      return next === null ? null : space.toRel(next);
    };
    const trashSelection =
      plan.kind === 'trash'
        ? selectionAfterTrash(
            rowsBeforeTrash?.get(session.id) ?? flattenProjectTree(tree.dirs ?? {}, tree.expanded),
            tree.selected,
            tree.selection,
            successes.flatMap((item) => {
              const path = item.source ? space.toRel(item.source) : null;
              return path === null ? [] : [path];
            }),
            tree.anchor,
          )
        : null;
    session.tree.setState({
      ...remapTreePaths(tree, remapTreePath),
      revealSeq: tree.revealSeq + 1,
      ...(trashSelection ?? {}),
    });
    const transfers: { absolute: string; pinned: boolean }[] = [];
    session.workspace.setState(
      remapGroupFileDocs(session.workspace.getState(), (doc) => {
        const absolute = space.toAbs(doc.path);
        if (absolute === null) return doc;
        const next = mapped(absolute);
        if (next === absolute) return doc;
        if (next === null) return null;
        const path = space.toRel(next);
        if (path === null) {
          transfers.push({ absolute: next, pinned: doc.pinned });
          return null;
        }
        return {
          ...doc,
          id: `file:${path}`,
          path,
          name: baseName(path),
          repoPath: innermostRepo(repoPaths, next),
          repoName: innermostRepo(repoPaths, next)
            ? baseName(innermostRepo(repoPaths, next) ?? '')
            : null,
        };
      }),
    );
    const destination = sessions.find((item) => item.id === destinationSession);
    if (destination)
      for (const item of transfers) {
        const path = destination.space.toRel(item.absolute);
        if (path !== null)
          destination.workspace.getState().openDoc(
            fileViewDoc({
              path,
              name: baseName(path),
              repoPath: innermostRepo(repoPaths, item.absolute),
              repoName: innermostRepo(repoPaths, item.absolute)
                ? baseName(innermostRepo(repoPaths, item.absolute) ?? '')
                : null,
            }),
            'pinned',
          );
      }
  }
  await Promise.allSettled(
    sessions.map(async (session) => {
      await Promise.all([session.tree.getState().reload(), session.refresh()]);
      const repo = getSessionStore(session.id)?.getState();
      const path = repo?.selectedFile?.path;
      const absolute = repo && path ? repo.space.toAbs(path) : null;
      if (repo && path && absolute !== null) {
        if (
          successes.some(
            (item) =>
              (item.source && isWithin(absolute, item.source)) ||
              (item.destination && isWithin(absolute, item.destination)),
          )
        )
          await repo.reloadWorkingFile(path);
      }
    }),
  );
}

/** 저장 확인 이후 쓰기와 자동 갱신을 잠시 멈추고 성공 경로만 연결한다. */
export async function executeFileOperation(
  client: IpcClient,
  plan: FsOperationPlan,
  decisions: Parameters<IpcClient['fsExecuteOperation']>[1],
  destinationSession?: number,
): Promise<FsOperationResult> {
  await fileEditors.settleOpening();
  const docs = affectedDocuments(plan);
  fileEditors.lockMutation(docs, true);
  let result: FsOperationResult | null = null;
  try {
    // 충돌 선택 동안 사용자가 다시 편집했다면 낡은 계획을 실행하지 않는다.
    if (docs.some((doc) => doc.dirty || doc.inflight || doc.composing))
      throw new Error(S.projectEdit.changedDuringConfirm);
    // 삭제 전 보이는 순서를 보관하되 완료 시점의 현재 선택을 기준으로 복구한다.
    const rowsBeforeTrash =
      plan.kind === 'trash'
        ? new Map(
            fileWorkspaceSessions().map((session) => {
              const tree = session.tree.getState();
              return [session.id, flattenProjectTree(tree.dirs ?? {}, tree.expanded)] as const;
            }),
          )
        : undefined;
    result = await client.fsExecuteOperation(plan.id, decisions);
    await applyResults(client, plan, result, docs, destinationSession, rowsBeforeTrash);
    return result;
  } finally {
    fileEditors.lockMutation(docs, false);
    // 원본 정리 실패처럼 일부만 게시된 경우도 잠금 해제 뒤 디스크의 실제 결과를 읽는다.
    const spaces = sessionSpaces();
    const destinations =
      result?.items.flatMap((item) => (item.destination ? [item.destination] : [])) ?? [];
    await Promise.allSettled(
      fileEditors
        .documents()
        .filter((doc) => docs.includes(doc))
        .map((doc) => {
          const destination = [...doc.sources.values()].some((source) => {
            const absolute = spaces.get(source.session)?.toAbs(source.path);
            return !!absolute && destinations.some((path) => isWithin(absolute, path));
          });
          return destination ? fileEditors.reloadAfterReplacement(doc) : fileEditors.refresh(doc);
        }),
    );
  }
}
