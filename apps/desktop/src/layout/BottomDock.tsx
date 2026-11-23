import { S } from '@mgit/ui';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';
import {
  Group,
  type Layout,
  type LayoutChangedMeta,
  Panel,
  Separator,
  useDefaultLayout,
  useGroupRef,
} from 'react-resizable-panels';
import { DOCK_ATTR } from '../actions';
import { hasModifier, rovingIndex } from '../components/roving';
import { FolderTimeline } from '../features/folder/FolderTimeline';
import { CommandLogPanel } from '../features/log/CommandLogPanel';
import { TerminalPanel, TerminalTabs } from '../features/terminal/TerminalPanel';
import { RepoGitLog } from '../features/workspace/RepoGitLog';
import { useAppStore, useFolder } from '../store';
import {
  activeTabKind,
  type DockState,
  type GitDockTab,
  gitDockTabsFor,
  shownDock,
} from '../store/app-store';
import styles from './BottomDock.module.css';
import { ToolButton } from './ToolButton';

/** 분할 크기 저장 id (앱 전역 1벌, 탭 종류 공용). localStorage 키는 `react-resizable-panels:bottom-dock` */
export const DOCK_LAYOUT_ID = 'bottom-dock';
/** 패널 id. 저장된 배치의 키이자 DOM id 이므로 바꾸면 저장값이 버려진다 */
export const BODY_PANEL = 'shell-body';
export const DOCK_PANEL = 'shell-dock';
/** 슬롯의 기본 높이 (본문 영역의 퍼센트) */
export const DEFAULT_DOCK_PERCENT = 45;

/** 세로 분할의 모양: 아래 패널이 접힘 / 둘 다 보임 / 위 패널이 접힘 */
export type DockMode = 'hidden' | 'normal' | 'maximized';

/** 슬롯 상태가 요구하는 분할 모양 */
export function dockModeOf(dock: Pick<DockState, 'tool' | 'maximized'>): DockMode {
  if (dock.tool === null) {
    return 'hidden';
  }
  return dock.maximized ? 'maximized' : 'normal';
}

/** 분할 모양에 맞는 배치(패널 id → 퍼센트). 보통일 때만 기억해 둔 슬롯 높이를 쓴다 */
export function dockLayout(mode: DockMode, dockPercent: number): Layout {
  switch (mode) {
    case 'hidden':
      return { [BODY_PANEL]: 100, [DOCK_PANEL]: 0 };
    case 'maximized':
      return { [BODY_PANEL]: 0, [DOCK_PANEL]: 100 };
    case 'normal':
      return { [BODY_PANEL]: 100 - dockPercent, [DOCK_PANEL]: dockPercent };
  }
}

/** 확정된 배치가 어느 분할 모양인지 (접힌 패널의 크기는 0 이다) */
export function dockModeOfLayout(layout: Layout): DockMode {
  if ((layout[DOCK_PANEL] ?? 0) <= 0) {
    return 'hidden';
  }
  return (layout[BODY_PANEL] ?? 0) <= 0 ? 'maximized' : 'normal';
}

/** 배치에서 보통 상태의 슬롯 높이(퍼센트)를 꺼낸다. 없거나 접힌 값이면 기본 높이 */
export function dockPercentOf(layout: Layout | undefined): number {
  const percent = layout?.[DOCK_PANEL];
  return typeof percent === 'number' && percent > 0 && percent < 100
    ? percent
    : DEFAULT_DOCK_PERCENT;
}

/** Git 도구 창 탭의 DOM id (탭 ↔ 탭 패널 연결) */
export function gitTabId(tab: GitDockTab): string {
  return `git-dock-tab-${tab}`;
}
/** Git 도구 창 탭 패널의 DOM id */
export const GIT_TAB_PANEL_ID = 'git-dock-panel';
/** 콘솔 탭 표시의 설명 글자 DOM id (탭의 설명으로 이어진다) */
const CONSOLE_BADGE_ID = 'git-dock-console-badge';

/**
 * 콘솔 탭 이름 옆 표시 (W19 ②): 폴더 탭에서 콘솔을 보지 않는 동안 실패한 명령이 쌓였으면 그 수. 콘솔을 열면 사라진다.
 * 보조 기술에는 숫자 대신 문장이 탭의 설명(`aria-describedby`)으로 읽힌다 — 탭 이름은 "콘솔" 그대로다 (W19 ③)
 */
function ConsoleFailureBadge({ unseen }: { unseen: number }) {
  return (
    <span className={styles.badge} title={S.log.unseenFailures(unseen)}>
      <span aria-hidden="true">{unseen > 99 ? '99+' : unseen}</span>
      <span id={CONSOLE_BADGE_ID} className={styles.srOnly}>
        {S.log.unseenFailures(unseen)}
      </span>
    </span>
  );
}

/**
 * Git 도구 창의 탭 줄 (W19 ③): 지금 탭 종류에서 쓸 수 있는 탭만 보인다. 탭 막대 하나가 Tab 정지 하나다 — 고른 탭만
 * Tab 으로 닿고, ←→·Home·End 로 옆 탭을 고른다(고르면 바로 보인다)
 */
function GitTabs() {
  const active = useAppStore((s) => s.dock.gitTab);
  const select = useAppStore((s) => s.setGitDockTab);
  const kind = useAppStore(activeTabKind);
  const unseen = useFolder((f) => f.commandLogUnseenFailures) ?? 0;
  const tabs = gitDockTabsFor(kind);
  /** ←→·Home·End: 옆 탭을 고르고 그 탭에 포커스를 준다 */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (hasModifier(e)) {
      return;
    }
    const next = rovingIndex(e.key, tabs.indexOf(active), tabs.length, 'horizontal');
    const tab = next === null ? undefined : tabs[next];
    if (!tab) {
      return;
    }
    e.preventDefault();
    select(tab);
    document.getElementById(gitTabId(tab))?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={S.dock.git} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const badge = tab === 'console' && kind === 'folder' && unseen > 0;
        return (
          <button
            key={tab}
            id={gitTabId(tab)}
            type="button"
            role="tab"
            aria-selected={tab === active}
            aria-controls={tab === active ? GIT_TAB_PANEL_ID : undefined}
            aria-label={badge ? S.dock.tabs[tab] : undefined}
            aria-describedby={badge ? CONSOLE_BADGE_ID : undefined}
            tabIndex={tab === active ? 0 : -1}
            className={styles.tab}
            onClick={() => select(tab)}
          >
            {S.dock.tabs[tab]}
            {badge ? <ConsoleFailureBadge unseen={unseen} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Git 도구 창의 내용: 고른 탭 하나 (탭 패널). 로그 탭은 탭 종류에 맞는 로그다 — 폴더 탭은 통합 타임라인, 저장소
 * 탭은 옛 사이드바·그래프·상세 (W21). 로그 탭은 보일 때만 마운트하므로 통합 타임라인은 로그 탭이 처음 보일 때
 * 열린다 (PF-04)
 */
function GitToolWindow() {
  const tab = useAppStore((s) => s.dock.gitTab);
  const kind = useAppStore(activeTabKind);
  return (
    <div
      className={styles.panel}
      role="tabpanel"
      id={GIT_TAB_PANEL_ID}
      aria-labelledby={gitTabId(tab)}
    >
      {tab === 'console' ? (
        <CommandLogPanel />
      ) : kind === 'folder' ? (
        <FolderTimeline />
      ) : kind === 'repo' ? (
        <RepoGitLog />
      ) : null}
    </div>
  );
}

/**
 * 슬롯에 보이는 도구 창: 머리(제목·탭·최대화·숨기기)와 내용. 터미널은 보이지 않을 때도 마운트해 두고
 * `display: none` 으로만 숨긴다 — 내리면 PTY 가 닫혀 실행 중인 명령이 죽는다 (WS-02)
 */
function DockWindow() {
  const tool = useAppStore((s) => shownDock(s).tool);
  const maximized = useAppStore((s) => shownDock(s).maximized);
  const toggleMaximized = useAppStore((s) => s.toggleDockMaximized);
  const hide = useAppStore((s) => s.hideDock);
  const terminal = tool === 'terminal';
  const sizeLabel = maximized ? S.dock.restore : S.dock.maximize;
  return (
    // 숨겨진 동안에는 높이 0 으로 접혀 있을 뿐 DOM 에 남으므로 포커스·보조 기술에서 뺀다
    <section
      className={styles.dock}
      aria-label={S.dock.label}
      inert={tool === null}
      {...{ [DOCK_ATTR]: '' }}
    >
      <header className={styles.header}>
        <span className={styles.title}>{terminal ? S.terminal.title : S.dock.git}</span>
        {terminal ? <TerminalTabs /> : <GitTabs />}
        <ToolButton
          icon={maximized ? 'restore' : 'maximize'}
          label={sizeLabel}
          onClick={toggleMaximized}
        />
        <ToolButton icon="hide" label={S.dock.hide} onClick={hide} />
      </header>
      <div className={styles.content}>
        {tool === 'git' ? <GitToolWindow /> : null}
        <TerminalPanel />
      </div>
    </section>
  );
}

/**
 * 앱 수준 아래 도구 창 슬롯 (WS-02~04): 위 = 본문(`children`), 아래 = 도구 창. 두 패널을 항상 렌더하고
 * 접기만 한다 — 숨김은 아래 패널, 최대화는 위 패널을 접는다. 분할 모양은 스토어의 슬롯 상태에서 계산해
 * 한 번에 적용하고, 사용자가 분할선을 끌어 접은 경우만 거꾸로 스토어에 반영한다.
 * 저장하는 것은 보통 상태의 높이뿐이라 숨김·최대화는 저장된 배치를 덮어쓰지 않는다.
 * 그리는 것은 화면에 그릴 상태(`shownDock`)다 — 고른 Git 탭을 지금 탭 종류에서 쓸 수 없으면 숨김으로 그린다
 */
export function BottomDock({ children }: { children: ReactNode }) {
  const tool = useAppStore((s) => shownDock(s).tool);
  const maximized = useAppStore((s) => shownDock(s).maximized);
  const hideDock = useAppStore((s) => s.hideDock);
  const setDockMaximized = useAppStore((s) => s.setDockMaximized);
  const mode = dockModeOf({ tool, maximized });
  const groupRef = useGroupRef();
  const { defaultLayout: saved, onLayoutChanged: saveLayout } = useDefaultLayout({
    id: DOCK_LAYOUT_ID,
  });
  // 보통 상태의 슬롯 높이. 숨김·최대화에서 돌아올 때 이 높이로 편다
  const dockPercent = useRef(dockPercentOf(saved));

  // 슬롯 상태가 바뀌면 배치를 맞춘다. 라이브러리가 그룹을 등록한 뒤(자식의 layout effect)이고 그리기 전이다
  useLayoutEffect(() => {
    groupRef.current?.setLayout(dockLayout(mode, dockPercent.current));
  }, [mode, groupRef]);

  /** 배치가 확정됐을 때: 보통 모양이면 높이를 기억·저장하고, 끌어서 접었으면 슬롯 상태로 옮긴다 */
  const onLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    const shape = dockModeOfLayout(layout);
    if (shape === 'normal') {
      dockPercent.current = dockPercentOf(meta.requestedLayout ?? layout);
      saveLayout(layout, meta);
    } else if (meta.isUserInteraction) {
      if (shape === 'hidden') {
        hideDock();
      } else {
        setDockMaximized(true);
      }
    }
  };

  return (
    <Group
      orientation="vertical"
      groupRef={groupRef}
      // 크기를 아직 못 잰 그룹(가려진 창 등)은 이 값으로 첫 배치를 잡으므로 현재 모양을 그대로 준다
      defaultLayout={dockLayout(mode, dockPercent.current)}
      onLayoutChanged={onLayoutChanged}
      data-dock-mode={mode}
    >
      <Panel id={BODY_PANEL} minSize="120px" collapsible>
        {/* 최대화로 접힌 동안에는 높이 0 으로 DOM 에 남으므로 Tab 순서·보조 기술에서 뺀다 (W19 ③) */}
        <div className={styles.body} inert={mode === 'maximized'}>
          {children}
        </div>
      </Panel>
      {/* 숨김·최대화에서는 끌 수 없다 (복원은 버튼·단축키로) */}
      <Separator
        className={styles.separator}
        disabled={mode !== 'normal'}
        aria-label={S.dock.resize}
      />
      <Panel
        id={DOCK_PANEL}
        defaultSize={`${DEFAULT_DOCK_PERCENT}%`}
        minSize="180px"
        collapsible
        style={{ overflow: 'hidden' }}
      >
        <DockWindow />
      </Panel>
    </Group>
  );
}
