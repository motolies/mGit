import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Parser } from '@lezer/common';

const supportCache = new Map<string, Promise<LanguageSupport | null>>();

/** 코드 펜스의 첫 단어를 기존 언어 이름·별칭과 정확하게 대조한다. */
function descriptionForInfo(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s+/)[0];
  return name ? LanguageDescription.matchLanguageName(languages, name, false) : null;
}

/** 미리보기 코드 블록에서도 파일과 같은 언어 로더를 사용하도록 가상 파일명을 만든다. */
export function languagePath(info: string): string | null {
  const description = descriptionForInfo(info);
  const extension = description?.extensions[0];
  return extension ? `code.${extension}` : null;
}

/** Markdown 여부를 확장자 목록과 동일하게 판정한다. */
export function isMarkdownPath(path: string): boolean {
  return LanguageDescription.matchFilename(languages, path)?.name === 'Markdown';
}

/** 파일 언어를 지연 로드하고 편집기·미리보기·diff에서 같은 지원 객체를 공유한다. */
export function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const description = LanguageDescription.matchFilename(languages, path);
  if (!description) return Promise.resolve(null);
  let cached = supportCache.get(description.name);
  if (!cached) {
    cached = (
      description.name === 'Markdown'
        ? import('@codemirror/lang-markdown').then(({ markdown, markdownLanguage }) =>
            markdown({ base: markdownLanguage, codeLanguages: descriptionForInfo }),
          )
        : description.load()
    ).catch(() => null);
    supportCache.set(description.name, cached);
  }
  return cached;
}

/** 동기 파싱 전에 Markdown 트리에서 실제 펜스 언어를 찾아 모두 로드한다. */
export async function parserFor(
  path: string,
  texts: readonly string[] = [],
): Promise<Parser | null> {
  const support = await loadLanguage(path);
  if (!support) return null;
  const parser = support.language.parser;
  if (isMarkdownPath(path) && texts.length) {
    const descriptions = new Set<LanguageDescription>();
    for (const text of texts) {
      parser.parse(text).iterate({
        enter(node) {
          if (node.name !== 'CodeInfo') return;
          const description = descriptionForInfo(text.slice(node.from, node.to));
          if (description) descriptions.add(description);
        },
      });
    }
    await Promise.all([...descriptions].map((description) => description.load().catch(() => null)));
  }
  return parser;
}
