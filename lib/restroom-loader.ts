import { RESTROOMS, type Restroom } from "./restroom-data.ts";

export type RestroomSource = "d1" | "bundled";

export interface LoadedRestrooms {
  data: Restroom[];
  source: RestroomSource;
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
    typeof candidate.bidet === "boolean"
  );
}

export async function loadRestrooms(
  fetcher: typeof fetch = fetch,
): Promise<LoadedRestrooms> {
  try {
    const response = await fetcher("/api/restrooms", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Restroom API returned ${response.status}`);

    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || !payload.every(isRestroom)) {
      throw new Error("Restroom API returned an invalid catalogue");
    }

    return { data: payload, source: "d1" };
  } catch {
    return { data: RESTROOMS, source: "bundled" };
  }
}
