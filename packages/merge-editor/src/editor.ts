import { defaultKeymap, history, historyKeymap, invertedEffects } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import {
  EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  WidgetType,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { ConflictDoc } from '@mgit/ipc';
import {
  type BlockRange,
  buildResultDoc,
  type ConflictOnly,
  conflictBlocks,
  linesFor,
  type MergeDraft,
  markerLines,
  type ResolutionKind,
  stripCr,
} from './model';

/** 블록 선택 효과. 같은 트랜잭션의 변경이 텍스트를 바꾸고, 이 효과가 범위·종류를 갱신한다 */
export const pickEffect = StateEffect.define<{
  index: number;
  kind: ResolutionKind;
  prevKind: ResolutionKind;
  from: number;
  to: number;
  prevFrom: number;
  prevTo: number;
}>();

/** 편집기 상태에 보관하는 블록 정보 */
export interface MergeFieldValue {
  blocks: BlockRange[];
  decorations: DecorationSet;
}

/**
 * 블록 버튼 줄의 고정 문구 (쪽 이름 `labels` 밖). 이 파일은 UI 문구 사전(`@mgit/ui`)을 모르므로 호출자가 지금 언어의
 * 문구를 넘긴다
 */
export interface MergePickLabels {
  /** ours 다음 theirs */
  both: string;
  /** theirs 다음 ours */
  bothReversed: string;
  /** 고른 것을 미해결로 되돌리기 */
  unresolved: string;
  /** 줄 고르기 버튼 (CF-14, `onLinePick` 이 있을 때만 그린다) */
  linePick: string;
}

/** 블록 위젯이 쓸 설정 (라벨·버튼 콜백) */
export interface MergeConfig {
  doc: ConflictDoc;
  labels: { ours: string; base: string; theirs: string };
  /** 버튼 줄의 고정 문구 */
  pickLabels: MergePickLabels;
  /** 위젯 버튼이 눌렸을 때. 기본은 `applyPick` */
  onPick?: (view: EditorView, index: number, kind: ResolutionKind) => void;
  /** 줄 끝 */
  hideBase?: boolean;
  /** 충돌 블록 순번 → 분류 라벨 (CF-15) */
  classLabels?: Record<number, string>;
  /** 줄 고르기 버튼 (CF-14). 없으면 버튼을 안 그린다 */
  onLinePick?: (view: EditorView, index: number) => void;
}

/** 충돌 블록 위 버튼 줄 (CF-08) */
class PickWidget extends WidgetType {
  private readonly index: number;
  private readonly kind: ResolutionKind;
  private readonly cfg: MergeConfig;

  constructor(index: number, kind: ResolutionKind, cfg: MergeConfig) {
    super();
    this.index = index;
    this.kind = kind;
    this.cfg = cfg;
  }

  /** 같은 블록·같은 상태면 다시 그리지 않는다 */
  override eq(other: PickWidget): boolean {
    return other.index === this.index && other.kind === this.kind;
  }

  /** 버튼 줄 DOM */
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = `cm-mg-pick cm-mg-pick-${this.kind}`;
    const title = document.createElement('span');
    title.className = 'cm-mg-pick-title';
    const cls = this.cfg.classLabels?.[this.index];
    title.textContent = `#${this.index + 1} ${this.kind === 'unresolved' ? '' : `(${this.kind})`}${cls ? ` · ${cls}` : ''}`;
    el.appendChild(title);
    const text = this.cfg.pickLabels;
    const choices: [ResolutionKind, string][] = [
      ['ours', this.cfg.labels.ours],
      ['theirs', this.cfg.labels.theirs],
      ['bothOursFirst', text.both],
      ['bothTheirsFirst', text.bothReversed],
    ];
    if (!this.cfg.hideBase) {
      choices.push(['base', this.cfg.labels.base]);
    }
    if (this.kind !== 'unresolved') {
      choices.push(['unresolved', text.unresolved]);
    }
    if (this.cfg.onLinePick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-mg-pick-btn';
      b.dataset.kind = 'linePick';
      b.textContent = text.linePick;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.cfg.onLinePick?.(view, this.index);
      });
      el.appendChild(b);
    }
    for (const [kind, label] of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-mg-pick-btn';
      b.dataset.kind = kind;
      b.textContent = label;
      b.disabled = kind === this.kind;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        (this.cfg.onPick ?? applyPick)(view, this.index, kind);
      });
      el.appendChild(b);
    }
    return el;
  }

  /** 위젯 안의 클릭은 편집기가 가로채지 않는다 */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 블록 범위로 위젯·줄 장식을 만든다. 여러 블록이 지워져 한 줄에 겹칠 수 있으므로 (예: 두 블록에 걸친 선택을
 * 지우면 둘 다 같은 위치로 접힌다) 정렬된 입력을 요구하는 RangeSetBuilder 대신 정렬해 주는 `Decoration.set` 을 쓴다
 */
function buildDecorations(
  state: EditorState,
  blocks: BlockRange[],
  cfg: MergeConfig,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    const lineStart = state.doc.lineAt(b.from).from;
    ranges.push(
      Decoration.widget({
        widget: new PickWidget(b.index, b.kind, cfg),
        block: true,
        side: -1,
      }).range(lineStart),
    );
    const last = state.doc.lineAt(Math.max(b.from, b.to)).number;
    for (let n = state.doc.lineAt(b.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      ranges.push(Decoration.line({ class: `cm-mg-line cm-mg-line-${b.kind}` }).range(line.from));
    }
  }
  return Decoration.set(ranges, true);
}

/** 블록 범위 StateField 를 만든다 */
export function createMergeField(cfg: MergeConfig, initial: BlockRange[]) {
  return StateField.define<MergeFieldValue>({
    create(state) {
      return { blocks: initial, decorations: buildDecorations(state, initial, cfg) };
    },
    update(value, tr) {
      let blocks = value.blocks;
      let changed = false;
      if (tr.docChanged) {
        const picked = new Set(
          tr.effects
            .filter((e) => e.is(pickEffect))
            .map((e) => (e.value as { index: number }).index),
        );
        blocks = blocks.map((b) => {
          if (picked.has(b.index)) {
            return b;
          }
          let touched = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (fromA <= b.to && toA >= b.from) {
              touched = true;
            }
          });
          const from = tr.changes.mapPos(b.from, -1);
          const to = Math.max(from, tr.changes.mapPos(b.to, 1));
          return { ...b, from, to, kind: touched && b.kind !== 'custom' ? 'custom' : b.kind };
        });
        changed = true;
      }
      for (const e of tr.effects) {
        if (e.is(pickEffect)) {
          blocks = blocks.map((b) =>
            b.index === e.value.index
              ? { ...b, kind: e.value.kind, from: e.value.from, to: e.value.to }
              : b,
          );
          changed = true;
        }
      }
      if (!changed) {
        return value;
      }
      return { blocks, decorations: buildDecorations(tr.state, blocks, cfg) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
}

/** 필드 핸들을 상태에서 찾기 위한 전역 레지스트리 (상태당 필드 하나) */
const FIELD_KEY = new WeakMap<EditorState, StateField<MergeFieldValue>>();

/** 상태의 블록 목록 */
export function blocksOf(state: EditorState): BlockRange[] {
  const f = state.facet(mergeFieldFacet)[0];
  return f ? state.field(f).blocks : [];
}

import { Facet } from '@codemirror/state';

/** 상태가 쓰는 블록 필드 */
const mergeFieldFacet = Facet.define<StateField<MergeFieldValue>>();

/** 남은 충돌 수 */
export function remainingCount(state: EditorState): number {
  return blocksOf(state).filter((b) => b.kind === 'unresolved').length;
}

/** 블록 i 를 `kind` 로 바꾸는 트랜잭션 (없으면 null). 빈 블록·빈 선택의 줄바꿈을 정리한다 */
export function pickSpec(
  state: EditorState,
  doc: ConflictDoc,
  index: number,
  kind: ResolutionKind,
  customLines?: readonly string[],
): TransactionSpec | null {
  const block = blocksOf(state).find((b) => b.index === index);
  const source = conflictBlocks(doc)[index];
  if (!block || !source) {
    return null;
  }
  const lines =
    kind === 'unresolved'
      ? markerLines(source)
      : kind === 'custom' && customLines
        ? customLines.map(stripCr)
        : linesFor(source, kind);
  const text = lines.join('\n');
  const docLen = state.doc.length;
  const wasEmpty = block.from === block.to;
  let from = block.from;
  let to = block.to;
  let insert = text;
  let newFrom = from;
  let newTo = from + text.length;
  if (!wasEmpty && text === '') {
    // 블록을 지우면서 인접 줄바꿈 하나도 지운다
    if (from > 0) {
      from -= 1;
    } else if (to < docLen) {
      to += 1;
    }
    newFrom = from;
    newTo = from;
  } else if (wasEmpty && text !== '') {
    if (from > 0) {
      insert = `\n${text}`;
      newFrom = from + 1;
      newTo = newFrom + text.length;
    } else if (docLen > 0) {
      insert = `${text}\n`;
      newFrom = 0;
      newTo = text.length;
    }
  }
  return {
    changes: { from, to, insert },
    effects: pickEffect.of({
      index,
      kind,
      prevKind: block.kind,
      from: newFrom,
      to: newTo,
      prevFrom: block.from,
      prevTo: block.to,
    }),
    selection: { anchor: newFrom },
    scrollIntoView: true,
  };
}

/** 뷰에 블록 선택을 적용한다 */
export function applyPick(view: EditorView, index: number, kind: ResolutionKind): void {
  const cfg = view.state.facet(configFacet)[0];
  if (!cfg) {
    return;
  }
  const spec = pickSpec(view.state, cfg.doc, index, kind);
  if (spec) {
    view.dispatch(spec);
  }
}

const configFacet = Facet.define<MergeConfig>();

/** 블록 i 를 사용자가 고른 줄로 바꾼다 (CF-14·15) */
export function applyCustom(view: EditorView, index: number, lines: readonly string[]): void {
  const cfg = view.state.facet(configFacet)[0];
  if (!cfg) {
    return;
  }
  const spec = pickSpec(view.state, cfg.doc, index, 'custom', lines);
  if (spec) {
    view.dispatch(spec);
  }
}

/** 다음/이전 미해결 블록으로 이동 (F8 / Shift-F8, CF-09) */
export function gotoConflict(view: EditorView, delta: 1 | -1): boolean {
  const unresolved = blocksOf(view.state).filter((b) => b.kind === 'unresolved');
  if (unresolved.length === 0) {
    return false;
  }
  const head = view.state.selection.main.head;
  const sorted = [...unresolved].sort((a, b) => a.from - b.from);
  const target =
    delta === 1
      ? (sorted.find((b) => b.from > head) ?? sorted[0])
      : ([...sorted].reverse().find((b) => b.from < head) ?? sorted[sorted.length - 1]);
  if (!target) {
    return false;
  }
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  });
  return true;
}

/** 파일명으로 언어 확장을 찾는다 (없으면 null) */
export async function languageFor(path: string): Promise<Extension | null> {
  const desc = LanguageDescription.matchFilename(languages, path);
  if (!desc) {
    return null;
  }
  try {
    const lang = await desc.load();
    return lang.extension;
  } catch {
    return null;
  }
}

/** tokens.css 변수를 쓰는 테마 */
export const mergeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--merge-font-size, 12px)',
    height: '100%',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--bg-panel)', color: 'var(--fg-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-mg-line-unresolved': {
    backgroundColor: 'color-mix(in srgb, var(--danger) 12%, transparent)',
  },
  '.cm-mg-line-ours': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
  '.cm-mg-line-theirs': { backgroundColor: 'color-mix(in srgb, #2b8a3e 12%, transparent)' },
  '.cm-mg-line-base': { backgroundColor: 'var(--bg-hover)' },
  '.cm-mg-line-bothOursFirst, .cm-mg-line-bothTheirsFirst': {
    backgroundColor: 'color-mix(in srgb, #5f3dc4 10%, transparent)',
  },
  '.cm-mg-line-custom': { backgroundColor: 'var(--diff-word-bg)' },
  '.cm-mg-side-block': { backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  '.cm-mg-pick': {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    padding: '2px 6px',
    fontFamily: 'var(--font-ui)',
    fontSize: 'calc(var(--merge-font-size, 12px) * 11 / 12)',
    background: 'var(--bg-panel)',
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-mg-pick-title': { color: 'var(--fg-muted)', marginRight: '4px' },
  '.cm-mg-pick-btn': {
    font: 'inherit',
    padding: '1px 6px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--bg)',
    color: 'var(--fg)',
    cursor: 'pointer',
  },
  '.cm-mg-pick-btn:disabled': { opacity: '0.5', cursor: 'default' },
});

/**
 * 결과 편집기 확장 묶음. `draft` 가 있으면 그 내용·블록 상태로, `initialText` 가 있으면 블록 추적 없이 그
 * 텍스트로 (이어서 편집) 시작한다
 */
export function createMergeExtensions(
  cfg: MergeConfig,
  opts: {
    onSave?: (view: EditorView) => boolean;
    initialText?: string | null;
    draft?: MergeDraft | null;
  } = {},
): { extensions: Extension; text: string } {
  const built: MergeDraft =
    opts.draft ??
    (opts.initialText == null
      ? buildResultDoc(cfg.doc, [])
      : { text: opts.initialText, ranges: [] });
  const field = createMergeField(cfg, built.ranges);
  const extensions: Extension = [
    configFacet.of(cfg),
    mergeFieldFacet.of(field),
    field,
    history(),
    invertedEffects.of((tr) =>
      tr.effects
        .filter((e) => e.is(pickEffect))
        .map((e) =>
          pickEffect.of({
            index: e.value.index,
            kind: e.value.prevKind,
            prevKind: e.value.kind,
            from: e.value.prevFrom,
            to: e.value.prevTo,
            prevFrom: e.value.from,
            prevTo: e.value.to,
          }),
        ),
    ),
    lineNumbers(),
    syntaxHighlighting(classHighlighter),
    mergeTheme,
    keymap.of([
      { key: 'F8', run: (v) => gotoConflict(v, 1) },
      { key: 'Shift-F8', run: (v) => gotoConflict(v, -1) },
      { key: 'Mod-s', run: (v) => opts.onSave?.(v) ?? false },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ];
  return { extensions, text: built.text };
}

/** 읽기 전용 열 확장 (ours/base/theirs). `blockLines` 는 강조할 줄 범위 */
export function createSideExtensions(
  blockLines: readonly { from: number; to: number }[],
): Extension {
  const deco = EditorView.decorations.compute(['doc'], (state) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const r of blockLines) {
      for (let n = r.from; n <= Math.min(r.to, state.doc.lines); n++) {
        const line = state.doc.line(n);
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-mg-side-block' }));
      }
    }
    return builder.finish();
  });
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    syntaxHighlighting(classHighlighter),
    mergeTheme,
    deco,
  ];
}

/** 테스트·외부에서 상태만 만들 때 */
export function createMergeState(cfg: MergeConfig, initialText?: string | null): EditorState {
  const { extensions, text } = createMergeExtensions(cfg, { initialText });
  const state = EditorState.create({ doc: text, extensions });
  FIELD_KEY.delete(state);
  return state;
}

export type { ConflictOnly };
