import { ConfirmDialog, PromptDialog, type PromptField, type PromptValidate } from '@mgit/ui';
import { useCallback, useRef, useState } from 'react';

interface ConfirmSpec {
  title: string;
  message: string;
  items?: readonly string[];
  confirmLabel?: string;
  danger?: boolean;
}

/** 확인과 취소 사이에 둘째 선택지를 더한 확인 (예: "다른 tag 는 건너뛰고 삭제") */
export interface ConfirmChoiceSpec extends ConfirmSpec {
  /** 둘째 선택지 단추의 글자. 취소와 확인 사이에 놓인다 */
  secondaryLabel: string;
}

/** 둘째 선택지가 있는 확인의 결과: 확인 단추 / 둘째 단추 / 취소(Esc·닫기 포함) */
export type ConfirmChoice = 'confirm' | 'secondary' | 'cancel';

interface PromptSpec {
  title: string;
  message?: string;
  /** 영향 범위 목록 (20개까지 보이고 나머지는 "외 N개") */
  items?: readonly string[];
  fields: readonly PromptField[];
  confirmLabel?: string;
  /** 확인 단추를 빨갛게 하고 체크 칸의 Enter 로 제출하지 않는다 (기본 false) */
  danger?: boolean;
  /** 필드를 넘는 검증 (사유를 돌려주면 확인을 끈다, W19) */
  validate?: PromptValidate;
  /** 지금 값에 따른 막지 않는 경고 한 줄 (없으면 그리지 않는다) */
  notice?: (values: Readonly<Record<string, string | boolean>>) => string | null;
}

/**
 * 확인·입력 대화상자를 Promise 로 쓰는 훅. `element` 를 트리에 두고
 * `confirm(spec)` / `confirmChoice(spec)` / `prompt(spec)` 를 await 한다 (취소면 false / 'cancel' / null).
 * `confirm` 과 `confirmChoice` 는 같은 확인 대화상자를 쓴다
 */
export function useDialogs() {
  const [confirmSpec, setConfirmSpec] = useState<
    (ConfirmSpec & { secondaryLabel?: string }) | null
  >(null);
  const [promptSpec, setPromptSpec] = useState<PromptSpec | null>(null);
  const confirmResolve = useRef<((choice: ConfirmChoice) => void) | null>(null);
  const promptResolve = useRef<((v: Record<string, string | boolean> | null) => void) | null>(null);

  /** 확인/취소 두 갈래 확인. 확인이면 true (둘째 단추는 보이지 않는다) */
  const confirm = useCallback(
    (spec: ConfirmSpec) =>
      new Promise<boolean>((resolve) => {
        confirmResolve.current = (choice) => resolve(choice === 'confirm');
        setConfirmSpec({ ...spec, secondaryLabel: undefined });
      }),
    [],
  );

  /** 확인/둘째 선택지/취소 세 갈래 확인. 고른 단추를 돌려준다 */
  const confirmChoice = useCallback(
    (spec: ConfirmChoiceSpec) =>
      new Promise<ConfirmChoice>((resolve) => {
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
        secondaryLabel={confirmSpec?.secondaryLabel}
        onSecondary={() => {
          setConfirmSpec(null);
          confirmResolve.current?.('secondary');
        }}
        onConfirm={() => {
          setConfirmSpec(null);
          confirmResolve.current?.('confirm');
        }}
        onCancel={() => {
          setConfirmSpec(null);
          confirmResolve.current?.('cancel');
        }}
      />
      <PromptDialog
        open={promptSpec !== null}
        title={promptSpec?.title ?? ''}
        message={promptSpec?.message}
        items={promptSpec?.items}
        fields={promptSpec?.fields ?? []}
        confirmLabel={promptSpec?.confirmLabel}
        danger={promptSpec?.danger}
        validate={promptSpec?.validate}
        notice={promptSpec?.notice}
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

  return { confirm, confirmChoice, prompt, element };
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
