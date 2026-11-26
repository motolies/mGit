import { presentableDiff } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from '@codemirror/view';
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
        position: 'absolute',
        zIndex: '3',
        margin: '0',
        padding: '0',
        boxSizing: 'border-box',
        textAlign: 'left',
        userSelect: 'none',
        WebkitUserSelect: 'none',
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
        margin: '0',
        lineHeight: 'inherit',
        verticalAlign: 'top',
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
        readonly button: HTMLButtonElement;
        readonly view: EditorView;
        readonly onScroll = () => this.refresh();
        constructor(view: EditorView) {
          this.view = view;
          this.button = document.createElement('button');
          this.button.type = 'button';
          this.button.className = 'mgit-inline-blame';
          this.button.hidden = true;
          // 주석 클릭은 코드 커서와 선택 범위를 바꾸지 않는다.
          this.button.onmousedown = (event) => {
            event.preventDefault();
            event.stopPropagation();
          };
          view.scrollDOM.append(this.button);
          view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
          this.refresh();
        }
        update(update: ViewUpdate) {
          if (
            update.selectionSet ||
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged
          )
            this.refresh();
        }
        /** 줄 높이와 커서 계산에 들어가지 않는 레이어를 실제 줄 끝 위치에 배치한다. */
        refresh() {
          const view = this.view;
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          const blame = data.lines[line.number - 1];
          const enabled =
            data.current && !data.pending && (data.lines.length > 0 || data.head === '');
          this.button.textContent = blameLabel(blame);
          this.button.disabled = !blame || /^0+$/.test(blame.oid);
          this.button.title =
            this.button.disabled || !blame ? '' : `${shortHash(blame.oid)}\n${blame.summary}`;
          this.button.onclick =
            !this.button.disabled && blame ? () => data.openCommit(blame.oid) : null;
          this.button.hidden = true;
          if (!enabled) return;
          view.requestMeasure({
            key: this,
            read: () => {
              if (!this.button.isConnected || line.to > view.state.doc.length) return null;
              if (!view.visibleRanges.some((range) => line.to >= range.from && line.to <= range.to))
                return null;
              const end = view.coordsAtPos(line.to, -1);
              if (!end) return null;
              const box = view.scrollDOM.getBoundingClientRect();
              const left = end.right - box.left + 24;
              const width = Math.min(600, view.scrollDOM.clientWidth - left - 8);
              if (width <= 0 || left < 0) return null;
              return {
                left: left + view.scrollDOM.scrollLeft,
                top: end.top - box.top + view.scrollDOM.scrollTop,
                width,
                height: end.bottom - end.top,
              };
            },
            write: (position) => {
              if (!this.button.isConnected) return;
              this.button.hidden = position === null;
              if (!position) return;
              Object.assign(this.button.style, {
                left: `${position.left}px`,
                top: `${position.top}px`,
                maxWidth: `${position.width}px`,
                height: `${position.height}px`,
                lineHeight: `${position.height}px`,
              });
            },
          });
        }
        destroy() {
          this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
          this.button.remove();
        }
      },
    ),
  ];
}
