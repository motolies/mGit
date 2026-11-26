import type { IpcClient } from '../client';
import type {
  FsClipboard,
  FsLocation,
  FsOperationDecision,
  FsOperationItem,
  FsOperationOutcome,
  FsOperationPlan,
  FsOperationRequest,
  FsSource,
} from '../types';
import type { MockFs } from './mock-fs';

type Location = { root: string; path: string };
type Node = {
  item: FsOperationItem;
  source: Location | null;
  destination: Location | null;
  children: Node[];
};
const absolute = (location: Location) => `${location.root}/${location.path}`;
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const child = (path: string, base: string) => (path ? `${path}/${base}` : base);

/**
 * 실제 파일 API와 같은 준비·결정·부분 성공 계약을 목 트리에 적용한다. `locate` 를 주면 세션 경로를 (루트, 나머지)로 나누는
 * 데 그것을 쓴다 (그룹의 `별칭/…` 경로 — 맨 위·모르는 별칭은 거기서 거부한다). 없으면 세션 루트 기준 경로 그대로다
 */
export function createMockFileOperations(
  fs: MockFs,
  rootOf: (session: number) => string,
  after: (items: FsOperationOutcome[]) => void,
  locate?: (session: number, path: string) => { root: string; path: string },
): Pick<
  IpcClient,
  | 'fsPrepareOperation'
  | 'fsExecuteOperation'
  | 'fsCancelOperation'
  | 'fsOperationProgress'
  | 'fsRegisterDrop'
  | 'fsClipboardRead'
  | 'fsClipboardWrite'
  | 'fsRecoveryWarnings'
> {
  let seq = 0;
  const progress = new Map<
    string,
    { completed: number; total: number; currentPath: string | null }
  >();
  let clipboard: FsClipboard | null = null;
  const grants = new Map<string, { locations: Location[]; cut: boolean }>();
  const plans = new Map<
    string,
    { request: FsOperationRequest; plan: FsOperationPlan; nodes: Node[] }
  >();
  const location = (value: FsLocation): Location =>
    locate
      ? locate(value.session, value.path)
      : {
          root: rootOf(value.session),
          path: value.path,
        };
  /** 세션 또는 외부 입력 토큰으로 등록한 경로만 찾는다. */
  const sourceOf = (source: FsSource): Location => {
    if (source.kind === 'session') return location(source);
    const entry = grants.get(source.token)?.locations[source.index];
    if (!entry) throw new Error('파일 입력이 만료되었습니다');
    return entry;
  };
  /** 폴더 내부 충돌까지 준비한다. */
  const build = (
    id: string,
    source: Location | null,
    destination: Location | null,
    directory: boolean,
  ): Node => {
    const kind = destination ? fs.kind(destination.root, destination.path) : null;
    /** 충돌 표시용 크기·수정 시각은 목록과 같은 메타데이터를 쓴다. */
    const metadata = (location: Location | null) => {
      if (!location) return null;
      const listing = fs.list(location.root, parent(location.path), 50_000);
      return listing.kind === 'listed'
        ? listing.entries.find((e) => e.name === name(location.path))
        : null;
    };
    const sourceMeta = metadata(source);
    const destinationMeta = metadata(destination);
    const item: FsOperationItem = {
      id,
      source: source ? absolute(source) : null,
      destination: destination ? absolute(destination) : null,
      directory,
      conflict:
        kind === null
          ? 'none'
          : kind === 'dir'
            ? directory
              ? 'directory'
              : 'type'
            : directory
              ? 'type'
              : 'file',
      error: null,
      sourceSize: sourceMeta?.size ?? null,
      destinationSize: destinationMeta?.size ?? null,
      sourceMtimeMs: sourceMeta?.mtimeMs ?? null,
      destinationMtimeMs: destinationMeta?.mtimeMs ?? null,
    };
    const node: Node = { item, source, destination, children: [] };
    if (source) {
      try {
        fs.validateOperation(source.root, source.path);
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      const srcKind = fs.kind(source.root, source.path);
      if (!source.path || srcKind === null || srcKind === 'symlink' || srcKind === 'other')
        item.error = '원본 파일이 없거나 보호된 경로입니다';
      if (directory && destination && absolute(destination).startsWith(`${absolute(source)}/`))
        item.error = '폴더를 자기 하위로 옮길 수 없습니다';
      if (!item.error && directory) {
        const listing = fs.list(source.root, source.path, 50_000);
        if (listing.kind !== 'listed') item.error = '폴더를 읽을 수 없습니다';
        else
          node.children = listing.entries.map((entry, i) =>
            build(
              `${id}/${i}`,
              { root: source.root, path: child(source.path, entry.name) },
              destination
                ? { root: destination.root, path: child(destination.path, entry.name) }
                : null,
              entry.kind === 'dir',
            ),
          );
      }
    }
    return node;
  };
  return {
    async fsPrepareOperation(request) {
      const destination = request.destination ? location(request.destination) : null;
      const sources = request.sources
        .map(sourceOf)
        .filter(
          (source, i, all) =>
            !all.some(
              (other, j) =>
                j < i &&
                (absolute(source) === absolute(other) ||
                  absolute(source).startsWith(`${absolute(other)}/`)),
            ),
        );
      const nodes =
        request.kind === 'createFile' || request.kind === 'createDirectory'
          ? [build('0', null, destination, request.kind === 'createDirectory')]
          : sources.map((source, i) =>
              build(
                String(i),
                source,
                destination
                  ? {
                      root: destination.root,
                      path:
                        request.kind === 'rename'
                          ? destination.path
                          : child(destination.path, name(source.path)),
                    }
                  : null,
                fs.kind(source.root, source.path) === 'dir',
              ),
            );
      const items: FsOperationItem[] = [];
      const visit = (node: Node) => {
        items.push(node.item);
        node.children.forEach(visit);
      };
      nodes.forEach(visit);
      const plan: FsOperationPlan = { id: `mock-operation-${++seq}`, kind: request.kind, items };
      plans.set(plan.id, { request, plan, nodes });
      progress.set(plan.id, { completed: 0, total: items.length, currentPath: null });
      return plan;
    },
    async fsExecuteOperation(id, decisions) {
      const prepared = plans.get(id);
      if (!prepared) throw new Error('파일 작업 계획이 만료되었습니다');
      plans.delete(id);
      const choices = new Map<string, FsOperationDecision>(decisions.map((d) => [d.itemId, d]));
      const items: FsOperationOutcome[] = [];
      const run = (node: Node, relocated?: Location): void => {
        let destination = relocated ?? node.destination;
        const choice = choices.get(node.item.id);
        const outcome = (status: FsOperationOutcome['status'], error: string | null = null) =>
          items.push({
            source: node.item.source,
            destination: destination ? absolute(destination) : null,
            directory: node.item.directory,
            status,
            error,
          });
        try {
          if (node.item.error) throw new Error(node.item.error);
          if (choice?.action === 'skip') {
            outcome('skipped');
            return;
          }
          if (choice?.action === 'rename' && destination) {
            if (
              !choice.name ||
              /[/\\]/.test(choice.name) ||
              ['.', '..', '.git'].includes(choice.name.toLowerCase())
            )
              throw new Error('잘못된 이름입니다');
            destination = {
              root: destination.root,
              path: child(parent(destination.path), choice.name),
            };
          }
          const kind = prepared.request.kind;
          if (kind === 'trash' && node.source) {
            fs.trash(node.source.root, node.source.path);
            outcome('committed');
            return;
          }
          if (!destination) throw new Error('목적지가 필요합니다');
          if (
            node.source &&
            absolute(node.source) === absolute(destination) &&
            (kind === 'move' || kind === 'rename')
          ) {
            outcome('skipped');
            return;
          }
          const exists = fs.kind(destination.root, destination.path);
          if (exists && choice?.action !== 'overwrite' && choice?.action !== 'merge')
            throw new Error('동일한 이름의 항목이 있습니다');
          if (choice?.action === 'merge' && exists === 'dir' && node.item.directory) {
            const start = items.length;
            for (const entry of node.children)
              run(entry, {
                root: destination.root,
                path: child(destination.path, name(entry.source?.path ?? '')),
              });
            if (items.slice(start).every((item) => item.status === 'committed')) {
              if ((kind === 'move' || kind === 'rename') && node.source)
                fs.trash(node.source.root, node.source.path);
              outcome('committed');
            }
            return;
          }
          if (kind === 'createFile' || kind === 'createDirectory') {
            if (exists && choice?.action === 'overwrite')
              fs.trash(destination.root, destination.path);
            fs.create(destination.root, destination.path, kind === 'createDirectory');
          } else if (node.source)
            fs.transfer(
              node.source.root,
              node.source.path,
              destination.root,
              destination.path,
              kind === 'move' || kind === 'rename',
              choice?.action === 'overwrite',
            );
          outcome('committed');
        } catch (error) {
          outcome('failed', error instanceof Error ? error.message : String(error));
        }
      };
      prepared.nodes.forEach((node) => {
        run(node);
      });
      progress.set(id, {
        completed: prepared.plan.items.length,
        total: prepared.plan.items.length,
        currentPath: null,
      });
      after(items);
      return { id, items };
    },
    async fsOperationProgress(id) {
      return progress.get(id) ?? { completed: 0, total: 0, currentPath: null };
    },
    async fsCancelOperation(id) {
      plans.delete(id);
    },
    async fsClipboardRead() {
      return clipboard;
    },
    async fsClipboardWrite(sources, cut) {
      if (
        cut &&
        sources.some((source) => source.kind === 'external' && !grants.get(source.token)?.cut)
      )
        throw new Error('외부 파일은 복사로만 가져올 수 있습니다');
      if (!sources.length) {
        clipboard = null;
        return;
      }
      const locations = sources.map(sourceOf);
      const token = `mock-clipboard-${++seq}`;
      grants.set(token, { locations, cut });
      clipboard = { token, count: locations.length, paths: locations.map(absolute), cut };
    },
    async fsRegisterDrop() {
      throw new Error('외부 파일 가져오기는 데스크톱 앱에서 사용할 수 있습니다');
    },
    async fsRecoveryWarnings() {
      return [];
    },
  };
}
