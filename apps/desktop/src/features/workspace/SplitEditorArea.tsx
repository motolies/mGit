// 편집기 공간의 분할 (R3): 왼쪽(기본) 그룹 하나, 또는 왼쪽·오른쪽 두 그룹을 나란히 그린다. 그룹마다 탭 막대와 보는 문서가
// 따로이고(`EditorArea` 를 그룹마다 하나), 마지막으로 포커스가 들어간 그룹이 지금 그룹이다 — 파일을 열면 그 그룹에 열리고
// ⌘W·Esc·트리에서 찾기는 그 그룹의 문서를 본다. 두 그룹 사이 경계를 끌어 폭을 바꾸며 폭은 탭(워크스페이스)마다 남는다.
// 오른쪽 그룹은 파일 탭만 담는다 (diff·충돌·개요 등은 세션 슬롯·저장소마다 하나라 왼쪽에만 둔다, `workspace-store`).

import type { SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { focusTargetIn } from '../../actions';
import { registerCommand } from '../../command-registry';
import type { MenuItem } from '../../components/ContextMenu';
import { useAppStore, useWorkspace } from '../../store';
import {
  allDocs,
  type EditorDoc,
  type EditorGroupId,
  type EditorSplit,
} from '../../store/workspace-store';
import { EditorArea } from './EditorArea';
import styles from './SplitEditorArea.module.css';

/**
 * 두 그룹 패널의 id (배치 키이자 DOM id). 오른쪽 패널은 분할을 켤 때마다(탭이 바뀌어도) 뒤에 차례 번호를 붙인 새 id 를
 * 쓴다 — 라이브러리는 같은 패널 묶음의 마지막 배치를 기억해 `defaultLayout` 보다 앞세우므로, 새 id 여야 그 탭의 저장된
 * 폭(`splitRatio`)이 적용된다
 */
const MAIN_PANEL = 'editor-main';
const SIDE_PANEL = 'editor-side';

/** 패널 자체는 스크롤하지 않는다 (스크롤은 안의 문서가 맡는다) */
const PANEL_STYLE = { overflow: 'hidden' } as const;

export interface SplitEditorAreaProps {
  /** 탭 제목 */
  titleOf: (doc: EditorDoc) => string;
  detailOf?: (doc: EditorDoc) => string | undefined;
  tooltipOf?: (doc: EditorDoc) => string | undefined;
  /** 문서 종류에 맞는 화면 (두 그룹이 같이 쓴다) */
  renderDoc: (doc: EditorDoc) => ReactNode;
  /** 문서 종류별 탭 우클릭 메뉴 (분할 항목은 이 부품이 앞에 붙인다) */
  tabMenu?: (doc: EditorDoc) => MenuItem[];
  dirtyOf?: (doc: EditorDoc) => boolean;
  /** 탭이 하나도 없을 때 보일 것 (왼쪽 그룹만 빌 수 있다 — 오른쪽은 비면 사라진다) */
  empty: ReactNode;
}

/** 그룹의 보고 있는 문서 */
function activeOf(docs: readonly EditorDoc[], id: string | null): EditorDoc | undefined {
  return docs.find((doc) => doc.id === id);
}

/**
 * 그룹 하나의 틀: 포커스·포인터가 들어오면 지금 그룹이 되고(`focusGroup`), 분할 명령(팔레트)을 그 그룹에 대고 등록한다.
 * 지금 그룹이면 `data-editor-current` 를 달아 ⌘2 가 그 그룹으로 간다
 */
function GroupFrame({
  group,
  current,
  split,
  activeDoc,
  onFocus,
  commands,
  children,
}: {
  group: EditorGroupId;
  current: boolean;
  split: EditorSplit | null;
  activeDoc: EditorDoc | undefined;
  onFocus: () => void;
  commands: {
    splitRight: (id: string) => void;
    moveOpposite: (id: string) => void;
    unsplit: () => void;
    focusOther: () => void;
  };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = S.workspace.split;
  // 팔레트의 분할 명령은 이 그룹 안에서 고른 것이 대상이다 (지금 그룹의 보고 있는 문서)
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const file = activeDoc?.kind === 'file' ? activeDoc : undefined;
    const offs = [
      registerCommand('editor.splitRight', element, {
        enabled: () => group === 'main' && file !== undefined,
        reason: () => (file ? undefined : t.fileOnly),
        run: () => {
          if (file) commands.splitRight(file.id);
        },
      }),
      registerCommand('editor.moveToOppositeGroup', element, {
        enabled: () => file !== undefined,
        reason: () => (file ? undefined : t.fileOnly),
        run: () => {
          if (file) commands.moveOpposite(file.id);
        },
      }),
      registerCommand('editor.unsplit', element, {
        enabled: () => split !== null,
        reason: () => (split ? undefined : t.notSplit),
        run: commands.unsplit,
      }),
      registerCommand('editor.focusOtherGroup', element, {
        enabled: () => split !== null,
        reason: () => (split ? undefined : t.notSplit),
        run: commands.focusOther,
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [group, split, activeDoc, commands, t]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 탭 막대와 문서를 묶는 영역이다 (fieldset 은 폼 묶음이다)
    <div
      ref={ref}
      role="group"
      aria-label={group === 'main' ? t.mainGroup : t.sideGroup}
      className={styles.frame}
      data-editor-group={group}
      data-editor-current={current ? 'true' : undefined}
      data-split={split ? 'true' : undefined}
      onFocusCapture={onFocus}
      onPointerDownCapture={onFocus}
    >
      {children}
    </div>
  );
}

/**
 * 편집기 공간 (ED-01·02, R3): 분할하지 않았으면 그룹 하나, 분할했으면 두 그룹을 경계로 나눠 그린다. 탭의 활성화·닫기·
 * 고정과 분할·옮기기는 활성 탭의 워크스페이스 스토어에 맡긴다. 탭 우클릭 메뉴 앞에 분할 항목을 붙인다 — 왼쪽 그룹의 파일 탭은
 * **오른쪽으로 분할**·**오른쪽 그룹으로 옮기기**, 오른쪽 그룹은 **왼쪽 그룹으로 옮기기**, 분할 중이면 **분할 해제**.
 * 패널 묶음과 왼쪽 패널은 분할과 상관없이 늘 같은 자리에 그리고 경계·오른쪽 패널만 더하고 뺀다 — 트리 모양이 바뀌면
 * 왼쪽 그룹의 문서가 다시 마운트되어 그 안의 상태(개요에서 연 대화상자, 편집기 뷰 등)가 사라진다. 분할을 풀면 왼쪽이
 * 전체 폭이고, 다시 분할하면 그 탭의 저장된 폭(`splitRatio`)으로 나눈다
 */
export function SplitEditorArea({
  titleOf,
  detailOf,
  tooltipOf,
  renderDoc,
  tabMenu,
  dirtyOf,
  empty,
}: SplitEditorAreaProps) {
  const ws = useWorkspace((w) => ({
    docs: w.docs,
    sessionDocs: w.sessionDocs,
    activeDocId: w.activeDocId,
    split: w.split,
    focusedGroup: w.focusedGroup,
    splitRatio: w.splitRatio,
    activateDoc: w.activateDoc,
    closeDoc: w.closeDoc,
    closeDocs: w.closeDocs,
    pinDoc: w.pinDoc,
    activateSideDoc: w.activateSideDoc,
    closeSideDoc: w.closeSideDoc,
    closeSideDocs: w.closeSideDocs,
    focusGroup: w.focusGroup,
    splitDoc: w.splitDoc,
    moveDoc: w.moveDoc,
    unsplit: w.unsplit,
    setSplitRatio: w.setSplitRatio,
  }));
  const storedDocs = ws?.docs;
  const sessionDocs = ws?.sessionDocs;
  const mainDocs = useMemo(
    () => allDocs({ docs: storedDocs ?? [], sessionDocs: sessionDocs ?? [] }),
    [storedDocs, sessionDocs],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const splitDoc = ws?.splitDoc;
  const moveDoc = ws?.moveDoc;
  const unsplit = ws?.unsplit;
  const focusGroup = ws?.focusGroup;
  const focusedGroup = ws?.focusedGroup ?? 'main';
  /** 그룹마다의 분할 명령 (팔레트·탭 메뉴가 같이 쓴다) */
  const commandsFor = useMemo(() => {
    /** 다른 쪽 그룹에 포커스를 준다 (그 그룹의 본문·탭 순서로 찾는다) */
    const focusOther = (from: EditorGroupId) => {
      const other: EditorGroupId = from === 'main' ? 'side' : 'main';
      const element = rootRef.current?.querySelector<HTMLElement>(`[data-editor-group="${other}"]`);
      if (!element) return;
      focusGroup?.(other);
      focusTargetIn(element).focus();
    };
    const make = (group: EditorGroupId) => ({
      splitRight: (id: string) => splitDoc?.(id, group),
      moveOpposite: (id: string) => moveDoc?.(id, group),
      unsplit: () => unsplit?.(),
      focusOther: () => focusOther(group),
    });
    return { main: make('main'), side: make('side') };
  }, [splitDoc, moveDoc, unsplit, focusGroup]);
  // 오른쪽 패널 id 의 차례 번호: 분할이 켜질 때와 분할한 채 탭이 바뀔 때 올린다 (렌더 중에 맞춘다 — 경계·오른쪽 패널이
  // 처음 그려지는 렌더부터 새 id 와 그 탭의 폭이 함께 간다)
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const splitOwner: SessionId | null = ws?.split ? activeSessionId : null;
  const [sideSeq, setSideSeq] = useState(0);
  const [sideSeqFor, setSideSeqFor] = useState<SessionId | null>(splitOwner);
  if (sideSeqFor !== splitOwner) {
    setSideSeqFor(splitOwner);
    if (splitOwner !== null) setSideSeq((seq) => seq + 1);
  }

  if (!ws) {
    return null;
  }
  const t = S.workspace.split;
  const split = ws.split;

  /** 그룹의 탭 메뉴: 분할 항목(파일 탭만) 뒤에 문서 종류별 항목 */
  const menuFor = (group: EditorGroupId) => (doc: EditorDoc) => {
    const items: MenuItem[] = [];
    if (doc.kind === 'file') {
      if (group === 'main') {
        items.push(
          { label: t.right, onSelect: () => ws.splitDoc(doc.id, 'main') },
          { label: t.moveRight, onSelect: () => ws.moveDoc(doc.id, 'main') },
        );
      } else {
        items.push({ label: t.moveLeft, onSelect: () => ws.moveDoc(doc.id, 'side') });
      }
    }
    if (split) items.push({ label: t.unsplit, onSelect: ws.unsplit });
    const rest = tabMenu?.(doc) ?? [];
    return [
      ...items,
      ...rest.map((item, index) =>
        index === 0 && items.length > 0 ? { ...item, separator: true } : item,
      ),
    ];
  };

  const main = (
    <GroupFrame
      group="main"
      current={split !== null && focusedGroup === 'main'}
      split={split}
      activeDoc={activeOf(mainDocs, ws.activeDocId)}
      onFocus={() => ws.focusGroup('main')}
      commands={commandsFor.main}
    >
      <EditorArea
        docs={mainDocs}
        activeId={ws.activeDocId}
        titleOf={titleOf}
        detailOf={detailOf}
        tooltipOf={tooltipOf}
        renderDoc={renderDoc}
        onActivate={ws.activateDoc}
        onClose={ws.closeDoc}
        onCloseMany={ws.closeDocs}
        onPin={ws.pinDoc}
        tabMenu={menuFor('main')}
        dirtyOf={dirtyOf}
        empty={empty}
      />
    </GroupFrame>
  );
  // 패널 묶음과 왼쪽 패널은 늘 그린다 (왼쪽 그룹이 다시 마운트되지 않게). 처음 배치는 분할 중이면 그 탭의 폭, 아니면 왼쪽
  // 전체 — 라이브러리는 패널 묶음이 바뀔 때 이 값을 읽는다
  const sidePanel = `${SIDE_PANEL}-${sideSeq}`;
  const layout = split
    ? { [MAIN_PANEL]: ws.splitRatio, [sidePanel]: 100 - ws.splitRatio }
    : { [MAIN_PANEL]: 100 };
  return (
    <div ref={rootRef} className={styles.root}>
      <Group
        orientation="horizontal"
        className={styles.group}
        defaultLayout={layout}
        onLayoutChanged={(next, meta) => {
          const ratio = next[MAIN_PANEL];
          if (split && meta.isUserInteraction && typeof ratio === 'number') ws.setSplitRatio(ratio);
        }}
      >
        <Panel id={MAIN_PANEL} minSize="200px" style={PANEL_STYLE}>
          {main}
        </Panel>
        {split ? (
          <>
            <Separator className={styles.separator} aria-label={t.resize} />
            <Panel id={sidePanel} minSize="200px" style={PANEL_STYLE}>
              <GroupFrame
                group="side"
                current={focusedGroup === 'side'}
                split={split}
                activeDoc={activeOf(split.docs, split.activeDocId)}
                onFocus={() => ws.focusGroup('side')}
                commands={commandsFor.side}
              >
                <EditorArea
                  docs={split.docs}
                  activeId={split.activeDocId}
                  titleOf={titleOf}
                  detailOf={detailOf}
                  tooltipOf={tooltipOf}
                  renderDoc={renderDoc}
                  onActivate={ws.activateSideDoc}
                  onClose={ws.closeSideDoc}
                  onCloseMany={ws.closeSideDocs}
                  onPin={ws.pinDoc}
                  tabMenu={menuFor('side')}
                  dirtyOf={dirtyOf}
                  empty={null}
                />
              </GroupFrame>
            </Panel>
          </>
        ) : null}
      </Group>
    </div>
  );
}
