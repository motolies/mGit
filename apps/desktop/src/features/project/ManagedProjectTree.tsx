import type {
  FsOperationDecision,
  FsOperationPlan,
  FsOperationRequest,
  FsSource,
  SessionId,
} from '@mgit/ipc';
import { Button, ConfirmDialog, Icon } from '@mgit/ui';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { registerCommand } from '../../command-registry';
import type { MenuItem } from '../../components/ContextMenu';
import { TextContextMenu } from '../../components/TextContextMenu';
import { useAppStore } from '../../store';
import { baseName, childPath, isWithin, parentDir, relativeTo } from '../../store/fs-path';
import { menuTargets } from '../workspace/folder-tree-menu';
import { FileConflictDialog } from './FileConflictDialog';
import { executeFileOperation, prepareFileOperation } from './file-operation-coordinator';
import styles from './ProjectEditing.module.css';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import { projectEditStrings } from './project-edit-strings';
import type { EntryRow, ProjectTreeRow, RootRow } from './project-tree-model';

const EDIT_ID = '\u0000project-new-entry';
interface InlineEdit {
  kind: 'createFile' | 'createDirectory' | 'rename';
  parent: string;
  path: string;
  name: string;
}

/** 중복 선택과 자식 선택을 제거해 같은 파일을 두 번 이동하지 않는다. */
export function normalizeProjectPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .filter((path) => path !== '')
    .filter(
      (path, _, all) =>
        path !== '' && !all.some((parent) => parent !== path && isWithin(path, parent)),
    );
}

/** 인라인 입력에서 경로가 아닌 이름 한 구성요소만 받는다. */
export function validProjectName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !name.includes(String.fromCharCode(0)) &&
    name.toLowerCase() !== '.git'
  );
}

/** Project 트리에 파일 작업·인라인 입력·포인터 이동을 연결한다. */
export function ManagedProjectTree({
  session,
  protectedPaths = [],
  ...props
}: ProjectTreeProps & { session: SessionId; protectedPaths?: readonly string[] }) {
  const client = useAppStore((state) => state.client);
  const t = projectEditStrings();
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [edit, setEdit] = useState<InlineEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    currentPath: string | null;
  } | null>(null);
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    plan: FsOperationPlan;
    resolve: (decisions: FsOperationDecision[] | null) => void;
  } | null>(null);
  const [trash, setTrash] = useState<string[] | null>(null);
  const operation = useRef<string | null>(null);
  const running = useRef(false);
  const outcomes = useRef<Awaited<ReturnType<typeof client.fsExecuteOperation>> | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    paths: string[];
    active: boolean;
    target: string | null;
    hover: string | null;
    since: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const pointerSample = useRef<PointerEvent<HTMLDivElement> | null>(null);
  const dragFrame = useRef<ReturnType<typeof setInterval> | null>(null);
  const moveLatest = useRef<(event: PointerEvent<HTMLDivElement>) => void>(() => {});
  const pendingConflict = useRef(conflict);
  pendingConflict.current = conflict;
  // 탭 전환·창 포커스 상실에서 캡처와 대기 중 확인을 정리한다.
  useEffect(() => {
    const clearDrag = () => {
      drag.current = null;
      pointerSample.current = null;
      if (dragFrame.current !== null) clearInterval(dragFrame.current);
      dragFrame.current = null;
      for (const node of host.current?.querySelectorAll<HTMLElement>('[data-drop-target]') ?? [])
        delete node.dataset.dropTarget;
    };
    window.addEventListener('blur', clearDrag);
    return () => {
      clearDrag();
      window.removeEventListener('blur', clearDrag);
      pendingConflict.current?.resolve(null);
      if (operation.current) void client.fsCancelOperation(operation.current);
    };
  }, [client]);
  const rows = props.rows;
  const protectedSelection = (paths: readonly string[]) =>
    paths.some((path) =>
      protectedPaths.some((absolute) => {
        const relative = relativeTo(props.root.detail, absolute);
        return relative !== null && isWithin(relative, path);
      }),
    );
  const selectedRow = rows.find((row) => row.id === props.selected);
  const directory = (row: ProjectTreeRow | undefined): string =>
    row?.kind === 'root'
      ? ''
      : row?.kind === 'entry'
        ? row.entryKind === 'dir'
          ? row.path
          : (parentDir(row.path) ?? '')
        : '';
  const targets = (row?: RootRow | EntryRow) =>
    normalizeProjectPaths(
      row
        ? menuTargets(
            row.id,
            props.selection ?? {},
            rows.map((entry) => entry.id),
          )
        : props.selection
          ? Object.keys(props.selection)
          : props.selected
            ? [props.selected]
            : [],
    );
  const sources = (paths: string[]): FsSource[] =>
    paths.map((path) => ({ kind: 'session', session, path }));

  // 실제 코어 항목 진행률만 표시하며 대기·완료 후 늦은 응답은 버린다.
  useEffect(() => {
    if (!busy) return;
    let live = true;
    let polling = false;
    const timer = setInterval(() => {
      const id = operation.current;
      if (!id || polling) return;
      polling = true;
      void client
        .fsOperationProgress(id)
        .then((value) => {
          if (live && operation.current === id)
            setProgress({ ...value, currentPath: value.currentPath ?? null });
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 250);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [busy, client]);

  // 포털 메뉴로 포커스를 옮기는 것은 입력 취소가 아니다. 실제 바깥 포인터만 취소한다.
  useEffect(() => {
    if (!edit || busy) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target === input.current || target.closest('[role="menu"], [role="menuitem"]'))
      )
        return;
      setEdit(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [edit, busy]);

  // Finder에서 클립보드를 바꿨다가 돌아오면 오래된 잘라내기 표시를 해제한다.
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void client
        .fsClipboardRead()
        .then((value) => {
          if (live)
            setCutPaths(
              value?.cut
                ? value.paths.flatMap((absolute) => {
                    const path = relativeTo(props.root.detail, absolute);
                    return path === null ? [] : [path];
                  })
                : [],
            );
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      window.removeEventListener('focus', refresh);
    };
  }, [client, props.root.detail]);

  /** 생성 위치를 펼치고 임시 행에 포커스를 둔다. */
  const begin = (kind: InlineEdit['kind'], row = selectedRow) => {
    if (busy) return;
    const path = row?.kind === 'entry' ? row.path : '';
    if (kind === 'rename' && (!path || protectedSelection([path]))) return;
    const parent = kind === 'rename' ? (parentDir(path) ?? '') : directory(row);
    const parentRow = rows.find(
      (item) => (item.kind === 'root' || item.kind === 'entry') && item.path === parent,
    );
    if ((parentRow?.kind === 'root' || parentRow?.kind === 'entry') && !parentRow.expanded)
      props.onToggle(parent);
    setError(null);
    setEdit({ kind, parent, path, name: kind === 'rename' ? baseName(path) : '' });
  };

  /** 동일 실행 경로에서 저장 보호·충돌 선택·결과 동기화를 처리한다. */
  const run = async (request: FsOperationRequest): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setProgress(null);
    setError(null);
    outcomes.current = null;
    try {
      const plan = await prepareFileOperation(client, request);
      if (!plan) return false;
      operation.current = plan.id;
      const decisions = plan.items.some((item) => item.conflict !== 'none' && !item.error)
        ? await new Promise<FsOperationDecision[] | null>((resolve) =>
            setConflict({ plan, resolve }),
          )
        : [];
      if (decisions === null) {
        await client.fsCancelOperation(plan.id);
        return false;
      }
      const result = await executeFileOperation(
        client,
        plan,
        decisions,
        request.destination?.session,
      );
      outcomes.current = result;
      const errors = result.items
        .filter((item) => item.status === 'failed' || item.error)
        .map((item) => `${item.source ?? item.destination ?? ''}: ${item.error ?? t.error}`);
      if (errors.length) setError(errors.join('\n'));
      props.onRefresh();
      return result.items.some((item) => item.status === 'committed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      operation.current = null;
      running.current = false;
      setBusy(false);
    }
  };

  /** 확정된 이름으로 생성하거나 이름을 바꾸고 새 파일을 연다. */
  const commit = async () => {
    if (!edit || busy) return;
    if (!validProjectName(edit.name)) {
      setError(t.invalid);
      return;
    }
    const path = childPath(edit.parent, edit.name);
    if (
      await run({
        kind: edit.kind,
        sources: edit.kind === 'rename' ? sources([edit.path]) : [],
        destination: { session, path },
      })
    ) {
      setEdit(null);
      props.onSelect(path);
      if (edit.kind === 'createFile') props.onOpenFile(path, 'pinned');
      if (edit.kind === 'createDirectory') props.onToggle(path);
    }
  };

  /** 파일 클립보드에는 실제 선택을 저장하고 텍스트 선택과 분리한다. */
  const copy = async (cut: boolean, paths = targets()) => {
    if (!paths.length || protectedSelection(paths)) return;
    try {
      await client.fsClipboardWrite(sources(paths), cut);
      setCutPaths(cut ? paths : []);
    } catch (cause) {
      setError(String(cause));
    }
  };
  /** 붙여넣기는 선택 파일의 부모 또는 선택 폴더를 목적지로 쓴다. */
  const paste = async (path = directory(selectedRow)) => {
    try {
      const value = await client.fsClipboardRead();
      if (!value) return;
      const items: FsSource[] = Array.from({ length: value.count }, (_, index) => ({
        kind: 'external',
        token: value.token,
        index,
      }));
      await run({
        kind: value.cut ? 'move' : 'copy',
        sources: items,
        destination: { session, path },
      });
      if (value.cut && outcomes.current) {
        const committed = outcomes.current.items
          .filter((item) => item.status === 'committed')
          .map((item) => item.source);
        const remaining = items.filter(
          (_, index) => !committed.includes(value.paths[index] ?? null),
        );
        await client.fsClipboardWrite(remaining, true);
        setCutPaths(
          value.paths
            .filter((path) => !committed.includes(path))
            .flatMap((path) => {
              const relative = relativeTo(props.root.detail, path);
              return relative === null ? [] : [relative];
            }),
        );
      }
    } catch (cause) {
      setError(String(cause));
    }
  };

  /** 메뉴 대상은 선택된 행 전체를 보존하며 배경은 항상 루트를 사용한다. */
  const menu = (row: RootRow | EntryRow): MenuItem[] => {
    const paths = targets(row);
    const protectedTarget = protectedSelection(paths);
    const editable = row.kind === 'entry' && (row.entryKind === 'file' || row.entryKind === 'dir');
    const group: MenuItem[] = [
      {
        label: t.newFile,
        commandId: 'project.newFile',
        disabled: busy,
        onSelect: () => begin('createFile', row),
      },
      {
        label: t.newFolder,
        commandId: 'project.newFolder',
        disabled: busy,
        onSelect: () => begin('createDirectory', row),
      },
      {
        label: t.paste,
        commandId: 'project.paste',
        disabled: busy,
        onSelect: () => void paste(directory(row)),
      },
    ];
    if (editable)
      group.push(
        {
          label: t.rename,
          commandId: 'project.rename',
          separator: true,
          disabled: busy || paths.length !== 1 || protectedTarget,
          disabledReason: protectedTarget ? t.protected : undefined,
          onSelect: () => begin('rename', row),
        },
        {
          label: t.copy,
          disabledReason: protectedTarget ? t.protected : undefined,
          commandId: 'project.copy',
          disabled: busy || protectedTarget,
          onSelect: () => void copy(false, paths),
        },
        {
          label: t.cut,
          disabledReason: protectedTarget ? t.protected : undefined,
          commandId: 'project.cut',
          disabled: busy || protectedTarget,
          onSelect: () => void copy(true, paths),
        },
      );
    const original = props.menu(row);
    return [
      ...group,
      ...original.map((item, index) => (index === 0 ? { ...item, separator: true } : item)),
      ...(editable
        ? [
            {
              label: t.trash,
              commandId: 'project.trash',
              separator: true,
              danger: true,
              disabledReason: protectedTarget ? t.protected : undefined,
              disabled: busy || protectedTarget,
              onSelect: () => setTrash(paths),
            },
          ]
        : []),
    ];
  };

  // 이벤트는 활성 Project 하나에만 전달된다. 외부 원본은 네이티브에서 발급한 토큰만 받는다.
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (
        event as CustomEvent<{ session: number; token: string; count: number; directory: string }>
      ).detail;
      if (detail.session !== session || busy) return;
      void run({
        kind: 'copy',
        sources: Array.from({ length: detail.count }, (_, index) => ({
          kind: 'external',
          token: detail.token,
          index,
        })),
        destination: { session, path: detail.directory },
      });
    };
    window.addEventListener('mgit-project-import', receive);
    return () => window.removeEventListener('mgit-project-import', receive);
  });

  // 팔레트·사용자 단축키도 메뉴와 같은 작업 함수를 호출한다.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const handlers: Record<string, () => void> = {
      'project.newFile': () => begin('createFile'),
      'project.newFolder': () => begin('createDirectory'),
      'project.rename': () => begin('rename'),
      'project.copy': () => void copy(false),
      'project.cut': () => void copy(true),
      'project.paste': () => void paste(),
      'project.trash': () => {
        const paths = targets();
        if (paths.length && !protectedSelection(paths)) setTrash(paths);
      },
    };
    const remove = Object.entries(handlers).map(([id, action]) =>
      registerCommand(id, element, { enabled: () => !busy && !edit, run: action }),
    );
    return () => {
      for (const off of remove) off();
    };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 입력을 시작할 때만 이름을 선택하며 입력할 때마다 커서를 옮기지 않는다.
  useEffect(() => {
    if (!edit) return;
    input.current?.focus();
    const end = edit.name.lastIndexOf('.');
    input.current?.setSelectionRange(0, end > 0 ? end : edit.name.length);
  }, [edit?.kind, edit?.path]);

  /** 트리의 입력 중에는 이름 필드가 키를 독점한다. */
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input,textarea,select,[contenteditable]')
    )
      return;
    if (event.key === 'Escape') {
      drag.current = null;
      setEdit(null);
      return;
    }
  };

  /** 포인터 아래 행을 실제 DOM 위치로 찾는다. */
  const dropTarget = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    if (!element || !host.current?.contains(element)) return null;
    const row = element.closest<HTMLElement>('[data-project-path]');
    return row?.dataset.projectDirectory === 'true'
      ? (row.dataset.projectPath ?? '')
      : row
        ? (parentDir(row.dataset.projectPath ?? '') ?? '')
        : '';
  };
  /** 가상 행 대신 계속 마운트되는 컨테이너가 포인터를 잡는다. */
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || busy || edit || (event.target as HTMLElement).closest('button,input'))
      return;
    const node = (event.target as HTMLElement).closest<HTMLElement>('[data-project-path]');
    const row = rows.find((item) => item.id === node?.dataset.projectPath);
    if (row?.kind !== 'entry' || protectedSelection(targets(row))) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      paths: targets(row),
      active: false,
      target: null,
      hover: null,
      since: Date.now(),
    };
  };
  /** 드래그 중 대상 강조·펼침·가장자리 스크롤을 갱신한다. */
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    pointerSample.current = event;
    const state = drag.current;
    if (!state) return;
    if (!state.active && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6) return;
    state.active = true;
    if (dragFrame.current === null)
      dragFrame.current = setInterval(() => {
        if (pointerSample.current && drag.current?.active)
          moveLatest.current(pointerSample.current);
      }, 60);
    suppressClick.current = true;
    host.current?.setPointerCapture?.(event.pointerId);
    const path = dropTarget(event.clientX, event.clientY);
    state.target =
      path !== null &&
      !state.paths.some((source) => isWithin(path, source) || parentDir(source) === path)
        ? path
        : null;
    for (const node of host.current?.querySelectorAll<HTMLElement>('[data-project-path]') ?? [])
      node.dataset.dropTarget = String(node.dataset.projectPath === state.target);
    if (state.target !== state.hover) {
      state.hover = state.target;
      state.since = Date.now();
    } else if (state.target !== null && Date.now() - state.since > 600) {
      const row = rows.find((item) => item.id === state.target);
      if ((row?.kind === 'root' || row?.kind === 'entry') && !row.expanded)
        props.onToggle(row.path);
    }
    const tree = host.current?.querySelector<HTMLElement>('[data-project-tree]');
    if (tree) {
      const box = tree.getBoundingClientRect();
      if (event.clientY < box.top + 24) tree.scrollTop -= 18;
      if (event.clientY > box.bottom - 24) tree.scrollTop += 18;
    }
  };
  moveLatest.current = pointerMove;

  /** 올바른 목적지에 놓았을 때만 공통 이동 작업을 실행한다. */
  const pointerUp = () => {
    const state = drag.current;
    drag.current = null;
    pointerSample.current = null;
    if (dragFrame.current !== null) clearInterval(dragFrame.current);
    dragFrame.current = null;
    for (const node of host.current?.querySelectorAll<HTMLElement>('[data-drop-target]') ?? [])
      delete node.dataset.dropTarget;
    if (state?.active && state.target !== null)
      void run({
        kind: 'move',
        sources: sources(state.paths),
        destination: { session, path: state.target },
      });
  };

  const displayRows = [...rows];
  if (edit && edit.kind !== 'rename') {
    const parent = rows.find((row) => row.id === edit.parent);
    const placeholder: EntryRow = {
      kind: 'entry',
      id: EDIT_ID,
      path: EDIT_ID,
      name: '',
      entryKind: edit.kind === 'createFile' ? 'file' : 'dir',
      depth: (parent?.depth ?? 0) + 1,
      parentId: edit.parent,
      setSize: 1,
      posInSet: 1,
      expanded: false,
      expandable: false,
      openable: false,
      size: null,
      mtimeMs: null,
    };
    displayRows.splice(
      Math.max(0, rows.findIndex((row) => row.id === edit.parent) + 1),
      0,
      placeholder,
    );
  }
  const inline = edit
    ? {
        id: edit.kind === 'rename' ? edit.path : EDIT_ID,
        input: (
          <TextContextMenu>
            <input
              ref={input}
              className={styles.input}
              aria-label={t.name}
              value={edit.name}
              disabled={busy}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  !busy &&
                  next instanceof Element &&
                  !next.closest('[role="menu"], [role="menuitem"]')
                )
                  setEdit(null);
              }}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commit();
                }
                if (e.key === 'Escape') setEdit(null);
              }}
            />
          </TextContextMenu>
        ),
      }
    : undefined;
  return (
    <div
      ref={host}
      className={styles.host}
      data-project-session={session}
      onKeyDownCapture={keys}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.stopPropagation();
          event.preventDefault();
          suppressClick.current = false;
        }
      }}
    >
      <ProjectTree
        {...props}
        rows={displayRows}
        cutPaths={cutPaths}
        inline={inline}
        menu={menu}
        busy={props.busy || busy}
        createTools={
          <>
            <Button
              size="compact"
              title={t.newFile}
              aria-label={t.newFile}
              disabled={busy}
              onClick={() => begin('createFile')}
            >
              <Icon name="file" />
            </Button>
            <Button
              size="compact"
              title={t.newFolder}
              aria-label={t.newFolder}
              disabled={busy}
              onClick={() => begin('createDirectory')}
            >
              <Icon name="folder" />
            </Button>
            <Button
              size="compact"
              title={t.collapse}
              aria-label={t.collapse}
              onClick={() => {
                for (const row of [...rows].reverse())
                  if (row.kind === 'entry' && row.expanded) props.onToggle(row.path);
              }}
            >
              −
            </Button>
          </>
        }
        banner={
          <>
            {props.banner}
            {error ? (
              <div role="alert" className={styles.error}>
                {error}
              </div>
            ) : null}
            {busy ? (
              <div className={styles.progress}>
                {t.working} {progress ? `${progress.completed}/${progress.total}` : null}
                {progress?.currentPath ? (
                  <span title={progress.currentPath}>{baseName(progress.currentPath)}</span>
                ) : null}
                <Button
                  size="compact"
                  onClick={() => {
                    if (operation.current) void client.fsCancelOperation(operation.current);
                  }}
                >
                  {t.cancel}
                </Button>
              </div>
            ) : null}
          </>
        }
      />
      {conflict ? (
        <FileConflictDialog
          plan={conflict.plan}
          onResolve={(decisions) => {
            conflict.resolve(decisions);
            setConflict(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={trash !== null}
        title={t.trash}
        message={t.confirmTrash}
        items={trash ?? []}
        danger
        onCancel={() => setTrash(null)}
        onConfirm={() => {
          const paths = trash ?? [];
          setTrash(null);
          void run({ kind: 'trash', sources: sources(paths), destination: null });
        }}
      />
    </div>
  );
}
