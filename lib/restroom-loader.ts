import type { Restroom } from "./restroom-data.ts";
import { BUNDLED_RESTROOMS } from "./restroom-bundle.ts";

/**
 * Where the returned catalogue came from:
 * - "d1": the live canonical API response.
 * - "cache": the last-known-good canonical API response saved by this loader
 *   on a previous successful load (runtime cache, kept fresh per device).
 * - "bundled": the generated snapshot of the canonical 776-row dataset
 *   (lib/restroom-bundle.ts) — only used before any successful load, so the
 *   offline catalogue is the same dataset as the online one, never the
 *   superseded legacy 1,112-row bundle.
 */
export type RestroomSource = "d1" | "cache" | "bundled";

/**
 * Why the live API could not be used. Distinguishing these matters: a server
 * error while online must never be reported to the user as "You're offline".
 * - "offline": the network request itself failed (no connection / DNS / abort).
 * - "api-error": the service answered, but with an HTTP error or an invalid
 *   payload.
 */
export type RestroomFailure = "offline" | "api-error";

export interface LoadedRestrooms {
  data: Restroom[];
  source: RestroomSource;
  failure: RestroomFailure | null;
}

const BIDET_EVIDENCE_DOMAIN: readonly string[] = [
  "field_verified",
  "osm_explicit",
  "unknown",
];

const LAST_GOOD_CACHE_KEY = "buttler.restrooms.last-good.v1";

class RestroomApiError extends Error {
  readonly kind: RestroomFailure;

  constructor(message: string, kind: RestroomFailure) {
    super(message);
    this.kind = kind;
  }
}

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false; // privacy modes can throw on access
  }
}

function readLastGoodCache(): Restroom[] | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(LAST_GOOD_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const normalized = parsed.map(normaliseRestroom);
    return normalized.every(isRestroom) ? (normalized as Restroom[]) : null;
  } catch {
    return null;
  }
}

function writeLastGoodCache(rows: Restroom[]): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(LAST_GOOD_CACHE_KEY, JSON.stringify(rows));
  } catch {
    // A full or unavailable storage must never break the live experience.
  }
}

// Older API/bundle rows may omit the evidence field; anything outside the
// canonical vocabulary is treated as unknown instead of rejecting the whole
// catalogue.
function normaliseRestroom(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.bidet_evidence !== "string" ||
    !BIDET_EVIDENCE_DOMAIN.includes(candidate.bidet_evidence)
  ) {
    return { ...candidate, bidet_evidence: "unknown" };
  }
  return candidate;
}

function isRestroom(value: unknown): value is Restroom {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Restroom>;
  return (
    ((typeof candidate.id === "string" && candidate.id.length > 0) ||
      Number.isInteger(candidate.id)) &&
    typeof candidate.name === "string" &&
    typeof candidate.latitude === "number" &&
    typeof candidate.longitude === "number" &&
    (candidate.address === null || typeof candidate.address === "string") &&
    typeof candidate.access === "string" &&
    typeof candidate.fee === "string" &&
    typeof candidate.bidet === "boolean" &&
    (candidate.bidet_evidence === undefined ||
      BIDET_EVIDENCE_DOMAIN.includes(candidate.bidet_evidence))
  );
}

export async function loadRestrooms(
  fetcher: typeof fetch = fetch,
): Promise<LoadedRestrooms> {
  try {
    let response: Response;
    try {
      response = await fetcher("/api/restrooms", {
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      throw new RestroomApiError(
        `Restroom API unreachable: ${String(cause)}`,
        "offline",
      );
    }
    if (!response.ok) {
      throw new RestroomApiError(
        `Restroom API returned ${response.status}`,
        "api-error",
      );
    }

    const payload: unknown = await response
      .json()
      .catch((cause) => {
        throw new RestroomApiError(
          `Restroom API returned unreadable JSON: ${String(cause)}`,
          "api-error",
        );
      });
    if (!Array.isArray(payload)) {
      throw new RestroomApiError(
        "Restroom API returned an invalid catalogue",
        "api-error",
      );
    }
    const normalized = payload.map(normaliseRestroom);
    if (!normalized.every(isRestroom)) {
      throw new RestroomApiError(
        "Restroom API returned an invalid catalogue",
        "api-error",
      );
    }

    const data = normalized as Restroom[];
    writeLastGoodCache(data);
    return { data, source: "d1", failure: null };
  } catch (error) {
    const failure: RestroomFailure =
      error instanceof RestroomApiError
        ? error.kind
        : "offline";
    const cached = readLastGoodCache();
    if (cached) return { data: cached, source: "cache", failure };
    return { data: BUNDLED_RESTROOMS, source: "bundled", failure };
  }
}
