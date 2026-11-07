import { NextResponse } from 'next/server';
import { checkOps, logOps } from '@/lib/opsAuth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The number behind one job or lead, for the server tool that sends a message
 * the owner approved. One record per call, and every call is logged.
 */
export async function GET(request: Request) {
  const auth = checkOps(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const q = new URL(request.url).searchParams;
  const kind = q.get('kind');
  const id = q.get('id') ?? '';
  if ((kind !== 'job' && kind !== 'lead') || !UUID.test(id)) {
    return NextResponse.json({ error: 'Ongeldige aanvraag' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } =
    kind === 'job'
      ? await supabase.from('jobs').select('customer_name, customer_phone').eq('id', id).maybeSingle()
      : await supabase.from('leads').select('name, phone, phone_e164').eq('id', id).maybeSingle();

  if (error) {
    console.error('ops contact read failed:', error.message);
    return NextResponse.json({ error: 'Lezen mislukt' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Niet gevonden' }, { status: 404 });

  const row = data as Record<string, string | null>;
  const phone = kind === 'job' ? row.customer_phone : row.phone_e164 ?? row.phone;
  if (!phone) return NextResponse.json({ error: 'Geen telefoonnummer bekend' }, { status: 404 });

  await logOps(supabase, 'contact.read', { kind, id });
  return NextResponse.json({ name: kind === 'job' ? row.customer_name : row.name, phone });
}
