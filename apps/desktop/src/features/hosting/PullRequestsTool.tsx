import { S } from '@mgit/ui';
import { useEffect } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { ToolButton } from '../../layout/ToolButton';
import { ToolWindowFrame, ToolWindowNote } from '../../layout/ToolWindowFrame';
import { headBranchOf, useAppStore, useSession } from '../../store';
import styles from './hosting.module.css';
import { PrList } from './PrList';
import toolStyles from './PullRequestsTool.module.css';
import { createPr, type PrDeps, prContent, prCreateDisabled, prReloadDisabled } from './pr-tool';

/**
 * 저장소 탭의 Pull Requests 도구 창 (W24, WS-17 — HO-02·03·04): 옛 Git 도구 창 왼쪽 칸의 PR/MR 섹션을 왼쪽 도구 창으로
 * 옮겼다. 왼쪽 띠에서 Project·Commit 과 같은 자리에 번갈아 뜨고, 띠의 단추는 원격 프로젝트(GitHub/GitLab)가 있을 때만
 * 있다 (`useActivePrKind`).
 * - 머리: 제목(GitHub = Pull Requests, GitLab = Merge Requests) + 개수, 계정이 연결됐을 때만 새로고침(읽는 중이면 꺼짐)·
 *   만들기…(다른 작업 중이거나 현재 branch 가 없으면 꺼짐, 만든 뒤 목록을 다시 읽는다). 옛 섹션의 접기(▾)는 없다 — 도구
 *   창 자체를 접는다
 * - 내용: 계정 없음(+ "계정 연결…" → 계정 대화상자) / 오류 / 읽는 중(목록이 빌 때만) / 비어 있음 / 목록(`PrList`)
 * - 첫 읽기: 계정이 연결된 프로젝트가 처음 보일 때 한 번, 프로젝트가 바뀌면 다시 (`ensurePullRequests` — 기억은 세션에
 *   있어 도구 창을 닫았다 열어도 다시 읽지 않는다)
 */
export function PullRequestsTool() {
  const s = useSession((st) => ({
    project: st.remoteProject,
    prs: st.pullRequests,
    loading: st.prsLoading,
    error: st.prsError,
    load: st.loadPullRequests,
    ensure: st.ensurePullRequests,
    checkout: st.checkoutPullRequest,
    create: st.createPullRequest,
    templates: st.prTemplates,
    refs: st.refs,
    path: st.path,
    headBranch: headBranchOf(st.refs),
    busy: st.busy,
  }));
  const openUrl = useAppStore((st) => st.openUrl);
  const setAppDialog = useAppStore((st) => st.setAppDialog);
  const openRepositoryAt = useAppStore((st) => st.openRepositoryAt);
  const dialogs = useDialogs();
  const project = s.project;
  const key = project?.accountId ? `${project.accountId}/${project.project}` : null;
  // 계정이 연결된 프로젝트가 처음 보일 때 한 번 읽는다 (같은 프로젝트로 이미 읽었으면 세션이 건너뛴다)
  const { ensure } = s;
  useEffect(() => {
    if (key !== null) {
      void ensure();
    }
  }, [key, ensure]);

  if (!project) {
    return null;
  }
  const title = S.pr.title(project.kind);
  const content = prContent({
    project,
    error: s.error,
    loading: s.loading,
    count: s.prs.length,
  });
  const deps: PrDeps = {
    state: { busy: s.busy, repoPath: s.path },
    session: { checkoutPullRequest: s.checkout },
    dialogs,
    openUrl,
    openRepositoryAt,
  };

  return (
    <ToolWindowFrame
      title={
        <>
          {title}
          <span className={toolStyles.count}>{s.prs.length}</span>
        </>
      }
      tools={
        project.accountId ? (
          <>
            <ToolButton
              icon="refresh"
              label={S.pr.reload}
              disabled={prReloadDisabled(s.loading)}
              onClick={() => void s.load()}
            />
            <ToolButton
              icon="add"
              label={S.pr.createAction}
              disabled={prCreateDisabled(s)}
              onClick={() =>
                void createPr({
                  dialogs,
                  headBranch: s.headBranch,
                  refs: s.refs,
                  remote: project.remote,
                  templates: s.templates,
                  create: s.create,
                  openUrl,
                  reload: s.load,
                })
              }
            />
          </>
        ) : null
      }
    >
      {content.kind === 'list' ? (
        <PrList prs={s.prs} label={title} deps={deps} />
      ) : content.kind === 'noAccount' ? (
        <div className={toolStyles.note}>
          {S.pr.noAccount}{' '}
          <button type="button" className={styles.link} onClick={() => setAppDialog('accounts')}>
            {S.pr.connect}
          </button>
        </div>
      ) : content.kind === 'error' ? (
        <ToolWindowNote text={content.message} error />
      ) : (
        <ToolWindowNote text={content.kind === 'loading' ? S.pr.loading : S.pr.empty} />
      )}
      {dialogs.element}
    </ToolWindowFrame>
  );
}
