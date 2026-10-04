// POST /api/moderation/promotions/{id}/reversal — Stage 14 ownership
// completion: the contract §18 guarded promotion reversal.
//
// The frozen §15 route design named this sub-resource shape ("final route in
// 14E design; concept fixed here"): a promotion is a resource under
// /api/moderation, and a reversal is a forward-appended correction OF it.
// Like the promotion endpoint, this is a THIN security boundary that decides
// nothing about whether the restore is safe:
//   1. authenticate the caller and gate them behind the SAME server-side
//      promoter allow-list (BUTTLER_PROMOTER_IDS) as promotion — moderator
//      status alone does not qualify, and an absent/malformed config fails
//      closed (503) before anything else runs;
//   2. accept an empty body, or a JSON object whose ONLY effective field is
//      an optional `reversal_note` string (metadata on the appended ledger
//      row, same 2,000-character rule as promotion_note). The body never
//      carries restore intent: canonical_id, changed columns, base or
//      resulting values, snapshots, contributor / promoter identity, and
//      every protected field are ignored — the ledger row is the sole
//      authority on what gets restored;
//   3. hand only the stored promotion id + the verified promoter subject to
//      the executor via `reverseCanonicalPromotion`, then map the structured
//      §18 result onto an HTTP response.
//
// A reversal never edits or deletes history: it appends a new ledger row
// linked by `reversal_of` and restores exactly the guarded pre-promotion
// snapshot, refusing (§18 `superseded_by_later_edit`) if anyone edited the
// row since the original promotion.

import {
  json,
  readOptionalJsonBody,
  requirePromoter,
  type ApiContext,
} from "../../../../_lib/http.ts";
import { reverseCanonicalPromotion } from "../../../../_lib/contributions-store.ts";

export async function onRequestPost(context: ApiContext): Promise<Response> {
  // 1. Identity + promoter allow-list (fail-closed ordering lives in the
  // shared seam: 503 db/auth unconfigured, 401 invalid token, 503 promoter
  // config absent/malformed).
  const gate = await requirePromoter(context);
  if ("response" in gate) return gate.response;

  // 2. Optional body. Everything except a `reversal_note` string is ignored.
  const body = await readOptionalJsonBody(context.request);
  if ("response" in body) return body.response;

  let reversalNote: string | null = null;
  const rawNote = body.value?.reversal_note;
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== "string") {
      return json({ error: "reversal_note must be a string", code: "invalid_reversal_note" }, 422);
    }
    reversalNote = rawNote;
  }

  const result = await reverseCanonicalPromotion(
    context.env.BUTTLER_DB!,
    gate.identity,
    context.params.id,
    gate.promoterIds,
    reversalNote,
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
