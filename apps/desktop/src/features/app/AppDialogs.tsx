import type { ExternalApps } from '@mgit/ipc';
import { Button, ConfirmDialog, PromptDialog, type PromptField, S } from '@mgit/ui';
import { useEffect, useId, useState } from 'react';
import type { Action } from '../../actions';
import { tabNavigationIndex } from '../../components/tab-navigation';
import { bool, raw, str } from '../../components/use-dialogs';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';
import { getEditorPreferences, setEditorPreferences } from '../../store/editor-preferences';
import type { LanguagePreference } from '../../store/language';
import { draftActions, hasShortcutConflicts, ShortcutSettings } from './ShortcutsDialog';
import styles from './ShortcutsDialog.module.css';

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
  const many = useAppStore((s) => s.closeTabsConfirm);
  const confirm = useAppStore((s) => s.confirmCloseSession);
  const cancel = useAppStore((s) => s.cancelCloseSession);
  if (!pending && !many) {
    return null;
  }
  return (
    <ConfirmDialog
      open
      title={
        many
          ? S.toolbar.closeTabsTitle(many.targets.length)
          : S.dialog.closeWithDrafts(pending?.name ?? '')
      }
      message={many ? S.toolbar.closeTabsMessage : S.dialog.closeWithDraftsMessage}
      items={
        many
          ? [...many.targets.map((id) => many.identities[id]?.name ?? String(id)), ...many.risks]
          : pending?.paths
      }
      expandableItems
      confirmLabel={many ? S.toolbar.closeTabsConfirm : S.dialog.closeWithDraftsConfirm}
      danger
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  );
}

const EMPTY: ExternalApps = { editor: '', editorCustom: '', terminal: '', terminalCustom: '' };

/** 자동 fetch 간격 select 의 기본 선택지 (분, 0 = 끔) */
const AUTO_FETCH_CHOICES: readonly number[] = [0, 5, 10, 15, 30, 60];

/** 언어 select 의 값을 선호로 읽는다. 모르는 값이면 system */
function languageOf(values: Record<string, string | boolean>): LanguagePreference {
  const v = str(values, 'language');
  return v === 'ko' || v === 'en' ? v : 'system';
}

/**
 * 자동 fetch 간격 select 의 선택지: 끔·5·10·15·30·60분. 저장된 값이 목록에 없으면(1440분 이하의 다른 값) 그 값도 크기
 * 순서 자리에 더해 지금 값이 보이게 한다
 */
export function autoFetchOptions(saved: number): { value: string; label: string }[] {
  const minutes = AUTO_FETCH_CHOICES.includes(saved)
    ? AUTO_FETCH_CHOICES
    : [...AUTO_FETCH_CHOICES, saved].sort((a, b) => a - b);
  return minutes.map((m) => ({
    value: String(m),
    label: m === 0 ? S.settings.autoFetchOff : S.settings.autoFetchMinutes(m),
  }));
}

/** 설정 대화상자를 열 때 읽는 값: 외부 앱과 자동 fetch 간격(분) */
interface SettingsValues {
  apps: ExternalApps;
  autoFetch: number;
}

/** 일반·단축키를 같은 대화상자에서 편집한다. 닫힌 뒤 도착한 조회 결과는 버린다. */
export function SettingsDialog({ actions = [] }: { actions?: readonly Action[] }) {
  const open = useAppStore((s) => s.settingsOpen);
  const get = useAppStore((s) => s.externalAppsGet);
  const getAutoFetch = useAppStore((s) => s.autoFetchGet);
  const [loaded, setLoaded] = useState<SettingsValues | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (open) {
      void Promise.all([get(), getAutoFetch()]).then(([apps, autoFetch]) => {
        if (!cancelled) setLoaded({ apps, autoFetch });
      });
    } else setLoaded(null);
    return () => {
      cancelled = true;
    };
  }, [open, get, getAutoFetch]);
  return open && loaded ? <SettingsForm actions={actions} initial={loaded} /> : null;
}

/** 일반 설정과 단축키의 초안을 유지하고 저장 성공 후에만 대화상자를 닫는다. */
function SettingsForm({
  actions,
  initial,
}: {
  actions: readonly Action[];
  initial: SettingsValues;
}) {
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const initialPage = useAppStore((s) => s.settingsPage);
  const [page, setPage] = useState(initialPage);
  const overrides = useAppStore((s) => s.shortcutOverrides);
  const setOverrides = useAppStore((s) => s.setShortcutOverrides);
  const [draft, setDraft] = useState(() => ({ ...overrides }));
  const save = useAppStore((s) => s.externalAppsSet);
  const saveAutoFetch = useAppStore((s) => s.autoFetchSet);
  const initialLanguage = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const hasTerminals = useAppStore((s) => s.terminals.length > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useModal(true);
  const titleId = useId();
  const generalId = useId();
  const shortcutsId = useId();
  const { apps } = initial;
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const editorPrefs = getEditorPreferences();
  const fields: readonly PromptField[] = [
    {
      key: 'printWidth',
      label: S.fileEditor.printWidth,
      initial: String(editorPrefs.printWidth),
      required: true,
    },
    {
      key: 'formatOnSave',
      label: S.fileEditor.formatOnSave,
      type: 'checkbox',
      initial: editorPrefs.formatOnSave,
    },
    {
      key: 'currentBlame',
      label: S.fileEditor.currentBlame,
      type: 'checkbox',
      initial: editorPrefs.currentBlame,
    },
    {
      key: 'allBlame',
      label: S.fileEditor.allBlame,
      type: 'checkbox',
      initial: editorPrefs.allBlame,
    },
    {
      key: 'changeMarkers',
      label: S.fileEditor.changeMarkers,
      type: 'checkbox',
      initial: editorPrefs.changeMarkers,
    },
    {
      key: 'language',
      label: S.settings.language,
      type: 'select',
      initial: initialLanguage,
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
    {
      key: 'autoFetch',
      label: S.settings.autoFetch,
      type: 'select',
      initial: String(initial.autoFetch),
      options: autoFetchOptions(initial.autoFetch),
    },
  ];
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.initial ?? ''])),
  );
  const conflicts = hasShortcutConflicts(draftActions(actions, draft));

  /** 일반 설정 저장 후 단축키를 반영하고, 언어 변경은 창을 닫은 뒤 적용한다. */
  const submit = async () => {
    if (saving || conflicts) return;
    const width = Number(str(values, 'printWidth'));
    if (!Number.isInteger(width) || width < 40 || width > 1000) {
      setError(S.fileEditor.printWidth);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await save({
        editor: str(values, 'editor'),
        editorCustom: str(values, 'editorCustom'),
        terminal: str(values, 'terminal'),
        terminalCustom: str(values, 'terminalCustom'),
      });
      const nextAutoFetch = Number(str(values, 'autoFetch') || initial.autoFetch);
      if (Number.isInteger(nextAutoFetch) && nextAutoFetch !== initial.autoFetch)
        await saveAutoFetch(nextAutoFetch);
      if (JSON.stringify(draft) !== JSON.stringify(overrides)) setOverrides(draft);
      setEditorPreferences({
        printWidth: width,
        formatOnSave: bool(values, 'formatOnSave'),
        currentBlame: bool(values, 'currentBlame'),
        allBlame: bool(values, 'allBlame'),
        changeMarkers: bool(values, 'changeMarkers'),
      });
      setOpen(false);
      const nextLanguage = languageOf(values);
      if (nextLanguage !== initialLanguage) await setLanguage(nextLanguage);
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={() => setOpen(false)}
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
    >
      <form
        className={styles.box}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId} className={styles.title}>
          {S.settings.title}
        </h2>
        <div className={styles.header} role="tablist" aria-label={S.settings.title}>
          {(['general', 'shortcuts'] as const).map((tab, index) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${tab === 'general' ? generalId : shortcutsId}-tab`}
              aria-controls={tab === 'general' ? generalId : shortcutsId}
              aria-selected={page === tab}
              tabIndex={page === tab ? 0 : -1}
              className={styles.pageTab}
              onClick={() => setPage(tab)}
              onKeyDown={(event) => {
                const nextIndex = tabNavigationIndex(event, index, 2);
                if (nextIndex !== null) {
                  event.preventDefault();
                  const next = nextIndex === 0 ? 'general' : 'shortcuts';
                  setPage(next);
                  document
                    .getElementById(`${next === 'general' ? generalId : shortcutsId}-tab`)
                    ?.focus();
                }
              }}
            >
              {tab === 'general' ? S.settings.general : S.shortcuts.title}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={generalId}
          aria-labelledby={`${generalId}-tab`}
          hidden={page !== 'general'}
          className={styles.general}
        >
          {hasTerminals ? (
            <p className={styles.hint}>{S.settings.languageRestartsTerminals}</p>
          ) : null}
          {fields.map((field) => (
            <label key={field.key} className={styles.field} htmlFor={`${generalId}-${field.key}`}>
              <span>{field.label}</span>
              {field.type === 'checkbox' ? (
                <input
                  id={`${generalId}-${field.key}`}
                  type="checkbox"
                  checked={values[field.key] === true}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })}
                />
              ) : field.type === 'select' ? (
                <select
                  id={`${generalId}-${field.key}`}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${generalId}-${field.key}`}
                  type={field.key === 'printWidth' ? 'number' : 'text'}
                  min={field.key === 'printWidth' ? 40 : undefined}
                  max={field.key === 'printWidth' ? 1000 : undefined}
                  step={field.key === 'printWidth' ? 1 : undefined}
                  required={field.required}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                />
              )}
            </label>
          ))}
        </div>
        <div
          role="tabpanel"
          id={shortcutsId}
          className={styles.pagePanel}
          aria-labelledby={`${shortcutsId}-tab`}
          hidden={page !== 'shortcuts'}
        >
          <ShortcutSettings
            actions={actions}
            draft={draft}
            onChange={setDraft}
            active={page === 'shortcuts'}
          />
        </div>
        {conflicts ? (
          <p role="status" className={styles.error}>
            {S.shortcuts.saveConflict}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <footer className={styles.footer}>
          <Button onClick={() => setOpen(false)} disabled={saving}>
            {S.confirm.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={saving || conflicts}>
            {S.settings.save}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}

export { EMPTY as EMPTY_EXTERNAL_APPS };
