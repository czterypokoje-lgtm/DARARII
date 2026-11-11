import { createClient } from '@supabase/supabase-js';
import { buildAdsFeed, checkAdsFeedAuth, CLICK_WINDOW_DAYS, type FeedJobRow } from '@/lib/adsConversionsFeed';
import { logOps } from '@/lib/opsAuth';

/**
 * Daily offline-conversion file for Google Ads (Goals > Conversions >
 * Uploads > Schedules, source HTTPS). See docs/ads-conversions-feed.md.
 *
 * HTTP Basic, user `google-ads`, password ADS_FEED_PASSWORD (24+ characters).
 * Any failure, including a missing env, answers 404 with an empty body, like
 * /api/export-conversions: the route does not admit it exists.
 *
 * Same source as that export (finished jobs "afgerond" plus their lead's
 * click ids) with two deliberate differences. It does NOT filter on
 * jobs.exported_at: that column means "downloaded by hand once", and a daily
 * schedule must keep offering the last 90 days, otherwise the first manual
 * download would empty it. And it selects no personal columns at all.
 */

export const dynamic = 'force-dynamic';

const notFound = () => new Response(null, { status: 404 });

export async function GET(request: Request) {
  const password = process.env.ADS_FEED_PASSWORD;
  if (!checkAdsFeedAuth(request.headers.get('authorization'), password)) return notFound();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.storage_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.storage_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return notFound();
  const supabase = createClient(url, key);

  /* A few days of slack; buildAdsFeed applies the exact 90-day rule. */
  const since = new Date(Date.now() - (CLICK_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, status, gross_margin, completed_at, gclid, wbraid, gbraid, click_captured_at, leads (gclid, wbraid, gbraid, created_at)'
    )
    .eq('status', 'afgerond')
    .gte('completed_at', since)
    .order('completed_at', { ascending: true })
    .limit(5000);

  if (error) {
    console.error('ads feed query failed:', error.message);
    return notFound();
  }

  const { csv, counts } = buildAdsFeed((data ?? []) as unknown as FeedJobRow[]);
  await logOps(supabase, 'ads_conversions_feed', counts as unknown as Record<string, unknown>);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
