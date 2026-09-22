import { Navigation, MapPin } from "lucide-react";
import { formatDistance } from "@/lib/distance";
import { motion } from "framer-motion";

interface BidetCardProps {
  // Canonical catalogue ids are strings; legacy bundled ids were numeric.
  id: string | number;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number;
  index: number;
}

export function BidetCard({ id, name, latitude, longitude, distance, index }: BidetCardProps) {
  const openDirections = () => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className="bg-card border border-border/50 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-300 relative overflow-hidden group"
    >
      <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-primary to-secondary opacity-70 group-hover:opacity-100 transition-opacity"></div>
      
      <div className="flex justify-between items-start gap-4">
        <div>
          <h3 className="font-display text-lg font-bold text-foreground leading-tight">
            {name}
          </h3>
          <div className="flex items-center gap-1.5 mt-2 text-muted-foreground font-medium text-sm">
            <MapPin className="w-4 h-4 text-primary" />
            {distance !== undefined ? (
              <span>{formatDistance(distance)} away</span>
            ) : (
              <span>Distance unknown</span>
            )}
          </div>
        </div>

        <button
          onClick={openDirections}
          className="flex-shrink-0 flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
          aria-label="Get Directions"
        >
          <Navigation className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] font-bold uppercase tracking-wider">Go</span>
        </button>
      </div>
    </motion.div>
  );
}
