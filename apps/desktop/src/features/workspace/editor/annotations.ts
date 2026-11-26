import { presentableDiff } from '@codemirror/merge';
import {
  type ChangeSet,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state';
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { BlameLine } from '@mgit/ipc';
import { formatDateTime, S, shortHash } from '@mgit/ui';

export interface ChangePreview {
  before: string;
  after: string;
}
/** 변경 표시 한 줄 (HEAD 대비) */
export type LineChange = ChangePreview & { kind: string };

/**
 * 주석 표시 설정과 동작. `lines`·`head` 는 처음 값이다 (주지 않으면 비어 있고, 편집기는 조회 결과를 `setGitBase` 로
 * 넣는다). 넣은 값은 문서 상태에 남아 편집을 따라 옮겨지므로 설정을 바꿔 다시 구성해도 유지된다
 */
export interface AnnotationData {
  lines?: BlameLine[] | null;
  head?: string | null;
  current: boolean;
  all: boolean;
  changes: boolean;
  openCommit: (oid: string) => void;
  preview: (change: ChangePreview) => void;
}

/** Blame 한 줄. null 은 조회 뒤에 고친(아직 커밋되지 않은) 줄이다 */
export type BlameSlot = BlameLine | null;

/** 문서 상태에 넣는 Git 기준: 조회 시점 원문에 맞춘 blame 과 HEAD 원문 (`setGitBase`) */
export interface GitBase {
  lines: BlameLine[];
  head: string | null;
}

/** 미커밋의 0 해시는 작성자 정보로 표시하지 않는다. */
export function blameLabel(line: BlameLine | null | undefined): string {
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
export function changedLines(before: string, after: string): Map<number, LineChange> {
  const result = new Map<number, LineChange>();
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

/** 줄 범위의 원문들 (1부터, 양 끝 포함) */
function lineTexts(doc: Text, from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(doc.line(n).text);
  return out;
}

/**
 * 조회해 둔 blame 을 편집에 맞춰 옮긴다 (N6: 입력마다 다시 조회하지 않는다). 바뀐 줄 범위마다 앞뒤에서 원문이 같은 줄은
 * 원래 blame 을 지키고(줄 끝에서 Enter·줄 앞에 줄 넣기), 나머지는 고친 줄(null)로 둔다 — `git blame --contents` 가
 * 같은 원문에 내는 결과와 같다. 한 거래의 여러 변경(다중 커서)이 같은 줄에 닿으면 하나로 묶는다. blame 이 비어 있으면
 * (HEAD 에 없는 파일) 그대로 둔다
 */
export function mapBlame(
  lines: readonly BlameSlot[],
  changes: ChangeSet,
  before: Text,
  after: Text,
): BlameSlot[] {
  if (lines.length === 0) return [...lines];
  const edits: { a0: number; a1: number; b0: number; b1: number }[] = [];
  changes.iterChanges((fromA, toA, fromB, toB) => {
    const edit = {
      a0: before.lineAt(fromA).number,
      a1: before.lineAt(toA).number,
      b0: after.lineAt(fromB).number,
      b1: after.lineAt(toB).number,
    };
    const last = edits[edits.length - 1];
    if (last && edit.a0 <= last.a1) {
      last.a1 = Math.max(last.a1, edit.a1);
      last.b1 = Math.max(last.b1, edit.b1);
    } else {
      edits.push(edit);
    }
  });
  const out: BlameSlot[] = [...lines];
  // 조회 결과가 문서 끝의 빈 줄을 세지 않아도 위치가 어긋나지 않게 채운다
  while (out.length < before.lines) out.push(null);
  for (let i = edits.length - 1; i >= 0; i--) {
    const { a0, a1, b0, b1 } = edits[i] as (typeof edits)[number];
    const oldTexts = lineTexts(before, a0, a1);
    const newTexts = lineTexts(after, b0, b1);
    const old = out.slice(a0 - 1, a1);
    const next: BlameSlot[] = newTexts.map(() => null);
    let head = 0;
    while (head < oldTexts.length && head < newTexts.length && oldTexts[head] === newTexts[head]) {
      next[head] = old[head] ?? null;
      head++;
    }
    let tail = 0;
    while (
      tail < oldTexts.length - head &&
      tail < newTexts.length - head &&
      oldTexts[oldTexts.length - 1 - tail] === newTexts[newTexts.length - 1 - tail]
    ) {
      next[newTexts.length - 1 - tail] = old[oldTexts.length - 1 - tail] ?? null;
      tail++;
    }
    out.splice(a0 - 1, a1 - a0 + 1, ...next);
  }
  return out;
}

/** 조회 결과를 문서 상태에 넣는다 (조회한 원문과 지금 원문이 같을 때). null 이면 비운다 */
export const setGitBase = StateEffect.define<GitBase | null>();

/** 문서에 맞춘 blame. 조회 결과를 받은 뒤 편집을 따라 옮겨진다. 아직 없으면 null */
const blameField = StateField.define<BlameSlot[] | null>({
  create: () => null,
  update(value, tr) {
    let next = value;
    if (next && tr.docChanged) next = mapBlame(next, tr.changes, tr.startState.doc, tr.newDoc);
    for (const effect of tr.effects) {
      if (effect.is(setGitBase)) next = effect.value ? [...effect.value.lines] : null;
    }
    return next;
  },
});

/** HEAD 원문(줄 끝은 LF)과 지금 원문의 변경 줄. HEAD 원문이 없으면(아직 조회 전·읽기 실패) 변경도 없다 */
interface BaseValue {
  head: string | null;
  changes: Map<number, LineChange>;
}

/** HEAD 원문과 문서로 변경 줄을 센다 */
function baseValue(head: string | null, doc: Text): BaseValue {
  return { head, changes: head === null ? new Map() : changedLines(head, doc.toString()) };
}

/**
 * HEAD 원문과 변경 줄. 원문이 바뀌면 바로 다시 비교한다 — 측정상 2만 줄에서도 1~2 ms 라 입력마다 해도 된다(N6). HEAD
 * 원문은 조회 결과로만 바뀐다
 */
const baseField = StateField.define<BaseValue>({
  create: () => ({ head: null, changes: new Map() }),
  update(value, tr) {
    let head = value.head;
    for (const effect of tr.effects) {
      if (effect.is(setGitBase)) head = effect.value?.head?.replace(/\r\n/g, '\n') ?? null;
    }
    if (head === value.head && !tr.docChanged) return value;
    return baseValue(head, tr.newDoc);
  },
});

/** 문서 상태의 blame (주석 확장이 없거나 아직 조회 전이면 null) */
export function blameOf(state: EditorState): BlameSlot[] | null {
  return state.field(blameField, false) ?? null;
}

/** 문서 상태의 HEAD 대비 변경 줄 (주석 확장이 없으면 빈 것) */
export function lineChangesOf(state: EditorState): Map<number, LineChange> {
  return state.field(baseField, false)?.changes ?? new Map();
}

/** blame 을 보일 수 있는지: 조회했고, 줄이 있거나 HEAD 에 없는 새 파일이다 */
function blameReady(lines: BlameSlot[] | null, head: string | null): lines is BlameSlot[] {
  return lines !== null && (lines.length > 0 || head === '');
}

/** 보이는 줄에만 이력과 변경 표시를 만들고 커서 이동은 문서 상태의 blame 을 사용한다. */
export function annotationExtension(data: AnnotationData, _text?: string): Extension {
  const seeded = data.lines !== undefined || data.head !== undefined;
  return [
    seeded ? blameField.init(() => (data.lines ? [...data.lines] : null)) : blameField,
    seeded
      ? baseField.init((state) => baseValue(data.head?.replace(/\r\n/g, '\n') ?? null, state.doc))
      : baseField,
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
        if (!data.changes) return null;
        const change = view.state
          .field(baseField)
          .changes.get(view.state.doc.lineAt(line.from).number);
        return change
          ? new MetaMarker(
              change.kind === 'deleted' ? '−' : '▎',
              () => data.preview(change),
              change.kind,
            )
          : null;
      },
      lineMarkerChange: (update) =>
        update.startState.field(baseField) !== update.state.field(baseField),
    }),
    gutter({
      class: 'mgit-blame-gutter',
      lineMarker(view, line) {
        const lines = view.state.field(blameField);
        if (!data.all || !blameReady(lines, view.state.field(baseField).head)) return null;
        const blame = lines[view.state.doc.lineAt(line.from).number - 1];
        return new MetaMarker(
          blameLabel(blame),
          blame && !/^0+$/.test(blame.oid) ? () => data.openCommit(blame.oid) : undefined,
        );
      },
      lineMarkerChange: (update) =>
        update.startState.field(blameField) !== update.state.field(blameField) ||
        update.startState.field(baseField).head !== update.state.field(baseField).head,
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
            update.geometryChanged ||
            update.startState.field(blameField) !== update.state.field(blameField)
          )
            this.refresh();
        }
        /** 줄 높이와 커서 계산에 들어가지 않는 레이어를 실제 줄 끝 위치에 배치한다. */
        refresh() {
          const view = this.view;
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          const lines = view.state.field(blameField);
          const blame = lines?.[line.number - 1] ?? null;
          const enabled = data.current && blameReady(lines, view.state.field(baseField).head);
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
