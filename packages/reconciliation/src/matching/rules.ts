import { nonArticleHosts } from '../../../../config/article-rules.js';
// Every threshold and switch of the sample-to-article matcher lives here.
// Turning a rule off, or changing a number, needs no other edit.
export const matchingRules = {
  // Publication times of the sample row and the article must be this close.
  exactWindowMs: 6 * 3600_000,
  relaxedWindowMs: 3 * 3600_000,
  // Copies of one story (for example www and biz hosts) are published together.
  sameStoryMs: 10 * 60_000,
  // Shortest title that may match: characters of the exact key, and characters
  // without spaces for Chinese, Japanese and Korean headlines.
  minTitle: 12,
  minCjkTitle: 6,
  // Shortest title accepted as the cut-off start of a longer one.
  minCut: 60,
  minCjkCut: 20,
  prefixIndex: 20,
  enabled: {
    sameStory: true,
    shortTitle: true,
    normalized: true,
    alternateTitle: true,
    sectionTrail: true,
    cutShort: true,
  },
  // Hosts whose every page is a known non-article shape. A sample row is
  // excluded only when the provider itself names one of these as its source.
  nonArticleHosts,
};

// How a sample row was tied to a fetched article. 'exact' is the original
// title rule; every later name is one relaxed rule in ./title-index.ts.
export type MatchRule = 'url' | 'exact' | 'same_story' | 'short_title' | 'normalized'
  | 'alternate_title' | 'section_trail' | 'cut_short';
export const relaxedRules: readonly MatchRule[] = ['same_story', 'short_title', 'normalized',
  'alternate_title', 'section_trail', 'cut_short'];
