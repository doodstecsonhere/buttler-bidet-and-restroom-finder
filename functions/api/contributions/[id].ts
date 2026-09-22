// GET /api/contributions/{id} — visible to its owner or a moderator; everyone
// else gets 404 so ids never leak the existence of other people's submissions.

import {
  json,
  publicContribution,
  requireIdentity,
  respond,
  type ApiContext,
} from "../../_lib/http.ts";
import { getContribution } from "../../_lib/contributions-store.ts";
import { isModerator } from "../../../lib/contributions/authorize.ts";

export async function onRequestGet(context: ApiContext): Promise<Response> {
  const gate = await requireIdentity(context);
  if ("response" in gate) return gate.response;

  const result = await getContribution(
    context.env.BUTTLER_DB!,
    gate.identity,
    context.params.id,
  );
  return respond(result, (row) =>
    json(publicContribution(row as unknown as Record<string, unknown>, isModerator(gate.identity))),
  );
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "method not allowed" }, 405);
}
