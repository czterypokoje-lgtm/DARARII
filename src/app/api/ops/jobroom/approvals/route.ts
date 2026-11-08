import { decideApproval, runOps } from '@/lib/opsJobRoom';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/** Releases or refuses one exact text (bound to its hash). Shadow: nothing is sent. */
export async function POST(request: Request) {
  return runOps(request, createSupabaseAdminClient, 'jobroom.approval', (db, body) =>
    decideApproval(db, body)
  );
}
