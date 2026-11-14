/**
 * Search engines and AI crawlers, recognised by the token in their user agent. Used by the Worker to
 * record crawler visits, by the dashboard to name them, and by the server snippet in Settings to decide
 * which requests to report.
 *
 *  answers   fetched because a person asked an AI assistant something (ChatGPT, Claude, Perplexity…)
 *  indexing  search indexes, classic and AI (Google, Bing, ChatGPT search…)
 *  training  collecting pages to train models (GPTBot, ClaudeBot, Common Crawl…)
 *
 * Only crawlers that identify themselves are recognised; a bot pretending to be a browser looks like one.
 */
export type CrawlKind = 'answers' | 'indexing' | 'training';

export interface Crawler {
  /** The token in the user agent, e.g. "GPTBot". */
  agent: string;
  /** What to call it on the dashboard. */
  name: string;
  kind: CrawlKind;
  /** Whose it is, for its icon. */
  domain: string;
}

export const CRAWL_KINDS: { kind: CrawlKind; label: string; about: string }[] = [
  { kind: 'answers', label: 'AI answers', about: 'Pages fetched because someone asked an AI assistant about them.' },
  { kind: 'indexing', label: 'Indexing', about: 'Search engines, classic and AI, adding pages to their index.' },
  { kind: 'training', label: 'Training', about: 'Crawlers collecting pages to train AI models.' },
];

export const CRAWLERS: Crawler[] = [
  // AI answers: a person's question made the assistant open the page.
  { agent: 'ChatGPT-User', name: 'ChatGPT', kind: 'answers', domain: 'openai.com' },
  { agent: 'Claude-User', name: 'Claude', kind: 'answers', domain: 'claude.ai' },
  { agent: 'Perplexity-User', name: 'Perplexity', kind: 'answers', domain: 'perplexity.ai' },
  { agent: 'MistralAI-User', name: 'Mistral', kind: 'answers', domain: 'mistral.ai' },
  { agent: 'DuckAssistBot', name: 'DuckDuckGo AI', kind: 'answers', domain: 'duckduckgo.com' },
  { agent: 'meta-externalfetcher', name: 'Meta AI', kind: 'answers', domain: 'meta.ai' },

  // Indexing: search, classic and AI.
  { agent: 'OAI-SearchBot', name: 'ChatGPT search', kind: 'indexing', domain: 'openai.com' },
  { agent: 'Claude-SearchBot', name: 'Claude search', kind: 'indexing', domain: 'claude.ai' },
  { agent: 'PerplexityBot', name: 'Perplexity', kind: 'indexing', domain: 'perplexity.ai' },
  { agent: 'Googlebot', name: 'Google', kind: 'indexing', domain: 'google.com' },
  { agent: 'GoogleOther', name: 'Google (other)', kind: 'indexing', domain: 'google.com' },
  { agent: 'bingbot', name: 'Bing', kind: 'indexing', domain: 'bing.com' },
  { agent: 'DuckDuckBot', name: 'DuckDuckGo', kind: 'indexing', domain: 'duckduckgo.com' },
  { agent: 'Applebot', name: 'Apple', kind: 'indexing', domain: 'apple.com' },
  { agent: 'YandexBot', name: 'Yandex', kind: 'indexing', domain: 'yandex.com' },
  { agent: 'Baiduspider', name: 'Baidu', kind: 'indexing', domain: 'baidu.com' },
  { agent: 'YouBot', name: 'You.com', kind: 'indexing', domain: 'you.com' },
  { agent: 'PetalBot', name: 'Petal', kind: 'indexing', domain: 'aspiegel.com' },

  // Training.
  { agent: 'GPTBot', name: 'OpenAI', kind: 'training', domain: 'openai.com' },
  { agent: 'ClaudeBot', name: 'Anthropic', kind: 'training', domain: 'anthropic.com' },
  { agent: 'anthropic-ai', name: 'Anthropic', kind: 'training', domain: 'anthropic.com' },
  { agent: 'CCBot', name: 'Common Crawl', kind: 'training', domain: 'commoncrawl.org' },
  { agent: 'Bytespider', name: 'ByteDance', kind: 'training', domain: 'bytedance.com' },
  { agent: 'meta-externalagent', name: 'Meta', kind: 'training', domain: 'meta.com' },
  { agent: 'Amazonbot', name: 'Amazon', kind: 'training', domain: 'amazon.com' },
  { agent: 'cohere-ai', name: 'Cohere', kind: 'training', domain: 'cohere.com' },
  { agent: 'cohere-training-data-crawler', name: 'Cohere', kind: 'training', domain: 'cohere.com' },
  { agent: 'Diffbot', name: 'Diffbot', kind: 'training', domain: 'diffbot.com' },
  { agent: 'AI2Bot', name: 'Ai2', kind: 'training', domain: 'allenai.org' },
  { agent: 'Timpibot', name: 'Timpi', kind: 'training', domain: 'timpi.io' },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest tokens first, so "cohere-training-data-crawler" wins over "cohere-ai"-style prefixes.
const ORDERED = [...CRAWLERS].sort((a, b) => b.agent.length - a.agent.length);

/** The alternation that matches any known crawler, for the server snippet's pre-check. */
export const CRAWLER_PATTERN = ORDERED.map((c) => escape(c.agent)).join('|');
const RE = new RegExp(CRAWLER_PATTERN, 'i');
const BY_AGENT = new Map(CRAWLERS.map((c) => [c.agent.toLowerCase(), c]));

/** The crawler a user agent belongs to, or null for a browser or an unknown bot. */
export function crawlerFor(userAgent: string | null | undefined): Crawler | null {
  const m = userAgent ? RE.exec(userAgent) : null;
  return m ? BY_AGENT.get(m[0].toLowerCase()) ?? null : null;
}

/** Dashboard lookup by the stored agent token. */
export function crawlerByAgent(agent: string): Crawler | undefined {
  return BY_AGENT.get(agent.toLowerCase());
}
