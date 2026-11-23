import { DEFAULT_GRAPH_COLUMNS } from '@mgit/graph-view';
import type { ConflictPayload, GraphRow, RepoRefs, TimelineInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionErrorBar } from '../components/ActionErrorBar';
import { ContextMenuArea } from '../components/ContextMenu';
import { raw, useDialogs } from '../components/use-dialogs';
import { CredentialDialog } from '../features/app/AppDialogs';
import { RepoSettingsDialog } from '../features/app/RepoSettingsDialog';
import { HintDialogs } from '../features/branch/HintDialogs';
import { joinMessage, splitMessage } from '../features/changes/CommitForm';
import { ReviewDialog } from '../features/conflict/AssistDialogs';
import { ConflictPane } from '../features/conflict/ConflictPane';
import { LinePickDialog } from '../features/conflict/LinePickDialog';
import { DiffPane } from '../features/diff/DiffPane';
import { Dashboard } from '../features/folder/Dashboard';
import { FolderSettingsDialog } from '../features/folder/FolderSettingsDialog';
import { FolderSettingsPanel, parseExclude } from '../features/folder/FolderSettingsPanel';
import { sameTimelineRow } from '../features/folder/FolderTimeline';
import { isGraphEmpty } from '../features/graph/GraphPane';
import { GraphSearch } from '../features/graph/GraphSearch';
import { graphMenuItems } from '../features/graph/graph-menu';
import { BlameDialog } from '../features/history/BlameDialog';
import { CompareDialog } from '../features/history/CompareDialog';
import { FileHistoryDialog } from '../features/history/FileHistoryDialog';
import { AccountsDialog } from '../features/hosting/AccountsDialog';
import { ProfilesDialog } from '../features/hosting/ProfilesDialog';
import { createPrFlow, prHeadBranch } from '../features/hosting/pr-flows';
import { MergePreviewDialog } from '../features/preview/MergePreviewDialog';
import { RebasePreviewDialog } from '../features/preview/RebasePreviewDialog';
import { planError, RebasePlanDialog } from '../features/rebase/RebasePlanDialog';
import { FileBackupsDialog } from '../features/safety/FileBackupsDialog';
import { TerminalPanel } from '../features/terminal/TerminalPanel';
import { BottomDock } from '../layout/BottomDock';
import { useAppStore } from '../store';
import { type DockState, externalKey } from '../store/app-store';
import { DEFAULT_GRAPH_QUERY } from '../store/session-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  folder: {} as Record<string, unknown>,
  mounts: 0,
  unmounts: 0,
}));

vi.mock('../store', async (orig) => {
  const m = await orig<typeof import('../store')>();
  return {
    ...m,
    useSession: (sel: (s: never) => unknown) => sel(h.session as never),
    useFolder: (sel: (s: never) => unknown) => sel(h.folder as never),
    useHasSession: () => true,
  };
});

vi.mock('@mgit/terminal', () => ({
  /** 마운트 수만 세는 터미널 */
  TerminalView: ({ active }: { active: boolean }) => {
    useEffect(() => {
      h.mounts += 1;
      return () => {
        h.unmounts += 1;
      };
    }, []);
    return <div data-testid="term" data-active={String(active)} />;
  },
}));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

beforeEach(() => {
  installDialogStub();
  h.session = {};
  h.folder = {};
  h.mounts = 0;
  h.unmounts = 0;
});
afterEach(() => {
  cleanup();
  removeDialogStub();
});

/** 사이드바처럼 안쪽 영역을 품은 바깥 영역 */
function Nested() {
  return (
    <ContextMenuArea<string>
      resolveTarget={(e) =>
        (e.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key') ?? null
      }
      items={(t) => [{ label: `바깥:${t}` }]}
    >
      <div data-key="k">outer-item</div>
      <ContextMenuArea<string>
        resolveTarget={(e) =>
          (e.target as HTMLElement).closest('[data-sm]')?.getAttribute('data-sm') ?? null
        }
        items={(t) => [{ label: `안쪽:${t}` }]}
      >
        <div data-sm="sub">inner-item</div>
        <div>inner-empty</div>
      </ContextMenuArea>
    </ContextMenuArea>
  );
}

describe('중첩 컨텍스트 메뉴', () => {
  it('안쪽 영역의 항목은 안쪽 메뉴가 열린다', async () => {
    render(<Nested />);
    fireEvent.contextMenu(screen.getByText('inner-item'));
    await tick();
    expect(screen.getByText('안쪽:sub')).toBeTruthy();
  });

  it('바깥 항목은 바깥 메뉴가 열린다', async () => {
    render(<Nested />);
    fireEvent.contextMenu(screen.getByText('outer-item'));
    await tick();
    expect(screen.getByText('바깥:k')).toBeTruthy();
  });

  it('대상이 없는 자리에서는 아무 메뉴도 열지 않는다', async () => {
    render(<Nested />);
    fireEvent.contextMenu(screen.getByText('inner-empty'));
    await tick();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

/** 버튼으로 PR 흐름을 시작한다 */
function PrFlow({ templates }: { templates: { name: string; body: string }[] }) {
  const d = useDialogs();
  const ref = useRef(d);
  ref.current = d;
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void createPrFlow(ref.current, {
            headBranch: 'main',
            refs: { labels: [] } as unknown as RepoRefs,
            remote: 'origin',
            templates: async () => templates,
            create: async () => null,
            openUrl: async () => {},
          })
        }
      >
        go
      </button>
      {d.element}
    </>
  );
}

describe('연속 대화상자', () => {
  const openTitles = () =>
    [...document.querySelectorAll('dialog[open] h2')].map((e) => e.textContent);

  it('템플릿이 둘 이상이어도 PR 만들기 대화상자가 남는다', async () => {
    render(
      <PrFlow
        templates={[
          { name: 'a', body: 'A' },
          { name: 'b', body: 'B' },
        ]}
      />,
    );
    fireEvent.click(screen.getByText('go'));
    await tick();
    expect(openTitles()).toEqual([S.pr.templateTitle]);
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    await tick();
    expect(openTitles()).toEqual([S.pr.createTitle]);
  });
});

/** 단추로 두 갈래(`confirm`)·세 갈래(`confirmChoice`) 확인을 열고 결과를 글자로 남긴다 */
function ConfirmHarness() {
  const d = useDialogs();
  const [result, setResult] = useState('none');
  return (
    <>
      <output data-testid="result">{result}</output>
      <button
        type="button"
        onClick={() =>
          void d
            .confirmChoice({
              title: 'diverged',
              message: 'm',
              danger: true,
              confirmLabel: '그래도 삭제',
              secondaryLabel: '건너뛰고 삭제',
            })
            .then(setResult)
        }
      >
        choice
      </button>
      <button
        type="button"
        onClick={() =>
          void d
            .confirm({ title: 'plain', message: 'm', confirmLabel: '그래도 삭제' })
            .then((ok) => setResult(String(ok)))
        }
      >
        plain
      </button>
      {d.element}
    </>
  );
}

describe('확인 대화상자의 둘째 선택지 (A5)', () => {
  const result = () => screen.getByTestId('result').textContent;
  const open = async (which: 'choice' | 'plain') => {
    fireEvent.click(screen.getByText(which));
    await tick();
  };
  const buttons = () =>
    [...document.querySelectorAll('dialog[open] button')].map((b) => b.textContent);
  /** 열린 대화상자의 단추를 누른다 (닫혀 있는 입력 대화상자에도 같은 이름의 취소 단추가 있다) */
  const press = async (label: string) => {
    fireEvent.click(within(document.querySelector('dialog[open]') as HTMLElement).getByText(label));
    await tick();
  };

  it('confirmChoice 는 취소·둘째·확인 세 단추를 두고 고른 단추를 돌려준다 (danger 면 취소에 포커스)', async () => {
    render(<ConfirmHarness />);
    await open('choice');
    expect(buttons()).toEqual([S.confirm.cancel, '건너뛰고 삭제', '그래도 삭제']);
    expect(document.activeElement?.textContent).toBe(S.confirm.cancel);
    await press('건너뛰고 삭제');
    expect(result()).toBe('secondary');
    expect(document.querySelector('dialog[open]')).toBeNull();

    await open('choice');
    await press(S.confirm.cancel);
    expect(result()).toBe('cancel');

    await open('choice');
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(result()).toBe('confirm');
  });

  it('confirm 은 지금처럼 두 단추에 true/false 이고, 앞의 둘째 선택지가 남지 않는다', async () => {
    render(<ConfirmHarness />);
    await open('choice');
    await press('건너뛰고 삭제');
    await open('plain');
    expect(buttons()).toEqual([S.confirm.cancel, '그래도 삭제']);
    await press(S.confirm.cancel);
    expect(result()).toBe('false');
    await open('plain');
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(result()).toBe('true');
  });
});

describe('입력이 사라지던 폼', () => {
  it('커밋 본문의 끝 공백·줄바꿈이 입력 중 사라지지 않는다', () => {
    const typed = 'hello world\nsecond line\n\n';
    let message = joinMessage('제목', '');
    for (const ch of typed) {
      const { summary, body } = splitMessage(message);
      message = joinMessage(summary, body + ch);
    }
    expect(splitMessage(message)).toEqual({ summary: '제목', body: typed });
  });

  it('제외 목록에 쉼표·공백을 그대로 칠 수 있고 저장할 때 나뉜다', async () => {
    const save = vi.fn(async () => {});
    h.folder = {
      settings: {
        exclude: [],
        pullMode: 'ffOnly',
        concurrency: 4,
        autoRefreshSecs: 60,
        worktreeRoot: null,
      },
      loadSettings: async () => {},
      saveSettings: save,
    };
    render(<FolderSettingsPanel />);
    const input = screen.getByLabelText(S.folder.settings.exclude) as HTMLInputElement;
    for (const value of ['repo-a', 'repo-a,', 'repo-a, ', 'repo-a, repo b']) {
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe(value);
    }
    fireEvent.click(screen.getByText(S.folder.settings.save));
    await tick();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ exclude: ['repo-a', 'repo b'] }));
    expect(parseExclude(' a, ,b ,')).toEqual(['a', 'b']);
  });

  it('사용자 정보를 저장해도 미저장 .gitignore 편집이 남는다', async () => {
    const settings = (name: string) => ({
      localUserName: name,
      localUserEmail: 'e',
      userName: name,
      userEmail: 'e',
      gitignore: 'orig\n',
      hooks: [],
      hooksPath: null,
      signing: { format: 'openpgp', signingKey: null, commitSign: false },
      perf: { trackedFiles: 1, fsmonitor: true, untrackedCache: true },
      shallow: false,
    });
    h.session = { repoSettings: settings('a'), lfs: null };
    const { rerender } = render(<RepoSettingsDialog />);
    await tick();
    const ta = document.querySelector('dialog textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'orig\nnew-rule' } });
    h.session = { repoSettings: settings('b'), lfs: null };
    rerender(<RepoSettingsDialog />);
    await tick();
    expect(ta.value).toBe('orig\nnew-rule');
  });

  it('자격 증명 입력은 다시 그려져도 남고, 비밀 값은 다듬지 않고 보낸다', async () => {
    const replyCredential = vi.fn(async () => {});
    act(() => {
      useAppStore.setState({
        credentialRequest: { reqId: 1, kind: 'password', target: 't', prompt: 'p', receivedAt: 0 },
        replyCredential,
      });
    });
    const { rerender } = render(<CredentialDialog />);
    await tick();
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  pass word  ' } });
    rerender(<CredentialDialog />);
    await tick();
    expect(input.value).toBe('  pass word  ');
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(replyCredential).toHaveBeenCalledWith('  pass word  ', true);
    expect(raw({ a: ' x ' }, 'a')).toBe(' x ');
    act(() => useAppStore.setState({ credentialRequest: null }));
  });

  it('줄 고르기의 체크 해제가 다음 블록으로 이어지지 않고 \\r 을 보이지 않는다', async () => {
    const block = (ours: string[], theirs: string[]) =>
      ({ kind: 'conflict', ours, base: [], theirs, labels: ['a', 'b', 'c'] }) as never;
    const labels = { ours: 'o', base: 'b', theirs: 't' };
    const view = (pick: Parameters<typeof LinePickDialog>[0]['pick']) => (
      <LinePickDialog pick={pick} labels={labels} onClose={() => {}} />
    );
    const { rerender } = render(
      view({ index: 0, block: block(['o1', 'o2'], ['t1']), apply: () => {} }),
    );
    await tick();
    fireEvent.click(document.querySelector('dialog li input') as HTMLInputElement);
    expect(document.querySelector('dialog pre')?.textContent).toBe('o2\nt1');
    rerender(view(null));
    await tick();
    rerender(view({ index: 1, block: block(['p1\r', 'p2'], ['q1']), apply: () => {} }));
    await tick();
    expect(document.querySelector('dialog pre')?.textContent).toBe('p1\np2\nq1');
  });
});

describe('힌트 대화상자의 push 경로', () => {
  const spec = {
    remote: 'fork',
    setUpstream: false,
    tags: false,
    forceWithLease: false,
    confirmUpstreamMismatch: false,
    rememberUpstreamMismatch: false,
  };

  /** 세션 스파이 */
  function session(hint: unknown, over: Record<string, unknown> = {}) {
    h.session = {
      pendingHint: hint,
      dismissHint: vi.fn(),
      pull: vi.fn(async () => true),
      push: vi.fn(async () => true),
      pushSubmodulesThenPush: vi.fn(async () => {}),
      commit: vi.fn(async () => true),
      opContinue: vi.fn(async () => {}),
      saveConflict: vi.fn(async () => true),
      ...over,
    };
    return h.session as Record<string, ReturnType<typeof vi.fn>>;
  }

  it('강제 push 는 고른 원격으로 간다', async () => {
    const s = session({ kind: 'nonFastForward', spec });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(s.push).toHaveBeenCalledWith(
      { ...spec, forceWithLease: true },
      { skipSubmoduleCheck: true },
    );
  });

  it('pull 후 push 는 pull 이 성공했을 때만, 고른 원격으로 간다', async () => {
    const s = session({ kind: 'nonFastForward', spec });
    render(<HintDialogs />);
    fireEvent.click(screen.getByText(S.dialog.pullThenPush));
    await tick();
    expect(s.pull).toHaveBeenCalled();
    expect(s.push).toHaveBeenCalledWith(spec, { skipSubmoduleCheck: true });
  });

  it('tag 이름 충돌은 안내만 한다: 강제 push·pull 단추 없이 확인 하나, 아무것도 다시 하지 않는다 (TG-02)', async () => {
    const s = session({ kind: 'tagExists', remote: 'origin', names: ['v2.3.1'] });
    render(<HintDialogs />);
    expect(document.querySelector('dialog h2')?.textContent).toBe(
      S.tag.exists.title('v2.3.1', 'origin'),
    );
    expect([...document.querySelectorAll('dialog button')].map((b) => b.textContent)).toEqual([
      S.confirm.cancel,
      S.confirm.ok,
    ]);
    expect(screen.queryByText(S.dialog.forcePush)).toBeNull();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(s.dismissHint).toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
    expect(s.pull).not.toHaveBeenCalled();
  });

  it('tag 이름 충돌: 원격 객체를 알면 둘째 단추가 위험 확인으로 이어지고, 확인하면 lease 덮어쓰기 (C5)', async () => {
    const commits = [
      { name: 'v1', local: 'a'.repeat(40), remote: 'b'.repeat(40), remoteObject: 'c'.repeat(40) },
    ];
    const s = session(
      { kind: 'tagExists', remote: 'origin', names: ['v1'], commits },
      { replaceRemoteTags: vi.fn(async () => []) },
    );
    render(<HintDialogs />);
    fireEvent.click(screen.getByText(S.tag.exists.replace));
    await tick();
    expect(document.querySelector('dialog[open] h2')?.textContent).toBe(
      S.tag.align.toLocalTitle(1, 'origin'),
    );
    expect(document.querySelector('dialog[open] p')?.textContent).toBe(S.tag.align.toLocalMessage);
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(s.dismissHint).toHaveBeenCalled();
    expect(s.replaceRemoteTags).toHaveBeenCalledWith('origin', [
      { name: 'v1', expectedRemote: 'c'.repeat(40) },
    ]);
    cleanup();
    // 원격 객체를 모르면(조회 전·실패) 둘째 단추가 없다
    session({
      kind: 'tagExists',
      remote: 'origin',
      names: ['v1'],
      commits: [{ ...commits[0], remoteObject: null }],
    });
    render(<HintDialogs />);
    expect(screen.queryByText(S.tag.exists.replace)).toBeNull();
  });

  it('pull 이 실패하면 push 하지 않는다', async () => {
    const s = session({ kind: 'nonFastForward', spec }, { pull: vi.fn(async () => false) });
    render(<HintDialogs />);
    fireEvent.click(screen.getByText(S.dialog.pullThenPush));
    await tick();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('서브모듈 대화상자는 원래 spec 으로 이어 간다', async () => {
    const items = [{ path: 'sub', count: 1 }];
    const forced = { ...spec, forceWithLease: true };
    const s = session({ kind: 'submoduleUnpushed', items, spec: forced });
    render(<HintDialogs />);
    fireEvent.click(screen.getByText(S.dialog.submoduleUnpushedAnyway));
    await tick();
    expect(s.push).toHaveBeenCalledWith(forced, { skipSubmoduleCheck: true });
    cleanup();
    const t = session({ kind: 'submoduleUnpushed', items, spec: forced });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(t.pushSubmodulesThenPush).toHaveBeenCalledWith(forced);
  });

  it('업스트림 이름 불일치는 확인 뒤 재시도하고 체크하면 기억한다', async () => {
    const s = session({
      kind: 'pushUpstreamMismatch',
      local: 'a',
      remote: 'origin',
      upstream: 'b',
      spec,
    });
    render(<HintDialogs />);
    await tick();
    fireEvent.click(screen.getByLabelText(S.dialog.upstreamMismatchRemember));
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(s.push).toHaveBeenCalledWith(
      { ...spec, confirmUpstreamMismatch: true, rememberUpstreamMismatch: true },
      { skipSubmoduleCheck: true },
    );
  });

  it('마커 경고에서 그래도 진행하면 원래 동작을 허용 플래그로 다시 한다', async () => {
    const s = session({
      kind: 'conflictMarkers',
      files: ['m.txt'],
      retry: { kind: 'commit', ignoreSecrets: true },
    });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(s.commit).toHaveBeenCalledWith({ ignoreSecrets: true, allowConflictMarkers: true });
    cleanup();
    const t = session({ kind: 'conflictMarkers', files: ['m.txt'], retry: { kind: 'opContinue' } });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(t.opContinue).toHaveBeenCalledWith(true);
    cleanup();
    const u = session({
      kind: 'conflictMarkers',
      files: ['m.txt'],
      retry: { kind: 'saveConflict', content: 'body', force: true },
    });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(u.saveConflict).toHaveBeenCalledWith('body', {
      force: true,
      allowConflictMarkers: true,
    });
  });

  it('구문 오류를 무릅쓴 저장도 마커 허용을 잃지 않는다', async () => {
    const s = session({
      kind: 'syntaxErrors',
      path: 'a',
      content: 'body',
      compare: { resultErrors: 1, firstErrorLine: 1, language: 'ts', newErrors: true },
      allowConflictMarkers: true,
    });
    render(<HintDialogs />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await tick();
    expect(s.saveConflict).toHaveBeenCalledWith('body', {
      force: true,
      allowConflictMarkers: true,
    });
  });
});

describe('그래프 메뉴 reword', () => {
  const row = {
    oid: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    refs: [],
    subject: 'subject',
    inHead: true,
  } as unknown as GraphRow;

  /** 메뉴 동작 스파이 */
  function actions(over: Record<string, unknown> = {}) {
    return {
      busy: false,
      op: null,
      headBranch: 'main',
      selectedCommit: null,
      signingInfo: null,
      commitMessageOf: vi.fn(async () => 'subject\n\nbody line'),
      rewordCommit: vi.fn(async () => {}),
      ...over,
    } as never;
  }

  /** 라벨로 항목 찾기 */
  const find = (list: ReturnType<typeof graphMenuItems>, label: string) =>
    list.find((i) => i.label === label);
  /** 둘째 선택지 확인 (tag 삭제 흐름만 쓴다) */
  const confirmChoice = async () => 'cancel' as const;

  it('입력란을 커밋 메시지 전체로 채운다', async () => {
    const prompt = vi.fn(async () => null);
    const items = graphMenuItems(row, actions(), {
      prompt,
      confirm: async () => false,
      confirmChoice,
    });
    find(items, S.menu.reword)?.onSelect?.();
    await tick();
    expect(prompt.mock.calls[0]?.[0 as never]).toMatchObject({
      fields: [{ key: 'message', initial: 'subject\n\nbody line' }],
    });
  });

  it('메시지를 못 읽으면 제목만으로 덮어쓰지 않도록 입력란을 열지 않는다', async () => {
    const prompt = vi.fn(async () => null);
    const items = graphMenuItems(row, actions({ commitMessageOf: vi.fn(async () => null) }), {
      prompt,
      confirm: async () => false,
      confirmChoice,
    });
    find(items, S.menu.reword)?.onSelect?.();
    await tick();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('HEAD 에서 닿지 않는 커밋은 reword·squash 를 끈다', () => {
    const items = graphMenuItems({ ...row, inHead: false }, actions(), {
      prompt: async () => null,
      confirm: async () => false,
      confirmChoice,
    });
    expect(find(items, S.menu.reword)?.disabled).toBe(true);
    expect(find(items, S.menu.squashIntoParent)?.disabled).toBe(true);
  });

  it('행의 tag 마다 `tag <n> ▸` 하위 메뉴: push(원격 하나면 평면, 둘이면 하위 메뉴)·삭제 (TG-01 ①)', async () => {
    const tagLabel = (name: string) => ({
      fullName: `refs/tags/${name}`,
      shortName: name,
      kind: { kind: 'tag', annotated: true },
      target: row.oid,
      isCurrent: false,
      upstreamGone: false,
    });
    const tagged = { ...row, refs: [tagLabel('v1'), tagLabel('v2')] } as unknown as GraphRow;
    const pushTags = vi.fn(async () => []);
    const dialogs = { prompt: async () => null, confirm: async () => false, confirmChoice };
    const one = graphMenuItems(tagged, actions({ remoteNames: ['origin'], pushTags }), dialogs);
    expect(one.filter((i) => i.children && i.label.startsWith(S.tag.logItem(''))).length).toBe(2);
    const v1 = find(one, S.tag.logItem('v1'));
    expect(v1?.separator).toBe(true);
    expect(find(one, S.tag.logItem('v2'))?.separator).toBe(false);
    expect(v1?.children?.map((c) => c.label)).toEqual([S.remote.pushTo('origin'), S.menu.delete]);
    v1?.children?.[0]?.onSelect?.();
    expect(pushTags).toHaveBeenCalledWith('origin', ['v1']);
    // 원격이 둘이면 push 가 원격 이름 하위 메뉴이고, 실행 중이면 꺼진다
    const two = graphMenuItems(
      tagged,
      actions({ remoteNames: ['origin', 'upstream'], busy: true }),
      dialogs,
    );
    const sub = find(two, S.tag.logItem('v2'))?.children ?? [];
    expect(sub.map((c) => [c.label, c.disabled])).toEqual([
      [S.tag.pushMenu, true],
      [S.menu.delete, true],
    ]);
    expect(sub[0]?.children?.map((c) => c.label)).toEqual(['origin', 'upstream']);
  });
});

describe('rebase 플랜', () => {
  const rowOf = (kind: string) =>
    ({ commit: { oid: 'a', subject: 's', authorName: 'x' }, kind, message: 's' }) as never;

  it('앞쪽이 drop 뿐이면 squash·fixup 을 막고, 전부 drop 도 막는다', () => {
    expect(planError([rowOf('drop'), rowOf('fixup')])).toBe(S.rebase.firstCannotSquash);
    expect(planError([rowOf('squash')])).toBe(S.rebase.firstCannotSquash);
    expect(planError([rowOf('drop'), rowOf('drop')])).toBe(S.rebase.allDropped);
    expect(planError([rowOf('pick'), rowOf('drop'), rowOf('fixup')])).toBeNull();
  });

  /** 대화상자 세션 */
  function plan(over: Record<string, unknown> = {}) {
    h.session = {
      rebasePlan: {
        onto: 'main',
        hasMerges: false,
        commits: [{ oid: 'a'.repeat(40), subject: 'subject', authorName: 'x' }],
      },
      busy: false,
      closeRebasePlan: vi.fn(),
      runRebasePlan: vi.fn(async () => false),
      verifyCommand: null,
      actionError: null,
      commitMessageOf: vi.fn(async () => 'subject\n\nbody line'),
      ...over,
    };
  }

  it('실패 사유를 대화상자 안에 보여 주고 머지 평탄화를 경고한다', async () => {
    plan({
      actionError: '실패 사유',
      rebasePlan: {
        onto: 'main',
        hasMerges: true,
        commits: [{ oid: 'a'.repeat(40), subject: 'subject', authorName: 'x' }],
      },
    });
    render(<RebasePlanDialog />);
    await tick();
    expect(screen.getByText('실패 사유')).toBeTruthy();
    expect(screen.getByText(S.rebase.mergesFlattened)).toBeTruthy();
  });

  it('reword 를 고르면 커밋 메시지 전체를 불러온다', async () => {
    plan();
    render(<RebasePlanDialog />);
    await tick();
    fireEvent.change(document.querySelector('dialog select') as HTMLSelectElement, {
      target: { value: 'reword' },
    });
    await tick();
    expect((document.querySelector('dialog textarea') as HTMLTextAreaElement).value).toBe(
      'subject\n\nbody line',
    );
  });
});

describe('작은 순수 함수', () => {
  it('타임라인 선택은 저장소까지 비교한다 (선택은 저장소 경로, 행은 번호 → 타임라인 정보로 경로)', () => {
    const row = { oid: 'x', repo: 1 } as unknown as GraphRow;
    const info = {
      repos: [
        { index: 0, path: '/f/a' },
        { index: 1, path: '/f/b' },
      ],
    } as unknown as TimelineInfo;
    expect(sameTimelineRow({ repoPath: '/f/b', oid: 'x' }, row, info)).toBe(true);
    expect(sameTimelineRow({ repoPath: '/f/a', oid: 'x' }, row, info)).toBe(false);
    expect(sameTimelineRow({ repoPath: '/f/b', oid: 'y' }, row, info)).toBe(false);
    expect(sameTimelineRow(null, row, info)).toBe(false);
    // 정보가 없거나 번호를 모르면 어느 선택과도 같지 않다
    expect(sameTimelineRow({ repoPath: '/f/b', oid: 'x' }, row, null)).toBe(false);
    expect(
      sameTimelineRow({ repoPath: '/f/b', oid: 'x' }, { oid: 'x' } as unknown as GraphRow, info),
    ).toBe(false);
  });

  it('질의가 걸린 0행은 "커밋 없음" 화면이 아니다', () => {
    const base = { totalRows: 0, loadState: 'complete' as const, hasChanges: false };
    expect(isGraphEmpty({ ...base, query: DEFAULT_GRAPH_QUERY })).toBe(true);
    expect(isGraphEmpty({ ...base, query: { ...DEFAULT_GRAPH_QUERY, pathScope: ['x'] } })).toBe(
      false,
    );
  });

  it('PR head 기본값은 업스트림 브랜치다', () => {
    const refs = (upstream: string | null) =>
      ({ labels: [{ isCurrent: true, upstream }] }) as unknown as RepoRefs;
    expect(prHeadBranch(refs('refs/remotes/origin/feat-up'), 'feat', 'origin')).toBe('feat-up');
    expect(prHeadBranch(refs('origin/feat-up'), 'feat', 'origin')).toBe('feat-up');
    expect(prHeadBranch(refs('refs/remotes/fork/feat-up'), 'feat', 'origin')).toBe('feat');
    expect(prHeadBranch(refs(null), 'feat', 'origin')).toBe('feat');
  });

  it('업스트림 없는 push 안내는 실제 원격 이름을 쓴다', () => {
    expect(S.remote.pushNoUpstream('fork')).toContain('fork');
    expect(DEFAULT_GRAPH_COLUMNS).toBeTruthy();
  });
});

describe('그래프 검색 입력', () => {
  it('입력 직후 닫으면 밀린 검색이 돌지 않는다', async () => {
    const runSearch = vi.fn(async () => {});
    h.session = {
      search: {
        open: true,
        query: '',
        rows: [],
        total: 0,
        truncated: false,
        cursor: 0,
        advanced: null,
      },
      runSearch,
      setSearchOpen: vi.fn(),
    };
    const { unmount } = render(<GraphSearch />);
    fireEvent.change(screen.getByPlaceholderText(S.search.placeholder), {
      target: { value: 'abc' },
    });
    unmount();
    await act(() => new Promise<void>((r) => setTimeout(r, 260)));
    expect(runSearch).not.toHaveBeenCalled();
  });
});

describe('ActionErrorBar', () => {
  it('커밋을 고른 상태에서도 오류를 보여 주고 닫을 수 있다', () => {
    const clearActionError = vi.fn();
    h.session = { actionError: '브랜치 실패', clearActionError };
    render(<ActionErrorBar />);
    fireEvent.click(screen.getByText('브랜치 실패'));
    expect(clearActionError).toHaveBeenCalled();
  });

  it('오류가 없으면 아무것도 그리지 않는다', () => {
    h.session = { actionError: null, clearActionError: () => {} };
    const { container } = render(<ActionErrorBar />);
    expect(container.firstChild).toBeNull();
  });
});

describe('저장된 자격 증명 지우기', () => {
  it('대상을 입력해 지우고, 물어본 대상을 제안한다', async () => {
    const credentialForget = vi.fn(async () => true);
    act(() => {
      useAppStore.setState({
        appDialog: 'accounts',
        credentialForget,
        credentialTargets: ['https://github.com'],
      });
    });
    render(<AccountsDialog />);
    await tick();
    expect(document.querySelector('datalist option')?.getAttribute('value')).toBe(
      'https://github.com',
    );
    const input = screen.getByLabelText(S.hosting.credentialTarget);
    fireEvent.change(input, { target: { value: ' https://github.com ' } });
    fireEvent.click(screen.getByText(S.hosting.credentialForget));
    await tick();
    expect(credentialForget).toHaveBeenCalledWith('https://github.com');
    act(() => useAppStore.setState({ appDialog: null }));
  });
});

describe('모달 안의 쓰기 오류', () => {
  /** 대화상자별로 열린 상태를 만든다 */
  const opened: [string, Record<string, unknown>, () => ReactElement][] = [
    [
      '두 ref 비교',
      {
        compare: {
          a: 'a',
          b: 'b',
          threeDot: false,
          files: [],
          path: null,
          diff: null,
          loading: false,
          diffLoading: false,
        },
        diffOptions: { wrap: true, tabWidth: 4 },
      },
      () => <CompareDialog />,
    ],
    [
      'blame',
      {
        blame: { path: 'a', rev: null, lines: [], loading: false, error: null },
        diffOptions: { ignoreWhitespace: false },
      },
      () => <BlameDialog />,
    ],
    [
      '파일 히스토리',
      { fileHistory: { path: 'a', entries: [], loading: false } },
      () => <FileHistoryDialog />,
    ],
    [
      '병합 미리보기',
      {
        preview: {
          reference: 'x',
          includeWip: false,
          loading: true,
          result: null,
          simulate: null,
          simulating: false,
          file: null,
          error: null,
        },
      },
      () => <MergePreviewDialog />,
    ],
    [
      'rebase 미리보기',
      { rebasePreview: { onto: 'x', loading: false, steps: [], error: null } },
      () => <RebasePreviewDialog />,
    ],
    [
      '해결 리뷰',
      {
        review: {
          title: 't',
          subtitle: 's',
          text: '',
          note: null,
          emptyText: '',
          loading: false,
          error: null,
        },
      },
      () => <ReviewDialog />,
    ],
  ];

  it.each(opened)('%s 안에 보인다', async (_name, state, view) => {
    h.session = { ...state, actionError: '실패 사유', clearActionError: vi.fn() };
    render(view());
    await tick();
    expect(document.querySelector('dialog')?.textContent).toContain('실패 사유');
  });

  it('작성자 프로필 적용 실패도 대화상자 안에 보인다', async () => {
    act(() => useAppStore.setState({ appDialog: 'profiles', profiles: [] }));
    h.session = { actionError: '실패 사유', clearActionError: vi.fn() };
    render(<ProfilesDialog />);
    await tick();
    expect(document.querySelector('dialog')?.textContent).toContain('실패 사유');
    act(() => useAppStore.setState({ appDialog: null }));
  });
});

describe('저장소 설정의 hook 열기', () => {
  /** hook 하나가 있는 설정 */
  const session = () => {
    h.session = {
      lfs: null,
      repoSettings: {
        localUserName: 'n',
        localUserEmail: 'e',
        userName: 'n',
        userEmail: 'e',
        gitignore: '',
        hooks: [{ name: 'pre-commit', path: '/h/pre-commit', executable: true }],
        hooksPath: null,
        signing: { format: 'openpgp', signingKey: null, commitSign: false },
        perf: { trackedFiles: 1, fsmonitor: true, untrackedCache: true },
        shallow: false,
      },
    };
  };

  afterEach(() => {
    act(() => useAppStore.setState({ openingExternal: [], lastError: null }));
  });

  it('여는 동안 버튼을 막는다', async () => {
    session();
    act(() => useAppStore.setState({ openingExternal: [externalKey('editor', '/h/pre-commit')] }));
    render(<RepoSettingsDialog />);
    await tick();
    const btn = screen.getByText(S.repoSettings.openHook) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('실패 사유를 대화상자 안에 보여 주고 눌러서 닫는다', async () => {
    session();
    render(<RepoSettingsDialog />);
    await tick();
    act(() => useAppStore.setState({ lastError: '에디터를 찾을 수 없습니다' }));
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.textContent).toContain('에디터를 찾을 수 없습니다');
    fireEvent.click(within(dialog).getByText('에디터를 찾을 수 없습니다'));
    await tick();
    expect(useAppStore.getState().lastError).toBeNull();
  });
});

describe('폴더 설정 저장 표시', () => {
  /** 설정 패널이 읽는 폴더 상태 */
  const folder = (saveSettings: () => Promise<boolean>) => {
    h.folder = {
      settings: {
        exclude: [],
        pullMode: 'ffOnly',
        concurrency: 4,
        autoRefreshSecs: 60,
        worktreeRoot: null,
      },
      loadSettings: async () => {},
      saveSettings,
    };
  };

  it('실패하면 "저장됨" 을 띄우지 않는다', async () => {
    folder(async () => false);
    render(<FolderSettingsPanel />);
    fireEvent.click(screen.getByText(S.folder.settings.save));
    await tick();
    expect(screen.queryByText(S.folder.settings.saved)).toBeNull();
  });

  it('성공하면 "저장됨" 을 띄운다', async () => {
    folder(async () => true);
    render(<FolderSettingsPanel />);
    fireEvent.click(screen.getByText(S.folder.settings.save));
    await tick();
    expect(screen.getByText(S.folder.settings.saved)).toBeTruthy();
  });

  it('성공 표시가 남아 있어도 다음 저장이 실패하면 지운다', async () => {
    let ok = true;
    folder(async () => ok);
    render(<FolderSettingsPanel />);
    fireEvent.click(screen.getByText(S.folder.settings.save));
    await tick();
    ok = false;
    fireEvent.click(screen.getByText(S.folder.settings.save));
    await tick();
    expect(screen.queryByText(S.folder.settings.saved)).toBeNull();
  });

  // W12: 개요 문서의 설정 보기를 "폴더 설정" 대화상자로 옮겼다. 모달 뒤의 개요 오류 줄은 보이지 않으므로
  // 저장 실패 사유는 대화상자 안(저장 버튼 위)에 보인다. 다른 작업이 남긴 오류는 설정 오류처럼 보이지 않게 뺀다
  it('저장 실패 사유는 폴더 설정 대화상자 안에 보인다', async () => {
    folder(async () => false);
    h.folder = {
      ...h.folder,
      error: '쓰기 실패',
      settingsOpen: true,
      setSettingsOpen: vi.fn(),
    };
    render(<FolderSettingsDialog />);
    await tick();
    const dialog = screen.getByRole('dialog', { name: S.folder.settings.title });
    // 저장하기 전에 남아 있던 오류(다른 작업의 것)는 보이지 않는다
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByText(S.folder.settings.save));
    await tick();
    expect(within(dialog).getByRole('alert').textContent).toBe('쓰기 실패');
    expect(within(dialog).queryByText(S.folder.settings.saved)).toBeNull();
  });

  it('개요 문서에는 설정 보기 대신 대화상자를 여는 버튼이 있다', async () => {
    const setSettingsOpen = vi.fn();
    h.folder = {
      id: 1,
      name: 'f',
      summaries: [],
      error: null,
      filter: 'all',
      sort: 'name',
      refreshedAt: null,
      view: 'summary',
      repos: [],
      setSettingsOpen,
    };
    render(<Dashboard />);
    await tick();
    expect(screen.queryByText(S.folder.settings.save)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.folder.settings.open }));
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });
});

describe('폐기 백업 대화상자', () => {
  it('확인을 받은 뒤 복구한다', async () => {
    const restore = vi.fn(async () => true);
    h.session = {
      fileBackups: [{ id: 3, relPath: 'a.txt', savedAt: 1, reason: 'discard' }],
      closeFileBackups: vi.fn(),
      restoreFileBackup: restore,
      busy: false,
      actionError: null,
    };
    render(<FileBackupsDialog />);
    await tick();
    fireEvent.click(screen.getByText(S.safety.fileBackupRestore));
    await tick();
    expect(restore).not.toHaveBeenCalled();
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(restore).toHaveBeenCalledWith(3);
  });
});

describe('hunk·줄 되돌리기 확인', () => {
  /** diff 하나를 연 세션 */
  function diffSession() {
    const discardHunk = vi.fn(async () => {});
    h.session = {
      selectedFile: { path: 'a.txt', staged: false, commit: null },
      diff: {
        oldPath: 'a.txt',
        newPath: 'a.txt',
        change: 'modified',
        binary: null,
        truncated: false,
        totalLines: 2,
        nonUtf8: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            section: null,
            lines: [
              { kind: 'del', text: 'old', oldNo: 1, newNo: null, noNewline: false },
              { kind: 'add', text: 'new', oldNo: null, newNo: 1, noNewline: false },
            ],
          },
        ],
      },
      diffLoading: false,
      diffError: null,
      diffMode: 'unified',
      diffOptions: { ignoreWhitespace: false, context: 3, wrap: true, tabWidth: 4 },
      submoduleLog: null,
      discardHunk,
      discardLines: vi.fn(async () => {}),
      applyHunk: vi.fn(async () => {}),
      applyLines: vi.fn(async () => {}),
      setDiffMode: vi.fn(),
      closeFile: vi.fn(),
      loadFullDiff: vi.fn(),
      setDiffOptions: vi.fn(),
      openDifftool: vi.fn(),
      loadSubmoduleLog: vi.fn(),
    };
    return { discardHunk };
  }

  it('hunk 되돌리기는 대화상자를 거친다', async () => {
    const { discardHunk } = diffSession();
    render(<DiffPane />);
    await tick();
    fireEvent.click(screen.getByText(S.diff.discardHunk));
    await tick();
    expect(discardHunk).not.toHaveBeenCalled();
    expect(document.querySelector('dialog[open] h2')?.textContent).toBe(
      S.diff.discardTitle('a.txt'),
    );
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(discardHunk).toHaveBeenCalledWith(0);
  });
});

describe('충돌 화면', () => {
  const doc = {
    eol: 'lf',
    trailingNewline: true,
    blocks: [
      { kind: 'clean', lines: ['a'] },
      { kind: 'conflict', ours: ['O'], base: ['B'], theirs: ['T'], labels: ['m', 'b', 'o'] },
    ],
  };

  /** 충돌 페이로드 */
  function payload(path: string, modified: boolean, worktree: string | null) {
    return {
      file: {
        path,
        kind: 'bothModified',
        binary: false,
        submodule: false,
        stages: ['1', '2', '3'],
      },
      doc,
      labels: { ours: 'm', base: 'b', theirs: 'o' },
      auto: [],
      worktreeModified: modified,
      worktree,
      ours: null,
      theirs: null,
    } as unknown as ConflictPayload;
  }

  /** 충돌을 연 세션 */
  function session(path: string, p: ConflictPayload, drafts: Record<string, unknown> = {}) {
    h.session = {
      conflict: { path, payload: p },
      conflictLoading: false,
      closeConflict: vi.fn(),
      saveConflict: vi.fn(async () => false),
      origins: null,
      loadConflictOrigins: vi.fn(),
      mergeTool: null,
      openMergetool: vi.fn(),
      rerere: { enabled: false, autoupdate: false, resolvedPaths: [] },
      rerereForget: vi.fn(),
      jumpToCommit: vi.fn(),
      verifyCommand: null,
      runVerify: vi.fn(),
      path: '/r',
      conflictDrafts: drafts,
      setConflictDraft: vi.fn(),
    };
  }

  /** 결과 편집기 내용 */
  const resultText = () => {
    const list = document.querySelectorAll<HTMLElement>('.cm-content');
    const last = list[list.length - 1];
    return [...(last?.querySelectorAll('.cm-line') ?? [])].map((l) => l.textContent).join('\n');
  };

  it('"이어서" 를 고르면 작업 트리 내용으로 연다', async () => {
    session('a.txt', payload('a.txt', true, 'WORKTREE\n'));
    render(<ConflictPane />);
    await tick();
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(resultText()).toBe('WORKTREE\n');
  });

  it('다른 파일로 바꾸면 "이어서" 를 다시 묻는다', async () => {
    session('a.txt', payload('a.txt', true, 'A\n'));
    const { rerender } = render(<ConflictPane />);
    await tick();
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    session('b.txt', payload('b.txt', true, 'B\n'));
    rerender(<ConflictPane />);
    await tick();
    expect(document.querySelector('dialog[open]')).toBeTruthy();
  });

  it('작업 트리 변경이 없으면 대화상자를 잠깐이라도 띄우지 않는다', async () => {
    const shown = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    session('a.txt', payload('a.txt', false, null));
    render(<ConflictPane />);
    await tick();
    expect(shown).not.toHaveBeenCalled();
    shown.mockRestore();
  });

  it('같은 충돌의 초안이 있으면 묻지 않고 복원하고, 다른 충돌의 초안은 쓰지 않는다', async () => {
    const draft = { text: 'MINE', ranges: [], key: '1:2:3' };
    session('a.txt', payload('a.txt', true, 'WT\n'), { 'a.txt': draft });
    const first = render(<ConflictPane />);
    await tick();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(resultText()).toBe('MINE');
    first.unmount();
    session('a.txt', payload('a.txt', false, null), { 'a.txt': { ...draft, key: 'other' } });
    render(<ConflictPane />);
    await tick();
    expect(resultText()).toContain('<<<<<<<');
  });
});

/** 터미널 도구 창이 보이는 슬롯 상태 */
const TERMINAL_DOCK: DockState = { tool: 'terminal', maximized: false, gitTab: 'console' };
/** 슬롯이 숨겨진 상태 (콘솔 탭을 골라 둔 채) */
const HIDDEN_DOCK: DockState = { tool: null, maximized: false, gitTab: 'console' };

describe('터미널 패널 숨기기', () => {
  afterEach(() => {
    act(() => useAppStore.setState({ terminals: [], activeTerminal: null, dock: HIDDEN_DOCK }));
  });

  it('숨겨도 터미널을 내리지 않아 PTY 가 살아 있고 초기 입력이 다시 가지 않는다', async () => {
    act(() => {
      useAppStore.setState({
        terminals: [{ id: 1, cwd: '/r', title: '', initialInput: 'verify\n' }],
        activeTerminal: 1,
        dock: TERMINAL_DOCK,
      });
    });
    const { rerender } = render(<TerminalPanel />);
    await tick();
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId('term').dataset.active).toBe('true');
    act(() => useAppStore.getState().hideDock());
    rerender(<TerminalPanel />);
    await tick();
    expect(h.unmounts).toBe(0);
    expect(screen.getByTestId('term').dataset.active).toBe('false');
    act(() => useAppStore.getState().toggleDock('terminal'));
    rerender(<TerminalPanel />);
    await tick();
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId('term').dataset.active).toBe('true');
  });

  it('아래 도구 창을 숨기거나 Git 으로 바꾸거나 최대화해도 터미널 뷰가 같은 노드로 DOM 에 남는다', async () => {
    h.session = { log: [] };
    act(() => {
      useAppStore.setState({
        terminals: [{ id: 1, cwd: '/r', title: '', initialInput: null }],
        activeTerminal: 1,
        dock: TERMINAL_DOCK,
      });
    });
    render(
      <BottomDock>
        <div>본문</div>
      </BottomDock>,
    );
    await tick();
    const term = screen.getByTestId('term');
    expect(term.dataset.active).toBe('true');
    const dock = screen.getByRole('region', { name: S.dock.label });
    const panel = term.parentElement?.parentElement as HTMLElement;
    expect(panel.style.display).toBe('');

    // Git 으로 바꾼다: 콘솔이 보이고 터미널은 display: none 으로만 숨는다
    act(() => useAppStore.getState().toggleDock('git', 'console'));
    await tick();
    expect(
      screen.getByRole('tab', { name: S.dock.tabs.console }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText(S.log.empty)).toBeTruthy();
    expect(screen.getByTestId('term')).toBe(term);
    expect(term.dataset.active).toBe('false');
    expect(panel.style.display).toBe('none');

    // 최대화 → 숨기기
    act(() => useAppStore.getState().toggleDockMaximized());
    await tick();
    expect(screen.getByRole('button', { name: S.dock.restore })).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: S.dock.hide })));
    await tick();
    expect(useAppStore.getState().dock).toEqual(HIDDEN_DOCK);
    expect(dock.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('term')).toBe(term);

    // 다시 터미널: 같은 뷰가 다시 보인다
    act(() => useAppStore.getState().toggleDock('terminal'));
    await tick();
    expect(dock.hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('term')).toBe(term);
    expect(term.dataset.active).toBe('true');
    expect(panel.style.display).toBe('');
    expect(h.mounts).toBe(1);
    expect(h.unmounts).toBe(0);
  });

  it('터미널 탭 줄에서 탭을 고르고 닫고 새로 연다', async () => {
    act(() => {
      useAppStore.setState({
        terminals: [
          { id: 1, cwd: '/work/api', title: '', initialInput: null },
          { id: 2, cwd: '/work/web', title: '검증', initialInput: null, exitCode: 0 },
        ],
        activeTerminal: 2,
        dock: TERMINAL_DOCK,
      });
    });
    render(
      <BottomDock>
        <div>본문</div>
      </BottomDock>,
    );
    await tick();
    // 탭 이름은 제목, 없으면 경로의 마지막 조각. 끝난 셸은 종료 코드를 붙인다
    const api = screen.getByRole('button', { name: 'api' });
    expect(screen.getByRole('button', { name: `검증 · ${S.terminal.exited(0)}` })).toBeTruthy();
    act(() => fireEvent.click(api));
    expect(useAppStore.getState().activeTerminal).toBe(1);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.terminal.open })));
    expect(useAppStore.getState().terminals).toHaveLength(3);
    // 탭을 모두 닫으면 도구 창이 숨는다
    for (const close of screen.getAllByRole('button', { name: S.terminal.close })) {
      act(() => fireEvent.click(close));
    }
    expect(useAppStore.getState().terminals).toEqual([]);
    expect(useAppStore.getState().dock.tool).toBeNull();
  });
});
