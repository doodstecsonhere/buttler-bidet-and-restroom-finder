import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Location } from '@/hooks/use-geolocation';

export interface Restroom {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  bidet: boolean;
  distance?: number;
}

interface MapProps {
  restrooms: Restroom[];
  userLocation: Location | null;
  geoError?: string | null;
  defaultCenter: [number, number];
}

// ─── Icons ───────────────────────────────────────────────────────────────────

const dropSvg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="${color}" stroke="none"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>`;

function makeIcon(color: string, borderColor: string) {
  return L.divIcon({
    className: 'bg-transparent border-none',
    html: `<div style="position:relative;width:36px;height:36px;background:white;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.22);border:2.5px solid ${borderColor};">${dropSvg(color)}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -38],
  });
}

const bidetIcon = makeIcon('#d97706', '#d97706');
const noDropIcon = makeIcon('#64748b', '#94a3b8');

// Pulsing green dot — strictly required to stand out against gold/blue-gray markers.
const greenUserIcon = L.divIcon({
  className: 'bg-transparent border-none',
  html: `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;">
      <div style="position:absolute;width:28px;height:28px;border-radius:50%;background:rgba(34,197,94,0.35);animation:buttler-pulse 1.8s ease-out infinite;"></div>
      <div style="position:absolute;width:22px;height:22px;border-radius:50%;background:rgba(34,197,94,0.2);animation:buttler-pulse 1.8s ease-out 0.4s infinite;"></div>
      <div style="position:relative;width:14px;height:14px;border-radius:50%;background:#22c55e;border:2.5px solid white;box-shadow:0 2px 8px rgba(34,197,94,0.6);z-index:1;"></div>
    </div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -16],
});

// Inject keyframes once.
if (typeof document !== 'undefined' && !document.getElementById('buttler-pulse-style')) {
  const style = document.createElement('style');
  style.id = 'buttler-pulse-style';
  style.textContent = `
    @keyframes buttler-pulse {
      0%   { transform: scale(0.8); opacity: 0.9; }
      50%  { transform: scale(1.4); opacity: 0.4; }
      100% { transform: scale(1.9); opacity: 0;   }
    }
    @keyframes buttler-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes buttler-fadein {
      from { opacity: 0; transform: translateX(-50%) translateY(6px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Locate control (FAB + auto-startup + green dot + toast) ─────────────────
//
// Single component owns the entire "where is the user" concern:
//   • On startup: watches the autoLocation / autoError props. The very first
//     time either resolves it fires the viewport ONCE and locks the hasFit ref.
//   • FAB tap: always re-runs geolocation and flies to the new position.
//
// Nothing here touches the 1168 restroom markers — they live in a sibling
// subtree so only the green dot Marker re-renders on position change.

const LOCATE_MSG = 'Location access needed to show user location.';
const STARTUP_ZOOM = 17;
const FALLBACK_ZOOM = 15;
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const updateStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
    };
  }, []);

  return isOnline;
}

interface LocateButtonProps {
  autoLocation: Location | null;
  autoError?: string | null;
  fallbackCenter: [number, number];
}

function LocateButton({ autoLocation, autoError, fallbackCenter }: LocateButtonProps) {
  const map = useMap();
  const [locatedPos, setLocatedPos] = useState<[number, number] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  // hasFit: ensures auto-centering fires exactly once on initial load.
  const hasFit = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Auto-locate on startup ────────────────────────────────────────────────
  useEffect(() => {
    if (hasFit.current) return;
    if (!autoLocation) return;
    hasFit.current = true;
    const coords: [number, number] = [autoLocation.lat, autoLocation.lng];
    setLocatedPos(coords);
    if (prefersReducedMotion()) map.setView(coords, STARTUP_ZOOM);
    else map.flyTo(coords, STARTUP_ZOOM, { animate: true, duration: 1.0 });
  }, [autoLocation, map]);

  useEffect(() => {
    if (hasFit.current) return;
    if (!autoError) return;
    // Only trigger fallback once geolocation has definitively failed.
    hasFit.current = true;
    map.setView(fallbackCenter, FALLBACK_ZOOM);
    showToast(LOCATE_MSG);
  }, [autoError, fallbackCenter, map, showToast]);

  // ── FAB tap ───────────────────────────────────────────────────────────────
  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) { showToast(LOCATE_MSG); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setLocatedPos(coords);
        setLocating(false);
        if (prefersReducedMotion()) map.setView(coords, STARTUP_ZOOM);
        else map.flyTo(coords, STARTUP_ZOOM, { animate: true, duration: 1.2 });
      },
      () => { setLocating(false); showToast(LOCATE_MSG); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }, [map, showToast]);

  const container = map.getContainer();

  return (
    <>
      {/* FAB — portaled into Leaflet container, never triggers restroom re-render */}
      {createPortal(
        <button
          onClick={handleLocate}
          disabled={locating}
          title="Show your location"
          aria-label="Show your location"
          style={{
            position: 'absolute',
            bottom: 80,
            right: 10,
            zIndex: 400,
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: locating ? '#f0fdf4' : 'white',
            border: '2px solid rgba(0,0,0,0.12)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: locating ? 'default' : 'pointer',
            transition: 'box-shadow 0.15s, background 0.15s',
            outline: 'none',
          }}
        >
          {locating ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: 'buttler-spin 1s linear infinite' }}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke={locatedPos ? '#22c55e' : '#374151'}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
            </svg>
          )}
        </button>,
        container,
      )}

      {/* Toast — portaled to document.body, above everything */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', bottom: 24, left: '50%',
          transform: 'translateX(-50%)', zIndex: 99999,
          background: 'rgba(17,24,39,0.92)', color: 'white',
          fontSize: 13, fontWeight: 500, padding: '10px 18px',
          borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          whiteSpace: 'nowrap', pointerEvents: 'none',
          animation: 'buttler-fadein 0.2s ease',
        }}>
          {toast}
        </div>,
        document.body,
      )}

      {/* Green pulsing dot — only this Marker re-renders on position change */}
      {locatedPos && (
        <Marker position={locatedPos} icon={greenUserIcon} zIndexOffset={1000}>
          <Popup className="font-sans">
            <div style={{ fontWeight: 700, textAlign: 'center', fontSize: 13 }}>You are here</div>
            <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', marginTop: 2 }}>
              Hold it in, we found help.
            </div>
          </Popup>
        </Marker>
      )}
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function accessLabel(access: string) {
  if (access === 'public') return { label: 'Public', color: '#22c55e' };
  if (access === 'customers') return { label: 'Customer-Only', color: '#f59e0b' };
  return { label: access, color: '#94a3b8' };
}

function feeLabel(fee: string) {
  if (fee === 'no') return 'Free';
  if (fee === 'yes') return 'Fee required';
  if (fee === 'unknown') return 'Fee unknown';
  return fee;
}

// ─── Main Map component ───────────────────────────────────────────────────────

export function Map({
  restrooms,
  userLocation,
  geoError,
  defaultCenter,
}: MapProps) {
  const isOnline = useOnlineStatus();
  const [tileLayerFailed, setTileLayerFailed] = useState(false);

  useEffect(() => {
    if (isOnline) setTileLayerFailed(false);
  }, [isOnline]);

  const showStreetTiles = isOnline && !tileLayerFailed;
  const mapStatus = isOnline
    ? 'Street map unavailable. Restroom locations remain interactive.'
    : 'You are offline. Restroom locations remain interactive; street tiles need an internet connection.';

  return (
    // Initial center = downtown Dumaguete at zoom 15.
    // LocateButton will immediately fly to the user if geolocation resolves,
    // or stay here if it fails — no fitBounds over all 1168 pins ever fires.
    <section
      className="relative w-full h-full overflow-hidden bg-slate-100"
      role="region"
      aria-label="Interactive restroom map"
      style={{
        backgroundImage: 'linear-gradient(rgba(148,163,184,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.18) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }}
    >
      <MapContainer
        center={defaultCenter}
        zoom={15}
        className="w-full h-full z-0"
        zoomControl={false}
        style={{ background: 'transparent' }}
      >
        {showStreetTiles && (
          <TileLayer
            attribution={OSM_ATTRIBUTION}
            url={OSM_TILE_URL}
            eventHandlers={{
              tileerror: () => setTileLayerFailed(true),
            }}
          />
        )}

      {/* Single component owns all user-location logic */}
      <LocateButton
        autoLocation={userLocation}
        autoError={geoError}
        fallbackCenter={defaultCenter}
      />

      {restrooms.map((restroom) => {
        const icon = restroom.bidet ? bidetIcon : noDropIcon;
        const access = accessLabel(restroom.access);

        return (
          <Marker
            key={restroom.id}
            position={[restroom.latitude, restroom.longitude]}
            icon={icon}
          >
            <Popup className="font-sans" minWidth={220}>
              <div className="py-1 px-0.5" style={{ minWidth: 200 }}>
                <div className="flex items-start gap-2 mb-2">
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: restroom.bidet ? '#d97706' : '#64748b', flexShrink: 0, marginTop: 4, display: 'inline-block' }} />
                  <h3 className="font-bold text-sm leading-tight text-gray-900">{restroom.name}</h3>
                </div>

                {restroom.address && (
                  <p className="text-xs text-gray-500 mb-2 leading-tight">{restroom.address}</p>
                )}

                <div className="flex flex-wrap gap-1.5 mb-2">
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 99, background: access.color + '20', color: access.color }}>
                    {access.label}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 99, background: '#f1f5f9', color: '#475569' }}>
                    {feeLabel(restroom.fee)}
                  </span>
                  {restroom.bidet && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 99, background: '#fef3c7', color: '#b45309' }}>
                      Bidet ✓
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 mb-2">
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: '#f1f5f9', color: '#64748b' }}>
                    Check current conditions before relying on this listing
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${restroom.latitude},${restroom.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12, fontWeight: 600, color: '#0ea5e9', textDecoration: 'none' }}
                  >
                    Get Directions →
                  </a>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
      </MapContainer>

      {!showStreetTiles && (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-[500] w-[min(92%,28rem)] -translate-x-1/2 rounded-lg bg-slate-900/90 px-4 py-2 text-center text-xs font-medium text-white shadow-lg"
          role="status"
          aria-live="polite"
        >
          {mapStatus}
        </div>
      )}
    </section>
  );
}
