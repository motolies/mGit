import type { Plugin } from 'prettier';
import { format } from 'prettier/standalone';
import { formatterParser } from './formatter-language';

/** 필요한 문법만 불러오며 모든 코드는 앱 번들에서 읽는다. */
async function pluginsFor(parser: string): Promise<Plugin[]> {
  switch (parser) {
    case 'babel':
      return [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')];
    case 'typescript':
      return [await import('prettier/plugins/typescript'), await import('prettier/plugins/estree')];
    case 'json':
    case 'jsonc':
      return [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')];
    case 'html':
      return [await import('prettier/plugins/html')];
    case 'css':
    case 'scss':
    case 'less':
      return [await import('prettier/plugins/postcss')];
    case 'markdown':
      return [await import('prettier/plugins/markdown')];
    case 'yaml':
      return [await import('prettier/plugins/yaml')];
    case 'java': {
      const { Parser } = await import('web-tree-sitter');
      const wasm = (await import('web-tree-sitter/web-tree-sitter.wasm?url')).default;
      await Parser.init({ locateFile: () => wasm });
      return [(await import('prettier-plugin-java')).default];
    }
    default:
      return [];
  }
}
/** 요청 하나를 처리하고 오류도 구조화해 화면으로 돌려준다. */
self.onmessage = async (
  event: MessageEvent<{ text: string; path: string; printWidth: number }>,
) => {
  try {
    const { text, path, printWidth } = event.data;
    const parser = formatterParser(path);
    if (!parser) throw new Error('Unsupported file type');
    const result = await format(text, {
      parser,
      plugins: await pluginsFor(parser),
      printWidth,
      endOfLine: 'lf',
      embeddedLanguageFormatting: 'off',
    });
    self.postMessage({ text: result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
