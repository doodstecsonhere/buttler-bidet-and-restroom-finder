// POST /api/me/contributions/{id}/withdraw — Stage 14N contributor
// self-withdrawal.
//
// A narrow, authenticated boundary that reuses the existing Stage 13 identity,
// authorization, HTTP, and store seams. It does exactly three things:
//   1. resolve the caller's SERVER-derived identity (bearer token only — never a
//      body/header/query field), failing closed 503 without auth configured and
//      401 when signed out;
//   2. accept an EMPTY body. Nothing in a request body is trusted: contributor
//      identity, actor identity, status, validation_status, event type, canonical
//      id, kind, payload, evidence, moderation fields, and every timestamp are
//      derived by the store from trusted server state, so a forged field here can
//      never steer the transition;
//   3. delegate to `withdrawContribution`, which enforces ownership and the
//      pre-terminal lifecycle rule, moves only this contributor's own row to
//      `withdrawn`, and appends exactly one `withdrawn` event.
//
// Moderator status grants no extra power on this route: withdrawing someone
// else's submission is a moderator supersession decision, which is deliberately
// NOT part of this endpoint (see `authorizeWithdraw` — a non-owner gets a 404).
// The contribution row is never deleted.

import {
  readOptionalJsonBody,
  requireIdentity,
  respond,
  json,
  type ApiContext,
} from "../../../../_lib/http.ts";
import { withdrawContribution } from "../../../../_lib/contributions-store.ts";

export async function onRequestPost(context: ApiContext): Promise<Response> {
  const gate = await requireIdentity(context);
  if ("response" in gate) return gate.response;

  // Body is optional and entirely ignored; only the 400/413 well-formedness
  // guardrails of the shared reader apply. No field is ever read from it.
  const body = await readOptionalJsonBody(context.request);
  if ("response" in body) return body.response;

  const result = await withdrawContribution(
    context.env.BUTTLER_DB!,
    gate.identity,
    context.params.id,
  );
  return respond(result, (value) => json(value));
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "method not allowed" }, 405);
}
