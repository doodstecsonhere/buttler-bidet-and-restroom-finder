// POST /api/moderation/contributions/{id}/promotion — Stage 14E canonical
// promotion boundary (contract §4 / §15 / §16).
//
// This is a THIN security boundary, not a second executor. It does exactly
// three things and nothing else:
//   1. authenticate the caller and gate them behind the SEPARATE server-side
//      promoter allow-list (BUTTLER_PROMOTER_IDS) — moderator status alone does
//      not qualify, and every rule is enforced server-side;
//   2. accept the frozen contract's "empty / ignored" body: the ONLY field it
//      ever reads is an optional `promotion_note` string. canonical_id, kind,
//      changed columns, values, snapshots, contributor / promoter identity, or
//      any other key is ignored — the contribution row is the sole source of
//      the proposed change (trust boundary, §4 / §15);
//   3. hand only the stored contribution id + the verified promoter subject to
//      the Stage 14D executor via `promoteApprovedToCanonical`, then map the
//      structured result (§16) onto an HTTP response.
//
// The handler decides nothing about whether the change is safe — that is the
// executor's frozen job. Nor does it read identity from the body/headers/query:
// identity comes only from the verified bearer token resolved upstream.

import {
  json,
  readOptionalJsonBody,
  requirePromoter,
  type ApiContext,
} from "../../../../_lib/http.ts";
import { promoteApprovedToCanonical } from "../../../../_lib/contributions-store.ts";

export async function onRequestPost(context: ApiContext): Promise<Response> {
  // 1 + 2. Identity + promoter allow-list. Fail-closed ordering is handled by
  // the seam: 503 (db/auth absent) / 401 (no valid token) / 503 (promoter
  // config absent or malformed). Not being on the list is decided in the store
  // by the pure predicate so the rule lives in exactly one place.
  const gate = await requirePromoter(context);
  if ("response" in gate) return gate.response;

  // 3. Optional body. Everything except a `promotion_note` string is ignored.
  const body = await readOptionalJsonBody(context.request);
  if ("response" in body) return body.response;

  let promotionNote: string | null = null;
  const rawNote = body.value?.promotion_note;
  if (rawNote !== undefined && rawNote !== null) {
    // Reject JSON smuggling / wrong types, but never let the note reach the
    // executor as anything other than a plain string.
    if (typeof rawNote !== "string") {
      return json({ error: "promotion_note must be a string", code: "invalid_promotion_note" }, 422);
    }
    promotionNote = rawNote;
  }

  const result = await promoteApprovedToCanonical(
    context.env.BUTTLER_DB!,
    gate.identity,
    context.params.id,
    gate.promoterIds,
    promotionNote,
  );

  if (result.ok) return json(result.value);
  const payload: Record<string, unknown> = { error: result.error };
  if (result.code) payload.code = result.code;
  if (result.details) payload.details = result.details;
  return json(payload, result.status);
}

export async function onRequest(context: ApiContext): Promise<Response> {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "method not allowed" }, 405);
}
