import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttrClick, AttrLead } from './adAttribution.ts';

/**
 * The two tables the matcher compares jobs with, read page by page (PostgREST
 * cuts a plain select at 1000 rows). Only rows that carry a click id are read,
 * and only the columns the matcher uses. The phone columns of leads are read
 * to compare numbers on the server and never leave it.
 */
const PAGE = 1000;
const MAX_ROWS = 10000;
const ANY_CLICK_ID = 'gclid.not.is.null,wbraid.not.is.null,gbraid.not.is.null';

async function readPaged<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  sinceIso: string
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .or(ANY_CLICK_ID)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    rows.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

/** Leads and call clicks with a click id, created since `sinceIso`. */
export async function loadAttributionPool(supabase: SupabaseClient, sinceIso: string) {
  const [leads, clicks] = await Promise.all([
    readPaged<AttrLead>(supabase, 'leads', 'id, phone, phone_e164, created_at, gclid, wbraid, gbraid', sinceIso),
    readPaged<AttrClick>(supabase, 'call_clicks', 'id, ref, created_at, claimed_by_job_id, gclid, wbraid, gbraid', sinceIso),
  ]);
  return { leads: leads.rows, clicks: clicks.rows, error: leads.error ?? clicks.error };
}
