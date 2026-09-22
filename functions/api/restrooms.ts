interface Env {
  BUTTLER_DB?: D1Database;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  all<T>(): Promise<{ results?: T[] }>;
}

type BidetEvidence = "field_verified" | "osm_explicit" | "unknown";

// Public contract per record (Stage 5B):
//   id: canonical string key
//   bidet: coarse availability flag
//   bidet_evidence: how the bidet claim was evidenced, derived from the
//   canonical verification column; never invented here.
interface CanonicalRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  has_bidet: number;
  bidet_evidence: BidetEvidence;
}

interface LegacyRow extends Omit<CanonicalRow, "id"> {
  id: number;
}

interface PagesContext {
  env: Env;
  request: Request;
}

// The canonical read model is the Buttler 2.0 source of truth. The public
// projection intentionally exposes only the fields the finder needs; internal
// restroom verification, provenance, and match columns stay in the database.
// `bidet_evidence` is the one internal verification field the owner approved
// for public exposure, so users can tell survey-checked bidets from map claims.
export const SELECT_PUBLIC_CANONICAL_LOCATIONS = `
  SELECT canonical_id AS id, name, latitude, longitude, address,
         access, fee, (bidet_presence = 'Yes') AS has_bidet,
         bidet_verification AS bidet_evidence
  FROM canonical_locations
  WHERE record_status <> 'rejected'
  ORDER BY canonical_id
`;

// Fallback keeps the deployed Pages build working if migrations 0003/0004
// have not been applied to the bound database yet. The legacy table carries
// no verification data, so every fallback row reports evidence as 'unknown'
// rather than implying field checks that never happened.
const SELECT_PUBLIC_LEGACY_RESTROOMS = `
  SELECT id, name, latitude, longitude, address, access, fee, has_bidet,
         'unknown' AS bidet_evidence
  FROM restroom_locations
  WHERE record_status <> 'rejected'
  ORDER BY id
`;

export function toPublicRestroom({ has_bidet, ...restroom }: CanonicalRow | LegacyRow) {
  return { ...restroom, bidet: has_bidet === 1 };
}

async function getRestrooms(context: PagesContext): Promise<Response> {
  if (!context.env.BUTTLER_DB) {
    return Response.json(
      { error: "Read database is not configured" },
      { status: 503 },
    );
  }

  try {
    const { results = [] } =
      await context.env.BUTTLER_DB.prepare(
        SELECT_PUBLIC_CANONICAL_LOCATIONS,
      ).all<CanonicalRow>();
    return Response.json(results.map(toPublicRestroom), {
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table/i.test(message)) throw error;

    const { results = [] } = await context.env.BUTTLER_DB.prepare(
      SELECT_PUBLIC_LEGACY_RESTROOMS,
    ).all<LegacyRow>();
    return Response.json(results.map(toPublicRestroom), {
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  return getRestrooms(context);
}
