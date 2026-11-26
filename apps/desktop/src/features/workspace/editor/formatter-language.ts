/** 파일명으로 내장 포맷터의 파서를 고른다. */
export function formatterParser(path: string): string | null {
  const ext = path.toLowerCase().split('.').at(-1) ?? '';
  return (
    (
      {
        js: 'babel',
        jsx: 'babel',
        mjs: 'babel',
        cjs: 'babel',
        ts: 'typescript',
        tsx: 'typescript',
        mts: 'typescript',
        cts: 'typescript',
        json: 'json',
        jsonc: 'jsonc',
        html: 'html',
        htm: 'html',
        css: 'css',
        scss: 'scss',
        less: 'less',
        md: 'markdown',
        markdown: 'markdown',
        yaml: 'yaml',
        yml: 'yaml',
        java: 'java',
      } as Record<string, string>
    )[ext] ?? null
  );
}
