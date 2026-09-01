import { useMemo, useState } from "react";
import { useOfflineRestrooms } from "@/hooks/use-offline-restrooms";
import { useGeolocation } from "@/hooks/use-geolocation";
import { calculateDistance } from "@/lib/distance";
import { Map } from "@/components/Map";
import { RestroomCard } from "@/components/RestroomCard";
import { MapPinOff, Loader2, Sparkles, Search, Droplets, Users, X, WifiOff } from "lucide-react";
import { motion } from "framer-motion";

const DUMAGUETE_CENTER: [number, number] = [9.317, 123.305];

export default function Home() {
  const { data: restrooms, isLoading: restroomsLoading, error: restroomsError, isFromCache } = useOfflineRestrooms();
  const { location, loading: geoLoading, error: geoError } = useGeolocation();

  const [search, setSearch] = useState("");
  const [bidetsOnly, setBidetsOnly] = useState(false);
  const [publicOnly, setPublicOnly] = useState(false);
  const hasActiveFilters = search.trim() !== "" || bidetsOnly || publicOnly;

  const sortedRestrooms = useMemo(() => {
    if (!restrooms) return [];
    return [...restrooms]
      .map((r) => ({
        ...r,
        distance: location
          ? calculateDistance(location.lat, location.lng, r.latitude, r.longitude)
          : undefined,
      }))
      .sort((a, b) => {
        if (a.distance !== undefined && b.distance !== undefined) return a.distance - b.distance;
        return 0;
      });
  }, [restrooms, location]);

  const filteredRestrooms = useMemo(() => {
    let result = sortedRestrooms;
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.address && r.address.toLowerCase().includes(q))
      );
    }
    if (bidetsOnly) result = result.filter((r) => r.bidet);
    if (publicOnly) result = result.filter((r) => r.access === "public" || r.access.includes("public"));
    return result;
  }, [sortedRestrooms, search, bidetsOnly, publicOnly]);

  const isGlobalLoading = restroomsLoading;

  return (
    <div className="flex flex-col md:flex-row min-h-[100dvh] w-full bg-background overflow-hidden">
      {/* Mobile Header overlay on map */}
      <div className="md:hidden absolute top-0 left-0 w-full z-10 pointer-events-none p-3">
        <div className="bg-white/85 backdrop-blur-md border border-white/40 shadow-lg rounded-2xl p-3 flex items-center gap-2.5 pointer-events-auto">
          <img src={`${import.meta.env.BASE_URL}images/logo.png`} alt="Buttler Logo" className="w-9 h-9 rounded-xl flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-base text-foreground leading-none">Buttler</h1>
            <p className="text-primary font-medium text-[10px] tracking-wide uppercase truncate">Bidet & Restroom Finder</p>
          </div>
          <button
            type="button"
            disabled
            className="text-[10px] font-semibold text-sky-700 bg-sky-100 px-2 py-1 rounded-full flex-shrink-0 cursor-not-allowed opacity-75"
          >
            Log in — coming soon
          </button>
        </div>
      </div>

      {/* Map Section */}
      <div className="h-[45vh] md:h-screen w-full md:flex-1 relative order-1 md:order-2 bg-muted/50 border-b md:border-b-0 md:border-l border-border z-0">
        <Map
          restrooms={filteredRestrooms}
          userLocation={location}
          geoError={geoError}
          defaultCenter={DUMAGUETE_CENTER}
        />
      </div>

      {/* Sidebar */}
      <div className="flex-1 md:flex-none md:w-[420px] lg:w-[480px] h-[55vh] md:h-screen flex flex-col order-2 md:order-1 bg-background z-10 shadow-2xl md:shadow-none">
        {/* Desktop Header */}
        <div className="hidden md:flex items-center gap-3 p-5 border-b border-border/60 bg-card">
          <img src={`${import.meta.env.BASE_URL}images/logo.png`} alt="Buttler Logo" className="w-11 h-11 rounded-xl shadow-sm" />
          <div className="flex-1">
            <h1 className="font-display font-bold text-xl text-foreground">Buttler</h1>
            <p className="text-primary font-medium text-xs flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Bidet & Restroom Finder
            </p>
          </div>
          <button
            type="button"
            disabled
            className="text-xs font-semibold text-sky-700 bg-sky-100 px-3 py-1.5 rounded-full cursor-not-allowed opacity-75"
          >
            Log in — coming soon
          </button>
        </div>

        {/* Search + Filters */}
        <div className="px-4 pt-3 pb-2 border-b border-border/40 bg-background/95 backdrop-blur space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or address..."
              className="w-full pl-9 pr-8 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setBidetsOnly((v) => !v)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold border transition-all ${bidetsOnly ? "bg-amber-500 border-amber-500 text-white shadow-sm" : "bg-muted/60 border-border/50 text-muted-foreground hover:border-amber-400 hover:text-amber-600"}`}
            >
              <Droplets className="w-3.5 h-3.5" />
              Bidets Only
            </button>
            <button
              onClick={() => setPublicOnly((v) => !v)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold border transition-all ${publicOnly ? "bg-green-600 border-green-600 text-white shadow-sm" : "bg-muted/60 border-border/50 text-muted-foreground hover:border-green-500 hover:text-green-600"}`}
            >
              <Users className="w-3.5 h-3.5" />
              Public Only
            </button>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setBidetsOnly(false);
                setPublicOnly(false);
              }}
              className="w-full py-1 text-xs font-semibold text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-lg transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* List header */}
        <div className="px-4 py-2.5 flex items-center justify-between bg-background/95 backdrop-blur">
          <h2 className="font-display font-semibold text-base text-foreground">
            {location ? "Nearest to you" : "All Restrooms"}
          </h2>
          <span className="text-xs font-bold px-2.5 py-1 bg-secondary/10 text-secondary rounded-full">
            {filteredRestrooms.length} found
          </span>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
          {geoError && !location && (
            <div className="p-3 bg-accent/10 border border-accent/20 rounded-2xl flex gap-3 text-sm text-foreground/80">
              <MapPinOff className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <p>Couldn't get your location. Showing all restrooms instead.</p>
            </div>
          )}

          {isFromCache && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-2xl flex gap-3 text-sm text-amber-800">
              <WifiOff className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p>You're offline — the bundled restroom catalogue, search, and filters still work.</p>
            </div>
          )}

          {isGlobalLoading ? (
            <div className="flex flex-col items-center justify-center h-40 space-y-3 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <p className="font-medium animate-pulse text-sm">Finding relief...</p>
            </div>
          ) : restroomsError ? (
            <div className="p-5 text-center bg-destructive/10 rounded-2xl border border-destructive/20">
              <p className="text-destructive font-semibold text-sm">Failed to load restroom locations.</p>
              <p className="text-xs mt-1 text-destructive/80">Please check your connection and try again.</p>
            </div>
          ) : filteredRestrooms.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-center px-6">
              <div className="w-14 h-14 bg-muted rounded-full flex items-center justify-center mb-3">
                <MapPinOff className="w-7 h-7 text-muted-foreground/50" />
              </div>
              <h3 className="font-display font-bold text-base text-foreground">No results</h3>
              <p className="text-muted-foreground text-sm mt-1">Try adjusting your search or filters.</p>
            </div>
          ) : (
            filteredRestrooms.map((restroom, idx) => (
              <RestroomCard
                key={restroom.id}
                id={restroom.id}
                name={restroom.name}
                latitude={restroom.latitude}
                longitude={restroom.longitude}
                address={restroom.address ?? null}
                access={restroom.access}
                fee={restroom.fee}
                bidet={restroom.bidet}
                distance={restroom.distance}
                index={idx}
                audited={false}
              />
            ))
          )}
        </div>
      </div>

    </div>
  );
}
