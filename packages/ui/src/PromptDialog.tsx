import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button';
import styles from './ConfirmDialog.module.css';
import { DialogItems } from './DialogItems';
import { isImeKey } from './keys';
import { S } from './strings';
import { useNativeDialog } from './use-native-dialog';

/** 입력 필드 하나 */
export interface PromptField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'checkbox' | 'select' | 'password';
  placeholder?: string;
  initial?: string | boolean;
  required?: boolean;
  /** `select` 의 선택지 */
  options?: readonly { value: string; label: string }[];
  /**
   * `checkbox`: 끈 칸 (W19). 체크할 수 없고 늘 빈 칸이며, 확인 결과(`onConfirm` 의 값)에 들지 않는다. 왜 끄는지는
   * `note` 로 보인다
   */
  disabled?: boolean;
  /** 칸 옆에 흐리게 붙는 보조 글자 (끈 칸의 사유 등). 그 칸의 설명(`aria-describedby`)이 된다 */
  note?: string;
  /**
   * 필드 묶음의 제목 (W19). 같은 제목이 이어지는 필드를 제목이 있는 구획(`fieldset`)으로 묶는다 — 옵션 칸과 대상 목록을
   * 나눌 때. 없으면 묶지 않는다 (지금까지의 모양)
   */
  group?: string;
}

/** 지금 값이 확인할 수 없는 사유를 돌려주는 검증 함수. 확인할 수 있으면 null */
export type PromptValidate = (values: Readonly<Record<string, string | boolean>>) => string | null;

export interface PromptDialogProps {
  open: boolean;
  title: string;
  /** 제목 아래 설명 */
  message?: string;
  /** 영향 범위 목록 (tag 이름 등). 설명 아래에 20개까지 보이고 나머지는 "외 N개" (`ConfirmDialog` 와 같은 모양) */
  items?: readonly string[];
  fields: readonly PromptField[];
  confirmLabel?: string;
  /**
   * 되돌릴 수 없는 작업이면 확인 단추를 빨갛게 하고, 체크 칸에서 Enter 를 눌러도 제출하지 않는다 — 칸을 고르다 실수로
   * 실행하지 않게. 기본은 false (지금까지의 동작)
   */
  danger?: boolean;
  /** 확인 외의 두 번째 선택지. 입력값 없이 바로 실행된다 */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /**
   * 필드를 넘는 검증 (W19, 예: 대상 저장소를 하나 이상 체크). 사유를 돌려주면 확인 단추를 끄고 단추 옆에 사유를 보인다
   */
  validate?: PromptValidate;
  /**
   * 지금 값에 따른 경고 한 줄 (막지 않는다 — 예: tag 지울 곳에서 "다시 생길 수 있습니다"). 단추 줄 위에 보인다. 없으면
   * 그리지 않는다 (지금까지의 모양)
   */
  notice?: (values: Readonly<Record<string, string | boolean>>) => string | null;
  onConfirm: (values: Record<string, string | boolean>) => void;
  onCancel: () => void;
}

/** 필드 묶음 하나: 제목(묶지 않은 필드는 null)과 그 안의 필드 (전체 목록에서의 차례 포함) */
export interface PromptFieldSegment {
  group: string | null;
  fields: { field: PromptField; index: number }[];
}

/** 필드를 차례대로 묶는다: 같은 묶음 제목이 이어지는 필드를 한 묶음으로, 제목이 없는 필드는 하나씩 (순서 유지) */
export function promptSegments(fields: readonly PromptField[]): PromptFieldSegment[] {
  const segments: PromptFieldSegment[] = [];
  fields.forEach((field, index) => {
    const group = field.group ?? null;
    const last = segments[segments.length - 1];
    if (group !== null && last && last.group === group) {
      last.fields.push({ field, index });
    } else {
      segments.push({ group, fields: [{ field, index }] });
    }
  });
  return segments;
}

/** 필드의 처음 값. 끈 체크 칸은 초깃값과 상관없이 빈 칸이다 */
function initialValue(f: PromptField): string | boolean {
  if (f.type === 'checkbox' && f.disabled) {
    return false;
  }
  return f.initial ?? (f.type === 'checkbox' ? false : '');
}

/** 확인 결과로 넘길 값: 끈 칸의 값은 뺀다 (체크할 수 없던 것은 고른 것이 아니다) */
export function promptResult(
  fields: readonly PromptField[],
  values: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const off = new Set(fields.filter((f) => f.disabled).map((f) => f.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => !off.has(key)));
}

/**
 * 검증 함수: `keys` 의 체크 칸이 하나도 체크되지 않았으면 `reason` (대상 목록을 다 풀면 확인을 끈다 — 빈 대상이 "전부"로
 * 가지 않게)
 */
export function requireChecked(keys: readonly string[], reason: string): PromptValidate {
  return (values) => (keys.some((key) => values[key] === true) ? null : reason);
}

/** 이름·메시지 등을 입력받는 대화상자. `ConfirmDialog` 와 같은 네이티브 `<dialog>` */
export function PromptDialog({
  open,
  title,
  message,
  items,
  fields,
  confirmLabel,
  danger = false,
  secondaryLabel,
  onSecondary,
  validate,
  notice,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const { ref, dialogProps } = useNativeDialog(open, onCancel);
  const titleId = useId();
  const messageId = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  // 호출자가 인라인 배열을 넘겨도 입력 중에 값이 지워지지 않게 내용으로 비교한다
  const fieldsKey = JSON.stringify(fields.map((f) => [f.key, f.type, f.initial, f.disabled]));

  // biome-ignore lint/correctness/useExhaustiveDependencies: fieldsKey 가 fields 내용을 대신한다
  useEffect(() => {
    if (open) {
      const init: Record<string, string | boolean> = {};
      for (const f of fieldsRef.current) {
        init[f.key] = initialValue(f);
      }
      setValues(init);
    }
  }, [open, fieldsKey]);

  const filled = fields.every((f) => {
    if (!f.required || f.type === 'checkbox') {
      return true;
    }
    const v = values[f.key];
    return typeof v === 'string' && v.trim() !== '';
  });
  const invalid = validate ? validate(values) : null;
  const valid = filled && invalid === null;
  const warning = notice ? notice(values) : null;

  /** 필드 하나 (`index` 는 전체 목록에서의 차례 — 첫 입력 칸이 포커스를 받는다) */
  const renderField = (f: PromptField, index: number) => {
    const id = `pf-${f.key}`;
    const noteId = `${id}-note`;
    return (
      <label
        key={f.key}
        className={styles.field}
        htmlFor={id}
        data-disabled={f.disabled ? 'true' : undefined}
      >
        {f.type === 'checkbox' ? (
          <span className={styles.checkRow}>
            <input
              id={id}
              type="checkbox"
              disabled={f.disabled}
              aria-describedby={f.note ? noteId : undefined}
              checked={!f.disabled && values[f.key] === true}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
              onKeyDown={(e) => {
                // 위험한 대화상자: 체크 칸의 Enter 는 폼 제출(암묵적 제출)로 가지 않는다. keydown 을 막으면 제출을
                // 일으키는 keypress 가 나오지 않는다. 칸 토글은 Space, 실행은 확인 단추로만 한다
                if (danger && e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
            />
            {f.label}
            {f.note ? (
              <span id={noteId} className={styles.note}>
                {f.note}
              </span>
            ) : null}
          </span>
        ) : (
          <>
            <span className={styles.label}>{f.label}</span>
            {f.type === 'select' ? (
              <select
                id={id}
                className={styles.input}
                value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea
                id={id}
                className={styles.input}
                rows={3}
                placeholder={f.placeholder}
                value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            ) : (
              <input
                id={id}
                type={f.type === 'password' ? 'password' : 'text'}
                className={styles.input}
                // biome-ignore lint/a11y/noAutofocus: 대화상자의 첫 입력 칸이다 (필드를 함수로 그려 린트가 <dialog> 조상을 보지 못한다)
                autoFocus={index === 0}
                placeholder={f.placeholder}
                value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                onKeyDown={(e) => {
                  // 한글 조합 중 Enter 는 제출로 보지 않는다 (PoC-4)
                  if (e.key === 'Enter' && isImeKey(e)) {
                    e.preventDefault();
                  }
                }}
              />
            )}
          </>
        )}
      </label>
    );
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      // 제목이 대화상자의 이름, 설명이 설명이 된다 (W19 ③)
      aria-labelledby={titleId}
      aria-describedby={message ? messageId : undefined}
      {...dialogProps}
    >
      <form
        method="dialog"
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) {
            onConfirm(promptResult(fields, values));
          }
        }}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {message ? (
          <p id={messageId} className={styles.message}>
            {message}
          </p>
        ) : null}
        <DialogItems items={items} />
        {promptSegments(fields).flatMap((segment) =>
          segment.group === null
            ? segment.fields.map(({ field, index }) => renderField(field, index))
            : [
                <fieldset key={`group:${segment.fields[0]?.field.key}`} className={styles.group}>
                  <legend className={styles.groupTitle}>{segment.group}</legend>
                  <div className={styles.groupBody}>
                    {segment.fields.map(({ field, index }) => renderField(field, index))}
                  </div>
                </fieldset>,
              ],
        )}
        {warning ? (
          <p className={styles.notice} role="status">
            {warning}
          </p>
        ) : null}
        <div className={styles.actions}>
          {invalid !== null ? (
            <span className={styles.invalid} role="status">
              {invalid}
            </span>
          ) : null}
          <Button type="button" onClick={onCancel}>
            {S.confirm.cancel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button type="button" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            className={danger ? styles.danger : undefined}
            disabled={!valid}
          >
            {confirmLabel ?? S.confirm.ok}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
