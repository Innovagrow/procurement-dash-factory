/**
 * Upwork saved-search / job-feed RSS source. Feed URLs come from RSS_FEED_URLS
 * (each one is an "RSS" link on an Upwork saved search). No auth is needed,
 * which makes this the most reliable fallback when the API app is not approved.
 */

import Parser from 'rss-parser';
import { env } from '../config/env';
import { requestWithRetry } from '../lib/http';
import { toErrorMessage } from '../lib/errors';
import { toIso } from '../lib/time';
import type { RawJob, SourceContext, SourceResult } from '../types';
import { BaseSource, isSourceSelected } from './base';
import {
  collapseWhitespace,
  decodeEntities,
  parseHourlyRange,
  parseMoney,
  safeNormalizeJob,
  stripHtml,
  toStringOrNull,
} from './normalize';

export const SOURCE_NAME = 'rss';
const SOURCE_ALIASES = ['rss_feed', 'feed', 'saved_search'];

const FEED_TIMEOUT_MS = Math.min(env.HTTP_TIMEOUT_MS, 20_000);
const MAX_ITEMS_PER_FEED = 200;

/** The labels Upwork emits inside the RSS description block. */
export const RSS_FIELD_LABELS = [
  'Budget',
  'Hourly Range',
  'Posted On',
  'Category',
  'Skills',
  'Country',
  'Location Requirement',
  'Experience Level',
] as const;

export interface UpworkFieldBlock {
  budgetText: string | null;
  hourlyRangeText: string | null;
  postedOnText: string | null;
  category: string | null;
  skillsText: string | null;
  country: string | null;
  experienceLevel: string | null;
  locationRequirement: string | null;
  /** Everything before the first labelled field, i.e. the job description. */
  lead: string;
}

function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads "<b>Budget</b>: $250" (and the plain-text "Budget: $250" that job-alert
 * emails use) without assuming a particular tag or spacing.
 */
export function readLabelledField(block: string, label: string): string | null {
  const escaped = escapeForRegex(label);

  const tagged = block.match(
    new RegExp(`<(?:b|strong)[^>]*>\\s*${escaped}\\s*<\\/(?:b|strong)>\\s*:?\\s*([^<\\n]*)`, 'i'),
  );
  if (tagged && tagged[1] !== undefined) {
    const value = collapseWhitespace(decodeEntities(tagged[1]));
    if (value !== '') return value;
  }

  const plain = block.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n]+)`, 'i'));
  if (plain && plain[1] !== undefined) {
    const value = collapseWhitespace(decodeEntities(plain[1]));
    if (value !== '') return value;
  }

  return null;
}

/** Splits an Upwork description block (RSS item or email body) into fields. */
export function parseUpworkFieldBlock(block: string): UpworkFieldBlock {
  const labelPattern = RSS_FIELD_LABELS.map(escapeForRegex).join('|');
  const firstLabel = block.search(
    new RegExp(`(?:<(?:b|strong)[^>]*>\\s*(?:${labelPattern})\\s*<\\/(?:b|strong)>|(?:^|\\n)\\s*(?:${labelPattern})\\s*:)`, 'i'),
  );
  const leadHtml = firstLabel > 0 ? block.slice(0, firstLabel) : firstLabel === 0 ? '' : block;

  return {
    budgetText: readLabelledField(block, 'Budget'),
    hourlyRangeText: readLabelledField(block, 'Hourly Range'),
    postedOnText: readLabelledField(block, 'Posted On'),
    category: readLabelledField(block, 'Category'),
    skillsText: readLabelledField(block, 'Skills'),
    country: readLabelledField(block, 'Country'),
    experienceLevel: readLabelledField(block, 'Experience Level'),
    locationRequirement: readLabelledField(block, 'Location Requirement'),
    lead: stripHtml(leadHtml),
  };
}

/** Strips the trailing " - Upwork" and the "…" Upwork appends to feed titles. */
export function cleanFeedTitle(title: string): string {
  return collapseWhitespace(decodeEntities(title))
    .replace(/\s*-\s*Upwork\s*$/i, '')
    .replace(/\s*[.…]{3,}$/, '')
    .trim();
}

function feedItemLink(item: Record<string, unknown>): string | null {
  const direct = toStringOrNull(item.link) ?? toStringOrNull(item.guid) ?? toStringOrNull(item.id);
  if (direct !== null) return direct;

  const content = toStringOrNull(item['content:encoded']) ?? toStringOrNull(item.content);
  if (content === null) return null;
  const href = content.match(/href\s*=\s*["']([^"']*upwork\.com[^"']*)["']/i);
  return href && href[1] ? href[1] : null;
}

function feedItemBlock(item: Record<string, unknown>): string {
  return (
    toStringOrNull(item['content:encoded']) ??
    toStringOrNull(item.content) ??
    toStringOrNull(item.contentSnippet) ??
    toStringOrNull(item.summary) ??
    toStringOrNull(item.description) ??
    ''
  );
}

/** Turns one parsed RSS item into a RawJob, or null when it is not a job link. */
export function mapFeedItem(item: Record<string, unknown>, feedUrl: string): RawJob | null {
  const link = feedItemLink(item);
  if (link === null) return null;

  const block = feedItemBlock(item);
  const fields = parseUpworkFieldBlock(block);
  const hourly = parseHourlyRange(fields.hourlyRangeText);
  const budget = parseMoney(fields.budgetText);

  const postedAt =
    fields.postedOnText ??
    toStringOrNull(item.isoDate) ??
    toStringOrNull(item.pubDate) ??
    toStringOrNull(item.published);

  const rawTitle = toStringOrNull(item.title);
  const title = rawTitle === null ? null : cleanFeedTitle(rawTitle);

  return safeNormalizeJob({
    source: SOURCE_NAME,
    url: link,
    title,
    description: fields.lead,
    postedAt,
    skills: fields.skillsText,
    category: fields.category,
    jobType: hourly.min !== null || hourly.max !== null ? 'HOURLY' : budget !== null ? 'FIXED' : null,
    budgetAmount: budget,
    hourlyMin: hourly.min,
    hourlyMax: hourly.max,
    experienceLevel: fields.experienceLevel,
    client: {
      country: fields.country,
    },
    raw: { feedUrl, item },
  });
}

export class RssSource extends BaseSource {
  private readonly parser: Parser;

  constructor() {
    super({
      name: SOURCE_NAME,
      rateCapacity: 10,
      rateRefillPerSecond: 3,
      breaker: { failureThreshold: 6, cooldownMs: 60_000 },
      cooldownBaseMs: 30_000,
      cooldownMaxMs: 15 * 60_000,
    });
    this.parser = new Parser({ timeout: FEED_TIMEOUT_MS });
  }

  override isEnabled(): boolean {
    return isSourceSelected(SOURCE_NAME, SOURCE_ALIASES) && this.feedUrls().length > 0;
  }

  feedUrls(): string[] {
    return env.RSS_FEED_URLS.filter((url) => /^https?:\/\//i.test(url));
  }

  private async fetchFeed(url: string): Promise<Record<string, unknown>[]> {
    await this.limiter.take();
    const response = await requestWithRetry<string>(
      {
        url,
        method: 'GET',
        responseType: 'text',
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      },
      { label: `GET rss ${url}`, maxRetries: env.HTTP_MAX_RETRIES },
    );

    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    if (body.trim() === '') return [];

    const feed = await this.parser.parseString(body);
    const items = Array.isArray(feed.items) ? feed.items : [];
    return items.slice(0, MAX_ITEMS_PER_FEED) as unknown as Record<string, unknown>[];
  }

  protected override async run(ctx: SourceContext): Promise<SourceResult> {
    const urls = this.feedUrls();
    const byLink = new Map<string, RawJob>();
    const errors: string[] = [];
    const sinceMs = ctx.since ? ctx.since.getTime() : null;
    let newest: Date | null = null;
    let itemsSeen = 0;

    for (const url of urls) {
      try {
        const items = await this.fetchFeed(url);
        itemsSeen += items.length;

        for (const item of items) {
          const job = mapFeedItem(item, url);
          if (!job) continue;

          if (job.postedAt && (newest === null || job.postedAt.getTime() > newest.getTime())) {
            newest = job.postedAt;
          }
          if (sinceMs !== null && job.postedAt && job.postedAt.getTime() <= sinceMs) continue;

          // Dedupe by canonical link: several saved searches overlap heavily.
          const key = job.url.toLowerCase();
          if (!byLink.has(key)) byLink.set(key, job);
        }
      } catch (err) {
        // One broken feed must not sink the others.
        const message = toErrorMessage(err);
        errors.push(`${url}: ${message}`);
        this.log.warn({ err, url }, 'rss feed fetch failed');
      }
    }

    if (errors.length > 0 && errors.length === urls.length) {
      throw new Error(`all ${urls.length} RSS feeds failed: ${errors.join(' | ')}`);
    }

    const jobs = Array.from(byLink.values()).slice(0, ctx.limit);

    return {
      jobs,
      cursor: newest ? toIso(newest) : ctx.cursor,
      meta: {
        feeds: urls.length,
        itemsSeen,
        failedFeeds: errors.length,
        ...(errors.length > 0 ? { errors } : {}),
      },
    };
  }
}

export const rssSource = new RssSource();
