import {
  type CreatePr,
  type PrTemplate,
  type PullRequest,
  type RepoRefs,
  remoteBranchName,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { bool, str, type useDialogs } from '../../components/use-dialogs';

type Dialogs = ReturnType<typeof useDialogs>;

/** 원격의 브랜치 이름들 (`origin/` 접두 제거) */
export function remoteBranches(refs: RepoRefs, remote: string): string[] {
  return refs.labels
    .filter((l) => l.kind.kind === 'remoteBranch' && l.kind.remote === remote)
    .map((l) => remoteBranchName(l))
    .filter((n) => n !== 'HEAD');
}

/** base 로 쓸 기본 브랜치 추정 */
export function defaultBase(branches: readonly string[]): string {
  return ['main', 'master', 'develop'].find((b) => branches.includes(b)) ?? branches[0] ?? 'main';
}

/**
 * PR head 기본값: 이 원격의 업스트림 브랜치. 로컬과 이름이 다를 수 있고, PR 은 원격에 있는 브랜치를 가리킨다.
 * 다른 원격을 추적하거나 업스트림이 없으면 로컬 이름을 쓴다
 */
export function prHeadBranch(refs: RepoRefs, headBranch: string | null, remote: string): string {
  const upstream = refs.labels.find((l) => l.isCurrent)?.upstream ?? null;
  const short = upstream?.replace(/^refs\/remotes\//, '') ?? '';
  const prefix = `${remote}/`;
  return short.startsWith(prefix) ? short.slice(prefix.length) : (headBranch ?? '');
}

/** PR/MR 만들기 (HO-03): 템플릿 고르기 → head/base/제목/본문/초안 → 생성 → 브라우저 */
export async function createPrFlow(
  d: Dialogs,
  deps: {
    headBranch: string | null;
    refs: RepoRefs;
    remote: string;
    templates: () => Promise<PrTemplate[]>;
    create: (spec: CreatePr) => Promise<PullRequest | null>;
    openUrl: (url: string) => Promise<void>;
  },
): Promise<PullRequest | null> {
  const branches = remoteBranches(deps.refs, deps.remote);
  const base = defaultBase(branches);
  const templates = await deps.templates();
  let body = templates[0]?.body ?? '';
  if (templates.length > 1) {
    const first = templates[0];
    const pick = await d.prompt({
      title: S.pr.templateTitle,
      fields: [
        {
          key: 'template',
          label: S.pr.template,
          type: 'select',
          initial: first?.name ?? '',
          options: templates.map((t) => ({ value: t.name, label: t.name })),
        },
      ],
      confirmLabel: S.pr.pickTemplate,
    });
    if (!pick) {
      return null;
    }
    body = templates.find((t) => t.name === str(pick, 'template'))?.body ?? '';
  }
  const options = [...new Set([base, ...branches])].map((b) => ({ value: b, label: b }));
  const head = prHeadBranch(deps.refs, deps.headBranch, deps.remote);
  const v = await d.prompt({
    title: S.pr.createTitle,
    fields: [
      { key: 'head', label: S.pr.head, initial: head, required: true },
      { key: 'base', label: S.pr.base, type: 'select', initial: base, options },
      { key: 'title', label: S.pr.prTitle, initial: deps.headBranch ?? '', required: true },
      { key: 'body', label: S.pr.body, type: 'textarea', initial: body },
      { key: 'draft', label: S.pr.draft, type: 'checkbox' },
    ],
    confirmLabel: S.pr.create,
  });
  if (!v) {
    return null;
  }
  const pr = await deps.create({
    head: str(v, 'head').trim(),
    base: str(v, 'base'),
    title: str(v, 'title').trim(),
    body: str(v, 'body'),
    draft: bool(v, 'draft'),
  });
  if (pr) {
    void deps.openUrl(pr.webUrl);
  }
  return pr;
}

/** PR 을 새 워크트리로 (HO-04): 경로를 묻고 체크아웃 뒤 그 워크트리를 연다 */
export async function checkoutPrWorktreeFlow(
  d: Dialogs,
  deps: {
    repoPath: string;
    number: number;
    checkout: (number: number, worktree: string | null) => Promise<string | null>;
    openRepositoryAt: (path: string) => Promise<unknown>;
  },
): Promise<void> {
  const v = await d.prompt({
    title: S.pr.checkoutWorktree,
    fields: [
      {
        key: 'path',
        label: S.pr.worktreePath,
        initial: `${deps.repoPath}-pr-${deps.number}`,
        required: true,
      },
    ],
    confirmLabel: S.dialog.create,
  });
  if (!v) {
    return;
  }
  const path = str(v, 'path').trim();
  const branch = await deps.checkout(deps.number, path);
  if (branch) {
    await deps.openRepositoryAt(path);
  }
}
