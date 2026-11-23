import type { ExternalApps } from '@mgit/ipc';
import { ConfirmDialog, PromptDialog, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { bool, raw, str } from '../../components/use-dialogs';
import { useAppStore } from '../../store';
import type { LanguagePreference } from '../../store/language';

/** git·ssh 자격 증명 입력 (AU-01·03). "키체인에 저장" 을 켜면 다음부터 묻지 않는다 */
export function CredentialDialog() {
  const req = useAppStore((s) => s.credentialRequest);
  const reply = useAppStore((s) => s.replyCredential);
  if (!req) {
    return null;
  }
  const kind = (['username', 'password', 'passphrase'].includes(req.kind) ? req.kind : 'other') as
    | 'username'
    | 'password'
    | 'passphrase'
    | 'other';
  return (
    <PromptDialog
      key={req.reqId}
      open
      title={S.credential.title[kind]}
      message={`${S.credential.target(req.target)}\n${req.prompt}`}
      fields={[
        {
          key: 'secret',
          label: S.credential.title[kind],
          type: kind === 'username' ? 'text' : 'password',
          required: true,
        },
        {
          key: 'remember',
          label: S.credential.remember,
          type: 'checkbox',
          initial: kind !== 'other',
        },
      ]}
      confirmLabel={S.credential.submit}
      onConfirm={(v) => void reply(raw(v, 'secret'), bool(v, 'remember'))}
      onCancel={() => void reply(null, false)}
    />
  );
}

/** 미저장 충돌 편집이 있는 탭을 닫기 전 확인 */
export function CloseSessionDialog() {
  const pending = useAppStore((s) => s.closeConfirm);
  const confirm = useAppStore((s) => s.confirmCloseSession);
  const cancel = useAppStore((s) => s.cancelCloseSession);
  if (!pending) {
    return null;
  }
  return (
    <ConfirmDialog
      open
      title={S.dialog.closeWithDrafts(pending.name)}
      message={S.dialog.closeWithDraftsMessage}
      items={pending.paths}
      confirmLabel={S.dialog.closeWithDraftsConfirm}
      danger
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  );
}

const EMPTY: ExternalApps = { editor: '', editorCustom: '', terminal: '', terminalCustom: '' };

/** 언어 select 의 값을 선호로 읽는다. 모르는 값이면 system */
function languageOf(values: Record<string, string | boolean>): LanguagePreference {
  const v = str(values, 'language');
  return v === 'ko' || v === 'en' ? v : 'system';
}

/**
 * 설정 (`⌘,`): 맨 위 화면 언어(다국어 L3), 그 아래 외부 앱(UX-07 — 에디터·터미널 프리셋 또는 직접 입력). 저장하면
 * 외부 앱을 저장하고 대화상자를 닫은 뒤, 언어가 바뀌었으면 언어를 바꾼다 (화면이 다시 마운트되므로 닫은 다음에 바꿔야
 * 대화상자가 다시 뜨지 않는다)
 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const get = useAppStore((s) => s.externalAppsGet);
  const save = useAppStore((s) => s.externalAppsSet);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  // 언어를 바꾸면 화면을 다시 마운트해 열린 터미널이 새 셸로 시작된다. 터미널이 있을 때만 미리 알린다
  const hasTerminals = useAppStore((s) => s.terminals.length > 0);
  const [apps, setApps] = useState<ExternalApps | null>(null);
  useEffect(() => {
    if (open) {
      void get().then(setApps);
    } else {
      setApps(null);
    }
  }, [open, get]);
  if (!open || !apps) {
    return null;
  }
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  return (
    <PromptDialog
      open
      title={S.settings.title}
      message={hasTerminals ? S.settings.languageRestartsTerminals : undefined}
      fields={[
        {
          key: 'language',
          label: S.settings.language,
          type: 'select',
          initial: language,
          options: [
            { value: 'system', label: S.settings.languageSystem },
            { value: 'ko', label: S.settings.languageKo },
            { value: 'en', label: S.settings.languageEn },
          ],
        },
        {
          key: 'editor',
          label: S.external.editor,
          type: 'select',
          initial: apps.editor,
          options: [
            { value: '', label: S.external.auto },
            { value: 'vscode', label: S.external.vscode },
            { value: 'idea', label: S.external.idea },
            { value: 'custom', label: S.external.custom },
          ],
        },
        { key: 'editorCustom', label: S.external.customEditor, initial: apps.editorCustom },
        {
          key: 'terminal',
          label: S.external.terminal,
          type: 'select',
          initial: apps.terminal,
          options: [
            { value: '', label: S.external.auto },
            ...(mac
              ? [
                  { value: 'terminal', label: S.external.terminalApp },
                  { value: 'iterm', label: S.external.iterm },
                ]
              : [{ value: 'wt', label: S.external.wt }]),
            { value: 'custom', label: S.external.custom },
          ],
        },
        { key: 'terminalCustom', label: S.external.customTerminal, initial: apps.terminalCustom },
      ]}
      confirmLabel={S.settings.save}
      onConfirm={(v) => {
        const nextLanguage = languageOf(v);
        void save({
          editor: str(v, 'editor'),
          editorCustom: str(v, 'editorCustom'),
          terminal: str(v, 'terminal'),
          terminalCustom: str(v, 'terminalCustom'),
        }).then(async () => {
          setOpen(false);
          if (nextLanguage !== language) {
            await setLanguage(nextLanguage);
          }
        });
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

export { EMPTY as EMPTY_EXTERNAL_APPS };
