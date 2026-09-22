// GET /api/moderation/contributions?status=… — the moderator queue. Privileged
// projection (reviewer sees validation state, notes, and decision metadata).
// Rejects a non-moderator before any query runs.

import {
  json,
  publicContribution,
  requireModerator,
  type ApiContext,
} from "../../_lib/http.ts";
import { moderationQueue } from "../../_lib/contributions-store.ts";
import { CONTRIBUTION_STATUSES, type ContributionStatus } from "../../../lib/contributions/contract.ts";

export async function onRequestGet(context: ApiContext): Promise<Response> {
  const gate = await requireModerator(context);
  if ("response" in gate) return gate.response;

  const url = new URL(context.request.url);
  const requested = url.searchParams.get("status");
  let statusFilter: ContributionStatus | null = null;
  if (requested !== null) {
    if (!(CONTRIBUTION_STATUSES as readonly string[]).includes(requested)) {
      return json({ error: "unknown status filter" }, 400);
    }
    statusFilter = requested as ContributionStatus;
  }

  const rows = await moderationQueue(context.env.BUTTLER_DB!, statusFilter);
  return json(
    rows.map((row) => publicContribution(row as unknown as Record<string, unknown>, true)),
  );
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "method not allowed" }, 405);
}
