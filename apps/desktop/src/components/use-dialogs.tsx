import { ConfirmDialog, PromptDialog, type PromptField, type PromptValidate } from '@mgit/ui';
import { useCallback, useRef, useState } from 'react';

interface ConfirmSpec {
  title: string;
  message: string;
  items?: readonly string[];
  confirmLabel?: string;
  danger?: boolean;
}

interface PromptSpec {
  title: string;
  message?: string;
  fields: readonly PromptField[];
  confirmLabel?: string;
  /** 필드를 넘는 검증 (사유를 돌려주면 확인을 끈다, W19) */
  validate?: PromptValidate;
}

/**
 * 확인·입력 대화상자를 Promise 로 쓰는 훅. `element` 를 트리에 두고
 * `confirm(spec)` / `prompt(spec)` 를 await 한다 (취소면 false / null)
 */
export function useDialogs() {
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [promptSpec, setPromptSpec] = useState<PromptSpec | null>(null);
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const promptResolve = useRef<((v: Record<string, string | boolean> | null) => void) | null>(null);

  const confirm = useCallback(
    (spec: ConfirmSpec) =>
      new Promise<boolean>((resolve) => {
        confirmResolve.current = resolve;
        setConfirmSpec(spec);
      }),
    [],
  );

  const prompt = useCallback(
    (spec: PromptSpec) =>
      new Promise<Record<string, string | boolean> | null>((resolve) => {
        promptResolve.current = resolve;
        setPromptSpec(spec);
      }),
    [],
  );

  const element = (
    <>
      <ConfirmDialog
        open={confirmSpec !== null}
        title={confirmSpec?.title ?? ''}
        message={confirmSpec?.message ?? ''}
        items={confirmSpec?.items}
        confirmLabel={confirmSpec?.confirmLabel}
        danger={confirmSpec?.danger}
        onConfirm={() => {
          setConfirmSpec(null);
          confirmResolve.current?.(true);
        }}
        onCancel={() => {
          setConfirmSpec(null);
          confirmResolve.current?.(false);
        }}
      />
      <PromptDialog
        open={promptSpec !== null}
        title={promptSpec?.title ?? ''}
        message={promptSpec?.message}
        fields={promptSpec?.fields ?? []}
        confirmLabel={promptSpec?.confirmLabel}
        validate={promptSpec?.validate}
        onConfirm={(values) => {
          setPromptSpec(null);
          promptResolve.current?.(values);
        }}
        onCancel={() => {
          setPromptSpec(null);
          promptResolve.current?.(null);
        }}
      />
    </>
  );

  return { confirm, prompt, element };
}

/** 문자열 값 꺼내기 */
export function str(values: Record<string, string | boolean>, key: string): string {
  const v = values[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 문자열 값을 다듬지 않고 꺼낸다 (비밀번호처럼 공백도 값인 경우) */
export function raw(values: Record<string, string | boolean>, key: string): string {
  const v = values[key];
  return typeof v === 'string' ? v : '';
}

/** 불리언 값 꺼내기 */
export function bool(values: Record<string, string | boolean>, key: string): boolean {
  return values[key] === true;
}
