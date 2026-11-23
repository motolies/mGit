import type { StatusEntry } from '@mgit/ipc';
import { Button, ConfirmDialog, S } from '@mgit/ui';
import { type MouseEvent, useCallback, useMemo, useState } from 'react';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { entryInArea, useAppStore, useSession } from '../../store';
import { groupByModule } from '../modules/module-groups';
import styles from './ChangesPanel.module.css';
import { CommitForm } from './CommitForm';
import { FileList } from './FileList';

type Area = 'conflict' | 'staged' | 'unstaged';

/** 영역별 다중 선택 상태를 관리한다 (클릭·Cmd·Shift) */
function useAreaSelection(order: readonly string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const onSelect = useCallback(
    (path: string, e: MouseEvent) => {
      setSelected((prev) => {
        if (e.shiftKey && anchor) {
          const a = order.indexOf(anchor);
          const b = order.indexOf(path);
          if (a >= 0 && b >= 0) {
            const [from, to] = a <= b ? [a, b] : [b, a];
            return new Set([...prev, ...order.slice(from, to + 1)]);
          }
        }
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        }
        return new Set([path]);
      });
      if (!e.shiftKey) {
        setAnchor(path);
      }
    },
    [order, anchor],
  );
  // 목록에서 사라진 경로는 선택에서 뺀다
  const live = useMemo(
    () => new Set([...selected].filter((p) => order.includes(p))),
    [selected, order],
  );
  return { selected: live, onSelect, clear: () => setSelected(new Set()) };
}

/** ignore 하위 메뉴 (CHG-10): 파일·확장자·폴더 패턴 */
function ignoreMenu(path: string, add: (patterns: string[]) => Promise<void>): MenuItem {
  const slash = path.lastIndexOf('/');
  const dir = slash > 0 ? path.slice(0, slash) : null;
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : null;
  const children: MenuItem[] = [
    { label: S.safety.ignoreFile(path), onSelect: () => void add([path]) },
  ];
  if (ext) {
    children.push({ label: S.safety.ignoreExt(ext), onSelect: () => void add([`*.${ext}`]) });
  }
  if (dir) {
    children.push({ label: S.safety.ignoreDir(dir), onSelect: () => void add([`${dir}/`]) });
  }
  return { label: S.safety.ignore, separator: true, children };
}

/** 영역 하나 (제목·버튼·목록) */
function Section({
  area,
  entries,
  view,
}: {
  area: Area;
  entries: StatusEntry[];
  view: 'tree' | 'flat' | 'module';
}) {
  const s = useSession((st) => ({
    modules: st.modules,
    openPath: st.selectedFile?.path ?? null,
    openBlame: st.openBlame,
    openFileHistory: st.openFileHistory,
    openDifftool: st.openDifftool,
    openStaged: st.selectedFile?.staged ?? false,
    openFile: st.openFile,
    openConflict: st.openConflict,
    conflictPath: st.conflict?.path ?? null,
    unresolve: st.unresolve,
    op: st.op,
    repoPath: st.path,
    ignoreAdd: st.ignoreAdd,
    stage: st.stage,
    unstage: st.unstage,
    stageAll: st.stageAll,
    unstageAll: st.unstageAll,
    discard: st.discard,
    renameCount: st.renameConflicts.length,
    openAssist: st.openAssistDialog,
    applyRules: st.applyRules,
    rerere: st.rerere,
    rerereSet: st.rerereSet,
    openReview: st.openReview,
  }));
  const openExternal = useAppStore((st) => st.openExternal);
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const { selected, onSelect, clear } = useAreaSelection(order);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const staged = area === 'staged';
  const picked = [...selected];
  const title =
    area === 'conflict'
      ? S.changes.conflicts(entries.length)
      : staged
        ? S.changes.staged(entries.length)
        : S.changes.unstaged(entries.length);

  /** 열기·열린 파일 (모듈 그룹마다 같은 FileList 를 쓴다) */
  const onOpen = (path: string) =>
    area === 'conflict' ? void s.openConflict(path) : void s.openFile(path, staged);
  const openPath =
    area === 'conflict' ? s.conflictPath : s.openStaged === staged ? s.openPath : null;
  const moduleGroups = view === 'module' ? groupByModule(entries, s.modules) : [];
  return (
    <section className={styles.section} data-area={area}>
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        <span className={styles.actions}>
          {area === 'unstaged' ? (
            <>
              <Button
                disabled={picked.length === 0}
                onClick={() => void s.stage(picked).then(clear)}
              >
                {S.changes.stageSelected}
              </Button>
              <Button disabled={picked.length === 0} onClick={() => setConfirmDiscard(true)}>
                {S.changes.discardSelected}
              </Button>
              <Button disabled={entries.length === 0} onClick={() => void s.stageAll()}>
                {S.changes.stageAll}
              </Button>
            </>
          ) : null}
          {area === 'staged' ? (
            <>
              <Button
                disabled={picked.length === 0}
                onClick={() => void s.unstage(picked).then(clear)}
              >
                {S.changes.unstageSelected}
              </Button>
              <Button disabled={entries.length === 0} onClick={() => void s.unstageAll()}>
                {S.changes.unstageAll}
              </Button>
            </>
          ) : null}
          {area === 'conflict' ? (
            <>
              {s.renameCount > 0 ? (
                <Button onClick={() => s.openAssist('rename')}>
                  {S.assist.renameButton(s.renameCount)}
                </Button>
              ) : null}
              <Button onClick={() => s.openAssist('rules')}>{S.assist.rulesButton}</Button>
              <Button onClick={() => void s.applyRules()}>{S.assist.applyRules}</Button>
              <Button
                title={S.assist.rerereHint}
                onClick={() => void s.rerereSet(!s.rerere.enabled, s.rerere.autoupdate)}
              >
                {s.rerere.enabled ? S.assist.rerereOn : S.assist.rerereOff}
              </Button>
              <Button
                disabled={picked.length === 0}
                onClick={() => void s.stage(picked).then(clear)}
              >
                {S.changes.stageSelected}
              </Button>
            </>
          ) : null}
        </span>
      </header>
      <ContextMenuArea<string>
        resolveTarget={(e) =>
          (e.target as HTMLElement | null)?.closest('[data-path]')?.getAttribute('data-path') ??
          null
        }
        items={(path) => [
          {
            label: S.actions.openEditor,
            onSelect: () => void openExternal('editor', `${s.repoPath}/${path}`),
          },
          {
            label: S.actions.reveal,
            onSelect: () => void openExternal('reveal', `${s.repoPath}/${path}`),
          },
          ...(area === 'conflict'
            ? []
            : [
                {
                  label: S.menu.blame,
                  separator: true,
                  onSelect: () => void s.openBlame(path, null),
                },
                { label: S.menu.fileHistory, onSelect: () => void s.openFileHistory(path) },
                {
                  label: S.menu.difftool,
                  onSelect: () => void s.openDifftool({ kind: 'workTree', path, staged }),
                },
              ]),
          ...(area === 'unstaged' ? [ignoreMenu(path, s.ignoreAdd)] : []),
          ...(area === 'staged' && s.op
            ? [
                {
                  label: S.conflict.unresolveRemake,
                  separator: true,
                  onSelect: () => void s.unresolve(path, 'remake'),
                },
                {
                  label: S.conflict.unresolveKeep,
                  onSelect: () => void s.unresolve(path, 'keepWorktree'),
                },
                { label: S.assist.reviewMenu, onSelect: () => void s.openReview(path) },
              ]
            : []),
        ]}
      >
        {view === 'module' ? (
          moduleGroups.map((g) => (
            <div key={g.path ?? '(root)'}>
              <div className={styles.moduleGroup}>{g.label}</div>
              <FileList
                entries={g.entries}
                staged={staged}
                view="flat"
                selected={selected}
                onSelect={onSelect}
                onOpen={onOpen}
                openPath={openPath}
              />
            </div>
          ))
        ) : (
          <FileList
            entries={entries}
            staged={staged}
            view={view}
            selected={selected}
            onSelect={onSelect}
            onOpen={onOpen}
            openPath={openPath}
          />
        )}
      </ContextMenuArea>
      <ConfirmDialog
        open={confirmDiscard}
        title={S.changes.discardTitle}
        message={S.changes.discardMessage(picked.length)}
        items={picked}
        confirmLabel={S.changes.discardConfirm}
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          void s.discard(picked).then(clear);
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </section>
  );
}

/** 우측 패널: 충돌·Staged·Unstaged 목록과 커밋 입력란 (CHG-01~06) */
export function ChangesPanel() {
  const entries = useSession((st) => st.status.entries);
  const openFileBackups = useSession((st) => st.openFileBackups);
  const [view, setView] = useState<'tree' | 'flat' | 'module'>('tree');

  const groups = useMemo(() => {
    const conflict: StatusEntry[] = [];
    const staged: StatusEntry[] = [];
    const unstaged: StatusEntry[] = [];
    for (const e of entries) {
      if (e.conflict) {
        conflict.push(e);
        continue;
      }
      if (entryInArea(e, true)) {
        staged.push(e);
      }
      if (entryInArea(e, false)) {
        unstaged.push(e);
      }
    }
    return { conflict, staged, unstaged };
  }, [entries]);

  return (
    <aside className={styles.panel}>
      <header className={styles.panelHeader}>
        <span className={styles.panelTitle}>{S.changes.title}</span>
        <button
          type="button"
          className={styles.view}
          onClick={() => void openFileBackups()}
          title={S.safety.fileBackupsHint}
        >
          {S.safety.fileBackups}
        </button>
        <span className={styles.viewToggle}>
          <button
            type="button"
            className={view === 'tree' ? styles.viewActive : styles.view}
            onClick={() => setView('tree')}
          >
            {S.changes.tree}
          </button>
          <button
            type="button"
            className={view === 'flat' ? styles.viewActive : styles.view}
            onClick={() => setView('flat')}
          >
            {S.changes.flat}
          </button>
          <button
            type="button"
            className={view === 'module' ? styles.viewActive : styles.view}
            onClick={() => setView('module')}
          >
            {S.changes.byModule}
          </button>
        </span>
      </header>
      <div className={styles.lists}>
        {groups.conflict.length > 0 ? (
          <Section area="conflict" entries={groups.conflict} view={view} />
        ) : null}
        <Section area="staged" entries={groups.staged} view={view} />
        <Section area="unstaged" entries={groups.unstaged} view={view} />
      </div>
      <CommitForm />
    </aside>
  );
}
