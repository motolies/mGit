import type { CloneRequest, GitignoreTemplate } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { bool, str } from '../../components/use-dialogs';

/** 대화상자 API (useDialogs 의 prompt) */
export interface PromptApi {
  prompt: (spec: {
    title: string;
    message?: string;
    fields: readonly {
      key: string;
      label: string;
      type?: 'text' | 'textarea' | 'checkbox' | 'select' | 'password';
      placeholder?: string;
      initial?: string | boolean;
      required?: boolean;
      options?: readonly { value: string; label: string }[];
    }[];
    confirmLabel?: string;
  }) => Promise<Record<string, string | boolean> | null>;
}

/** URL 의 마지막 요소에서 `.git` 을 뗀 폴더 이름 */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[/:\\]/).pop() ?? '';
  return last.replace(/\.git$/, '') || 'repo';
}

/** 경로 두 개를 잇는다 (구분자는 상위 경로의 것을 따른다) */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}

/** clone 흐름 (REPO-02): 옵션 입력 → 상위 폴더 선택 → 폴더 이름 → clone */
export async function cloneFlow(
  d: PromptApi,
  deps: {
    pickDirectory: (title: string) => Promise<string | null>;
    cloneRepository: (req: CloneRequest) => Promise<boolean>;
  },
  initialUrl = '',
): Promise<void> {
  const v = await d.prompt({
    title: S.clone.title,
    fields: [
      { key: 'url', label: S.clone.url, required: true, initial: initialUrl },
      { key: 'branch', label: S.clone.branch },
      { key: 'recurse', label: S.clone.recurse, type: 'checkbox' },
      { key: 'depth', label: S.clone.depth, placeholder: S.clone.depthPlaceholder },
      { key: 'blobless', label: S.clone.blobless, type: 'checkbox' },
      { key: 'singleBranch', label: S.clone.singleBranch, type: 'checkbox' },
    ],
    confirmLabel: S.clone.button,
  });
  if (!v) {
    return;
  }
  const parent = await deps.pickDirectory(S.clone.pickParent);
  if (!parent) {
    return;
  }
  const named = await d.prompt({
    title: S.clone.title,
    message: parent,
    fields: [
      { key: 'name', label: S.clone.name, initial: repoNameFromUrl(str(v, 'url')), required: true },
    ],
    confirmLabel: S.clone.button,
  });
  if (!named) {
    return;
  }
  await deps.cloneRepository({
    url: str(v, 'url'),
    dest: joinPath(parent, str(named, 'name')),
    branch: str(v, 'branch') || null,
    recurseSubmodules: bool(v, 'recurse'),
    depth: Number.parseInt(str(v, 'depth'), 10) > 0 ? Number.parseInt(str(v, 'depth'), 10) : null,
    blobless: bool(v, 'blobless'),
    singleBranch: bool(v, 'singleBranch'),
  });
}

/** init 흐름 (REPO-04): 상위 폴더 선택 → 이름·branch·템플릿 → 생성 */
export async function initFlow(
  d: PromptApi,
  deps: {
    pickDirectory: (title: string) => Promise<string | null>;
    templates: GitignoreTemplate[];
    initRepository: (path: string, branch: string, template: string | null) => Promise<boolean>;
  },
): Promise<void> {
  const parent = await deps.pickDirectory(S.init.pickParent);
  if (!parent) {
    return;
  }
  const v = await d.prompt({
    title: S.init.title,
    message: parent,
    fields: [
      { key: 'name', label: S.init.name, required: true },
      { key: 'branch', label: S.init.branch, initial: 'main', required: true },
      {
        key: 'template',
        label: S.init.template,
        type: 'select',
        initial: '',
        options: [
          { value: '', label: S.init.none },
          ...deps.templates.map((t) => ({ value: t.id, label: t.label })),
        ],
      },
    ],
    confirmLabel: S.init.button,
  });
  if (!v) {
    return;
  }
  await deps.initRepository(
    joinPath(parent, str(v, 'name')),
    str(v, 'branch'),
    str(v, 'template') || null,
  );
}

/** branch 만들기 흐름 (BR-02): 이름 + 만든 뒤 checkout */
export async function createBranchFlow(
  d: PromptApi,
  createBranch: (name: string, start: string | null, checkout: boolean) => Promise<void>,
): Promise<void> {
  const v = await d.prompt({
    title: S.dialog.createBranch,
    fields: [
      { key: 'name', label: S.dialog.branchName, required: true },
      { key: 'checkout', label: S.dialog.checkoutAfter, type: 'checkbox', initial: true },
    ],
    confirmLabel: S.dialog.create,
  });
  if (v) {
    await createBranch(str(v, 'name'), null, bool(v, 'checkout'));
  }
}
