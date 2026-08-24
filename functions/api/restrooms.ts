interface Env {
  BUTTLER_DB?: D1Database;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  all<T>(): Promise<{ results?: T[] }>;
}

interface RestroomRow {
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

const SELECT_PUBLIC_RESTROOMS = `
  SELECT id, name, latitude, longitude, address, access, fee, has_bidet
  FROM restroom_locations
  WHERE record_status <> 'rejected'
  ORDER BY id
`;

async function getRestrooms(context: PagesContext): Promise<Response> {
  if (!context.env.BUTTLER_DB) {
    return Response.json(
      { error: "Read database is not configured" },
      { status: 503 },
    );
  }

  const { results = [] } = await context.env.BUTTLER_DB.prepare(
    SELECT_PUBLIC_RESTROOMS,
  ).all<RestroomRow>();

  return Response.json(
    results.map(({ has_bidet, ...restroom }) => ({
      ...restroom,
      bidet: has_bidet === 1,
    })),
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
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
