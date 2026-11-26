import type { PullMode, SessionId } from '@mgit/ipc';
import { Button, Icon, S } from '@mgit/ui';
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenuArea } from '../components/ContextMenu';
import { type DropdownItem, DropdownMenu } from '../components/DropdownMenu';
import { hasModifier, rovingIndex } from '../components/roving';
import { useCommandTitle } from '../components/use-command-shortcut';
import { useBatchReport } from '../features/folder/batch-report';
import { useFolderBatchFlows } from '../features/folder/FolderBatchBar';
import { RemotesDialog } from '../features/remote/RemotesDialog';
import { useActiveTab, useAppStore, useFolder, useIsRepoTab, useSession } from '../store';
import { type SessionCloseMode, sessionCloseTargets } from '../store/session-close';
import type { ThemePreference } from '../store/theme';
import styles from './Toolbar.module.css';

/** 테마 선택지. 문구는 지금 언어의 사전에서 그릴 때마다 읽는다 */
function themeOptions(): { value: ThemePreference; label: string }[] {
  return [
    { value: 'system', label: S.toolbar.theme.system },
    { value: 'light', label: S.toolbar.theme.light },
    { value: 'dark', label: S.toolbar.theme.dark },
  ];
}

const PULL_MODES: PullMode[] = ['default', 'merge', 'rebase', 'ffOnly'];

/** 진행 중인 장시간 명령 표시 + 진행률 + 취소 버튼 (RM-05) */
function OperationIndicator() {
  // 스토어 객체 참조를 그대로 돌려줘야 useShallow 가 안정된다 (새 객체를 만들면 무한 렌더)
  const ops = useSession((s) =>
    s.operationOrder.flatMap((id) => {
      const op = s.operations[id];
      return op && !op.done ? [op] : [];
    }),
  );
  const cancel = useSession((s) => s.cancelOperation);
  if (ops.length === 0) {
    return null;
  }
  return (
    <span className={styles.operations}>
      {ops.map((op) => (
        <span key={op.id} className={styles.operation} title={op.message}>
          {S.operation.running(op.label)}
          {op.percent !== null ? (
            <progress className={styles.progress} max={100} value={op.percent} />
          ) : null}
          {op.percent !== null ? ` ${S.operation.percent(op.percent)}` : ''}
          <button
            type="button"
            className={styles.tabClose}
            onClick={() => void cancel(op.id)}
            aria-label={S.toolbar.cancel}
            title={S.toolbar.cancel}
          >
            ×
          </button>
        </span>
      ))}
    </span>
  );
}

/** Undo/Redo 버튼 (SF-03). 직전 작업 이름을 보여 준다 */
function UndoButtons() {
  const s = useSession((st) => ({
    entries: st.undoState.entries,
    redoCount: st.undoState.redoCount,
    busy: st.busy,
    undo: st.undo,
    redo: st.redo,
  }));
  const top = s.entries[0];
  return (
    <span className={styles.sync}>
      <Button
        disabled={s.busy || !top}
        onClick={() => void s.undo()}
        title={top ? S.safety.undoOf(top.label) : S.safety.nothingToUndo}
      >
        ↶ {S.safety.undo}
      </Button>
      <Button
        disabled={s.busy || s.redoCount === 0}
        onClick={() => void s.redo()}
        title={S.safety.redo}
      >
        ↷
      </Button>
    </span>
  );
}

/** 진행 중인 clone (앱 수준 작업) */
function CloneIndicator() {
  const op = useAppStore((s) => s.cloneOp);
  const cancel = useAppStore((s) => s.cancelClone);
  if (!op || op.done) {
    return null;
  }
  return (
    <span className={styles.operations}>
      <span className={styles.operation} title={op.message}>
        {S.operation.running(op.label)}
        {op.percent !== null ? (
          <progress className={styles.progress} max={100} value={op.percent} />
        ) : null}
        <button
          type="button"
          className={styles.tabClose}
          onClick={() => void cancel()}
          aria-label={S.toolbar.cancel}
          title={S.toolbar.cancel}
        >
          ×
        </button>
      </span>
    </span>
  );
}

/** Fetch·Pull·Push 버튼 + 현재 branch 의 ahead/behind 배지 (RM-02~04·06) */
function SyncButtons({ onRemotes }: { onRemotes: () => void }) {
  const s = useSession((st) => ({
    current: st.refs.labels.find((l) => l.isCurrent) ?? null,
    hasRemotes: st.refs.remotes.length > 0,
    // 배열 참조를 그대로 선택한다 (map 은 아래에서 — 선택자가 새 배열을 만들면 무한 렌더)
    remotes: st.refs.remotes,
    busy: st.busy,
    op: st.op,
    pullMode: st.pullMode,
    setPullMode: st.setPullMode,
    fetch: st.fetch,
    pull: st.pull,
    push: st.push,
  }));
  const fetchTitle = useCommandTitle('sync.fetch', S.remote.fetch, 'mod+shift+f');
  const pullTitle = useCommandTitle('sync.pull', S.remote.pullMode[s.pullMode]);
  const pushTitle = useCommandTitle('sync.push', S.remote.push);
  const disabled = s.busy || s.op !== null;
  const cur = s.current;
  const badge = cur
    ? cur.upstreamGone
      ? S.sidebar.gone
      : cur.upstream
        ? `${S.status.ahead(cur.ahead ?? 0)} ${S.status.behind(cur.behind ?? 0)}`
        : S.sidebar.noUpstream
    : '';
  // push 대상 (RM-04): 기본은 업스트림, ⌄ 메뉴에서 원격을 고를 수 있다
  const upstreamShort = cur?.upstream ? cur.upstream.replace(/^refs\/remotes\//, '') : null;
  const pushLabel = upstreamShort
    ? S.remote.pushUpstream(upstreamShort)
    : S.remote.pushNoUpstream(s.remotes.length === 1 ? (s.remotes[0]?.name ?? '') : 'origin');
  const pushDisabled = disabled || !cur || !s.hasRemotes;
  const pushItems: DropdownItem[] = [
    { kind: 'item', label: pushLabel, onSelect: () => void s.push(), disabled: pushDisabled },
    { kind: 'separator' },
    ...s.remotes.map(
      (r): DropdownItem => ({
        kind: 'item',
        label: S.remote.pushTo(r.name),
        onSelect: () => void s.push({ remote: r.name }),
        disabled: pushDisabled,
      }),
    ),
  ];
  return (
    <span className={styles.sync}>
      <Button
        title={fetchTitle}
        disabled={disabled || !s.hasRemotes}
        onClick={() => void s.fetch(null, true)}
      >
        {S.remote.fetch}
      </Button>
      <span className={styles.split}>
        <Button
          disabled={disabled || !cur?.upstream || cur.upstreamGone}
          onClick={() => void s.pull()}
          title={pullTitle}
        >
          {S.remote.pull}
        </Button>
        <select
          className={styles.select}
          value={s.pullMode}
          onChange={(e) => s.setPullMode(e.target.value as PullMode)}
          aria-label={S.remote.pull}
        >
          {PULL_MODES.map((m) => (
            <option key={m} value={m}>
              {S.remote.pullMode[m]}
            </option>
          ))}
        </select>
      </span>
      <span className={styles.split}>
        <Button
          disabled={pushDisabled}
          onClick={() => void s.push()}
          title={`${pushLabel} · ${pushTitle}`}
        >
          {S.remote.push}
        </Button>
        <DropdownMenu
          trigger={
            <button
              type="button"
              className={styles.caret}
              disabled={pushDisabled}
              aria-label={S.remote.pushMenu}
              title={S.remote.pushMenu}
            >
              ⌄
            </button>
          }
          items={pushItems}
        />
      </span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
      <Button onClick={onRemotes} disabled={s.busy}>
        {S.remote.remotes}
      </Button>
    </span>
  );
}

/**
 * 폴더 탭의 Fetch·Pull·Push (WS-09, 결정 10번): 저장소 탭의 버튼과 같은 자리·모양이다. 대상은 프로젝트 트리에서
 * 고른 저장소, 없으면 전체 — 툴팁과 접근성 이름에 대상 수를 쓴다. Fetch 는 바로, Pull 은 폴더 설정의 방식(기본
 * ff-only)과 코어의 건너뛰기 규칙 그대로, Push 는 항상 대상 확인창을 거친다. 일괄 작업이 도는 동안 진행을 보이고
 * 버튼을 막는다. 결과는 토스트로 알린다 (개요 탭을 열지 않아도 보인다)
 */
function FolderSyncButtons() {
  const f = useFolder((st) => ({
    progress: st.batchProgress,
    pullMode: st.settings?.pullMode ?? 'ffOnly',
  }));
  const flows = useFolderBatchFlows(useBatchReport());
  if (!f) {
    return null;
  }
  const t = S.folder.batch;
  const label = (op: string) => t.withScope(op, flows.scope);
  return (
    <span className={styles.sync}>
      <Button
        disabled={flows.running}
        onClick={() => void flows.fetch()}
        aria-label={label(S.remote.fetch)}
        title={label(S.remote.fetch)}
      >
        {S.remote.fetch}
      </Button>
      <Button
        disabled={flows.running}
        onClick={() => void flows.pull()}
        aria-label={label(S.remote.pull)}
        title={`${label(S.remote.pull)}\n${t.pullTip(S.folder.settings[f.pullMode])}`}
      >
        {S.remote.pull}
      </Button>
      <Button
        disabled={flows.running}
        onClick={() => void flows.push()}
        aria-label={label(S.remote.push)}
        title={label(S.remote.push)}
      >
        {S.remote.push}
      </Button>
      {f.progress ? (
        <span className={styles.operation} role="status">
          {S.operation.running(t.running(f.progress.label, f.progress.phase))}
          {f.progress.percent !== null ? (
            <progress className={styles.progress} max={100} value={f.progress.percent} />
          ) : null}
        </span>
      ) : null}
      {flows.dialogs.element}
    </span>
  );
}

/**
 * 상단 툴바: 저장소 열기·닫기, 열린 저장소 탭, 동기화, 새로고침, Git 콘솔(⌘J), 테마 선택. 세션 버튼(동기화·undo·진행
 * 중인 명령·원격 관리)은 저장소 탭일 때만 보인다 — 폴더 탭의 숨은 세션에 대고 동작하지 않는다 (W13)
 */
export function Toolbar() {
  const isOpening = useAppStore((s) => s.isOpening);
  const theme = useAppStore((s) => s.theme);
  const sessionOrder = useAppStore((s) => s.sessionOrder);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openRepository = useAppStore((s) => s.showHome);
  const closeSession = useAppStore((s) => s.requestCloseSession);
  const closeTabs = useAppStore((s) => s.requestCloseTabs);
  const closing = useAppStore((s) => s.closeTabsRunning);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setTheme = useAppStore((s) => s.setTheme);
  const lastError = useAppStore((s) => s.lastError);
  const clearError = useAppStore((s) => s.clearError);
  const consoleOpen = useAppStore((s) => s.dock.tool === 'git' && s.dock.gitTab === 'console');
  const toggleDock = useAppStore((s) => s.toggleDock);
  const refreshActive = useAppStore((s) => s.refreshActive);
  const repoTab = useIsRepoTab();
  const folderTab = useActiveTab()?.kind === 'folder';
  const [showRemotes, setShowRemotes] = useState(false);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settingsTitle = useCommandTitle('app.settings', S.actions.settings);
  const refreshTitle = useCommandTitle('view.refresh', S.toolbar.refresh, 'mod+r');
  const logTitle = useCommandTitle('view.log', S.toolbar.log, 'mod+j');
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabPrefix = useId();
  const homeVisible = useAppStore((s) => s.homeVisible);
  const previousHome = useRef(homeVisible);
  const previousActive = useRef(activeSessionId);
  const previousTabCount = useRef(sessionOrder.length);
  // 전역 닫기 명령으로 세션 본문까지 사라졌다면 남은 활성 탭 또는 빈 탭 영역으로 돌아간다.
  useLayoutEffect(() => {
    const closed =
      (previousActive.current !== null && !sessionOrder.includes(previousActive.current)) ||
      sessionOrder.length < previousTabCount.current;
    const returned = previousHome.current && !homeVisible;
    previousHome.current = homeVisible;
    previousActive.current = activeSessionId;
    previousTabCount.current = sessionOrder.length;
    if ((closed || returned) && document.activeElement === document.body) {
      const target =
        activeSessionId === null
          ? null
          : document.getElementById(`${tabPrefix}-${activeSessionId}`);
      (target ?? tabsRef.current)?.focus();
    }
  }, [sessionOrder, activeSessionId, tabPrefix, homeVisible]);

  /** 탭 닫기 완료 뒤 포커스가 사라졌으면 다음·이전 탭, 빈 목록 순서로 복귀한다 */
  const closeTab = async (id: SessionId) => {
    const tabs = sessionOrder.filter((key) => sessions[key]);
    const index = tabs.indexOf(id);
    const origin = document.activeElement;
    await closeSession(id);
    if (origin instanceof HTMLElement && origin.isConnected) return;
    const live = tabsRef.current;
    if (!live) return;
    const next = tabs.slice(index + 1).concat(tabs.slice(0, index).reverse());
    const target = next
      .map((key) => document.getElementById(`${tabPrefix}-${key}`))
      .find((el) => el?.isConnected);
    (target ?? live).focus();
  };

  /** 저장소·폴더 탭도 Tab 진입점 하나와 방향키·Home/End 선택을 제공한다 */
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: SessionId) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom,
        }),
      );
      return;
    }
    if (hasModifier(e)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void closeTab(id);
      return;
    }
    const index = rovingIndex(e.key, sessionOrder.indexOf(id), sessionOrder.length, 'horizontal');
    const next = index === null ? undefined : sessionOrder[index];
    if (!next) return;
    e.preventDefault();
    setActiveSession(next);
    document.getElementById(`${tabPrefix}-${next}`)?.focus();
  };

  return (
    <header className={styles.toolbar}>
      <span className={styles.brand}>{S.app.title}</span>
      <Button variant="primary" onClick={() => void openRepository()} disabled={isOpening}>
        {isOpening ? S.toolbar.opening : S.toolbar.openRepo}
      </Button>
      <Button
        onClick={() => void refreshActive()}
        disabled={!repoTab && !folderTab}
        title={refreshTitle}
      >
        {S.toolbar.refresh}
      </Button>
      {repoTab ? <SyncButtons onRemotes={() => setShowRemotes(true)} /> : null}
      {folderTab ? <FolderSyncButtons /> : null}
      {repoTab ? <UndoButtons /> : null}

      <ContextMenuArea
        className={styles.tabContext}
        resolveTarget={(event) => {
          const element = (event.target as HTMLElement).closest<HTMLElement>('[data-session-tab]');
          const id = Number(element?.dataset.sessionTab);
          return element && sessions[id] ? id : null;
        }}
        items={(id) =>
          (
            [
              ['this', S.toolbar.closeThisTab],
              ['others', S.toolbar.closeOtherTabs],
              ['all', S.toolbar.closeAllTabs],
            ] as const
          ).map(([mode, label]) => ({
            label,
            disabled: closing || sessionCloseTargets(sessionOrder, sessions, id, mode).length === 0,
            onSelect: () => void closeTabs(id, mode as SessionCloseMode),
          }))
        }
      >
        <div
          ref={tabsRef}
          className={styles.tabs}
          role="tablist"
          tabIndex={sessionOrder.length === 0 ? 0 : -1}
          aria-label={S.toolbar.tabsLabel}
        >
          {sessionOrder.map((id) => {
            const meta = sessions[id];
            if (!meta) {
              return null;
            }
            const active = id === activeSessionId;
            return (
              <div
                key={id}
                data-session-tab={id}
                className={active ? styles.tabActive : styles.tab}
              >
                <button
                  type="button"
                  className={styles.tabLabel}
                  id={`${tabPrefix}-${id}`}
                  role="tab"
                  aria-selected={active}
                  tabIndex={active || (activeSessionId === null && sessionOrder[0] === id) ? 0 : -1}
                  onKeyDown={(e) => onTabKeyDown(e, id)}
                  onClick={() => setActiveSession(id)}
                  title={`${meta.kind === 'folder' ? S.home.folder : S.home.repo}: ${meta.path}`}
                  aria-description={meta.kind === 'folder' ? S.home.folder : S.home.repo}
                >
                  {meta.kind === 'folder' ? <Icon name="folder" /> : null}
                  <span>{meta.parent !== null ? `└ ${meta.name}` : meta.name}</span>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  disabled={closing}
                  tabIndex={-1}
                  onClick={() => void closeTab(id)}
                  aria-label={S.toolbar.closeRepo}
                  title={S.toolbar.closeRepo}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </ContextMenuArea>

      <CloneIndicator />
      {repoTab ? <OperationIndicator /> : null}

      {lastError ? (
        // 오류는 나타날 때 바로 읽힌다 (W19 ③ — 감싼 칸이 알리고 단추의 뜻은 그대로다)
        <span role="alert" className={styles.errorSlot}>
          <button type="button" className={styles.error} onClick={clearError} title={lastError}>
            {lastError}
          </button>
        </span>
      ) : null}

      <Button
        onClick={() => toggleDock('git', 'console')}
        aria-pressed={consoleOpen}
        title={logTitle}
      >
        {S.toolbar.log}
      </Button>

      <Button onClick={() => setSettingsOpen(true)} title={settingsTitle}>
        {S.actions.settings}
      </Button>
      <label className={styles.theme}>
        <span className={styles.themeLabel}>{S.toolbar.theme.label}</span>
        <select
          className={styles.select}
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemePreference)}
        >
          {themeOptions().map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {showRemotes && repoTab ? <RemotesDialog onClose={() => setShowRemotes(false)} /> : null}
    </header>
  );
}
