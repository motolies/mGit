import { open } from '@tauri-apps/plugin-dialog';

/** 폴더 선택 대화상자를 띄운다. `defaultPath` 가 있으면 그 폴더에서 연다. 취소하면 null */
export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title,
    ...(defaultPath ? { defaultPath } : {}),
  });
  return typeof result === 'string' ? result : null;
}
