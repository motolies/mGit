import type { SessionId } from '@mgit/ipc';
import { ConfirmDialog, PromptDialog, S } from '@mgit/ui';
import { useState } from 'react';
import { bool, str } from '../../components/use-dialogs';
import { type SessionState, useAppStore, useSession, useSessionOf } from '../../store';
import { folderHintMode } from '../../store/repo-sessions';
import type { PendingHint } from '../../store/session-store';
import { commitPairLine } from '../tags/tag-flows';

/** 힌트 대화상자가 읽는 세션 상태와 동작 */
function pickHint(st: SessionState) {
  return {
    hint: st.pendingHint,
    dismiss: st.dismissHint,
    reapplyKept: st.reapplyKept,
    saveConflict: st.saveConflict,
    checkout: st.checkout,
    deleteBranch: st.deleteBranch,
    pull: st.pull,
    push: st.push,
    submoduleAdopt: st.submoduleAdopt,
    ignoreAdd: st.ignoreAdd,
    pushSubmodulesThenPush: st.pushSubmodulesThenPush,
    removeIndexLock: st.removeIndexLock,
    createBranch: st.createBranch,
    setCommitNoVerify: st.setCommitNoVerify,
    commit: st.commit,
    opContinue: st.opContinue,
    replaceRemoteTags: st.replaceRemoteTags,
  };
}

/**
 * 쓰기 실패 힌트에 따른 대화상자 (BR-03 변경 중 전환, BR-04 미병합 삭제, WT-05 워크트리 충돌,
 * RM-04 non-fast-forward). 저장소 탭: 범위 세션(그 탭의 세션)의 힌트
 */
export function HintDialogs() {
  return <HintDialogsBody s={useSession(pickHint)} />;
}

/**
 * 정해 준 세션의 힌트 대화상자 (폴더 탭, W15): 폴더 탭에서 켠 종류(`folderHintMode`)만 보이고, 제목 앞에 어느 저장소의
 * 것인지 밝힌다. `act` 는 저장소 탭과 같은 동작을 그 세션에 대고 하고, `info` 는 확인 단추 하나로 알리기만 한다. `off`
 * 인 힌트는 보이지 않는다 (바쁨에도 세지 않는다 — `sessionDialogOpen`)
 */
export function SessionHintDialogs({
  sessionId,
  repoName,
}: {
  sessionId: SessionId;
  repoName: string;
}) {
  const s = useSessionOf(sessionId, pickHint);
  const h = s.hint;
  if (!h) {
    return null;
  }
  const title = (t: string) => S.repoSession.hintTitle(repoName, t);
  switch (folderHintMode(h)) {
    case 'off':
      return null;
    case 'info':
      // 알리기만 하는 종류는 지금 hook 거부 하나다 (`folderHintMode`)
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.hookFailed)}
          message={S.repoSession.hookFailedInfo}
          confirmLabel={S.confirm.ok}
          onConfirm={s.dismiss}
          onCancel={s.dismiss}
        />
      );
    case 'act':
      return <HintDialogsBody s={s} title={title} />;
  }
}

/**
 * 힌트 대화상자의 몸통 (세션 컨테이너 공용): 받은 세션 상태의 힌트에 맞는 대화상자. `title` 은 제목을 꾸민다 (폴더 탭은
 * 저장소 이름을 붙인다. 저장소 탭은 그대로)
 */
function HintDialogsBody({
  s,
  title = (t) => t,
}: {
  s: ReturnType<typeof pickHint>;
  title?: (t: string) => string;
}) {
  const openRepositoryAt = useAppStore((st) => st.openRepositoryAt);
  const h = s.hint;
  if (!h) {
    return null;
  }
  switch (h.kind) {
    case 'dirtyWorkTree':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.dirtyCheckout)}
          message={S.dialog.dirtyCheckoutMessage}
          items={h.files}
          confirmLabel={S.dialog.stashAndSwitch}
          onConfirm={() => {
            s.dismiss();
            void s.checkout(h.target, true);
          }}
          onCancel={s.dismiss}
        />
      );
    case 'remoteBranchTaken': {
      const oid = h.oid;
      const upstream = h.upstream?.replace(/^refs\/remotes\//, '') ?? null;
      return (
        <PromptDialog
          open
          title={title(S.dialog.remoteBranchTaken(h.local))}
          message={S.dialog.remoteBranchTakenMessage(h.local, upstream, `${h.remote}/${h.name}`)}
          fields={[
            {
              key: 'name',
              label: S.dialog.branchName,
              initial: `${h.remote}-${h.name}`,
              required: true,
            },
          ]}
          confirmLabel={S.dialog.createTracking}
          secondaryLabel={oid === null ? undefined : S.dialog.checkoutDetached}
          onSecondary={
            oid === null
              ? undefined
              : () => {
                  s.dismiss();
                  void s.checkout({ kind: 'commit', oid });
                }
          }
          onConfirm={(v) => {
            s.dismiss();
            void s.checkout({
              kind: 'remoteBranch',
              remote: h.remote,
              name: h.name,
              local: str(v, 'name').trim(),
            });
          }}
          onCancel={s.dismiss}
        />
      );
    }
    case 'notFullyMerged':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.deleteBranchForce(h.name))}
          message={S.dialog.deleteBranchForceMessage}
          confirmLabel={S.dialog.delete}
          danger
          onConfirm={() => {
            s.dismiss();
            void s.deleteBranch(h.name, true);
          }}
          onCancel={s.dismiss}
        />
      );
    case 'branchElsewhere':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.branchElsewhere)}
          message={S.dialog.branchElsewhereMessage(h.path)}
          confirmLabel={S.dialog.openWorktree}
          onConfirm={() => {
            s.dismiss();
            void openRepositoryAt(h.path);
          }}
          onCancel={s.dismiss}
        />
      );
    case 'indexLock':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.indexLock)}
          message={S.dialog.indexLockMessage}
          confirmLabel={S.dialog.removeLock}
          danger
          onConfirm={() => {
            s.dismiss();
            void s.removeIndexLock();
          }}
          onCancel={s.dismiss}
        />
      );
    case 'detachedHead':
      return (
        <PromptDialog
          open
          title={title(S.dialog.detachedHead)}
          message={S.dialog.detachedHeadMessage}
          fields={[{ key: 'name', label: S.dialog.branchName, required: true }]}
          confirmLabel={S.dialog.create}
          onConfirm={(v) => {
            s.dismiss();
            void s.createBranch(str(v, 'name'), null, true);
          }}
          onCancel={s.dismiss}
        />
      );
    case 'noUpstream':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.noUpstream)}
          message={S.dialog.noUpstreamMessage}
          confirmLabel={S.dialog.pushSetUpstream}
          onConfirm={() => {
            s.dismiss();
            if (h.spec) {
              void s.push({ ...h.spec, setUpstream: true }, { skipSubmoduleCheck: true });
            } else {
              void s.push({ setUpstream: true });
            }
          }}
          onCancel={s.dismiss}
        />
      );
    case 'nestedRepo':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.nestedRepo)}
          message={S.dialog.nestedRepoMessage(h.paths.join(', '))}
          confirmLabel={S.dialog.nestedRepoAdopt}
          secondaryLabel={S.dialog.nestedRepoIgnore}
          onConfirm={() => {
            s.dismiss();
            for (const p of h.paths) {
              void s.submoduleAdopt(p);
            }
          }}
          onSecondary={() => {
            s.dismiss();
            void s.ignoreAdd(h.paths.map((p) => `${p}/`));
          }}
          onCancel={s.dismiss}
        />
      );
    case 'submoduleUnpushed':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.submoduleUnpushed)}
          message={S.dialog.submoduleUnpushedMessage(
            h.items.map((i) => `${i.path} (${i.count})`).join(', '),
          )}
          confirmLabel={S.dialog.submoduleUnpushedFirst}
          secondaryLabel={S.dialog.submoduleUnpushedAnyway}
          onConfirm={() => {
            s.dismiss();
            void s.pushSubmodulesThenPush(h.spec);
          }}
          onSecondary={() => {
            s.dismiss();
            void s.push(h.spec, { skipSubmoduleCheck: true });
          }}
          onCancel={s.dismiss}
        />
      );
    case 'reapplyResolutions':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.reapplyTitle)}
          message={S.dialog.reapplyMessage(h.count)}
          confirmLabel={S.dialog.reapplyYes}
          onConfirm={() => {
            s.dismiss();
            void s.reapplyKept();
          }}
          onCancel={s.dismiss}
        />
      );
    case 'syntaxErrors':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.syntaxTitle)}
          message={S.dialog.syntaxMessage(
            h.compare.resultErrors,
            h.compare.firstErrorLine ?? null,
            h.compare.language,
          )}
          confirmLabel={S.dialog.syntaxSaveAnyway}
          danger
          onConfirm={() => {
            s.dismiss();
            void s.saveConflict(h.content, {
              force: true,
              allowConflictMarkers: h.allowConflictMarkers,
            });
          }}
          onCancel={s.dismiss}
        />
      );
    case 'hookFailed':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.hookFailed)}
          message={S.dialog.hookFailedMessage}
          confirmLabel={S.dialog.retryNoVerify}
          danger
          onConfirm={() => {
            s.dismiss();
            s.setCommitNoVerify(true);
            void s.commit();
          }}
          onCancel={s.dismiss}
        />
      );
    case 'nothingToCommit':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.nothingToCommit)}
          message={S.dialog.nothingToCommitMessage}
          confirmLabel={S.confirm.ok}
          onConfirm={s.dismiss}
          onCancel={s.dismiss}
        />
      );
    case 'nonFastForward':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.nonFastForward)}
          message={S.dialog.nonFastForwardMessage}
          confirmLabel={S.dialog.forcePush}
          danger
          secondaryLabel={S.dialog.pullThenPush}
          onSecondary={() => {
            s.dismiss();
            // pull 이 실패하면 run 은 오류를 남기고 false 로 끝난다. 그때는 push 하지 않는다
            void s.pull().then((ok) => {
              if (ok) {
                void s.push(h.spec, { skipSubmoduleCheck: true });
              }
            });
          }}
          onConfirm={() => {
            s.dismiss();
            void s.push({ ...h.spec, forceWithLease: true }, { skipSubmoduleCheck: true });
          }}
          onCancel={s.dismiss}
        />
      );
    case 'staleInfo':
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.staleInfo)}
          message={S.dialog.staleInfoMessage}
          confirmLabel={S.dialog.staleInfoPull}
          onConfirm={() => {
            s.dismiss();
            void s.pull();
          }}
          onCancel={s.dismiss}
        />
      );
    case 'tagExists':
      return <TagExistsDialog key={h.names.join('\u0000')} hint={h} s={s} title={title} />;
    case 'pushUpstreamMismatch':
      return (
        <PromptDialog
          open
          title={title(S.dialog.upstreamMismatch)}
          message={S.dialog.upstreamMismatchMessage(h.local, h.remote, h.upstream)}
          fields={[{ key: 'remember', label: S.dialog.upstreamMismatchRemember, type: 'checkbox' }]}
          confirmLabel={S.dialog.upstreamMismatchConfirm}
          onConfirm={(v) => {
            s.dismiss();
            void s.push(
              {
                ...h.spec,
                confirmUpstreamMismatch: true,
                rememberUpstreamMismatch: bool(v, 'remember'),
              },
              { skipSubmoduleCheck: true },
            );
          }}
          onCancel={s.dismiss}
        />
      );
    case 'conflictMarkers': {
      const { retry } = h;
      return (
        <ConfirmDialog
          open
          title={title(S.dialog.conflictMarkers)}
          message={S.dialog.conflictMarkersMessage}
          items={h.files}
          confirmLabel={
            retry.kind === 'commit'
              ? S.dialog.conflictMarkersCommit
              : retry.kind === 'opContinue'
                ? S.dialog.conflictMarkersContinue
                : S.dialog.conflictMarkersSave
          }
          danger
          onConfirm={() => {
            s.dismiss();
            switch (retry.kind) {
              case 'commit':
                void s.commit({
                  ignoreSecrets: retry.ignoreSecrets,
                  allowConflictMarkers: true,
                });
                break;
              case 'opContinue':
                void s.opContinue(true);
                break;
              case 'saveConflict':
                void s.saveConflict(retry.content, {
                  force: retry.force,
                  allowConflictMarkers: true,
                });
                break;
            }
          }}
          onCancel={s.dismiss}
        />
      );
    }
  }
}

/**
 * tag 이름 충돌 안내 (TG-02): 알리기만 한다 — branch 의 강제 push 대화상자처럼 덮어쓰기를 권하지 않는다. 단일 조회가
 * 끝나면 두 commit 을 보이고(B5), 원격 객체를 알면 둘째 단추 "원격 tag 를 로컬 것으로 덮어쓰기…"(C5)가 생긴다. 그 단추는
 * 위험 확인(두 commit, 되돌릴 수 없음)으로 이어지고, 확인하면 확인한 원격 객체로 lease 를 건 push 한 번으로 덮어쓴다
 */
function TagExistsDialog({
  hint,
  s,
  title,
}: {
  hint: Extract<PendingHint, { kind: 'tagExists' }>;
  s: ReturnType<typeof pickHint>;
  title: (t: string) => string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [only] = hint.names;
  const commits = hint.commits ?? [];
  const lines = hint.commits?.map((c) => commitPairLine(c.name, c.remote, c.local));
  // 덮어쓰기는 모든 tag 의 원격 객체(lease 기준)를 알 때만 할 수 있다
  const items = commits.flatMap((c) =>
    c.remoteObject === null
      ? []
      : [
          {
            name: c.name,
            expectedRemote: c.remoteObject,
            remoteCommit: c.remote,
            localCommit: c.local,
          },
        ],
  );
  const canReplace = items.length > 0 && items.length === hint.names.length;
  if (confirming) {
    return (
      <ConfirmDialog
        open
        title={title(S.tag.align.toLocalTitle(items.length, hint.remote))}
        message={S.tag.align.toLocalMessage}
        items={items.map((i) => commitPairLine(i.name, i.remoteCommit, i.localCommit))}
        confirmLabel={S.tag.align.toLocalConfirm}
        danger
        onConfirm={() => {
          s.dismiss();
          void s.replaceRemoteTags(
            hint.remote,
            items.map((i) => ({ name: i.name, expectedRemote: i.expectedRemote })),
          );
        }}
        onCancel={s.dismiss}
      />
    );
  }
  return (
    <ConfirmDialog
      open
      title={title(
        hint.names.length === 1 && only
          ? S.tag.exists.title(only, hint.remote)
          : S.tag.exists.titleMany(hint.names.length, hint.remote),
      )}
      message={S.tag.exists.message}
      items={lines ?? (hint.names.length > 1 ? hint.names : undefined)}
      confirmLabel={S.confirm.ok}
      secondaryLabel={canReplace ? S.tag.exists.replace : undefined}
      onSecondary={() => setConfirming(true)}
      onConfirm={s.dismiss}
      onCancel={s.dismiss}
    />
  );
}
