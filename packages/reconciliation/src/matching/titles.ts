import { matchingTitle } from '../identity.js';

// The forms of one title the matcher compares.
//   exact: the long-standing key (NFKC, lower case, recognised publisher suffix
//          removed, punctuation collapsed to single spaces).
//   loose: also decodes HTML entities and ignores spacing.
//   head:  the loose form of what precedes the first bar, when a provider title
//          carries the page's section trail ("Headline | Section | Site").
export type TitleForms = { exact: string; loose: string; head: string | null; cjk: boolean };

const named: Record<string, string> = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body[0] !== '#') return named[body.toLowerCase()] ?? whole;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const withoutSpaces = (key: string) => key.replaceAll(' ', '');
const cjkCharacters = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
// Chinese, Japanese and Korean headlines say as much in far fewer characters.
export function mostlyCjk(key: string): boolean {
  return (key.match(cjkCharacters)?.length ?? 0) * 2 > key.length;
}

export function looseTitle(title: string, site: string): string {
  return withoutSpaces(matchingTitle(decodeEntities(title || ''), site));
}

export function titleForms(title: string, site: string): TitleForms {
  const decoded = decodeEntities(title || '');
  const loose = withoutSpaces(matchingTitle(decoded, site));
  const bar = decoded.search(/[|｜]/);
  const head = bar > 0 ? withoutSpaces(matchingTitle(decoded.slice(0, bar), site)) : '';
  return { exact: matchingTitle(title || '', site), loose, head: head && head !== loose ? head : null, cjk: mostlyCjk(loose) };
}
