// Buttler 2.0 — Stage 13 frontend: the contributions API client.
//
// Everything the browser sends and parses for the contribution workflow lives
// here, as a pure module: no React, no DOM, and no direct `fetch`. The caller
// injects the SAME `authorizedFetch` the whole app already uses, which keeps
// the two hard auth rules in one place:
//
//   1. A bearer token is only ever attached to same-origin `/api/*` requests
//      (enforced by `src/auth/authorized-fetch.ts`, never re-implemented here).
//   2. Without a signed-in user, a protected call fails locally with
//      `AuthRequiredError` before any request leaves the browser — and this
//      file turns that into a friendly "sign in first" result.
//
// The request and response shapes come straight from the Stage 13 backend
// (`functions/api/**`): submit is a POST of `{ kind, target_canonical_id,
// payload, notes, evidence }`, history is `GET /api/me/contributions`, the
// queue is `GET /api/moderation/contributions`, and a decision is
// `POST /api/moderation/contributions/{id}/{approve|reject}`. Client-side
// pre-validation mirrors the backend allow-list purely to give faster, kinder
// feedback — the server remains the authority and re-validates everything.

import { AuthRequiredError } from "../auth/authorized-fetch.ts";
import {
  MAX_EVIDENCE_JSON_LENGTH,
  MAX_NOTES_LENGTH,
  isContributionKind,
  validatePayload,
  validateTargetForKind,
} from "../../../../lib/contributions/contract.ts";
import type { ContributionKind } from "../../../../lib/contributions/contract.ts";
import { EVIDENCE_TYPES } from "./ui-vocabulary.ts";

// ---------------------------------------------------------------------------
// Shapes returned by the backend's public projections (functions/_lib/http.ts)
// ---------------------------------------------------------------------------

export interface PublicContribution {
  contribution_id: string;
  kind: string;
  target_canonical_id: string | null;
  status: string;
  submitted_at: string | null;
  payload: Record<string, unknown> | null;
  evidence: unknown;
  notes: string | null;
}

/** What a moderator additionally sees; never rendered to plain contributors. */
export interface ModeratedContribution extends PublicContribution {
  validation_status: string | null;
  moderation_note: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

// ---------------------------------------------------------------------------
// Drafts and results
// ---------------------------------------------------------------------------

export interface EvidenceDraft {
  type: string;
  detail: string;
  observed_at: string;
  source_url: string;
}

export interface ContributionDraft {
  kind: string;
  targetCanonicalId: string | null;
  payload: Record<string, unknown>;
  notes: string;
  evidence: EvidenceDraft[];
}

export type FailureCode =
  | "validation"
  | "auth_required"
  | "forbidden"
  | "not_found"
  | "duplicate"
  | "rate_limited"
  | "too_large"
  | "not_open"
  | "offline"
  | "server";

export type ContributionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FailureCode; message: string };

export interface SubmissionReceipt {
  contributionId: string;
  status: string;
}

// Stage 14 promotion/reversal receipts mirror the executor's camelCase success
// body (`functions/_lib/contributions-store.ts`), which is what the endpoints
// echo on a 200. Only the fields the promoter console needs are read back; a
// wrong shape is an honest service error, never a half-parse.
export interface PromotionReceipt {
  promotionId: string;
  canonicalId: string;
  changedColumns: string[];
  promotedAt: string | null;
}

export interface ReversalReceipt {
  reversalId: string;
  reversesPromotionId: string;
  canonicalId: string;
  changedColumns: string[];
  restoredValues: Record<string, unknown>;
  reversedAt: string | null;
}

// ---------------------------------------------------------------------------
// Request construction (pure, fully unit-testable)
// ---------------------------------------------------------------------------

const MAX_DETAIL_LENGTH = 300;
const MAX_SOURCE_URL_LENGTH = 300;

/** Same shape the backend contract enforces for canonical target ids. */
export function isCanonicalTargetId(value: unknown): value is string {
  return typeof value === "string" && /^buttler_loc_[0-9a-f]{20}$/.test(value);
}

type ValidationFailure = { message: string } | null;

function validateEvidence(evidence: EvidenceDraft[]): ValidationFailure | null {
  if (evidence.length === 0) return null;
  const knownTypes = new Set(EVIDENCE_TYPES.map((entry) => entry.value));
  for (const item of evidence) {
    if (!knownTypes.has(item.type)) {
      return { message: "Choose an evidence type from the list." };
    }
    if (item.detail.length > MAX_DETAIL_LENGTH) {
      return { message: `Each evidence note is limited to ${MAX_DETAIL_LENGTH} characters.` };
    }
    if (item.source_url.length > MAX_SOURCE_URL_LENGTH) {
      return { message: "A source link is too long." };
    }
    if (
      item.observed_at.length > 0 &&
      !/^\d{4}-\d{2}-\d{2}$/.test(item.observed_at)
    ) {
      return { message: "An observation date should look like 2026-09-29." };
    }
  }
  const serialised = JSON.stringify(
    evidence.map((item) => ({
      type: item.type,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.observed_at ? { observed_at: item.observed_at } : {}),
      ...(item.source_url ? { source_url: item.source_url } : {}),
    })),
  );
  if (serialised.length > MAX_EVIDENCE_JSON_LENGTH) {
    return { message: "There is too much evidence on one contribution." };
  }
  return null;
}

/** Serialise evidence drafts into the documented wire shape, dropping blanks. */
export function evidenceToWire(evidence: EvidenceDraft[]): unknown[] {
  return evidence.map((item) => {
    const wire: Record<string, string> = { type: item.type };
    if (item.detail.trim()) wire.detail = item.detail.trim();
    if (item.observed_at.trim()) wire.observed_at = item.observed_at.trim();
    if (item.source_url.trim()) wire.source_url = item.source_url.trim();
    return wire;
  });
}

/**
 * Validate a draft and produce the exact JSON body the backend expects.
 * Returns a friendly validation message (never a stack trace or token) when
 * the draft could not succeed, so the caller can skip the network entirely.
 */
export function buildSubmissionBody(
  draft: ContributionDraft,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string } {
  if (!isContributionKind(draft.kind)) {
    return { ok: false, message: "Choose one of the listed contribution types." };
  }
  const kind: ContributionKind = draft.kind;

  const target =
    draft.targetCanonicalId === null || draft.targetCanonicalId === ""
      ? null
      : draft.targetCanonicalId;

  const targetCheck = validateTargetForKind(kind, target);
  if (!targetCheck.ok) {
    return {
      ok: false,
      message:
        kind === "new_location"
          ? "A brand-new place should not be attached to an existing listing."
          : "Pick the restroom or place this report is about first.",
    };
  }

  const payloadCheck = validatePayload(kind, draft.payload);
  if (!payloadCheck.ok) {
    return { ok: false, message: friendlyPayloadError(payloadCheck.error) };
  }

  if (draft.notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, message: `Extra notes are limited to ${MAX_NOTES_LENGTH} characters.` };
  }

  const evidenceProblem = validateEvidence(draft.evidence);
  if (evidenceProblem) return { ok: false, message: evidenceProblem.message };

  return {
    ok: true,
    body: {
      kind,
      target_canonical_id: target,
      payload: draft.payload,
      notes: draft.notes.trim() ? draft.notes.trim() : null,
      evidence: draft.evidence.length > 0 ? evidenceToWire(draft.evidence) : null,
    },
  };
}

// Backend validation messages are already short and safe; map the common ones
// to contributor-friendly phrasing without losing specificity.
function friendlyPayloadError(serverError: string): string {
  if (serverError.includes("at least one field")) {
    return "Fill in at least one answer for this contribution type.";
  }
  if (serverError.includes("Dumaguete")) {
    return "Those coordinates fall outside the Dumaguete area Buttler covers.";
  }
  if (serverError.includes("not a recognised value")) {
    return "One of the chosen answers is not a recognised option.";
  }
  return serverError;
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

const STATUS_FAILURES: Record<number, { code: FailureCode; message: string }> = {
  400: { code: "validation", message: "The server could not accept this contribution. Check the highlighted fields." },
  401: { code: "auth_required", message: "Your sign-in expired. Please sign in again." },
  403: { code: "forbidden", message: "This step is only for Buttler moderators." },
  404: { code: "not_found", message: "That contribution or place could not be found." },
  409: { code: "duplicate", message: "An open report of this same kind already exists for this place." },
  413: { code: "too_large", message: "That submission is too large. Please shorten the text." },
  429: { code: "rate_limited", message: "You have several reports still waiting for review. Please try again after a moderator catches up." },
  503: { code: "not_open", message: "Contributions are not open on this deployment yet — the reviewers are not wired up." },
};

async function failureFromResponse(response: Response): Promise<{ code: FailureCode; message: string }> {
  const mapped = STATUS_FAILURES[response.status] ?? {
    code: "server" as const,
    message: "Buttler's service had a problem just now. Please try again.",
  };
  // A 400 carries the backend's own short, allow-list-derived reason (for
  // example "latitude out of the Dumaguete service area"), which is the most
  // useful safe feedback a contributor can get. Anything else keeps the
  // generic wording above.
  if (response.status === 400) {
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length <= 200) {
        return { code: "validation", message: parsed.error };
      }
    } catch {
      // fall through to the generic message
    }
  }
  // A 403 on a decision carries the server's own "... your own submission"
  // reason (lib/contributions/authorize.ts). That is the only signal which
  // distinguishes "not a moderator" from "a moderator deciding their own
  // report", so surface the accurate wording instead of the misleading
  // moderators-only text. The refusal itself stays entirely server-side.
  if (response.status === 403) {
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.includes("own submission")) {
        return { code: "forbidden", message: "You can't approve or reject your own submission." };
      }
    } catch {
      // fall through to the generic message
    }
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ContributionsClientDeps {
  /** The app's authorized fetch (`useButtlerAuth().authorizedFetch`). */
  request: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface ContributionsClient {
  submit(draft: ContributionDraft): Promise<ContributionResult<SubmissionReceipt>>;
  listMine(): Promise<ContributionResult<PublicContribution[]>>;
  queue(status?: string | null): Promise<ContributionResult<ModeratedContribution[]>>;
  decide(
    contributionId: string,
    decision: "approve" | "reject",
    note: string,
  ): Promise<ContributionResult<{ status: string }>>;
  /**
   * Stage 14E canonical promotion (§15/§16). The ONLY client-supplied field is
   * an optional note; canonical_id, kind, changed columns, values, snapshots,
   * and every identity come from the stored row + the verified token. Whether
   * this caller is a promoter is decided entirely server-side (403 otherwise).
   */
  promote(
    contributionId: string,
    note: string,
  ): Promise<ContributionResult<PromotionReceipt>>;
  /**
   * Stage 14 §18 guarded reversal of an existing promotion. Like promote, the
   * body carries only an optional note — the ledger row is the sole authority
   * on what gets restored, and the promoter gate is enforced server-side.
   */
  reverse(
    promotionId: string,
    note: string,
  ): Promise<ContributionResult<ReversalReceipt>>;
}

export function createContributionsClient(deps: ContributionsClientDeps): ContributionsClient {
  const { request } = deps;

  async function send<T>(
    run: () => Promise<Response>,
    parse: (payload: unknown) => T | null,
  ): Promise<ContributionResult<T>> {
    let response: Response;
    try {
      response = await run();
    } catch (cause) {
      if (cause instanceof AuthRequiredError) {
        return { ok: false, code: "auth_required", message: "Sign in to use this part of Buttler." };
      }
      if (cause instanceof ContributionDraftError) {
        return { ok: false, code: "validation", message: cause.message };
      }
      return { ok: false, code: "offline", message: "You appear to be offline. Buttler kept your draft — try again when you reconnect." };
    }
    if (!response.ok) {
      const failure = await failureFromResponse(response);
      return { ok: false, ...failure };
    }
    if (response.status === 204) {
      return { ok: true, value: null as unknown as T };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, code: "server", message: "Buttler's service sent an unexpected reply." };
    }
    const value = parse(payload);
    if (value === null) {
      return { ok: false, code: "server", message: "Buttler's service sent an unexpected reply." };
    }
    return { ok: true, value };
  }

  return {
    submit(draft) {
      return send(
        async () =>
          await request("/api/contributions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(throwIfInvalid(draft)),
          }),
        (payload) => {
          // The create endpoint echoes the store's in-memory shape
          // (`contributionId`), while list projections use the DB column name
          // (`contribution_id`). Accept either so a 201 is never misread as a
          // service error.
          const value = payload as { contribution_id?: unknown; contributionId?: unknown; status?: unknown };
          const contributionId =
            typeof value?.contribution_id === "string"
              ? value.contribution_id
              : typeof value?.contributionId === "string"
                ? value.contributionId
                : null;
          if (contributionId === null) return null;
          return {
            contributionId,
            status: typeof value.status === "string" ? value.status : "pending",
          };
        },
      );
    },

    listMine() {
      return send(
        () => request("/api/me/contributions", { method: "GET", headers: { Accept: "application/json" } }),
        (payload) => (Array.isArray(payload) ? (payload as PublicContribution[]) : null),
      );
    },

    queue(status) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      return send(
        () => request(`/api/moderation/contributions${query}`, { method: "GET", headers: { Accept: "application/json" } }),
        (payload) => (Array.isArray(payload) ? (payload as ModeratedContribution[]) : null),
      );
    },

    decide(contributionId, decision, note) {
      return send(
        () =>
          request(
            `/api/moderation/contributions/${encodeURIComponent(contributionId)}/${decision}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ note: note.trim() ? note.trim() : null }),
            },
          ),
        (payload) => {
          const value = payload as { status?: unknown };
          return typeof value?.status === "string" ? { status: value.status } : null;
        },
      );
    },

    promote(contributionId, note) {
      return send(
        () =>
          request(
            `/api/moderation/contributions/${encodeURIComponent(contributionId)}/promotion`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ promotion_note: note.trim() ? note.trim() : null }),
            },
          ),
        (payload) => {
          const value = payload as {
            promotionId?: unknown;
            canonicalId?: unknown;
            changedColumns?: unknown;
            promotedAt?: unknown;
          };
          if (typeof value?.promotionId !== "string") return null;
          return {
            promotionId: value.promotionId,
            canonicalId: typeof value.canonicalId === "string" ? value.canonicalId : "",
            changedColumns: Array.isArray(value.changedColumns)
              ? (value.changedColumns.filter((c) => typeof c === "string") as string[])
              : [],
            promotedAt: typeof value.promotedAt === "string" ? value.promotedAt : null,
          };
        },
      );
    },

    reverse(promotionId, note) {
      return send(
        () =>
          request(
            `/api/moderation/promotions/${encodeURIComponent(promotionId)}/reversal`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ reversal_note: note.trim() ? note.trim() : null }),
            },
          ),
        (payload) => {
          const value = payload as {
            reversalId?: unknown;
            reversesPromotionId?: unknown;
            canonicalId?: unknown;
            changedColumns?: unknown;
            restoredValues?: unknown;
            reversedAt?: unknown;
          };
          if (typeof value?.reversalId !== "string") return null;
          return {
            reversalId: value.reversalId,
            reversesPromotionId:
              typeof value.reversesPromotionId === "string" ? value.reversesPromotionId : "",
            canonicalId: typeof value.canonicalId === "string" ? value.canonicalId : "",
            changedColumns: Array.isArray(value.changedColumns)
              ? (value.changedColumns.filter((c) => typeof c === "string") as string[])
              : [],
            restoredValues:
              value.restoredValues && typeof value.restoredValues === "object"
                ? (value.restoredValues as Record<string, unknown>)
                : {},
            reversedAt: typeof value.reversedAt === "string" ? value.reversedAt : null,
          };
        },
      );
    },
  };
}

function throwIfInvalid(draft: ContributionDraft): Record<string, unknown> {
  const built = buildSubmissionBody(draft);
  if (!built.ok) {
    // The UI validates before enabling the button; this is the last gate so a
    // malformed body can never leave the browser even from a future caller.
    throw new ContributionDraftError(built.message);
  }
  return built.body;
}

/** Raised when a draft fails local pre-validation at send time. */
export class ContributionDraftError extends Error {
  readonly name = "ContributionDraftError";
}
