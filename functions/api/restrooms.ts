interface Env {
  BUTTLER_DB?: D1Database;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  all<T>(): Promise<{ results?: T[] }>;
}

interface CanonicalRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  has_bidet: number;
}

interface LegacyRow {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  has_bidet: number;
}

interface PagesContext {
  env: Env;
  request: Request;
}

// The canonical read model is the Buttler 2.0 source of truth. The public
// projection intentionally exposes only the fields the finder needs; internal
// verification, provenance, and match columns stay in the database.
export const SELECT_PUBLIC_CANONICAL_LOCATIONS = `
  SELECT canonical_id AS id, name, latitude, longitude, address,
         access, fee, (bidet_presence = 'Yes') AS has_bidet
  FROM canonical_locations
  WHERE record_status <> 'rejected'
  ORDER BY canonical_id
`;

// Fallback keeps the deployed Pages build working if migrations 0003/0004
// have not been applied to the bound database yet.
const SELECT_PUBLIC_LEGACY_RESTROOMS = `
  SELECT id, name, latitude, longitude, address, access, fee, has_bidet
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
