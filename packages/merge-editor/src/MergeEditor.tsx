import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AutoSuggestion, BlockClass, ConflictDoc, SideLabels } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyCustom,
  applyPick,
  blocksOf,
  createMergeExtensions,
  createSideExtensions,
  gotoConflict,
  languageFor,
  remainingCount,
} from './editor';
import styles from './MergeEditor.module.css';
import {
  type MergeDraft,
  markerLineNumbers,
  openConflictCount,
  plainDoc,
  type ResolutionKind,
  sideDoc,
  toFileText,
} from './model';

/** 초안을 알리는 최소 간격. 큰 파일에서 글자마다 문서 전체를 복사하지 않게 한다 */
const DRAFT_THROTTLE_MS = 250;

/** 저장 옵션 */
export interface MergeSaveOptions {
  /** 충돌 마커가 남아 있어도 저장한다 (마커가 내용인 fixture 등) */
  allowConflictMarkers: boolean;
}

export interface MergeEditorProps {
  path: string;
  doc: ConflictDoc;
  labels: SideLabels;
  /** 작업 트리의 편집 중이던 내용으로 시작 (이어서). null 이면 블록 문서로 시작 */
  initialText?: string | null;
  /** 이전에 편집하던 초안. 있으면 `initialText` 보다 우선한다 */
  initialDraft?: MergeDraft | null;
  /** 저장. 성공하면 true */
  onSave: (fileText: string, options?: MergeSaveOptions) => Promise<boolean>;
  /** 결과 편집기가 바뀔 때 초안을 알린다 (저장 전 내용 보호) */
  onDraftChange?: (draft: MergeDraft) => void;
  /** 복원한 초안을 버리고 처음부터 */
  onDiscardDraft?: () => void;
  /** 블록 분류·자동 결합 제안 (CF-15) */
  auto?: readonly AutoSuggestion[];
  /** 분류 라벨 문구 */
  classLabel?: (c: BlockClass) => string;
  /** 줄 고르기 (CF-14): 호출자가 UI 를 띄우고 `apply` 로 결과 줄을 넘긴다 */
  onLinePick?: (index: number, apply: (lines: string[]) => void) => void;
}

/** 한 열의 CodeMirror 뷰를 담는 컨테이너 */
function Pane({
  title,
  viewRef,
  className,
}: {
  title: string;
  viewRef: (el: HTMLDivElement | null) => void;
  className?: string;
}) {
  return (
    <div className={`${styles.pane} ${className ?? ''}`}>
      <div className={styles.paneTitle} title={title}>
        {title}
      </div>
      <div className={styles.editor} ref={viewRef} />
    </div>
  );
}

/** 3-way 병합 편집기 (CF-06~10·13): ours·base·theirs 읽기 전용 + 결과 편집. 블록 정렬 스크롤 동기 */
export function MergeEditor({
  path,
  doc,
  labels,
  initialText,
  initialDraft,
  onSave,
  onDraftChange,
  onDiscardDraft,
  auto,
  classLabel,
  onLinePick,
}: MergeEditorProps) {
  const [hideBase, setHideBase] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [markerLeft, setMarkerLeft] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(initialDraft != null);
  const [restored] = useState(initialDraft != null);
  const hosts = useRef<Record<'ours' | 'base' | 'theirs' | 'result', HTMLDivElement | null>>({
    ours: null,
    base: null,
    theirs: null,
    result: null,
  });
  const views = useRef<Partial<Record<'ours' | 'base' | 'theirs' | 'result', EditorView>>>({});
  const anchorsRef = useRef<Partial<Record<'ours' | 'base' | 'theirs' | 'result', number[]>>>({});
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // 위젯 버튼 구성에만 쓰이므로 ref 로 읽어 뷰를 다시 만들지 않는다
  const hideBaseRef = useRef(hideBase);
  hideBaseRef.current = hideBase;
  const onLinePickRef = useRef(onLinePick);
  onLinePickRef.current = onLinePick;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const classLabelRef = useRef(classLabel);
  classLabelRef.current = classLabel;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const docRef = useRef(doc);
  docRef.current = doc;
  // 저장 중 여부·최신 초안은 ref 로 둔다. 상태로 두면 뷰가 다시 만들어져 편집이 사라진다
  const savingRef = useRef(false);
  const draftRef = useRef<MergeDraft | null>(initialDraft ?? null);
  /** 아직 알리지 않은 편집을 바로 알린다 */
  const flushDraftRef = useRef<() => void>(() => {});
  // 블록 추적이 없는 모드 (작업 트리 내용으로 이어서 편집)
  const textMode = initialDraft ? initialDraft.ranges.length === 0 : initialText != null;

  // 편집기 안에서는 LF 만 다룬다. 줄끝은 저장할 때 원본 `doc` 으로 되살린다
  const editorDoc = useMemo(() => plainDoc(doc), [doc]);
  const sides = useMemo(
    () => ({
      ours: sideDoc(editorDoc, 'ours'),
      base: sideDoc(editorDoc, 'base'),
      theirs: sideDoc(editorDoc, 'theirs'),
    }),
    [editorDoc],
  );

  /** 결과 텍스트를 파일 규칙으로 바꿔 저장한다. `allowMarkers` 면 남은 마커도 그대로 저장한다 */
  const save = useCallback(async (allowMarkers = false): Promise<boolean> => {
    const v = views.current.result;
    if (!v || savingRef.current) {
      return false;
    }
    const text = v.state.doc.toString();
    const markers = markerLineNumbers(text);
    if (markers.length > 0 && !allowMarkers) {
      setMarkerLeft(markers);
      gotoConflict(v, 1);
      return false;
    }
    setMarkerLeft([]);
    flushDraftRef.current();
    savingRef.current = true;
    setSaving(true);
    try {
      const fileText = toFileText(text, docRef.current);
      const ok = await onSaveRef.current(
        fileText,
        allowMarkers ? { allowConflictMarkers: true } : undefined,
      );
      if (ok) {
        setDirty(false);
      }
      return ok;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  // 뷰 생성 (문서가 바뀌면 다시)
  useEffect(() => {
    const classLabels: Record<number, string> = {};
    for (const a of autoRef.current ?? []) {
      const label = classLabelRef.current?.(a.class);
      if (label) {
        classLabels[a.index] = label;
      }
    }
    const cfg = {
      doc: editorDoc,
      labels,
      get hideBase() {
        return hideBaseRef.current;
      },
      classLabels,
      pickLabels: {
        both: S.conflict.pickBoth,
        bothReversed: S.conflict.pickBothReversed,
        unresolved: S.conflict.pickUndo,
        linePick: S.assist.linePick,
      },
      onLinePick: onLinePickRef.current
        ? (view: EditorView, index: number) =>
            onLinePickRef.current?.(index, (lines) => applyCustom(view, index, lines))
        : undefined,
    };
    const { extensions, text } = createMergeExtensions(cfg, {
      initialText,
      draft: draftRef.current,
      onSave: () => {
        void save();
        return true;
      },
    });
    /** 남은 충돌 수. 블록 추적이 없으면 텍스트의 마커로 센다 */
    const remainingOf = (state: EditorView['state']) =>
      blocksOf(state).length > 0 ? remainingCount(state) : openConflictCount(state.doc.toString());
    let draftPending = false;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    /** 밀린 편집을 초안으로 알린다 */
    const flushDraft = () => {
      if (!draftPending) {
        return;
      }
      draftPending = false;
      const draft = {
        text: result.state.doc.toString(),
        ranges: blocksOf(result.state),
      };
      draftRef.current = draft;
      onDraftChangeRef.current?.(draft);
    };
    flushDraftRef.current = flushDraft;
    /** 첫 편집은 바로, 이어지는 편집은 묶어서 알린다 */
    const noteEdit = () => {
      draftPending = true;
      if (draftTimer !== null) {
        return;
      }
      flushDraft();
      draftTimer = setTimeout(() => {
        draftTimer = null;
        flushDraft();
      }, DRAFT_THROTTLE_MS);
    };
    const result = new EditorView({
      doc: text,
      extensions: [
        extensions,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setDirty(true);
            setMarkerLeft([]);
            noteEdit();
          }
          if (u.docChanged || u.transactions.some((t) => t.effects.length > 0)) {
            setRemaining(remainingOf(u.state));
          }
        }),
      ],
      parent: hosts.current.result ?? undefined,
    });
    const make = (side: 'ours' | 'base' | 'theirs') =>
      new EditorView({
        doc: sides[side].text,
        extensions: createSideExtensions(sides[side].blockLines),
        parent: hosts.current[side] ?? undefined,
      });
    const ours = make('ours');
    const base = make('base');
    const theirs = make('theirs');
    views.current = { ours, base, theirs, result };
    setRemaining(remainingOf(result.state));

    // 구문 강조는 비동기로 붙인다
    let cancelled = false;
    void languageFor(path).then((ext) => {
      if (!ext || cancelled) {
        return;
      }
      for (const v of [ours, base, theirs, result]) {
        v.dispatch({ effects: StateEffect.appendConfig.of(ext) });
      }
    });

    // 블록 정렬 스크롤 동기: 충돌 블록 시작 줄을 앵커로 구간 비례 매핑
    const anchorLines = (side: 'ours' | 'base' | 'theirs') =>
      sides[side].blockLines.map((b) => b.from);
    const resultAnchors = () =>
      blocksOf(result.state)
        .sort((a, b) => a.from - b.from)
        .map((b) => result.state.doc.lineAt(b.from).number);
    anchorsRef.current = {
      ours: anchorLines('ours'),
      base: anchorLines('base'),
      theirs: anchorLines('theirs'),
    };
    let syncing = false;
    const tops = (v: EditorView, lines: number[]) => {
      const total = v.state.doc.lines;
      const ys = [
        0,
        ...lines.map((n) => v.lineBlockAt(v.state.doc.line(Math.min(n, total)).from).top),
      ];
      ys.push(v.contentHeight);
      return ys;
    };
    const onScroll = (src: EditorView, srcLines: () => number[]) => () => {
      if (syncing) {
        return;
      }
      syncing = true;
      try {
        const sy = tops(src, srcLines());
        const top = src.scrollDOM.scrollTop;
        let i = 0;
        while (i + 1 < sy.length - 1 && (sy[i + 1] ?? 0) <= top) {
          i++;
        }
        const s0 = sy[i] ?? 0;
        const s1 = sy[i + 1] ?? s0 + 1;
        const frac = s1 > s0 ? (top - s0) / (s1 - s0) : 0;
        const all: [EditorView, () => number[]][] = [
          [ours, () => anchorsRef.current.ours ?? []],
          [base, () => anchorsRef.current.base ?? []],
          [theirs, () => anchorsRef.current.theirs ?? []],
          [result, resultAnchors],
        ];
        for (const [v, lines] of all) {
          if (v === src) {
            continue;
          }
          const ty = tops(v, lines());
          const t0 = ty[i] ?? 0;
          const t1 = ty[i + 1] ?? t0;
          v.scrollDOM.scrollTop = t0 + frac * (t1 - t0);
        }
      } finally {
        syncing = false;
      }
    };
    const handlers: [EditorView, () => void][] = [
      [ours, onScroll(ours, () => anchorsRef.current.ours ?? [])],
      [base, onScroll(base, () => anchorsRef.current.base ?? [])],
      [theirs, onScroll(theirs, () => anchorsRef.current.theirs ?? [])],
      [result, onScroll(result, resultAnchors)],
    ];
    for (const [v, h] of handlers) {
      v.scrollDOM.addEventListener('scroll', h, { passive: true });
    }
    return () => {
      cancelled = true;
      if (draftTimer !== null) {
        clearTimeout(draftTimer);
      }
      // 뷰가 사라지기 전에 밀린 편집을 남긴다 (탭 전환·화면 이동·문서 재수신)
      flushDraft();
      flushDraftRef.current = () => {};
      for (const [v, h] of handlers) {
        v.scrollDOM.removeEventListener('scroll', h);
        v.destroy();
      }
      views.current = {};
    };
  }, [editorDoc, labels, path, initialText, sides, save]);

  /** 자동 결합 제안을 미해결 블록에 적용 (CF-15) */
  const applyAuto = () => {
    const v = views.current.result;
    if (!v) {
      return;
    }
    const unresolved = new Set(
      blocksOf(v.state)
        .filter((x) => x.kind === 'unresolved')
        .map((x) => x.index),
    );
    for (const a of auto ?? []) {
      const r = a.resolution;
      if (!r || !unresolved.has(a.index)) {
        continue;
      }
      if (r.kind === 'custom') {
        applyCustom(v, a.index, r.lines);
      } else {
        applyPick(v, a.index, r.kind);
      }
    }
  };
  const autoCount = (auto ?? []).filter((a) => a.resolution).length;

  /** 모든 미해결 블록에 같은 선택 */
  const pickAll = (kind: ResolutionKind) => {
    const v = views.current.result;
    if (!v) {
      return;
    }
    for (const b of blocksOf(v.state).filter((x) => x.kind === 'unresolved')) {
      applyPick(v, b.index, kind);
    }
  };

  const hostRef = (key: 'ours' | 'base' | 'theirs' | 'result') => (el: HTMLDivElement | null) => {
    hosts.current[key] = el;
  };

  return (
    <div className={styles.root} data-hide-base={hideBase ? 'true' : 'false'}>
      <div className={styles.toolbar}>
        <span className={styles.remaining} data-done={remaining === 0 ? 'true' : 'false'}>
          {S.conflict.remaining(remaining)}
        </span>
        <Button
          onClick={() => views.current.result && gotoConflict(views.current.result, -1)}
          title="Shift+F8"
        >
          {S.conflict.prev}
        </Button>
        <Button
          onClick={() => views.current.result && gotoConflict(views.current.result, 1)}
          title="F8"
        >
          {S.conflict.next}
        </Button>
        <span className={styles.sep} />
        <Button onClick={() => pickAll('ours')} disabled={textMode}>
          {S.conflict.allOurs}
        </Button>
        <Button onClick={() => pickAll('theirs')} disabled={textMode}>
          {S.conflict.allTheirs}
        </Button>
        {autoCount > 0 ? (
          <Button onClick={applyAuto} disabled={textMode} variant="primary">
            {S.assist.autoApply(autoCount)}
          </Button>
        ) : null}
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={hideBase}
            onChange={(e) => setHideBase(e.target.checked)}
          />
          {S.conflict.hideBase}
        </label>
        <span className={styles.spacer} />
        {restored ? (
          <span className={styles.restored}>
            {S.conflict.draftRestored}
            {onDiscardDraft ? (
              <Button onClick={onDiscardDraft}>{S.conflict.discardDraft}</Button>
            ) : null}
          </span>
        ) : null}
        {markerLeft.length > 0 ? (
          <>
            <span className={styles.warn}>{S.conflict.markersLeft(markerLeft)}</span>
            <Button disabled={saving} onClick={() => void save(true)}>
              {S.conflict.saveAnyway}
            </Button>
          </>
        ) : null}
        <Button variant="primary" disabled={saving} onClick={() => void save()} title="⌘S">
          {dirty ? S.conflict.saveDirty : S.conflict.save}
        </Button>
      </div>
      <div className={styles.top}>
        <Pane title={labels.ours} viewRef={hostRef('ours')} />
        <Pane title={labels.base} viewRef={hostRef('base')} className={styles.basePane} />
        <Pane title={labels.theirs} viewRef={hostRef('theirs')} />
      </div>
      <div className={styles.bottom}>
        <Pane title={S.conflict.result} viewRef={hostRef('result')} />
      </div>
    </div>
  );
}
