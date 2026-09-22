// GET /api/me/contributions — the caller's own submissions and their status.
// Returns the base projection (no internal moderation columns) so a
// contributor can track their reports without seeing reviewer notes.

import {
  json,
  publicContribution,
  requireIdentity,
  type ApiContext,
} from "../../_lib/http.ts";
import { listMyContributions } from "../../_lib/contributions-store.ts";

export async function onRequestGet(context: ApiContext): Promise<Response> {
  const gate = await requireIdentity(context);
  if ("response" in gate) return gate.response;

  const rows = await listMyContributions(context.env.BUTTLER_DB!, gate.identity);
  return json(
    rows.map((row) => publicContribution(row as unknown as Record<string, unknown>, false)),
  );
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "method not allowed" }, 405);
}
