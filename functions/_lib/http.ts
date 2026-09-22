// Buttler 2.0 — Stage 13 Pages Function HTTP helpers.
//
// Small shared glue so every protected endpoint fails the same safe way: no
// database -> 503, auth not wired -> 503 (never a silent anonymous pass), signed
// out -> 401, oversized body -> 413, malformed JSON -> 400. Handlers stay thin
// and only contain routing + delegation to the store.

import { resolveIdentity, type AuthEnv } from "./identity.ts";
import type { D1Database } from "./contributions-store.ts";
import { MAX_BODY_BYTES } from "../../lib/contributions/contract.ts";
import type { Identity } from "../../lib/contributions/authorize.ts";
import type { StoreResult } from "./contributions-store.ts";

export interface ApiEnv extends AuthEnv {
  BUTTLER_DB?: D1Database;
}

export interface ApiContext {
  request: Request;
  env: ApiEnv;
  params: Record<string, string>;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
} as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...SECURITY_HEADERS } });
}

export function databaseUnavailable(): Response {
  return json({ error: "database is not configured" }, 503);
}

export function authNotConfigured(): Response {
  return json(
    { error: "contributions are not open yet: authentication is not configured" },
    503,
  );
}

export type Gate =
  | { identity: Identity }
  | { response: Response };

export async function requireIdentity(ctx: ApiContext): Promise<Gate> {
  if (!ctx.env.BUTTLER_DB) return { response: databaseUnavailable() };
  const resolution = await resolveIdentity(ctx.request, ctx.env);
  // Fail closed: with no provider wired we never process a write.
  if (!resolution.configured) return { response: authNotConfigured() };
  if (!resolution.identity) return { response: json({ error: "authentication required" }, 401) };
  return { identity: resolution.identity };
}

export async function requireModerator(ctx: ApiContext): Promise<Gate> {
  const gate = await requireIdentity(ctx);
  if ("response" in gate) return gate;
  if (gate.identity.role !== "moderator" && gate.identity.role !== "admin") {
    return { response: json({ error: "moderator role required" }, 403) };
  }
  return gate;
}

export async function readJsonBody(
  request: Request,
): Promise<{ value: Record<string, unknown> } | { response: Response }> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    return { response: json({ error: "payload too large" }, 413) };
  }
  if (buffer.byteLength === 0) {
    return { response: json({ error: "body required" }, 400) };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buffer));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { response: json({ error: "body must be a JSON object" }, 400) };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { response: json({ error: "invalid JSON" }, 400) };
  }
}

// Public projection of a stored contribution: never leak moderation internals
// or contributor identity to a non-privileged reader.
export function publicContribution(
  row: Record<string, unknown>,
  viewerIsPrivileged: boolean,
): Record<string, unknown> {
  const base = {
    contribution_id: row.contribution_id,
    kind: row.kind,
    target_canonical_id: row.target_canonical_id,
    status: row.status,
    submitted_at: row.submitted_at,
    payload: safeParse(row.payload_json),
    evidence: safeParse(row.evidence_json),
    notes: row.notes,
  };
  if (!viewerIsPrivileged) return base;
  return {
    ...base,
    validation_status: row.validation_status,
    moderation_note: row.moderation_note,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
  };
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function respond<T>(
  result: StoreResult<T>,
  success: (value: T) => Response,
): Response {
  if (result.ok) return success(result.value);
  return json({ error: result.error }, result.status);
}
