import type { OpKind } from '@mgit/ipc';
import { Button, Icon, S } from '@mgit/ui';
import { type CSSProperties, type ReactNode, useId } from 'react';
import { focusPanel } from '../../actions';
import { useRovingGrid } from '../../components/roving';
import { useDialogs } from '../../components/use-dialogs';
import styles from './OpBand.module.css';
import {
  type AbortConfirm,
  ISOLATED_ROW_COLUMNS,
  OP_BAND_MAX_ROWS,
  type OpRowSlot,
  opBandOverflow,
  opControls,
  opRowSlots,
  opSlotColumn,
} from './op-band';

/** 줄 아래에 붙는 상태 (실행 중·결과·막힌 사유) */
export interface OpRowStatus {
  tone: 'info' | 'error';
  text: string;
}

export interface OpRowViewProps {
  kind: OpKind;
  /** 작업 라벨 (`REBASING 2/5`) */
  label: string;
  conflicts: number;
  /** 쓰기가 도는 중: 버튼을 모두 끈다 */
  busy: boolean;
  /**
   * 대상 이름과 색 (여러 대상을 한 띠에 보일 때 — 폴더 탭은 저장소). 없으면 그리지 않는다 (저장소 탭의 띠 — 탭이 그
   * 저장소다)
   */
  subject?: { name: string; color: number | null; title?: string };
  /** 실행할 수 없는 사유 (예: 세션 상한). 있으면 실행 버튼을 끄고 툴팁·상태 줄에 보인다 */
  blocked?: string | null;
  /** 실행 중·결과 상태. 없으면 충돌 수에 따른 안내를 보인다 */
  status?: OpRowStatus | null;
  /** 중단 확인창 (`abortConfirm`). 확인하면 `onAbort` */
  abortConfirm: AbortConfirm;
  /**
   * "충돌 해결" (충돌이 있을 때): 있으면 버튼과 충돌 수 버튼이 생긴다. 무엇을 여는지는 컨테이너가 정한다
   */
  onResolve?: () => void;
  /** "충돌 해결" 의 툴팁 */
  resolveTitle?: string;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}

/**
 * 진행 중인 작업 한 줄 (MRG-05, WS-10): 라벨, (대상 이름), 충돌 안내 또는 상태, 충돌 해결·Continue·Skip·Abort.
 * props 전용이다 — 저장소 탭의 띠(`RepoOpBand`, W21)와 폴더 탭의 띠(`FolderOpBand`)가 같은 조건(`opControls`)·같은 확인창으로
 * 그린다. Abort 는 확인창을 거친다
 */
export function OpRowView({
  kind,
  label,
  conflicts,
  busy,
  subject,
  blocked = null,
  status = null,
  abortConfirm,
  onResolve,
  resolveTitle,
  onContinue,
  onSkip,
  onAbort,
}: OpRowViewProps) {
  const dialogs = useDialogs();
  const baseId = useId();
  const c = opControls(kind, conflicts, busy);
  const stopped = blocked !== null;
  const shown: OpRowStatus | null = status ?? (stopped ? { tone: 'error', text: blocked } : null);
  const slots = new Set(
    opRowSlots({
      kind,
      conflicts,
      subject: subject !== undefined,
      resolvable: onResolve !== undefined,
    }),
  );
  /**
   * 칸 표시: 여러 줄 띠의 격자에서 놓일 열 (한 줄 배너는 열 없이 차례대로 그린다 — 격자가 아니면 무시된다). `data-col` 은
   * 띠 안 ↑↓ 이동이 같은 열의 단추를 찾는 데 쓴다 (W27)
   */
  const at = (slot: OpRowSlot) => ({
    'data-slot': slot,
    'data-col': opSlotColumn(slot),
    style: { gridColumn: opSlotColumn(slot) } as CSSProperties,
  });
  // 줄은 "(대상 이름 +) 작업 라벨" 이름의 묶음이다 (W19 ③). 여러 대상의 띠는 단추마다 대상 이름을 설명으로 붙인다 —
  // 보조 기술이 줄마다 "Abort" 만 읽지 않게
  const subjectId = `${baseId}-subject`;
  const labelId = `${baseId}-label`;
  const named = subject !== undefined && slots.has('subject');
  const describe = named ? { 'aria-describedby': subjectId } : {};
  return (
    // biome-ignore lint/a11y/useSemanticElements: 줄은 격자(subgrid)의 한 줄이라 fieldset 의 테두리·legend 배치를 쓸 수 없다
    <div
      className={styles.row}
      data-op-row=""
      data-busy={busy ? 'true' : 'false'}
      role="group"
      aria-labelledby={named ? `${subjectId} ${labelId}` : labelId}
    >
      {subject && slots.has('subject') ? (
        <span className={styles.subject} title={subject.title ?? subject.name} {...at('subject')}>
          {subject.color === null ? null : (
            <span
              className={styles.swatch}
              style={{ '--repo-color': `var(--graph-lane-${subject.color})` } as CSSProperties}
            />
          )}
          <span id={subjectId} className={styles.name}>
            {subject.name}
          </span>
        </span>
      ) : null}
      <span id={labelId} className={styles.label} {...at('label')}>
        {label}
      </span>
      {onResolve && slots.has('count') ? (
        <button
          type="button"
          className={styles.count}
          onClick={onResolve}
          title={resolveTitle}
          disabled={busy}
          {...describe}
          {...at('count')}
        >
          <Icon name="warning" />
          {S.opBand.conflicts(conflicts)}
        </button>
      ) : null}
      <span
        className={styles.hint}
        data-tone={shown?.tone ?? 'info'}
        title={shown?.text ?? c.hint}
        role={shown ? 'status' : undefined}
        {...at('hint')}
      >
        {shown?.text ?? c.hint}
      </span>
      <span className={styles.actions}>
        {onResolve && slots.has('resolve') ? (
          <Button
            size="compact"
            disabled={busy}
            onClick={onResolve}
            title={resolveTitle}
            {...describe}
            {...at('resolve')}
          >
            {S.opBand.resolve}
          </Button>
        ) : null}
        {/* 꺼진 단추는 툴팁이 뜨지 않는 웹뷰가 있어 사유는 감싼 칸에 단다 */}
        <span title={blocked ?? c.continueReason ?? undefined} {...at('continue')}>
          <Button
            size="compact"
            variant="primary"
            disabled={c.continueDisabled || stopped}
            onClick={() => onContinue()}
            {...describe}
          >
            {S.op.continueLabel}
          </Button>
        </span>
        {slots.has('skip') ? (
          <Button
            size="compact"
            disabled={busy || stopped}
            onClick={() => onSkip()}
            {...describe}
            {...at('skip')}
          >
            {S.op.skip}
          </Button>
        ) : null}
        <Button
          size="compact"
          {...describe}
          disabled={busy || stopped}
          onClick={() =>
            void dialogs.confirm(abortConfirm).then((ok) => {
              if (ok) {
                onAbort();
              }
            })
          }
          {...at('abort')}
        >
          {S.op.abort}
        </Button>
      </span>
      {dialogs.element}
    </div>
  );
}

export interface IsolatedRowViewProps {
  /** 격리 병합의 임시 branch */
  branch: string;
  /** "메인에 반영"을 막는 사유 (`isolatedRow`). 있으면 단추를 끄고 감싼 칸의 툴팁으로 보인다 */
  applyBlocked: string | null;
  /** "버리기" 확인창 (`isolatedDiscardConfirm`). 확인하면 `onDiscard` */
  discardConfirm: AbortConfirm;
  onApply: () => void;
  onDiscard: () => void;
}

/**
 * 격리 병합 줄 (W21, 계획 7.2절 — 옛 사이드바의 격리 병합 띠): [격리] 칩, 안내("격리 병합 중 (branch)"), 메인에 반영,
 * 버리기. 작업 줄과 같은 띠의 격자에 놓인다 — 반영은 Continue 열, 버리기는 Abort 열 (`ISOLATED_ROW_COLUMNS`). 격리는
 * 위험이 아니라 모드라 배경은 중립, 칩은 강조 색 테두리다. 버리기는 확인창을 거친다. props 전용
 */
export function IsolatedRowView({
  branch,
  applyBlocked,
  discardConfirm,
  onApply,
  onDiscard,
}: IsolatedRowViewProps) {
  const dialogs = useDialogs();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;
  const text = S.preview.isolatedBanner(branch);
  /** 칸이 놓일 띠의 열 (`data-slot` 은 격리 줄의 이름, 열은 작업 줄과 공유) */
  const at = (slot: keyof typeof ISOLATED_ROW_COLUMNS) => ({
    'data-slot': slot,
    'data-col': opSlotColumn(ISOLATED_ROW_COLUMNS[slot]),
    style: { gridColumn: opSlotColumn(ISOLATED_ROW_COLUMNS[slot]) } as CSSProperties,
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: 줄은 격자(subgrid)의 한 줄이라 fieldset 의 테두리·legend 배치를 쓸 수 없다
    <div
      className={styles.row}
      data-op-row=""
      data-tone="mode"
      role="group"
      aria-labelledby={`${labelId} ${hintId}`}
    >
      <span id={labelId} className={styles.label} {...at('label')}>
        {S.opBand.isolatedLabel}
      </span>
      <span id={hintId} className={styles.hint} title={text} {...at('hint')}>
        {text}
      </span>
      <span className={styles.actions}>
        {/* 꺼진 단추는 툴팁이 뜨지 않는 웹뷰가 있어 사유는 감싼 칸에 단다 (Continue 와 같다) */}
        <span title={applyBlocked ?? undefined} {...at('apply')}>
          <Button size="compact" disabled={applyBlocked !== null} onClick={() => onApply()}>
            {S.preview.isolatedApply}
          </Button>
        </span>
        <Button
          size="compact"
          onClick={() =>
            void dialogs.confirm(discardConfirm).then((ok) => {
              if (ok) {
                onDiscard();
              }
            })
          }
          {...at('discard')}
        >
          {S.preview.isolatedDiscard}
        </Button>
      </span>
      {dialogs.element}
    </div>
  );
}

/**
 * 띠가 통째로 사라질 때(작업이 끝남) 그 안에 있던 키보드 포커스를 받을 곳 (W27): 로그(⌘9 와 같은 대상 — 로그 탭이 보일
 * 때), 로그가 없으면 에디터 공간 (⌘2 와 같은 대상). 포커스가 body 로 빠지지 않게 한다
 */
function focusAfterBand(): void {
  const log = document.querySelector('[data-panel="git-log"]');
  focusPanel(log && !log.closest('[inert]') ? 'git-log' : 'editor');
}

/**
 * 진행 중인 작업 띠 (WS-10): 줄을 세로로 쌓는다. `OP_BAND_MAX_ROWS` 줄까지 보이고 넘치면 띠 안에서 스크롤한다 (화면
 * 틀을 밀어내지 않게). 줄이 없으면 아무것도 그리지 않는다 — 자리를 차지하지 않는다. 줄들은 한 격자의 열을 나눠 쓴다
 * (W19, `OP_ROW_SLOTS`) — 대상 이름·라벨·충돌 수·단추가 줄마다 같은 열에 놓인다
 */
export function OpBandView({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) {
    return null;
  }
  return <OpBandSection count={count}>{children}</OpBandSection>;
}

/**
 * 띠 요소 (W27 — 띠가 있을 때만 마운트한다: 띠가 사라질 때 그 안의 포커스를 옮기려고). 띠 전체가 Tab 정지 하나다
 * (`useRovingGrid` — 줄 안 ←→·Home·End, 줄 사이 ↑↓, 꺼진 단추는 건너뛴다). 누른 단추가 꺼지거나 그 줄이 사라지면 포커스를
 * 띠에 두고, 띠가 사라지면 로그(없으면 에디터)로 옮긴다. 두 탭의 띠가 같은 규칙이다
 */
function OpBandSection({ count, children }: { count: number; children: ReactNode }) {
  const roving = useRovingGrid<HTMLElement>({ row: '[data-op-row]', onFocusLost: focusAfterBand });
  const { hidden } = opBandOverflow(count);
  return (
    <section
      ref={roving.ref}
      className={styles.band}
      aria-label={S.opBand.label}
      title={hidden > 0 ? S.opBand.more(count) : undefined}
      data-overflow={hidden > 0 ? 'true' : 'false'}
      style={{ '--op-band-rows': OP_BAND_MAX_ROWS } as CSSProperties}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      onBlur={roving.onBlur}
    >
      {children}
    </section>
  );
}
