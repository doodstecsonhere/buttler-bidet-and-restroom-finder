/**
 * Offline-aware restroom data hook.
 *
 * The read-only launch first asks the same-origin read API for the D1 catalogue.
 * The owned catalogue remains bundled so database, network, and binding errors
 * cannot make the finder unusable.
 */

import { useEffect, useState } from "react";
import {
  loadRestrooms,
  type LoadedRestrooms,
} from "../../../../lib/restroom-loader";

export interface CachedRestroom {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  bidet: boolean;
}

interface UseOfflineRestroomsResult {
  data: CachedRestroom[] | null;
  isLoading: boolean;
  error: Error | null;
  /** true when the data was served from the local cache (no live network hit) */
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
    error: null,
    isFromCache: loaded?.source === "bundled",
  };
}
