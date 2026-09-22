/**
 * Offline-aware restroom data hook.
 *
 * The read-only launch first asks the same-origin read API for the canonical
 * D1 catalogue. When that fails, the hook reports *why* it failed (true
 * network loss vs. a server-side error) so the UI never claims "You're
 * offline" while the user is online. The fallback data is the last-known-good
 * canonical response, or the generated canonical bundle before any successful
 * load — never the superseded legacy catalogue.
 */

import { useEffect, useState } from "react";
import {
  loadRestrooms,
  type LoadedRestrooms,
  type RestroomFailure,
  type RestroomSource,
} from "../../../../lib/restroom-loader";
import type { Restroom } from "../../../../lib/restroom-data";

export type CachedRestroom = Restroom & { distance?: number };

interface UseOfflineRestroomsResult {
  data: CachedRestroom[] | null;
  isLoading: boolean;
  /** why the live API could not be used; null when served live */
  failure: RestroomFailure | null;
  /** where the current catalogue came from (live API, cache, or bundle) */
  source: RestroomSource | null;
  /** true when the data was not served by a live API hit */
  isFromCache: boolean;
}

export function useOfflineRestrooms(): UseOfflineRestroomsResult {
  const [loaded, setLoaded] = useState<LoadedRestrooms | null>(null);

  useEffect(() => {
    let active = true;
    void loadRestrooms().then((result) => {
      if (active) setLoaded(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return {
    data: loaded?.data ?? null,
    isLoading: loaded === null,
    failure: loaded?.failure ?? null,
    source: loaded?.source ?? null,
    isFromCache: (loaded?.source ?? "d1") !== "d1",
  };
}
