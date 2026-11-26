import { presentableDiff } from '@codemirror/merge';
import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { BlameLine } from '@mgit/ipc';
import { formatDateTime, S, shortHash } from '@mgit/ui';

export interface ChangePreview {
  before: string;
  after: string;
}
export interface AnnotationData {
  lines: BlameLine[];
  head: string | null;
  current: boolean;
  all: boolean;
  changes: boolean;
  pending: boolean;
  openCommit: (oid: string) => void;
  preview: (change: ChangePreview) => void;
}
/** 미커밋의 0 해시는 작성자 정보로 표시하지 않는다. */
export function blameLabel(line: BlameLine | undefined): string {
  if (!line || /^0+$/.test(line.oid)) return S.fileEditor.localChange;
  return [
    line.author,
    line.authorTime === null ? '' : formatDateTime(line.authorTime),
    line.summary,
  ]
    .filter(Boolean)
    .join(' · ');
}
class Attribution extends WidgetType {
  readonly line: BlameLine | undefined;
  readonly open: (oid: string) => void;
  constructor(line: BlameLine | undefined, open: (oid: string) => void) {
    super();
    this.line = line;
    this.open = open;
  }
  eq(other: Attribution): boolean {
    return this.line === other.line;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'mgit-inline-blame';
    el.textContent = blameLabel(this.line);
    if (this.line && !/^0+$/.test(this.line.oid)) {
      const oid = this.line.oid;
      el.title = `${shortHash(oid)}\n${this.line.summary}`;
      el.onclick = () => this.open(oid);
    } else el.disabled = true;
    return el;
  }
}
class MetaMarker extends GutterMarker {
  readonly label: string;
  readonly action: (() => void) | undefined;
  readonly kind: string;
  constructor(label: string, action?: () => void, kind = '') {
    super();
    this.label = label;
    this.action = action;
    this.kind = kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = this.label;
    el.className = `mgit-git-marker ${this.kind}`;
    if (this.action) el.onclick = this.action;
    return el;
  }
}
/** HEAD와 현재 텍스트의 변경 위치 및 원문 조각을 계산한다. */
export function changedLines(
  before: string,
  after: string,
): Map<number, ChangePreview & { kind: string }> {
  const result = new Map<number, ChangePreview & { kind: string }>();
  for (const change of presentableDiff(before, after, { timeout: 100, scanLimit: 1000 })) {
    const start = after.slice(0, change.fromB).split('\n').length;
    const end = start + after.slice(change.fromB, change.toB).split('\n').length - 1;
    const entry = {
      before: before.slice(change.fromA, change.toA),
      after: after.slice(change.fromB, change.toB),
      kind:
        change.fromA === change.toA
          ? 'added'
          : change.fromB === change.toB
            ? 'deleted'
            : 'modified',
    };
    for (let line = start; line <= end; line++) result.set(line, entry);
  }
  return result;
}
/** 보이는 줄에만 이력과 변경 표시를 만들고 커서 이동은 캐시된 이력을 사용한다. */
export function annotationExtension(data: AnnotationData, text: string): Extension {
  const changes =
    data.changes && data.head !== null
      ? changedLines(data.head.replace(/\r\n/g, '\n'), text)
      : new Map();
  return [
    EditorView.baseTheme({
      '.mgit-inline-blame': {
        color: 'var(--fg-muted)',
        background: 'transparent',
        border: 'none',
        marginLeft: '24px',
        font: 'inherit',
        cursor: 'pointer',
        opacity: '0.75',
        maxWidth: '600px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.mgit-git-marker': {
        font: 'inherit',
        background: 'transparent',
        border: 'none',
        color: 'var(--fg-muted)',
        cursor: 'pointer',
        padding: '0 4px',
        maxWidth: '220px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.mgit-git-marker.added': { color: 'var(--success, #4a9)' },
      '.mgit-git-marker.modified': { color: 'var(--accent)' },
      '.mgit-git-marker.deleted': { color: 'var(--danger)' },
    }),
    gutter({
      class: 'mgit-change-gutter',
      lineMarker(view, line) {
        const change = changes.get(view.state.doc.lineAt(line.from).number);
        return change
          ? new MetaMarker(
              change.kind === 'deleted' ? '−' : '▎',
              () => data.preview(change),
              change.kind,
            )
          : null;
      },
    }),
    gutter({
      class: 'mgit-blame-gutter',
      lineMarker(view, line) {
        if (!data.all || data.pending || (data.lines.length === 0 && data.head !== '')) return null;
        const blame = data.lines[view.state.doc.lineAt(line.from).number - 1];
        return new MetaMarker(
          blameLabel(blame),
          blame && !/^0+$/.test(blame.oid) ? () => data.openCommit(blame.oid) : undefined,
        );
      },
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = this.build(view);
        }
        update(update: ViewUpdate) {
          if (update.selectionSet || update.docChanged || update.viewportChanged)
            this.decorations = this.build(update.view);
        }
        build(view: EditorView): DecorationSet {
          const builder = new RangeSetBuilder<Decoration>();
          if (data.current && !data.pending && (data.lines.length > 0 || data.head === '')) {
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            builder.add(
              line.to,
              line.to,
              Decoration.widget({
                widget: new Attribution(data.lines[line.number - 1], data.openCommit),
                side: 1,
              }),
            );
          }
          return builder.finish();
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}
