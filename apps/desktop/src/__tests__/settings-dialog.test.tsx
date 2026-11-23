import type { ExternalApps } from '@mgit/ipc';
import { S, setStringsLocale } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../features/app/AppDialogs';
import { Root } from '../Root';
import { useAppStore } from '../store';
import type { LanguagePreference } from '../store/language';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({ mounts: 0 }));

// 루트 테스트용 앱: 마운트 수를 세고 지금 사전의 문구 하나를 그린다 (네임스페이스로 읽어야 바뀐 사전을 본다)
vi.mock('../App', async () => {
  const react = await import('react');
  const ui = await import('@mgit/ui');
  return {
    App: () => {
      react.useEffect(() => {
        h.mounts += 1;
      }, []);
      return <p>{ui.S.settings.title}</p>;
    },
  };
});

const APPS: ExternalApps = { editor: 'vscode', editorCustom: '', terminal: '', terminalCustom: '' };

/**
 * 설정 대화상자를 연 상태로 스토어를 채운다. 저장·자동 fetch 간격 저장·닫기·언어 바꾸기를 부른 차례를 `order` 에
 * 적는다. `autoFetch` 는 저장돼 있는 자동 fetch 간격(분)이다
 */
function openSettings(language: LanguagePreference, autoFetch = 5) {
  const order: string[] = [];
  const externalAppsSet = vi.fn(async (_apps: ExternalApps) => {
    order.push('save');
  });
  const autoFetchSet = vi.fn(async (minutes: number) => {
    order.push(`autoFetch:${minutes}`);
  });
  const setSettingsOpen = vi.fn((open: boolean) => {
    order.push(`open:${open}`);
    useAppStore.setState({ settingsOpen: open });
  });
  const setLanguage = vi.fn(async (pref: LanguagePreference) => {
    order.push(`language:${pref}`);
  });
  act(() => {
    useAppStore.setState({
      settingsOpen: true,
      language,
      externalAppsGet: async () => APPS,
      externalAppsSet,
      autoFetchGet: async () => autoFetch,
      autoFetchSet,
      setSettingsOpen,
      setLanguage,
    });
  });
  return { order, externalAppsSet, autoFetchSet, setLanguage };
}

/** 대화상자의 자동 fetch 간격 select */
function autoFetchSelect() {
  const dialog = screen.getByRole('dialog', { name: S.settings.title });
  return within(dialog).getByLabelText(S.settings.autoFetch) as HTMLSelectElement;
}

/** 대화상자를 제출한다 */
function submit() {
  fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
}

/** 언어 select 와 대화상자의 select 목록 */
function languageSelect() {
  const dialog = screen.getByRole('dialog', { name: S.settings.title });
  const selects = within(dialog).getAllByRole('combobox') as HTMLSelectElement[];
  const language = within(dialog).getByLabelText(S.settings.language) as HTMLSelectElement;
  return { dialog, selects, language };
}

beforeEach(() => {
  installDialogStub();
  h.mounts = 0;
});
afterEach(() => {
  cleanup();
  removeDialogStub();
  // 다른 테스트는 한국어를 전제로 한다
  setStringsLocale('ko');
  act(() => useAppStore.setState({ settingsOpen: false, uiLocale: 'ko' }));
});

describe('설정 대화상자 (⌘,)', () => {
  it('맨 위에 언어 select 가 있고 지금 선호가 처음 값이며, 그 아래 외부 앱 필드가 그대로 있다', async () => {
    openSettings('en');
    render(<SettingsDialog />);
    await tick();
    const { dialog, selects, language } = languageSelect();
    expect(S.settings.title).toBe('설정');
    expect(selects[0]).toBe(language);
    expect(language.value).toBe('en');
    expect([...language.options].map((o) => [o.value, o.textContent])).toEqual([
      ['system', '시스템 언어 따름'],
      ['ko', '한국어'],
      ['en', 'English'],
    ]);
    expect(within(dialog).getByLabelText('언어 (Language)')).toBe(language);
    expect(within(dialog).getByLabelText(S.external.editor)).toBe(selects[1]);
    expect(within(dialog).getByLabelText(S.external.terminal)).toBe(selects[2]);
    expect(within(dialog).getByLabelText(S.external.customEditor)).toBeTruthy();
    expect(within(dialog).getByLabelText(S.external.customTerminal)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeTruthy();
  });

  it('English 로 저장하면 외부 앱을 먼저 저장하고 대화상자를 닫은 뒤 언어를 바꾼다', async () => {
    const { order, externalAppsSet, setLanguage } = openSettings('system');
    render(<SettingsDialog />);
    await tick();
    const { language } = languageSelect();
    expect(language.value).toBe('system');
    fireEvent.change(language, { target: { value: 'en' } });
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(order).toEqual(['save', 'open:false', 'language:en']);
    expect(externalAppsSet).toHaveBeenCalledWith(APPS);
    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('언어를 그대로 두고 저장하면 언어는 바꾸지 않는다', async () => {
    const { order, setLanguage } = openSettings('ko');
    render(<SettingsDialog />);
    await tick();
    fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    await tick();
    expect(order).toEqual(['save', 'open:false']);
    expect(setLanguage).not.toHaveBeenCalled();
  });

  it('영어 화면에서는 영어로 그리고, 언어 이름은 원어로 둔다', async () => {
    setStringsLocale('en');
    openSettings('system');
    render(<SettingsDialog />);
    await tick();
    const { dialog, language } = languageSelect();
    expect(within(dialog).getByRole('heading').textContent).toBe('Settings');
    expect(within(dialog).getByLabelText('Language')).toBe(language);
    expect([...language.options].map((o) => o.textContent)).toEqual([
      'System default',
      '한국어',
      'English',
    ]);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('설정 대화상자의 자동 fetch 간격', () => {
  it('외부 앱 필드 뒤 맨 아래에 있고, 끔·5·10·15·30·60분 중 저장된 값이 골라져 있다', async () => {
    openSettings('ko', 10);
    render(<SettingsDialog />);
    await tick();
    const { selects } = languageSelect();
    const select = autoFetchSelect();
    expect(selects.indexOf(select)).toBe(3);
    expect(select.value).toBe('10');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['0', '끔'],
      ['5', '5분'],
      ['10', '10분'],
      ['15', '15분'],
      ['30', '30분'],
      ['60', '60분'],
    ]);
  });

  it('저장된 값이 목록에 없으면 그 값을 크기 순서 자리에 더해 보인다', async () => {
    openSettings('ko', 45);
    render(<SettingsDialog />);
    await tick();
    const select = autoFetchSelect();
    expect(select.value).toBe('45');
    expect([...select.options].map((o) => o.value)).toEqual([
      '0',
      '5',
      '10',
      '15',
      '30',
      '45',
      '60',
    ]);
  });

  it('간격을 바꿔 저장하면 외부 앱 다음에 간격을 저장하고 닫는다', async () => {
    const { order, autoFetchSet } = openSettings('ko', 5);
    render(<SettingsDialog />);
    await tick();
    fireEvent.change(autoFetchSelect(), { target: { value: '0' } });
    submit();
    await tick();
    expect(autoFetchSet).toHaveBeenCalledWith(0);
    expect(order).toEqual(['save', 'autoFetch:0', 'open:false']);
  });

  it('간격을 그대로 두고 저장하면 간격은 저장하지 않는다', async () => {
    const { order, autoFetchSet } = openSettings('ko', 30);
    render(<SettingsDialog />);
    await tick();
    submit();
    await tick();
    expect(autoFetchSet).not.toHaveBeenCalled();
    expect(order).toEqual(['save', 'open:false']);
  });

  it('영어 화면에서는 영어 라벨과 분 단위로 쓴다', async () => {
    setStringsLocale('en');
    openSettings('system', 1);
    render(<SettingsDialog />);
    await tick();
    const select = autoFetchSelect();
    expect(within(screen.getByRole('dialog')).getByLabelText('Auto fetch interval')).toBe(select);
    expect([...select.options].map((o) => o.textContent).slice(0, 3)).toEqual([
      'Off',
      '1 minute',
      '5 minutes',
    ]);
  });
});

describe('설정 대화상자의 터미널 안내', () => {
  it('열린 터미널이 있을 때만 언어를 바꾸면 터미널이 새로 시작된다고 알린다', async () => {
    openSettings('system');
    act(() => useAppStore.setState({ terminals: [] }));
    const { unmount } = render(<SettingsDialog />);
    await tick();
    expect(screen.queryByText(S.settings.languageRestartsTerminals)).toBeNull();
    unmount();

    act(() =>
      useAppStore.setState({
        terminals: [{ id: 1, cwd: '/r', title: '', initialInput: null }],
      }),
    );
    render(<SettingsDialog />);
    await tick();
    expect(screen.getByText(S.settings.languageRestartsTerminals)).toBeTruthy();
    act(() => useAppStore.setState({ terminals: [] }));
  });
});

describe('루트의 다시 마운트', () => {
  it('화면 언어(uiLocale)가 바뀌면 앱을 다시 마운트해 새 사전으로 그리고, 같은 값이면 그대로 둔다', () => {
    act(() => useAppStore.setState({ uiLocale: 'ko' }));
    render(<Root />);
    expect(screen.getByText('설정')).toBeTruthy();
    expect(h.mounts).toBe(1);

    act(() => {
      setStringsLocale('en');
      useAppStore.setState({ uiLocale: 'en' });
    });
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(h.mounts).toBe(2);

    act(() => useAppStore.setState({ uiLocale: 'en' }));
    expect(h.mounts).toBe(2);
  });
});
