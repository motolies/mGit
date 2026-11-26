// 여러 저장소 한꺼번에 clone: URL 여러 줄 입력 → 상위 폴더 → 대상 체크 목록 → 코어 일괄 clone → 결과 알림. 끝나면
// 앱 스토어가 상위 폴더를 폴더 탭으로 열고 그 폴더의 작업 기록에 남긴다 (`cloneRepositories`). 작업 기록의 "실패한
// 저장소만 다시 실행" 은 같은 흐름을 실패·취소된 대상으로 채워 다시 연다.

import type { BatchResult, CloneBatchRequest, CloneTarget } from '@mgit/ipc';
import { type PromptField, type PromptValidate, requireChecked, S } from '@mgit/ui';
import { bool, raw, str } from '../../components/use-dialogs';
import type { TaskEntry } from '../../store';
import { batchNotice } from '../folder/batch-report';
import { repoNameFromUrl } from './repo-flows';

/** 동시 clone 수 (자격 증명 창이 한꺼번에 몰리지 않게 낮게 둔다 — 코어 기본값과 같다) */
export const BATCH_CLONE_CONCURRENCY = 2;

/** 줄 하나를 해석하지 못한 사유 */
export type CloneLineError = 'badUrl' | 'badName' | 'tooManyParts';

/** 해석한 대상 하나 (입력의 몇째 줄인지와 함께) */
export interface CloneLine extends CloneTarget {
  line: number;
}

/** 입력 전체의 해석 결과 */
export interface CloneList {
  /** clone 할 대상 (입력 순서, 같은 URL 은 처음 것만) */
  targets: CloneLine[];
  /** 같은 URL 이라 뺀 줄 수 */
  duplicates: number;
  /** 해석하지 못한 줄 */
  errors: { line: number; error: CloneLineError }[];
  /** 둘 이상의 대상이 같은 폴더 이름을 쓴다 (대소문자를 가리지 않는 파일 시스템에서도 겹치지 않게 소문자로 비교) */
  nameClashes: string[];
}

/** 상위 폴더 바로 아래의 폴더 이름으로 쓸 수 있는지 (코어와 같은 규칙: `.`·`..`·경로 구분자 없음) */
function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}

/** 같은 저장소인지 볼 때 쓰는 URL (끝의 `/` 를 뗀다) */
function urlKey(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * URL 여러 줄을 해석한다. 빈 줄과 `#` 로 시작하는 줄은 건너뛰고, 줄 안의 ` #` 뒤도 무시한다. 줄마다 `URL [폴더 이름]` —
 * 이름을 쓰지 않으면 URL 의 마지막 부분에서 `.git` 을 뗀 이름(단일 clone 과 같은 규칙). 같은 URL 은 한 번만 넣는다
 */
export function parseCloneList(text: string): CloneList {
  const targets: CloneLine[] = [];
  const errors: CloneList['errors'] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const body = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (body === '') {
      return;
    }
    const parts = body.split(/\s+/);
    const [url = '', given] = parts;
    if (parts.length > 2) {
      errors.push({ line, error: 'tooManyParts' });
      return;
    }
    if (url.startsWith('-')) {
      errors.push({ line, error: 'badUrl' });
      return;
    }
    const name = given ?? repoNameFromUrl(url);
    if (!validName(name)) {
      errors.push({ line, error: 'badName' });
      return;
    }
    if (seen.has(urlKey(url))) {
      duplicates++;
      return;
    }
    seen.add(urlKey(url));
    targets.push({ url, name, line });
  });
  const counts = new Map<string, number>();
  for (const t of targets) {
    const key = t.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const nameClashes = [
    ...new Set(
      targets.filter((t) => (counts.get(t.name.toLowerCase()) ?? 0) > 1).map((t) => t.name),
    ),
  ];
  return { targets, duplicates, errors, nameClashes };
}

/** 입력 창의 확인을 막는 사유: 해석하지 못한 첫 줄, 겹치는 폴더 이름, 대상 없음. 칸이 비었으면 null (필수 칸이 막는다) */
export function cloneListError(text: string): string | null {
  if (text.trim() === '') {
    return null;
  }
  const m = S.clone.many;
  const list = parseCloneList(text);
  const [first] = list.errors;
  if (first) {
    return m.errors[first.error](first.line);
  }
  if (list.nameClashes.length > 0) {
    return m.nameClash(list.nameClashes.join(', '));
  }
  return list.targets.length === 0 ? m.noTargets : null;
}

/** 다시 입력할 수 있는 줄들: 이름이 URL 에서 나오는 이름과 같으면 URL 만, 다르면 `URL 이름` */
export function formatCloneList(targets: readonly CloneTarget[]): string {
  return targets
    .map((t) => (t.name === repoNameFromUrl(t.url) ? t.url : `${t.url} ${t.name}`))
    .join('\n');
}

/** 경량 복제·서브모듈 옵션 (모든 대상에 같게) */
export interface BatchCloneOptions {
  recurseSubmodules: boolean;
  depth: number | null;
  blobless: boolean;
  singleBranch: boolean;
}

/** 다시 열 때 채울 값 (실패한 저장소만 다시 실행) */
export interface BatchClonePreset {
  /** 입력 칸의 줄들 */
  text: string;
  /** 상위 폴더 (있으면 고르지 않는다) */
  parent?: string;
  options?: BatchCloneOptions;
}

/** 흐름이 쓰는 대화상자 (useDialogs 의 prompt) */
export interface BatchCloneDialogs {
  prompt: (spec: {
    title: string;
    message?: string;
    fields: readonly PromptField[];
    confirmLabel?: string;
    validate?: PromptValidate;
    notice?: (values: Readonly<Record<string, string | boolean>>) => string | null;
  }) => Promise<Record<string, string | boolean> | null>;
}

/** 흐름이 쓰는 앱 동작 */
export interface BatchCloneDeps {
  /** 폴더 선택 창 (`defaultPath` 가 있으면 그 폴더에서 연다) */
  pickDirectory: (title: string, defaultPath?: string) => Promise<string | null>;
  /** 일괄 clone 실행 (앱 스토어 `cloneRepositories`: 끝나면 폴더 탭을 열고 작업 기록에 남긴다) */
  cloneRepositories: (request: CloneBatchRequest) => Promise<BatchResult | null>;
  /** 결과 알림 */
  notice: (n: { kind: 'success' | 'error'; title: string; message?: string }) => void;
  /** 상위 폴더 선택 창의 처음 위치 (폴더 탭에서 열었으면 그 폴더) */
  defaultParent?: string | null;
}

/** 입력 창 값의 글자 칸 */
const textOf = (values: Readonly<Record<string, string | boolean>>, key: string) =>
  typeof values[key] === 'string' ? (values[key] as string) : '';

/** 체크 목록 칸의 키 (입력 순서) */
const targetKey = (index: number) => `target:${index}`;

/**
 * 여러 저장소 clone 흐름: ① URL 여러 줄과 옵션(서브모듈·경량 복제)을 받는다 — 해석하지 못한 줄·겹치는 폴더 이름이 있으면
 * 확인을 끄고, 아래에 대상 수를 보인다 ② 상위 폴더를 고른다 (다시 실행이면 그대로, 폴더 탭에서 열었으면 그 폴더에서 연다)
 * ③ 대상 체크 목록(`폴더 이름 ← URL`, 처음엔 모두 체크)으로 확인한다 ④ 체크한 대상을 동시 2개로 clone 하고 결과를 알린다
 */
export async function batchCloneFlow(
  d: BatchCloneDialogs,
  deps: BatchCloneDeps,
  preset?: BatchClonePreset,
): Promise<BatchResult | null> {
  const c = S.clone;
  const m = c.many;
  const options = preset?.options;
  const v = await d.prompt({
    title: m.title,
    message: m.note,
    fields: [
      {
        key: 'urls',
        label: m.urls,
        type: 'textarea',
        required: true,
        placeholder: m.placeholder,
        ...(preset ? { initial: preset.text } : {}),
      },
      {
        key: 'recurse',
        label: c.recurse,
        type: 'checkbox',
        initial: options?.recurseSubmodules ?? false,
      },
      {
        key: 'depth',
        label: c.depth,
        placeholder: c.depthPlaceholder,
        initial: options?.depth ? String(options.depth) : '',
      },
      { key: 'blobless', label: c.blobless, type: 'checkbox', initial: options?.blobless ?? false },
      {
        key: 'singleBranch',
        label: c.singleBranch,
        type: 'checkbox',
        initial: options?.singleBranch ?? false,
      },
    ],
    validate: (values) => cloneListError(textOf(values, 'urls')),
    notice: (values) => {
      const list = parseCloneList(textOf(values, 'urls'));
      return list.targets.length === 0 ? null : m.count(list.targets.length, list.duplicates);
    },
    confirmLabel: m.next,
  });
  if (!v) {
    return null;
  }
  const list = parseCloneList(raw(v, 'urls'));
  if (list.targets.length === 0 || list.errors.length > 0 || list.nameClashes.length > 0) {
    return null;
  }
  const parent =
    preset?.parent ??
    (deps.defaultParent
      ? await deps.pickDirectory(m.pickParent, deps.defaultParent)
      : await deps.pickDirectory(m.pickParent));
  if (!parent) {
    return null;
  }
  const checked = await d.prompt({
    title: m.confirmTitle(list.targets.length),
    message: `${parent}\n${m.confirmNote}`,
    fields: list.targets.map((t, index) => ({
      key: targetKey(index),
      label: m.target(t.name, t.url),
      type: 'checkbox' as const,
      initial: true,
      group: m.group(list.targets.length),
    })),
    validate: requireChecked(
      list.targets.map((_, index) => targetKey(index)),
      m.noneChecked,
    ),
    confirmLabel: c.button,
  });
  if (!checked) {
    return null;
  }
  const targets = list.targets
    .filter((_, index) => bool(checked, targetKey(index)))
    .map(({ url, name }) => ({ url, name }));
  if (targets.length === 0) {
    return null;
  }
  const depth = Number.parseInt(str(v, 'depth'), 10);
  const result = await deps.cloneRepositories({
    parent,
    targets,
    recurseSubmodules: bool(v, 'recurse'),
    depth: depth > 0 ? depth : null,
    blobless: bool(v, 'blobless'),
    singleBranch: bool(v, 'singleBranch'),
    concurrency: BATCH_CLONE_CONCURRENCY,
  });
  if (result) {
    deps.notice(batchNotice(result));
  }
  return result;
}

/**
 * 작업 기록의 여러 저장소 clone 줄에서 "실패한 저장소만 다시 실행" 할 값: 실패하거나 취소된 대상(결과 줄의 폴더 이름으로
 * 요청의 대상을 찾는다)과 같은 상위 폴더·옵션. clone 줄이 아니거나 다시 할 대상이 없으면 null
 */
export function cloneRetryPreset(entry: TaskEntry): BatchClonePreset | null {
  const request = entry.clone;
  if (!request || !entry.result) {
    return null;
  }
  const again = new Set(
    entry.result.results.filter((r) => !r.ok || r.cancelled === true).map((r) => r.name),
  );
  const targets = request.targets.filter((t) => again.has(t.name));
  if (targets.length === 0) {
    return null;
  }
  return {
    text: formatCloneList(targets),
    parent: request.parent,
    options: {
      recurseSubmodules: request.recurseSubmodules,
      depth: request.depth ?? null,
      blobless: request.blobless,
      singleBranch: request.singleBranch,
    },
  };
}

/** 다시 실행할 대상 수 (단추 글자) */
export function cloneRetryCount(preset: BatchClonePreset): number {
  return preset.text.split('\n').filter((line) => line.trim() !== '').length;
}
