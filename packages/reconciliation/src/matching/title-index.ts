import { matchingTitle } from '../identity.js';
import { matchingRules as rules, type MatchRule } from './rules.js';
import { looseTitle, mostlyCjk, titleForms } from './titles.js';

type Row = Record<string, any>;
export type TitleRule = Exclude<MatchRule, 'url'>;
export type TitleMatch = { article: Row; rule: TitleRule } | { ambiguous: true } | null;

const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
};
const fetchTime = (article: Row): number => article.fetch_finished_at ?? article.fetched ?? Number.MAX_SAFE_INTEGER;

// Finds the fetched article a provider title refers to. No rule scores
// similarity: each one names an exact, explainable difference between the two
// titles, and every match still needs the same site, close publication times
// and a single story.
export class TitleIndex {
  private readonly exact = new Map<string, Row[]>();
  private relaxed?: {
    loose: Map<string, Row[]>; alternate: Map<string, Row[]>; prefix: Map<string, { title: string; article: Row }[]>;
  };
  // from/to bound the publication times a relaxed rule can accept, so its
  // lookups cover the sample's period, not the whole article history.
  constructor(private readonly articles: Row[], private readonly from: number, private readonly to: number) {
    for (const article of articles) add(this.exact, article.domain + '|' + matchingTitle(article.title || '', article.domain), article);
  }

  find(site: string, title: string, publishedAt: number): TitleMatch {
    const forms = titleForms(title, site), on = rules.enabled;
    const within = (ms: number) => (article: Row) =>
      !!article.published && Math.abs(Date.parse(article.published) - publishedAt) <= ms;
    const sameExact = this.exact.get(site + '|' + forms.exact) || [];
    // The original rule: identical normalized title.
    if (forms.exact.length >= rules.minTitle) {
      const found = this.decide(sameExact.filter(within(rules.exactWindowMs)), 'exact');
      if (found) return found;
    }
    const minimum = (key: string) => mostlyCjk(key) ? rules.minCjkTitle : rules.minTitle;
    if (forms.loose.length < minimum(forms.loose)) return null;
    // A section trail is short next to its headline. "Breaking | Headline" has
    // the label first, so its head is not taken for a whole title.
    const head = forms.head && forms.head.length >= minimum(forms.head) && forms.head.length * 2 >= forms.loose.length
      ? forms.head : null;
    const stages: [boolean, TitleRule, () => Row[]][] = [
      // Identical title that the 12-character minimum, sized for Latin text, turned away.
      [on.shortTitle && forms.exact.length < rules.minTitle, 'short_title', () => sameExact],
      // Same letters and digits; spacing, punctuation or HTML entities differ.
      [on.normalized, 'normalized', () => this.index().loose.get(site + '|' + forms.loose) || []],
      // The provider shows the page's other title (og:title), not its headline.
      [on.alternateTitle, 'alternate_title', () => this.index().alternate.get(site + '|' + forms.loose) || []],
      // The provider title continues with "| Section | Site" after the headline.
      [on.sectionTrail && !!head, 'section_trail', () => [
        ...(this.index().loose.get(site + '|' + head) || []), ...(this.index().alternate.get(site + '|' + head) || [])]],
      // One side was cut at a length limit; the other starts with all of it.
      [on.cutShort, 'cut_short', () => this.cut(site, forms.loose)],
    ];
    const close = within(rules.relaxedWindowMs);
    for (const [enabled, rule, candidates] of stages) {
      if (!enabled) continue;
      const found = this.decide(candidates().filter(close), rule);
      if (found) return found;
    }
    return null;
  }

  // One candidate matches. Several match only when they are copies of one
  // story, published together; otherwise the title is ambiguous and stays unmatched.
  private decide(candidates: Row[], rule: TitleRule): TitleMatch {
    const articles = [...new Set(candidates)];
    if (!articles.length) return null;
    if (articles.length === 1) return { article: articles[0]!, rule };
    if (!rules.enabled.sameStory) return { ambiguous: true };
    const times = articles.map(article => Date.parse(article.published));
    if (Math.max(...times) - Math.min(...times) > rules.sameStoryMs) return { ambiguous: true };
    const first = articles.reduce((best, article) => fetchTime(article) < fetchTime(best) ? article : best);
    return { article: first, rule: rule === 'exact' ? 'same_story' : rule };
  }

  private cut(site: string, title: string): Row[] {
    if (title.length < rules.prefixIndex) return [];
    return (this.index().prefix.get(site + '|' + title.slice(0, rules.prefixIndex)) || []).filter(entry => {
      const [short, long] = entry.title.length < title.length ? [entry.title, title] : [title, entry.title];
      return short.length < long.length && long.startsWith(short)
        && short.length >= (mostlyCjk(short) ? rules.minCjkCut : rules.minCut);
    }).map(entry => entry.article);
  }

  // Built on first use: most sample rows are settled by URL or exact title.
  private index() {
    if (this.relaxed) return this.relaxed;
    const loose = new Map<string, Row[]>(), alternate = new Map<string, Row[]>(),
      prefix = new Map<string, { title: string; article: Row }[]>();
    const addPrefix = (article: Row, title: string) => {
      if (title.length >= rules.prefixIndex) add(prefix, article.domain + '|' + title.slice(0, rules.prefixIndex), { title, article });
    };
    for (const article of this.articles) {
      const published = article.published ? Date.parse(article.published) : NaN;
      if (!(published >= this.from && published <= this.to)) continue;
      const title = looseTitle(article.title || '', article.domain);
      if (title) { add(loose, article.domain + '|' + title, article); addPrefix(article, title); }
      const other = article.alt_title ? looseTitle(article.alt_title, article.domain) : '';
      if (other && other !== title) { add(alternate, article.domain + '|' + other, article); addPrefix(article, other); }
    }
    return this.relaxed = { loose, alternate, prefix };
  }
}
