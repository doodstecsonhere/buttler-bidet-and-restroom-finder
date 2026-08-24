/**
 * Offline-aware restroom data hook.
 *
 * The read-only launch bundles the owned catalogue with the PWA. It no longer
 * needs an API, database, network request, or localStorage copy to show places.
 */

import { RESTROOMS } from "../../../../lib/restroom-data";

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
  return {
    data: RESTROOMS,
    isLoading: false,
    error: null,
    isFromCache: !navigator.onLine,
  };
}
