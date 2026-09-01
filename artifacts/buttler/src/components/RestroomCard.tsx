import { Navigation, MapPin, Droplets, Users, Lock } from "lucide-react";
import { formatDistance } from "@/lib/distance";
import { motion } from "framer-motion";

interface RestroomCardProps {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  access: string;
  fee: string;
  bidet: boolean;
  distance?: number;
  index: number;
  audited: boolean;
}

export function RestroomCard({ name, latitude, longitude, address, access, fee, bidet, distance, index, audited }: RestroomCardProps) {
  const openDirections = () => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`, '_blank', 'noopener,noreferrer');
  };

  const isPublic = access === 'public';
  const isFree = fee === 'no';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.5), duration: 0.3 }}
      className="bg-card border border-border/50 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all duration-300 relative overflow-hidden group"
    >
      <div className={`absolute top-0 left-0 w-1.5 h-full ${bidet ? 'bg-gradient-to-b from-amber-400 to-amber-600' : 'bg-gradient-to-b from-slate-300 to-slate-400'} opacity-70 group-hover:opacity-100 transition-opacity`} />

      <div className="flex justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            {audited && (
              <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-0.5">
                <span>✓</span> Verified
              </span>
            )}
          </div>
          <h3 className="font-display text-base font-bold text-foreground leading-tight truncate">{name}</h3>
          {address && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-1">{address}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <MapPin className="w-3 h-3 text-primary flex-shrink-0" />
              {distance !== undefined ? <span>{formatDistance(distance)} away</span> : <span>Distance unknown</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${isPublic ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
              {isPublic ? <Users className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
              {isPublic ? 'Public' : 'Customer-Only'}
            </span>
            {!isFree && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {fee === 'yes' ? 'Fee required' : fee === 'unknown' ? 'Fee unknown' : fee}
              </span>
            )}
            {bidet && (
              <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">
                <Droplets className="w-3 h-3" /> Bidet
              </span>
            )}
          </div>
        </div>

        <button
          onClick={openDirections}
          className="flex-shrink-0 flex flex-col items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
          aria-label="Get Directions"
        >
          <Navigation className="w-4 h-4 mb-0.5" />
          <span className="text-[9px] font-bold uppercase tracking-wider">Go</span>
        </button>
      </div>
    </motion.div>
  );
}
