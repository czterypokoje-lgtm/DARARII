import { NextResponse } from 'next/server';
import { priceFor, type PricedCoverageRow } from '@/lib/capability';
import { checkOps, logOps } from '@/lib/opsAuth';
import { customerPrice, customerPriceInclVat } from '@/lib/opsBids';
import { scenarioFromLabel } from '@/lib/scenarios';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A price suggestion for one lead from the technicians' own lists. Read only.
 * An unclear service gives no price: a wrong row would quote a wrong amount.
 */
export async function GET(request: Request) {
  const auth = checkOps(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'Ongeldige lead' }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data: lead, error } = await supabase.from('leads').select('brand, model, service').eq('id', id).maybeSingle();
  if (error) {
    console.error('ops lead quote read failed:', error.message);
    return NextResponse.json({ error: 'Lezen mislukt' }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ error: 'Niet gevonden' }, { status: 404 });

  const scenario = scenarioFromLabel(lead.service);
  const car = { make: lead.brand, model: lead.model, year: null };
  if (!scenario || !lead.brand) return NextResponse.json({ car, scenario, prices: [] });

  const [technicians, coverage] = await Promise.all([
    supabase.from('technicians').select('id, name').eq('active', true),
    supabase
      .from('technician_coverage')
      .select('technician_id, make, model, scenario, from_year, to_year, excluded, keyless, price'),
  ]);
  const failed = technicians.error ?? coverage.error;
  if (failed) {
    console.error('ops lead quote lists failed:', failed.message);
    return NextResponse.json({ error: 'Lezen mislukt' }, { status: 500 });
  }

  const rows = (coverage.data ?? []) as PricedCoverageRow[];
  const prices = (technicians.data ?? [])
    .flatMap((tech) => {
      const price = priceFor(rows.filter((r) => r.technician_id === tech.id), car, scenario, null);
      return price === null
        ? []
        : [{ technician: tech.name, price, customerPrice: customerPrice(price), customerPriceInclVat: customerPriceInclVat(price) }];
    })
    .sort((a, b) => a.price - b.price);

  await logOps(supabase, 'lead_quote.read', { id });
  return NextResponse.json({ car, scenario, prices });
}
