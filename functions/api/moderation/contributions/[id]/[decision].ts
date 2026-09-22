// POST /api/moderation/contributions/{id}/{decision} — approve / reject,
// moderator only. `decision` is validated against a fixed set. The handler
// records the decision + who/when and appends a moderation event. Approving
// here is a DECISION, not a write: it does not touch canonical_locations (that
// is the separate, un-wired `applyApprovedToCanonical` path the owner must
// enable explicitly). A contributor — even a moderator — can never decide their
// own submission; `authorizeDecision` enforces that server-side.

import {
  json,
  readJsonBody,
  requireModerator,
  respond,
  type ApiContext,
} from "../../../../_lib/http.ts";
import { decideContribution } from "../../../../_lib/contributions-store.ts";
import type { Decision } from "../../../../../lib/contributions/authorize.ts";

const DECISIONS: readonly string[] = ["approve", "reject"];

export async function onRequestPost(context: ApiContext): Promise<Response> {
  const gate = await requireModerator(context);
  if ("response" in gate) return gate.response;

  const decision = context.params.decision;
  if (!DECISIONS.includes(decision)) {
    return json({ error: "decision must be approve or reject" }, 400);
  }

  let note: string | null = null;
  const body = await readJsonBody(context.request);
  if ("response" in body) {
    // A decision may legitimately carry no note; only reject a *malformed* body.
    if (body.response.status !== 400) return body.response;
  } else if (typeof body.value.note === "string") {
    note = body.value.note;
  }

  const result = await decideContribution(
    context.env.BUTTLER_DB!,
    gate.identity,
    context.params.id,
    decision as Decision,
    note,
  );
  return respond(result, (value) => json(value));
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "method not allowed" }, 405);
}
