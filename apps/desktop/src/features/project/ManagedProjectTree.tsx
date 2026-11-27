import type {
  FsOperationDecision,
  FsOperationPlan,
  FsOperationRequest,
  FsSource,
  SessionId,
} from '@mgit/ipc';
import { Button, ConfirmDialog, Icon, isImeKey, S } from '@mgit/ui';
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { registerCommand } from '../../command-registry';
import type { MenuItem } from '../../components/ContextMenu';
import { TextContextMenu } from '../../components/TextContextMenu';
import { ToolButton } from '../../layout/ToolButton';
import { useAppStore } from '../../store';
import { FocusTier, onFocusRefresh } from '../../store/focus-refresh';
import { baseName, childPath, isWithin, parentDir } from '../../store/fs-path';
import { dirSpace, type RootSpace } from '../../store/root-space';
import { menuTargets } from '../workspace/folder-tree-menu';
import { FileConflictDialog } from './FileConflictDialog';
import { executeFileOperation, prepareFileOperation } from './file-operation-coordinator';
import styles from './ProjectEditing.module.css';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import { projectEditStrings } from './project-edit-strings';
import type { EntryRow, ProjectTreeRow, RootRow } from './project-tree-model';
import type { ProjectFilterView } from './use-project-filter';

/** 이벤트 대상이 트리(행 목록) 안인지 */
function inTree(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-project-tree]') !== null;
}

const EDIT_ID = '\u0000project-new-entry';
interface InlineEdit {
  kind: 'createFile' | 'createDirectory' | 'rename';
  parent: string;
  path: string;
  name: string;
}

/**
 * 트리에 내려 줄 행: 새 파일·폴더를 만드는 중이면 부모 바로 아래에 이름 입력 줄 자리(`EDIT_ID`)를 끼운다. 아니면 받은 행
 * 배열을 그대로 돌려준다 — 참조가 같아야 트리의 폭 측정·키 규칙 메모가 다시 돌지 않는다
 */
function withPlaceholder(
  rows: readonly ProjectTreeRow[],
  kind: 'createFile' | 'createDirectory' | null,
  parentId: string,
): readonly ProjectTreeRow[] {
  if (kind === null) return rows;
  const parentIndex = rows.findIndex((row) => row.id === parentId);
  const placeholder: EntryRow = {
    kind: 'entry',
    id: EDIT_ID,
    path: EDIT_ID,
    name: '',
    entryKind: kind === 'createFile' ? 'file' : 'dir',
    depth: (rows[parentIndex]?.depth ?? 0) + 1,
    parentId,
    setSize: 1,
    posInSet: 1,
    expanded: false,
    expandable: false,
    openable: false,
    size: null,
    mtimeMs: null,
  };
  const next = [...rows];
  next.splice(Math.max(0, parentIndex + 1), 0, placeholder);
  return next;
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

/**
 * Project 트리에 파일 작업·인라인 입력·포인터 이동을 연결한다. `space` 는 트리의 경로 공간(클립보드·보호 경로의 절대
 * 경로를 트리 경로로 바꾼다)이고, 주지 않으면 루트 행의 detail 디렉터리 하나다 (저장소 탭). `filter` 를 주면 트리 위에
 * 거르기 줄(이름 필터 칸·"변경된 파일만" 단추, R1)을 놓는다 — 이때 `rows` 는 이미 거른 행이다
 */
export function ManagedProjectTree({
  session,
  protectedPaths = [],
  space: givenSpace,
  filter,
  ...props
}: ProjectTreeProps & {
  session: SessionId;
  protectedPaths?: readonly string[];
  space?: RootSpace;
  filter?: ProjectFilterView;
}) {
  const rootDir = props.root.detail;
  // 공간이 바뀔 때만 새 객체가 되게 한다 (클립보드 표시를 다시 읽는 효과가 공간에 묶여 있다)
  const space = useMemo(() => givenSpace ?? dirSpace(rootDir), [givenSpace, rootDir]);
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
  const [focusSeq, setFocusSeq] = useState(0);
  const trashFocus = useRef(false);
  const alive = useRef(true);
  // 확인 중 사용자가 다른 화면으로 이동하면 기존 포커스 복귀 요청을 취소한다.
  useEffect(() => {
    alive.current = true;
    const leave = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('dialog, [role="dialog"], [role="menu"]'))
        return;
      if (event.type === 'blur' || (target instanceof Node && !host.current?.contains(target)))
        trashFocus.current = false;
      // 트리에서 새 행을 선택한 경우에도 오래된 복귀 요청은 버린다.
      if (
        event.type === 'pointerdown' &&
        target instanceof Element &&
        target.closest('[data-project-tree]')
      )
        trashFocus.current = false;
    };
    document.addEventListener('focusin', leave);
    document.addEventListener('pointerdown', leave);
    window.addEventListener('blur', leave);
    return () => {
      alive.current = false;
      document.removeEventListener('focusin', leave);
      document.removeEventListener('pointerdown', leave);
      window.removeEventListener('blur', leave);
    };
  }, []);
  /** 삭제 확인을 연 경로에서만 트리 포커스 복귀를 예약한다. */
  const beginTrash = (paths: string[]) => {
    trashFocus.current = true;
    setTrash(paths);
  };
  /** 사용자가 다른 영역으로 이동하지 않은 경우에만 탐색을 이어간다. */
  const returnTrashFocus = () => {
    if (alive.current && trashFocus.current && host.current?.isConnected)
      setFocusSeq((value) => value + 1);
    trashFocus.current = false;
  };
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
  const filterInput = useRef<HTMLInputElement>(null);
  const filtering = filter?.active === true;
  /**
   * 펼침을 뒤집는다. 거른 보기는 폴더를 모두 펼쳐 보이므로 바꾸지 않는다 — 실제 펼침 기록은 거르기를 끈 뒤의 트리 것이라
   * 거른 행에서 건드리면 엉뚱한 폴더가 접힌다
   */
  const toggle = (path: string) => {
    if (!filtering) props.onToggle(path);
  };
  /** 트리(행 목록)에 포커스를 준다 */
  const focusTree = () => host.current?.querySelector<HTMLElement>('[data-project-tree]')?.focus();
  /**
   * 거르기 칸에서 트리로 들어간다 (↓·Enter): 고른 행이 맞은 항목으로 보이면 그대로, 아니면 첫 맞은 항목을 고른다.
   * `open` 이면 그 항목이 파일일 때 고정 탭으로 연다 (트리의 Enter 와 같다)
   */
  const enterTree = (open: boolean) => {
    const hits = filter?.hits;
    const current = rows.find((row) => row.id === props.selected);
    const target =
      current && hits?.has(current.id) ? current : rows.find((row) => hits?.has(row.id));
    if (target && target.id !== props.selected) props.onSelect(target.id);
    focusTree();
    if (open && target?.kind === 'entry' && target.openable && !target.expandable)
      props.onOpenFile(target.path, 'pinned');
  };
  const protectedSelection = (paths: readonly string[]) =>
    paths.some((path) =>
      protectedPaths.some((absolute) => {
        const relative = space.toRel(absolute);
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
  /**
   * 그 디렉터리 안에 만들거나 붙여넣을 수 있는지. 실제 디렉터리가 없는 맨 위(가상 그룹의 '' — 별칭만 놓인다)는 코어가
   * 거부하므로 화면에서 먼저 막는다 (MR-13)
   */
  const writableDir = (dir: string) => dir !== '' || space.toAbs('') !== null;
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

  // Finder에서 클립보드를 바꿨다가 돌아오면 오래된 잘라내기 표시를 해제한다. 처음 그릴 때 한 번 읽고, 창 포커스 복귀 때는
  // 포커스 갱신 조율기(G4, 나머지 단계)를 거쳐 잘라내기 표시가 있을 때만 읽는다 — 표시가 없으면 해제할 것이 없고, 잘라내기는
  // 이 트리가 하므로(다른 탭의 트리는 그려질 때 처음 읽기로 맞춘다) 바깥에서 새 표시가 생기지 않는다. 클립보드 읽기는 UI
  // 스레드의 동기 명령이라 돌아온 직후 화면을 막지 않게 줄인다
  const cutRef = useRef(cutPaths);
  cutRef.current = cutPaths;
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
                    const path = space.toRel(absolute);
                    return path === null ? [] : [path];
                  })
                : [],
            );
        })
        .catch(() => {});
    };
    refresh();
    const off = onFocusRefresh({
      name: 'project-tree:clipboard',
      tier: FocusTier.rest,
      run: () => {
        if (cutRef.current.length > 0) refresh();
      },
    });
    return () => {
      live = false;
      off();
    };
  }, [client, space]);

  /** 생성 위치를 펼치고 임시 행에 포커스를 둔다. */
  const begin = (kind: InlineEdit['kind'], row = selectedRow) => {
    if (busy) return;
    const path = row?.kind === 'entry' ? row.path : '';
    if (kind === 'rename' && (!path || protectedSelection([path]))) return;
    const parent = kind === 'rename' ? (parentDir(path) ?? '') : directory(row);
    if (kind !== 'rename' && !writableDir(parent)) {
      setError(S.group.topReadOnly);
      return;
    }
    const parentRow = rows.find(
      (item) => (item.kind === 'root' || item.kind === 'entry') && item.path === parent,
    );
    if ((parentRow?.kind === 'root' || parentRow?.kind === 'entry') && !parentRow.expanded)
      toggle(parent);
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
      if (edit.kind === 'createDirectory') toggle(path);
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
    if (!writableDir(path)) {
      setError(S.group.topReadOnly);
      return;
    }
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
              const relative = space.toRel(path);
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
    const readOnlyTop = !writableDir(directory(row));
    const topReason = readOnlyTop ? S.group.topReadOnly : undefined;
    const group: MenuItem[] = [
      {
        label: t.newFile,
        commandId: 'project.newFile',
        disabled: busy || readOnlyTop,
        disabledReason: topReason,
        onSelect: () => begin('createFile', row),
      },
      {
        label: t.newFolder,
        commandId: 'project.newFolder',
        disabled: busy || readOnlyTop,
        disabledReason: topReason,
        onSelect: () => begin('createDirectory', row),
      },
      {
        label: t.paste,
        commandId: 'project.paste',
        disabled: busy || readOnlyTop,
        disabledReason: topReason,
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
              onSelect: () => beginTrash(paths),
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
        if (paths.length && !protectedSelection(paths)) beginTrash(paths);
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

  /**
   * 트리의 입력 중에는 이름 필드가 키를 독점한다. 트리에서 글자를 치면 이름 필터 칸으로 가서 이어 적는다 (IntelliJ 의 speed
   * search — 한글 조합 키는 칸으로 포커스만 옮긴다). 이름 필터가 걸린 트리의 Esc 는 필터를 지운다 (편집기 탭을 닫지 않는다)
   */
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input,textarea,select,[contenteditable]')
    )
      return;
    if (event.key === 'Escape') {
      drag.current = null;
      setEdit(null);
      if (filter && filter.query !== '' && inTree(event.target)) {
        event.preventDefault();
        filter.setQuery('');
      }
      return;
    }
    if (
      !filter ||
      !inTree(event.target) ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      busy ||
      edit
    )
      return;
    if (isImeKey(event)) {
      filterInput.current?.focus();
    } else if (event.key.length === 1 && event.key !== ' ') {
      event.preventDefault();
      filter.setQuery(filter.query + event.key);
      filterInput.current?.focus();
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
      if ((row?.kind === 'root' || row?.kind === 'entry') && !row.expanded) toggle(row.path);
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

  // 새 항목 입력 줄의 자리만 본다 (입력 중인 이름은 행 모양을 바꾸지 않는다)
  const placeholderKind = edit && edit.kind !== 'rename' ? edit.kind : null;
  const placeholderParent = edit?.parent ?? '';
  const displayRows = useMemo(
    () => withPlaceholder(rows, placeholderKind, placeholderParent),
    [rows, placeholderKind, placeholderParent],
  );
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
        onToggle={toggle}
        marks={filter?.marks}
        filtered={filtering}
        focusSeq={focusSeq}
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
              // 거른 보기의 폴더는 늘 펼쳐 보인다 (접을 실제 펼침이 아니다)
              disabled={filtering}
              onClick={() => {
                for (const row of [...rows].reverse())
                  if (row.kind === 'entry' && row.expanded) toggle(row.path);
              }}
            >
              −
            </Button>
          </>
        }
        banner={
          <>
            {filter ? (
              <>
                <div className={styles.filter}>
                  <Icon name="search" />
                  <input
                    ref={filterInput}
                    type="search"
                    className={styles.filterInput}
                    data-project-filter=""
                    value={filter.query}
                    placeholder={S.project.filter.placeholder}
                    aria-label={S.project.filter.label}
                    title={S.project.filter.hint}
                    onChange={(e) => filter.setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // 한글 조합 중의 Enter·Esc·↓ 는 입력기 몫이다
                      if (isImeKey(e)) return;
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        if (filter.query !== '') filter.setQuery('');
                        focusTree();
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        enterTree(false);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        enterTree(true);
                      }
                    }}
                  />
                  <ToolButton
                    icon="changedOnly"
                    label={S.project.filter.changedOnly}
                    pressed={filter.changedOnly}
                    onClick={() => filter.setChangedOnly(!filter.changedOnly)}
                  />
                </div>
                {filter.note ? (
                  <div className={styles.filterNote} role="status">
                    {filter.note}
                  </div>
                ) : null}
              </>
            ) : null}
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
        onCancel={() => {
          setTrash(null);
          returnTrashFocus();
        }}
        onConfirm={() => {
          const paths = trash ?? [];
          setTrash(null);
          void run({ kind: 'trash', sources: sources(paths), destination: null }).finally(
            returnTrashFocus,
          );
        }}
      />
    </div>
  );
}
