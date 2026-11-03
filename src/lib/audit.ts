import type { AppDb } from "@/db";
import type { AuditAction } from "@/db/schema";

import { auditLog } from "@/db/schema";

/**
 * Records who did or viewed something (CLAUDE.md rule 9).
 *
 * Pass the request transaction (`c.var.db`), so the entry commits with the
 * action or not at all: an entry that survived a rolled-back action would be a
 * lie, and one lost when the action succeeded would be a gap nobody could see.
 *
 * Append-only in the database, not by convention: the runtime role holds
 * INSERT and SELECT, and a trigger refuses UPDATE and DELETE (migration 0001).
 */
export async function recordAudit(
  db: AppDb,
  entry: {
    facilityId: string;
    /** Null for something the system did with nobody asking. */
    actorId?: string | null;
    action: AuditAction;
    entityType: string;
    entityId?: string | null;
    /** One line a human can read without joining anything. */
    summary: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    facilityId: entry.facilityId,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    detail: entry.detail ?? null,
  });
}
