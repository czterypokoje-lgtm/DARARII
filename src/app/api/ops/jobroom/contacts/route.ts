import { resolveContact, runOps, saveContact } from '@/lib/opsJobRoom';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/** Saves a contact (every customer who writes) and, on an explicit pick, one alias. */
export async function POST(request: Request) {
  return runOps(request, createSupabaseAdminClient, 'jobroom.contact.save', (db, body) =>
    saveContact(db, body)
  );
}

/** `?q=name`: exact alias match after folding accents. Zero or several matches return candidates. */
export async function GET(request: Request) {
  return runOps(request, createSupabaseAdminClient, 'jobroom.contact.resolve', (db, input) =>
    resolveContact(db, (input as URL).searchParams.get('q'))
  );
}
