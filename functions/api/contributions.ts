// POST /api/contributions — authenticated contribution creation.
//
// Contract (Stage 12 PART 10). Ships fail-closed: with no authentication
// provider wired, `requireIdentity` answers 503 before the store is ever
// reached, so an anonymous write is structurally impossible. The moment the
// owner approves a provider and `resolveIdentity` returns a real identity, this
// handler enforces: contributor id from the session (never the body), forced
// pending status, allow-listed payload, size caps, rate/pending/duplicate
// limits, and an append-only `submitted` event. It cannot touch canonical data.

import {
  json,
  readJsonBody,
  requireIdentity,
  respond,
  type ApiContext,
} from "../_lib/http.ts";
import { createContribution } from "../_lib/contributions-store.ts";

export async function onRequestPost(context: ApiContext): Promise<Response> {
  const gate = await requireIdentity(context);
  if ("response" in gate) return gate.response;

  const body = await readJsonBody(context.request);
  if ("response" in body) return body.response;

  const result = await createContribution(context.env.BUTTLER_DB!, gate.identity, {
    kind: body.value.kind,
    targetCanonicalId: body.value.target_canonical_id ?? null,
    payload: body.value.payload,
    notes: body.value.notes ?? null,
    evidence: body.value.evidence ?? null,
  });

  return respond(result, (value) => json(value, 201));
}

export async function onRequest(context: ApiContext): Promise<Response> {
  // Only POST is meaningful here; GET on the collection is not a public feed.
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "method not allowed" }, 405);
}
