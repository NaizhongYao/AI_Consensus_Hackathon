import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, Circle, LayersControl, Marker, LayerGroup, useMapEvents, Polygon, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Map as MapIcon, BarChart3, Recycle, Droplet, Building, AlertTriangle, Leaf, Activity, Loader2, Download, MousePointer } from 'lucide-react';
import { cn } from './utils'; // FIX #1: utils.ts is at project root, not ./lib/utils

// --- Global Icon Config ---
const starIcon = L.divIcon({
  html: `<div style="font-size: 16px; line-height: 1; text-shadow: 0 0 4px rgba(255,255,255,0.8);">⭐</div>`,
  className: 'custom-leaflet-icon',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

const timberIcon = L.divIcon({
  html: `<div style="width: 12px; height: 12px; border-radius: 50%; background-color: #2ecc71; box-shadow: 0 0 8px #2ecc71; border: 2px solid white;"></div>`,
  className: 'custom-leaflet-icon',
  iconSize: [12, 12],
  iconAnchor: [6, 6]
});

const concreteIcon = L.divIcon({
  html: `<div style="width: 12px; height: 12px; border-radius: 50%; background-color: #95a5a6; box-shadow: 0 0 8px #95a5a6; border: 2px solid white;"></div>`,
  className: 'custom-leaflet-icon',
  iconSize: [12, 12],
  iconAnchor: [6, 6]
});

const steelIcon = L.divIcon({
  html: `<div style="width: 12px; height: 12px; border-radius: 50%; background-color: #3498db; box-shadow: 0 0 8px #3498db; border: 2px solid white;"></div>`,
  className: 'custom-leaflet-icon',
  iconSize: [12, 12],
  iconAnchor: [6, 6]
});

const mixedIcon = L.divIcon({
  html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: conic-gradient(#2ecc71 0% 33%, #95a5a6 33% 66%, #3498db 66% 100%); box-shadow: 0 0 8px #7f8c8d; border: 2px solid white;"></div>`,
  className: 'custom-leaflet-icon',
  iconSize: [12, 12],
  iconAnchor: [6, 6]
});

// --- Types ---
interface BuildingData {
  id: string;
  lat: number;
  lng: number;
  yearOfConstruction: number;
  age: number;
  structureType: '木造' | 'RC造' | '鉄骨造';
  totalFloorArea: number;
  risk_12m: number;
  risk_24m: number;
  risk_36m: number;
  currentRisk: number;
  timber: number;
  concrete: number;
  steel: number;
  co2_savings: number;
}

interface FacilityData {
  name: string;
  lat: number;
  lng: number;
  type: string;
  materials: string[];
  phone: string;
  opening_hours: string;
  operator: string;
}

// FIX #23: dynamic reference year instead of hardcoded 2026
const REFERENCE_YEAR = new Date().getFullYear();

// --- Data Simulation ---
const TOKYO_DATA = {
  "annual_waste_tonnes": 1180000,
  "recycling_rate_pct": 21.5,
  "cd_waste_share_pct": 19.0,
  "incineration_rate_pct": 74.5,
  "population": 14000000,
  "waste_per_capita_kg": 340
};

const TOKYO_CENTER = { lat: 35.6804, lng: 139.7690 };
const TOKYO_BOUNDS: [[number, number], [number, number]] = [
  [35.5000, 139.5000], // southwest corner
  [35.8500, 139.9500], // northeast corner
];

const inBounds = (lat: number, lng: number) => {
  return lat >= 35.5000 && lat <= 35.8500 && lng >= 139.5000 && lng <= 139.9500;
};

// Math routines
function isPointInPolygon(lat: number, lng: number, vs: {lat: number, lng: number}[]) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    let xi = vs[i].lat, yi = vs[i].lng;
    let xj = vs[j].lat, yj = vs[j].lng;
    let intersect = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// FIX #6: compute centroid of polygon ring instead of taking first vertex
function polygonCentroid(ring: number[][]): { lat: number, lng: number } {
  // ring is array of [lng, lat] pairs (GeoJSON order)
  let sumLat = 0, sumLng = 0, count = 0;
  // Skip duplicate closing vertex if present
  const end = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  for (let i = 0; i < end; i++) {
    sumLng += ring[i][0];
    sumLat += ring[i][1];
    count++;
  }
  return count > 0 ? { lat: sumLat / count, lng: sumLng / count } : { lat: TOKYO_CENTER.lat, lng: TOKYO_CENTER.lng };
}

const SURVIVAL_PARAMS = {
  '木造': { median: 38, shape: 2.5 },
  'RC造': { median: 68, shape: 3.0 },
  '鉄骨造': { median: 50, shape: 2.8 },
  'default': { median: 45, shape: 2.5 }
};

function getWeibullProb(age: number, deltaMonths: number, type: string) {
  const params = SURVIVAL_PARAMS[type as keyof typeof SURVIVAL_PARAMS] || SURVIVAL_PARAMS['default'];
  const scale = params.median / Math.pow(Math.LN2, 1 / params.shape);
  const deltaYears = deltaMonths / 12;
  const safeAge = Math.max(0, age); // guard against negative ages from bad data
  const s_t = Math.exp(-Math.pow(safeAge / scale, params.shape));
  const s_t_dt = Math.exp(-Math.pow((safeAge + deltaYears) / scale, params.shape));
  if (s_t <= 0) return 1.0;
  return 1 - (s_t_dt / s_t);
}

const MATERIAL_COEFFS = {
  '木造': { timber: 0.20, concrete: 0.05, steel: 0.005 },
  'RC造': { timber: 0.02, concrete: 0.40, steel: 0.080 },
  '鉄骨造': { timber: 0.05, concrete: 0.10, steel: 0.120 },
};

function estimateMaterials(type: string, area: number) {
  const coeffs = MATERIAL_COEFFS[type as keyof typeof MATERIAL_COEFFS] || MATERIAL_COEFFS['木造'];
  return {
    timber: area * coeffs.timber,
    concrete: area * coeffs.concrete,
    steel: area * coeffs.steel,
    co2_savings: area * coeffs.timber * 0.9
  };
}

// FIX #13: deterministic structure-type assignment from a single seeded draw
// Hashes a stable key so the same building gets the same type across re-mounts.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295; // normalize to [0, 1)
}

function inferStructureType(seedKey: string): '木造' | 'RC造' | '鉄骨造' {
  // Intended distribution: 40% 木造, 40% RC造, 20% 鉄骨造
  const r = hashString(seedKey);
  if (r < 0.4) return '木造';
  if (r < 0.8) return 'RC造';
  return '鉄骨造';
}

// Distance (Haversine)
function getDistanceMetrics(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI/180;
  const p2 = lat2 * Math.PI/180;
  const dp = (lat2-lat1) * Math.PI/180;
  const dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// FIX #10: proper CSV field escaping
function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// FIX #9: slugify area name for CSV filename
function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'selection';
}

// Simple KMeans for cluster targeting
const FALLBACK_FACILITIES: FacilityData[] = [
  { name: "Tokyo Rinkai Recycling Plant", lat: 35.6195, lng: 139.7969, materials: ["concrete", "steel", "general"], type: "recycling_center", phone: "03-5566-7788", opening_hours: "Mo-Fr 08:00-17:00", operator: "Tokyo Gov" },
  { name: "Koto Ward Timber Recycling Center", lat: 35.6762, lng: 139.8174, materials: ["timber"], type: "recycling_center", phone: "03-3344-5566", opening_hours: "Mo-Sa 09:00-18:00", operator: "Koto Ward" },
  { name: "Shinagawa Scrap Metal Yard", lat: 35.6090, lng: 139.7400, materials: ["steel"], type: "scrap_yard", phone: "03-8899-0011", opening_hours: "Mo-Fr 07:00-19:00", operator: "Private" },
  { name: "Adachi Construction Waste Center", lat: 35.7753, lng: 139.8047, materials: ["concrete", "general"], type: "waste_disposal", phone: "03-1122-3344", opening_hours: "24/7", operator: "Adachi Ward" },
  { name: "Nerima Timber Salvage Yard", lat: 35.7357, lng: 139.6517, materials: ["timber"], type: "recycling_center", phone: "03-4455-6677", opening_hours: "Mo-Sa 08:00-16:00", operator: "Nerima Logging" },
  { name: "Ota Ward Metal Recycling", lat: 35.5613, lng: 139.7160, materials: ["steel", "general"], type: "scrap_yard", phone: "03-9988-7766", opening_hours: "Mo-Fr 09:00-18:00", operator: "Ota Metalworks" },
  { name: "Suginami General Waste Center", lat: 35.6993, lng: 139.6368, materials: ["concrete", "general"], type: "waste_disposal", phone: "03-1234-5678", opening_hours: "Mo-Fr 08:00-17:00", operator: "Suginami Gov" }
];

// --- Colors & UI mappings ---
const CHART_COLORS = {
  'Timber': '#2ecc71',
  'Concrete': '#95a5a6',
  'Steel': '#3498db',
};

const getRiskLevel = (risk: number) => {
  if (risk >= 0.8) return { label: '🔴 Critical', color: '#e74c3c' };
  if (risk >= 0.6) return { label: '🟠 High', color: '#f39c12' };
  if (risk >= 0.4) return { label: '🟡 Medium', color: '#f1c40f' };
  return { label: '🟢 Low', color: '#2ecc71' };
};

const SUB_AREAS: Record<string, { lat: number, lng: number, radius: number } | null> = {
  "All Tokyo": null,
  "Shinjuku Station Area": { lat: 35.6901, lng: 139.7004, radius: 800 },
  "Shibuya Station Area": { lat: 35.6580, lng: 139.7016, radius: 800 },
  "Marunouchi / Chiyoda": { lat: 35.6812, lng: 139.7671, radius: 800 },
  "Roppongi / Minato": { lat: 35.6628, lng: 139.7327, radius: 800 },
  "Akihabara": { lat: 35.6983, lng: 139.7731, radius: 600 },
  "Custom Selection (Click Radius)": null,
  "Custom Selection (Draw Freehand)": null
};

// --- Components ---
// FIX #4: FitBounds now only acts when `enabled` is true (i.e., the tab is visible)
// and only when the building set *identity* meaningfully changes, not on every render.
function FitBounds({ buildings, enabled }: { buildings: BuildingData[], enabled: boolean }) {
  const map = useMap();
  const lastKeyRef = useRef<string>('');
  useEffect(() => {
    if (!enabled || buildings.length === 0) return;
    // Build a cheap signature of the current selection; skip fitBounds if unchanged.
    const key = `${buildings.length}|${buildings[0]?.id || ''}|${buildings[buildings.length - 1]?.id || ''}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const lats = buildings.map(b => b.lat);
    const lngs = buildings.map(b => b.lng);
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)]
    );
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
  }, [buildings, map, enabled]);
  return null;
}

function MapEventsHandler({ onMapClick }: { onMapClick: (latlng: {lat: number, lng: number}) => void }) {
  useMapEvents({
    click: (e) => onMapClick(e.latlng)
  });
  return null;
}

function KPIDisplay({ title, value, unit, icon: Icon, colorClass }: any) {
  return (
    <div className={cn("rounded-[8px] bg-white shadow-sm border border-[#dee2e6] p-[16px] shrink-0", colorClass)}>
      <div className="flex items-center gap-2 mb-[8px]">
        <Icon size={14} className="text-[#6c757d]" />
        <span className="text-[0.75rem] font-bold text-[#6c757d] tracking-wide uppercase">{title}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[1.5rem] font-extrabold text-[#212529]">{value}</span>
        {unit && <span className="text-[0.85rem] font-bold text-[#6c757d]">{unit}</span>}
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'map' | 'material' | 'recovery'>('map');
  const [loading, setLoading] = useState(true);
  const [processedBuildings, setProcessedBuildings] = useState<BuildingData[]>([]);
  const [facilities, setFacilities] = useState<FacilityData[]>([]);

  const [plateauStatus, setPlateauStatus] = useState<'LIVE'|'SYNTHETIC'>('SYNTHETIC');
  const [dataWarning, setDataWarning] = useState<string|null>(null);

  const [selectedAreaName, setSelectedAreaName] = useState<string>("All Tokyo");
  const [customCenter, setCustomCenter] = useState<{lat: number, lng: number} | null>(null);
  const [customRadius, setCustomRadius] = useState<number>(300);
  const [drawPoints, setDrawPoints] = useState<{lat: number, lng: number}[]>([]);

  // FIX #14: use a ref flag instead of module-level globals to guard StrictMode double-invoke.
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    // FIX #3: wrap the whole flow in try/finally so setLoading(false) always runs,
    // even if anything throws unexpectedly.
    async function loadData() {
      try {
        console.log("FETCHING DATA — this should only appear once");

        const fetchWithTimeout = (url: string, ms = 3000, options: RequestInit = {}) => {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), ms);
          return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
        };

        // Concurrent data fetching with aggressive timeouts to skip hanging proxies
        const [plateauRes] = await Promise.allSettled([
          fetchWithTimeout("https://plateau.geospatial.jp/main/api/v1/collections/13113_bldg/items?limit=100&f=json", 3000)
            .then(r => {
              if (!r.ok) throw new Error(`PLATEAU HTTP ${r.status}`);
              return r.json();
            })
        ]);

        // 1. Process PLATEAU Buildings
        let bData: BuildingData[] = [];
        let plateauSucceeded = false;
        try {
          if (plateauRes.status === 'rejected') throw new Error("PLATEAU Timeout or Fetch Error");
          const data = plateauRes.value;
          if (!data || !data.features || data.features.length === 0) throw new Error("No features returned");

          bData = data.features.map((f: any) => {
            let lat = TOKYO_CENTER.lat, lng = TOKYO_CENTER.lng;
            if (f.geometry?.type === 'Point') {
              lng = f.geometry.coordinates[0]; lat = f.geometry.coordinates[1];
            } else if (f.geometry?.type === 'Polygon') {
              // FIX #6: use centroid of outer ring, not first vertex
              const centroid = polygonCentroid(f.geometry.coordinates[0]);
              lat = centroid.lat; lng = centroid.lng;
            } else if (f.geometry?.type === 'MultiPolygon') {
              const centroid = polygonCentroid(f.geometry.coordinates[0][0]);
              lat = centroid.lat; lng = centroid.lng;
            }

            const props = f.properties || {};
            const stableId = props.gml_id || f.id || `BLDG-LIVE-${Math.random().toString(36).substring(2,8)}`;

            // FIX #5: use Number() coercion instead of parseInt on unknown types
            const rawYear = props.yearOfConstruction ?? props['建築年'];
            const year = rawYear !== undefined && rawYear !== null && !isNaN(Number(rawYear))
              ? Number(rawYear)
              : (1955 + Math.floor(hashString(stableId + ':year') * (2010 - 1955)));

            const rawStructure = props.structureType || props['構造種別'];
            let typeLabel: '木造' | 'RC造' | '鉄骨造';
            if (rawStructure === '木造') {
              typeLabel = '木造';
            } else if (rawStructure && (String(rawStructure).includes('RC') || String(rawStructure).includes('鉄筋'))) {
              typeLabel = 'RC造';
            } else if (rawStructure && String(rawStructure).includes('鉄骨')) {
              typeLabel = '鉄骨造';
            } else {
              // FIX #13: deterministic fallback via stable hash
              typeLabel = inferStructureType(stableId + ':type');
            }

            const rawArea = props.totalFloorArea ?? props['延床面積'];
            const area = rawArea !== undefined && rawArea !== null && !isNaN(Number(rawArea))
              ? Number(rawArea)
              : (80 + Math.floor(hashString(stableId + ':area') * 1920));

            // FIX #23: use dynamic REFERENCE_YEAR
            const age = Math.max(0, REFERENCE_YEAR - year);

            return {
              id: stableId,
              lat, lng,
              yearOfConstruction: year,
              age,
              structureType: typeLabel,
              totalFloorArea: area,
              risk_12m: getWeibullProb(age, 12, typeLabel),
              risk_24m: getWeibullProb(age, 24, typeLabel),
              risk_36m: getWeibullProb(age, 36, typeLabel),
              currentRisk: getWeibullProb(age, 24, typeLabel),
              ...estimateMaterials(typeLabel, area)
            };
          }).filter((b: BuildingData) => inBounds(b.lat, b.lng));

          if (bData.length === 0) throw new Error("No valid bounding box match");

          plateauSucceeded = true;
          console.log("✅ PLATEAU data loaded successfully:", bData.length, "records");
        } catch (err: any) {
          console.warn("❌ PLATEAU failed:", err.message);
        }

        if (!plateauSucceeded) {
          console.log("🔄 Trying OSM Overpass API primary server...");

          const query = `[out:json][timeout:90];
area["name"="渋谷区"]["admin_level"="7"]->.shibuya;
(
  way["building"](area.shibuya);
  relation["building"](area.shibuya);
);
out center 1000;`;

          let osmData: any = null;
          try {
            const overpassRes = await fetchWithTimeout("https://overpass-api.de/api/interpreter", 10000, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: "data=" + encodeURIComponent(query)
            });
            if (!overpassRes.ok) throw new Error(`Primary Overpass HTTP ${overpassRes.status}`);
            osmData = await overpassRes.json();
            console.log("✅ Primary OSM fetched successfully.");
          } catch (osmErr: any) {
            console.error("❌ Primary OSM failed:", osmErr.message);
            console.log("🔄 Trying OSM Overpass API fallback server...");
            try {
              const overpassRes2 = await fetchWithTimeout("https://overpass.kumi.systems/api/interpreter", 10000, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: "data=" + encodeURIComponent(query)
              });
              if (!overpassRes2.ok) throw new Error(`Fallback Overpass HTTP ${overpassRes2.status}`);
              osmData = await overpassRes2.json();
              console.log("✅ Fallback OSM fetched successfully.");
            } catch (osmErr2: any) {
              console.error("❌ Fallback OSM also failed:", osmErr2.message);
            }
          }

          if (osmData && osmData.elements && osmData.elements.length > 0) {
            try {
              bData = osmData.elements.map((el: any) => {
                const lat = el.center?.lat || el.lat;
                const lng = el.center?.lon || el.lon;
                const tags = el.tags || {};
                const osmType = tags.building || "yes";
                const stableId = `OSM-${el.id}`;

                let typeLabel: '木造' | 'RC造' | '鉄骨造' = '木造';
                const residential = ["house","detached","terrace","residential"];
                const commercial  = ["commercial","retail","office","hotel"];
                const industrial  = ["industrial","warehouse","factory"];
                if (residential.includes(osmType)) typeLabel = '木造';
                else if (commercial.includes(osmType)) typeLabel = 'RC造';
                else if (industrial.includes(osmType)) typeLabel = '鉄骨造';
                // FIX #13: deterministic seeded assignment, not two independent Math.random() calls
                else typeLabel = inferStructureType(stableId);

                let year = 1955 + Math.floor(hashString(stableId + ':year') * (2010 - 1955));
                if (tags.start_date) {
                  const parsed = parseInt(String(tags.start_date).substring(0,4), 10);
                  if (!isNaN(parsed)) year = parsed;
                }
                const age = Math.max(0, REFERENCE_YEAR - year);

                let area = 80 + Math.floor(hashString(stableId + ':area') * 800);
                if (tags['building:levels']) {
                  const levels = parseFloat(tags['building:levels']);
                  if (!isNaN(levels)) area = levels * 150;
                }

                return {
                  id: stableId, lat, lng,
                  yearOfConstruction: year, age, structureType: typeLabel, totalFloorArea: area,
                  risk_12m: getWeibullProb(age, 12, typeLabel),
                  risk_24m: getWeibullProb(age, 24, typeLabel),
                  risk_36m: getWeibullProb(age, 36, typeLabel),
                  currentRisk: getWeibullProb(age, 24, typeLabel),
                  ...estimateMaterials(typeLabel, area)
                };
              }).filter((b: BuildingData) => b.lat && b.lng && inBounds(b.lat, b.lng));
              console.log("✅ OSM data processed successfully:", bData.length, "records");
            } catch (parseErr: any) {
              console.error("❌ OSM Parsing JSON error:", parseErr.message);
            }
          }
        }

        // Output Result processing
        if (bData.length > 0) {
          if (bData.length < 500) {
            const warningMsg = `⚠️ WARNING: Only partial real data retrieved (${bData.length} records). Synthetic data removed to ensure data accuracy.`;
            setDataWarning(warningMsg);
          }
          setPlateauStatus('LIVE');
          setProcessedBuildings(bData);
        } else {
          console.warn("⚠️ Both PLATEAU and OSM failed completely. Generating fully synthetic dataset.");
          const errMsg = "🛑 ERROR: All external data APIs failed. Synthetic data deployed for demonstration purposes.";
          setDataWarning(errMsg);
          const synth = generateMassiveSynth(2000);
          setProcessedBuildings(synth);
          setPlateauStatus('SYNTHETIC');
        }

        // 2. Process Facilities (Recycling/Waste)
        try {
          const facQuery = `[out:json][timeout:60];
(
  node["amenity"="recycling"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["landuse"="landfill"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["industrial"="scrap_yard"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["amenity"="waste_disposal"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["recycling:wood"="yes"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["recycling:concrete"="yes"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  node["recycling:scrap_metal"="yes"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  way["landuse"="landfill"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
  way["industrial"="scrap_yard"](around:20000,${TOKYO_CENTER.lat},${TOKYO_CENTER.lng});
);
out center;`;
          const fetchRes = await fetchWithTimeout("https://overpass-api.de/api/interpreter", 10000, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: "data=" + encodeURIComponent(facQuery)
          });
          if (!fetchRes.ok) throw new Error("Overpass Facility HTTP " + fetchRes.status);
          const facData = await fetchRes.json();
          let fList: FacilityData[] = [];
          if (facData && facData.elements) {
            fList = facData.elements.map((el: any) => {
              const lat = el.lat || el.center?.lat;
              const lng = el.lon || el.center?.lon;
              if (!lat || !lng) return null;

              const tags = el.tags || {};
              let materials: string[] = [];
              if (tags["recycling:wood"] === "yes") materials.push("timber");
              if (tags["recycling:concrete"] === "yes") materials.push("concrete");
              if (tags["recycling:scrap_metal"] === "yes" || tags["industrial"] === "scrap_yard") materials.push("steel");
              if (tags["amenity"] === "recycling" && materials.length === 0) materials.push("general");
              if (tags["landuse"] === "landfill") materials = ["landfill"];

              if (materials.length === 0) return null;

              return {
                name: tags.name || tags.operator || "Unnamed Facility",
                lat, lng,
                type: tags.amenity || tags.landuse || tags.industrial || "recycling_center",
                materials,
                phone: tags.phone || "",
                opening_hours: tags.opening_hours || "",
                operator: tags.operator || ""
              };
            }).filter((f: any): f is FacilityData => f !== null);
          }
          if (fList.length === 0) throw new Error("No valid facilities extracted");
          setFacilities(fList);
          console.log("✅ Facilities loaded:", fList.length);
        } catch (facErr: any) {
          console.error("❌ Facilities fetch failed. Using hardcoded fallback.", facErr.message);
          setFacilities(FALLBACK_FACILITIES);
        }
      } catch (fatalErr: any) {
        // FIX #3: last-resort catch so we always deliver *something* and clear the loading state
        console.error("🛑 Fatal error in data loading, falling back fully:", fatalErr?.message || fatalErr);
        setDataWarning("🛑 ERROR: Data loading failed. Using synthetic fallback.");
        setProcessedBuildings(generateMassiveSynth(2000));
        setPlateauStatus('SYNTHETIC');
        setFacilities(FALLBACK_FACILITIES);
      } finally {
        setLoading(false);
      }
    }

    function generateMassiveSynth(count: number) {
      const TOKYO_LAND_POLYGON = [
        {lat: 35.54, lng: 139.76}, {lat: 35.58, lng: 139.65},
        {lat: 35.62, lng: 139.58}, {lat: 35.75, lng: 139.58},
        {lat: 35.80, lng: 139.65}, {lat: 35.80, lng: 139.80},
        {lat: 35.70, lng: 139.89}, {lat: 35.63, lng: 139.87},
        {lat: 35.61, lng: 139.79}, {lat: 35.54, lng: 139.76}
      ];
      const items: BuildingData[] = [];
      let i = 0;
      while (items.length < count) {
        const lat = 35.5000 + Math.random() * (35.8500 - 35.5000);
        const lng = 139.5000 + Math.random() * (139.9500 - 139.5000);
        if (!isPointInPolygon(lat, lng, TOKYO_LAND_POLYGON)) continue;

        const year = Math.floor(Math.random() * (2010 - 1955 + 1)) + 1955;
        // FIX #13: single seeded draw via inferStructureType with stable id
        const stableId = `BLDG-${1000 + i++}`;
        const type: '木造'|'RC造'|'鉄骨造' = inferStructureType(stableId);
        const area = Math.floor(Math.random() * (2000 - 80 + 1)) + 80;
        const age = Math.max(0, REFERENCE_YEAR - year);
        items.push({
          id: stableId, lat, lng,
          yearOfConstruction: year, age, structureType: type, totalFloorArea: area,
          risk_12m: getWeibullProb(age, 12, type),
          risk_24m: getWeibullProb(age, 24, type),
          risk_36m: getWeibullProb(age, 36, type),
          currentRisk: getWeibullProb(age, 24, type),
          ...estimateMaterials(type, area)
        });
      }
      return items.sort((a,b)=>b.currentRisk-a.currentRisk);
    }

    loadData();
  }, []);

  const handleMapClick = (latlng: {lat: number, lng: number}) => {
    if (selectedAreaName === "Custom Selection (Click Radius)") {
      setCustomCenter(latlng);
    } else if (selectedAreaName === "Custom Selection (Draw Freehand)") {
      setDrawPoints(prev => [...prev, latlng]);
    }
  };

  const selectedBuildings = useMemo(() => {
    if (selectedAreaName === "All Tokyo") return processedBuildings;

    if (selectedAreaName === "Custom Selection (Draw Freehand)") {
      if (drawPoints.length < 3) return [];
      return processedBuildings.filter(b => isPointInPolygon(b.lat, b.lng, drawPoints));
    }

    let center, radius;
    if (selectedAreaName === "Custom Selection (Click Radius)") {
      if (!customCenter) return [];
      center = customCenter;
      radius = customRadius;
    } else {
      const area = SUB_AREAS[selectedAreaName];
      if (!area) return [];
      center = area;
      radius = area.radius;
    }

    return processedBuildings.filter(b => getDistanceMetrics(b.lat, b.lng, center.lat, center.lng) <= radius);
  }, [processedBuildings, selectedAreaName, customCenter, customRadius, drawPoints]);

  const selectedBuildingIds = useMemo(() => new Set(selectedBuildings.map(b => b.id)), [selectedBuildings]);

  const mapCenterObj = useMemo(() => {
    if (selectedBuildings.length === 0) return TOKYO_CENTER;
    const lats = selectedBuildings.map(b => b.lat);
    const lngs = selectedBuildings.map(b => b.lng);
    return {
      lat: (Math.max(...lats) + Math.min(...lats)) / 2,
      lng: (Math.max(...lngs) + Math.min(...lngs)) / 2
    };
  }, [selectedBuildings]);

  const nearestFacilities = useMemo(() => {
    if (selectedBuildings.length === 0 || facilities.length === 0) return { timber: [], concrete: [], steel: [] };

    const withDist = facilities.map(f => {
      const distance_m = getDistanceMetrics(mapCenterObj.lat, mapCenterObj.lng, f.lat, f.lng);
      return { ...f, distance_m, distance_km: (distance_m / 1000).toFixed(2) };
    });

    return {
      timber: withDist.filter(f => f.materials.includes("timber") || f.materials.includes("general")).sort((a,b) => a.distance_m - b.distance_m).slice(0, 3),
      concrete: withDist.filter(f => f.materials.includes("concrete") || f.materials.includes("general")).sort((a,b) => a.distance_m - b.distance_m).slice(0, 3),
      steel: withDist.filter(f => f.materials.includes("steel") || f.materials.includes("general")).sort((a,b) => a.distance_m - b.distance_m).slice(0, 3)
    };
  }, [mapCenterObj, facilities, selectedBuildings]);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#f8f9fa] text-[#212529]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 text-[#2ecc71] animate-spin" />
          <h2 className="text-xl font-medium tracking-tight">Initializing Material Recovery Data...</h2>
        </div>
      </div>
    );
  }

  // FIX #10: Blob-based CSV export with proper field escaping and UTF-8 BOM for Excel
  // FIX #9: filename reflects the actual selected area
  const exportCSV = () => {
    const headers = ['building_id', 'age', 'structure_type', 'floor_area_m2', 'timber_m3', 'concrete_m3', 'steel_t', 'co2_savings_t', 'risk_level'];

    const rows = selectedBuildings.map(b => {
      const riskLevel = b.currentRisk > 0.8 ? 'Critical' : b.currentRisk > 0.6 ? 'High' : b.currentRisk > 0.4 ? 'Medium' : 'Low';
      return [
        b.id, b.age, b.structureType, b.totalFloorArea,
        b.timber.toFixed(1), b.concrete.toFixed(1), b.steel.toFixed(2),
        b.co2_savings.toFixed(1), riskLevel
      ].map(csvField).join(',');
    });

    const csvBody = [headers.join(','), ...rows].join('\r\n');
    const BOM = '\uFEFF'; // ensures Excel reads UTF-8 correctly on Windows
    const blob = new Blob([BOM + csvBody], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${slugify(selectedAreaName)}_recovery_plan.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Clean up the object URL after the download kicks off
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Analytics datasets for selected buildings
  const totalTimber = selectedBuildings.reduce((s, b) => s + b.timber, 0);
  const totalConcrete = selectedBuildings.reduce((s, b) => s + b.concrete, 0);
  const totalSteel = selectedBuildings.reduce((s, b) => s + b.steel, 0);
  const totalCO2 = selectedBuildings.reduce((s, b) => s + b.co2_savings, 0);

  const materialByType = ['木造', 'RC造', '鉄骨造'].map(type => {
    const subset = selectedBuildings.filter(b => b.structureType === type);
    return {
      type,
      timber: subset.reduce((sum, b) => sum + b.timber, 0),
      concrete: subset.reduce((sum, b) => sum + b.concrete, 0),
      steel: subset.reduce((sum, b) => sum + b.steel, 0),
    };
  });

  // FIX #8: pie chart now uses honest estimated mass (tonnes) for all three materials,
  // so wedge sizes are actually comparable. Densities: timber ≈ 0.5 t/m³, concrete ≈ 2.4 t/m³, steel = 1 t/t.
  const timberTonnes = totalTimber * 0.5;
  const concreteTonnes = totalConcrete * 2.4;
  const steelTonnes = totalSteel;
  const pieData = [
    { name: 'Timber', value: timberTonnes },
    { name: 'Concrete', value: concreteTonnes },
    { name: 'Steel', value: steelTonnes }
  ];

  return (
    <div className="flex bg-[#f8f9fa] text-[#212529] min-h-screen font-sans">

      {/* Sidebar */}
      <div className="w-[320px] shrink-0 border-r border-[#dee2e6] bg-[#ffffff] flex flex-col h-screen overflow-y-auto z-10 shadow-sm relative">
        <div className="p-[24px] border-b border-[#dee2e6] bg-slate-50">
          <div className="text-[1.1rem] font-[800] text-[#2ecc71] leading-tight uppercase">
            Material Recovery
          </div>
          <div className="text-[0.8rem] text-[#212529] font-[500] mt-1 tracking-wide uppercase">
            Tokyo City Planner's Edition
          </div>
        </div>

        <div className="p-[24px] flex flex-col gap-[20px] flex-1">
          <div className="flex flex-col gap-[8px]">
            <label className="text-[0.75rem] uppercase font-bold text-[#6c757d] tracking-[0.05em] flex items-center gap-2">
              <MousePointer size={14}/> Selection Scope
            </label>
            <select
              value={selectedAreaName}
              onChange={(e) => {
                setSelectedAreaName(e.target.value);
                setCustomCenter(null);
                setDrawPoints([]);
              }}
              className="w-full bg-[#f8f9fa] border border-[#dee2e6] rounded-[6px] p-[10px] text-[0.85rem] text-[#212529] outline-none focus:border-[#2ecc71] font-medium"
            >
              {Object.keys(SUB_AREAS).map(area => <option key={area} value={area}>{area}</option>)}
            </select>
          </div>

          {selectedAreaName === "Custom Selection (Click Radius)" && (
            <div className="flex flex-col gap-[8px] p-3 rounded-lg border border-blue-100 bg-blue-50">
              <span className="text-xs text-blue-700 font-medium">Click anywhere on the map to set zone center.</span>
              <label className="text-[0.75rem] uppercase font-bold text-[#6c757d] tracking-[0.05em] mt-2">Selection Radius ({customRadius}m)</label>
              <input
                type="range" min="100" max="1500" step="100" value={customRadius}
                onChange={(e) => setCustomRadius(Number(e.target.value))}
                className="w-full cursor-pointer accent-[#2ecc71]"
              />
            </div>
          )}

          {selectedAreaName === "Custom Selection (Draw Freehand)" && (
            <div className="flex flex-col gap-[8px] p-3 rounded-lg border border-red-100 bg-red-50">
              <span className="text-xs text-red-700 font-medium">Click on the map to place vertices and draw a custom polygon. (Need at least 3 points)</span>
              <button onClick={() => setDrawPoints([])} className="mt-2 bg-red-100 hover:bg-red-200 text-red-800 transition-colors text-xs font-bold py-2 px-3 rounded shadow-sm text-center">Clear Drawing</button>
            </div>
          )}

          <div className="bg-[#f8f9fa] rounded-lg p-4 border border-[#dee2e6] shadow-inner mt-4">
            <h4 className="text-[0.65rem] font-bold text-[#6c757d] uppercase tracking-wider mb-3">Tokyo Metro Baselines</h4>

            <div className="relative group flex justify-between items-center text-sm py-1.5 border-b border-gray-100 cursor-help">
               <span className="text-[#6c757d]">Annual Waste:</span>
               <span className="font-bold">{TOKYO_DATA.annual_waste_tonnes.toLocaleString()} t</span>
               <div className="absolute left-0 top-full mt-1 w-[220px] bg-[#2c3e50] text-white text-xs p-2 rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-[9999]">
                 Total waste generated annually across all 23 Tokyo special wards. Source: Tokyo Metropolitan Government FY2023 waste report.
               </div>
            </div>

            <div className="relative group flex justify-between items-center text-sm py-1.5 border-b border-gray-100 cursor-help">
               <span className="text-[#6c757d]">C&D Share:</span>
               <span className="font-bold">{TOKYO_DATA.cd_waste_share_pct}%</span>
               <div className="absolute left-0 top-full mt-1 w-[220px] bg-[#2c3e50] text-white text-xs p-2 rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-[9999]">
                 Construction and Demolition waste as a share of total waste. Includes materials from building demolition, renovation, and new construction across Tokyo. Equivalent to ~224,000 tonnes per year.
               </div>
            </div>

            <div className="relative group flex justify-between items-center text-sm py-1.5 border-b border-gray-100 cursor-help">
               <span className="text-[#6c757d]">Current Recovery:</span>
               <span className="font-bold text-[#e74c3c]">{TOKYO_DATA.recycling_rate_pct}%</span>
               <div className="absolute left-0 top-full mt-1 w-[220px] bg-[#2c3e50] text-white text-xs p-2 rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-[9999]">
                 Percentage of C&D waste currently recovered and reused rather than incinerated or landfilled. Only 21.5% is recovered — meaning ~175,000 tonnes is lost every year. This tool helps close that gap.
               </div>
            </div>

          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden relative">

        {/* Status Bar */}
        <div className="h-[36px] bg-[#212529] shrink-0 border-b border-[#363A45] flex items-center px-[20px] justify-between z-20">
          <div className="flex items-center gap-[15px] font-mono text-[10px] tracking-[0.1em]">
            <span className="text-[#6c757d]">LIVE DATA STATUS:</span>
            <span className={cn("flex items-center gap-[4px]", plateauStatus === 'LIVE' ? "text-[#2ecc71]" : "text-[#f39c12]")}>
              <span className="w-[6px] h-[6px] rounded-full bg-current"></span> PLATEAU BLDG: {plateauStatus}
            </span>
          </div>
          <div className="text-[10px] text-[#6c757d] font-mono">
             PRIORITY SCORE ENGINE: ACTIVE
          </div>
        </div>

        {/* Tab Header */}
        <div className="h-[50px] shrink-0 bg-[#ffffff] border-b border-[#dee2e6] flex items-center px-[20px] gap-[10px] z-20 shadow-sm relative">
          <button
            onClick={() => setActiveTab('map')}
            className={cn("px-[16px] py-[8px] rounded-[6px] text-[0.8rem] font-bold transition-all shadow-sm flex items-center gap-2", activeTab === 'map' ? "bg-[#212529] text-[#ffffff]" : "bg-[#f8f9fa] text-[#6c757d] border border-[#dee2e6] hover:bg-[#e9ecef]")}
          >
            <MapIcon size={14}/> 1. Select Area
          </button>
          <button
            onClick={() => setActiveTab('material')}
            className={cn("px-[16px] py-[8px] rounded-[6px] text-[0.8rem] font-bold transition-all shadow-sm flex items-center gap-2", activeTab === 'material' ? "bg-[#212529] text-[#ffffff]" : "bg-[#f8f9fa] text-[#6c757d] border border-[#dee2e6] hover:bg-[#e9ecef]")}
          >
            <BarChart3 size={14}/> 2. Material Breakdown
          </button>
          <button
            onClick={() => setActiveTab('recovery')}
            className={cn("px-[16px] py-[8px] rounded-[6px] text-[0.8rem] font-bold transition-all shadow-sm flex items-center gap-2", activeTab === 'recovery' ? "bg-[#2ecc71] text-white" : "bg-[#f8f9fa] text-[#6c757d] border border-[#dee2e6] hover:bg-[#e9ecef]")}
          >
            <Recycle size={14}/> 3. Recovery Plan
          </button>
        </div>

        {/* Dynamic Wrapper */}
        <div className="flex-1 relative overflow-auto bg-[#f8f9fa]">

          {dataWarning && (
            <div className="bg-[#fff3cd] border-b border-[#ffeeba] text-[#856404] px-[20px] py-[10px] text-[0.8rem] z-30 relative font-medium shadow-sm">
              {dataWarning}
            </div>
          )}

          {/* TAB 1: AREA SELECTION */}
          <div className={cn("absolute inset-0 transition-opacity duration-300 flex flex-col", activeTab === 'map' ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0")}>

            <div className="flex-1 w-full relative">
              <MapContainer
                center={[TOKYO_CENTER.lat, TOKYO_CENTER.lng]}
                zoom={11} minZoom={11}
                maxBounds={TOKYO_BOUNDS} maxBoundsViscosity={1.0}
                className="w-full h-full"
                zoomControl={true} scrollWheelZoom={true} doubleClickZoom={true} touchZoom={true}
              >
                {/* FIX #4: only fit bounds when the tab is visible */}
                <FitBounds buildings={selectedBuildings} enabled={activeTab === 'map'} />
                <MapEventsHandler onMapClick={handleMapClick} />
                <LayersControl position="topright">
                  <LayersControl.BaseLayer checked name="Light Map (Positron)">
                    <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                  </LayersControl.BaseLayer>

                  <LayersControl.Overlay checked name="Tokyo Buildings">
                    <LayerGroup>
                      {processedBuildings.map(b => {
                        const isSelected = selectedBuildingIds.has(b.id);
                        return (
                          <CircleMarker
                            key={b.id} center={[b.lat, b.lng]} radius={isSelected ? 3 : 1}
                            pathOptions={{
                              color: isSelected ? '#2ecc71' : '#ced4da',
                              fillColor: isSelected ? '#2ecc71' : '#ced4da',
                              fillOpacity: isSelected ? 0.9 : 0.4,
                              weight: 1
                            }}
                          >
                            <Popup className="custom-popup">
                              <div className="font-sans text-[#212529] p-[5px]">
                                <h3 className="font-bold text-[1rem] tracking-tight mb-[10px] text-[#2ecc71] pb-[5px] border-b border-[#dee2e6]">{b.id}</h3>
                                <div className="grid grid-cols-2 gap-x-[15px] gap-y-[5px] text-[0.85rem] mb-[15px]">
                                  <span className="text-[#6c757d] uppercase text-[0.7rem] pt-[2px]">Age</span> <span className="font-medium text-right font-mono">{b.age} yr</span>
                                  <span className="text-[#6c757d] uppercase text-[0.7rem] pt-[2px]">Type</span> <span className="font-medium text-right font-mono">{b.structureType}</span>
                                  <span className="text-[#6c757d] uppercase text-[0.7rem] pt-[2px]">Area</span> <span className="font-medium text-right font-mono">{b.totalFloorArea}m²</span>
                                </div>
                                <div className="text-[0.8rem] text-[#212529] space-y-[4px] border-t border-[#dee2e6] pt-[10px] font-mono">
                                  <div className="flex justify-between"><span className="text-[#2ecc71]">Timber:</span> <span>{b.timber.toFixed(1)}m³</span></div>
                                  <div className="flex justify-between"><span className="text-[#95a5a6]">Concrete:</span> <span>{b.concrete.toFixed(1)}m³</span></div>
                                  <div className="flex justify-between"><span className="text-[#3498db]">Steel:</span> <span>{b.steel.toFixed(2)}t</span></div>
                                </div>
                              </div>
                            </Popup>
                          </CircleMarker>
                        );
                      })}
                    </LayerGroup>
                  </LayersControl.Overlay>

                  <LayersControl.Overlay checked name="Recycling Facilities">
                    <LayerGroup>
                      {facilities.map((f, i) => {
                        let iconObj = mixedIcon;
                        const t = f.materials.includes("timber");
                        const c = f.materials.includes("concrete");
                        const s = f.materials.includes("steel");
                        const count = (t ? 1 : 0) + (c ? 1 : 0) + (s ? 1 : 0);

                        if (count <= 1) {
                            if (t) iconObj = timberIcon;
                            else if (c) iconObj = concreteIcon;
                            else if (s) iconObj = steelIcon;
                        }

                        return (
                          <Marker key={`fac-${i}`} position={[f.lat, f.lng]} icon={iconObj}>
                            <Popup>
                              <span className="font-bold text-gray-800">{f.name}</span><br/>
                              <span className="text-xs text-gray-500 uppercase">{f.type.replace('_', ' ')}</span><br/>
                              <span className="text-xs">Accepts: {f.materials.join(', ')}</span>
                            </Popup>
                          </Marker>
                        );
                      })}
                    </LayerGroup>
                  </LayersControl.Overlay>

                  {selectedAreaName === "Custom Selection (Click Radius)" && customCenter && (
                    <LayersControl.Overlay checked name="Custom Radius Box">
                      <Circle
                        center={[customCenter.lat, customCenter.lng]} radius={customRadius}
                        pathOptions={{ color: '#3498db', fillColor: '#3498db', fillOpacity: 0.1, weight: 2, dashArray: "4, 8" }}
                      />
                    </LayersControl.Overlay>
                  )}
                  {selectedAreaName === "Custom Selection (Draw Freehand)" && drawPoints.length > 0 && (
                    <LayersControl.Overlay checked name="Custom Drawn Area">
                      <LayerGroup>
                        {drawPoints.map((p, i) => (
                          <CircleMarker key={i} center={[p.lat, p.lng]} radius={4} pathOptions={{ color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 1 }} />
                        ))}
                        {drawPoints.length === 2 && (
                          <Polyline positions={drawPoints} pathOptions={{ color: '#e74c3c', weight: 2, dashArray: "4, 8" }} />
                        )}
                        {drawPoints.length > 2 && (
                          <Polygon positions={drawPoints} pathOptions={{ color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 0.1, weight: 2, dashArray: "4, 8" }} />
                        )}
                      </LayerGroup>
                    </LayersControl.Overlay>
                  )}
                  {selectedAreaName !== "All Tokyo" && selectedAreaName !== "Custom Selection (Click Radius)" && selectedAreaName !== "Custom Selection (Draw Freehand)" && SUB_AREAS[selectedAreaName] && (
                    <LayersControl.Overlay checked name="Selected Zone">
                      <Circle
                        center={[SUB_AREAS[selectedAreaName]!.lat, SUB_AREAS[selectedAreaName]!.lng]} radius={SUB_AREAS[selectedAreaName]!.radius}
                        pathOptions={{ color: '#3498db', fillColor: '#3498db', fillOpacity: 0.1, weight: 2, dashArray: "4, 8" }}
                      />
                    </LayersControl.Overlay>
                  )}
                </LayersControl>
              </MapContainer>
            </div>

            <div className="h-[140px] shrink-0 bg-white border-t border-[#dee2e6] p-[20px] shadow-[0_-4px_10px_rgba(0,0,0,0.02)] z-20 flex gap-6 items-center">
               <div className="pr-6 border-r border-[#dee2e6]">
                  <div className="text-[2rem] font-bold text-[#2ecc71] leading-none mb-1">{selectedBuildings.length}</div>
                  <div className="text-[0.7rem] uppercase font-bold text-[#6c757d] tracking-wider">Priority Buildings Selected</div>
               </div>
               <div className="flex gap-4 overflow-x-auto flex-1 items-center">
                 <div className="flex flex-col gap-1">
                   <span className="text-xs text-gray-500 uppercase font-bold">Total Floor Area</span>
                   <span className="text-lg font-mono font-bold">{selectedBuildings.reduce((s,b)=>s+b.totalFloorArea,0).toLocaleString()} m²</span>
                 </div>
                 <div className="w-[1px] h-8 bg-gray-200"></div>
                 <div className="flex flex-col gap-1">
                   <span className="text-xs text-gray-500 uppercase font-bold">Dominant Type</span>
                   <span className="text-lg font-mono font-bold text-[#3498db]">
                     {selectedBuildings.length > 0 ? Object.entries(selectedBuildings.reduce((a:any,b)=> {a[b.structureType]=(a[b.structureType]||0)+1; return a;},{})).sort((a:any,b:any)=>b[1]-a[1])[0][0] : 'N/A'}
                   </span>
                 </div>
                 <div className="w-[1px] h-8 bg-gray-200"></div>
                 <div className="flex flex-col gap-1">
                   <span className="text-xs text-gray-500 uppercase font-bold">Oldest Potential Age</span>
                   <span className="text-lg font-mono font-bold text-[#e74c3c]">{selectedBuildings.length > 0 ? Math.max(...selectedBuildings.map(b=>b.age)) : 0} yrs</span>
                 </div>
               </div>
            </div>
          </div>

          {/* TAB 2: MATERIAL BREAKDOWN */}
          <div className={cn("absolute inset-0 p-[30px] overflow-y-auto transition-opacity duration-300", activeTab === 'material' ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0")}>
            <div className="max-w-6xl mx-auto space-y-[30px]">

              <div className="flex gap-[20px] overflow-x-auto pb-[10px]">
                <KPIDisplay title="Total Timber" value={totalTimber.toLocaleString(undefined, {maximumFractionDigits:0})} unit="m³" icon={Leaf} colorClass="flex-1 min-w-[200px] border-l-[4px] border-l-[#2ecc71]" />
                <KPIDisplay title="Total Concrete" value={totalConcrete.toLocaleString(undefined, {maximumFractionDigits:0})} unit="m³" icon={Building} colorClass="flex-1 min-w-[200px] border-l-[4px] border-l-[#95a5a6]" />
                <KPIDisplay title="Total Steel" value={totalSteel.toLocaleString(undefined, {maximumFractionDigits:1})} unit="t" icon={Activity} colorClass="flex-1 min-w-[200px] border-l-[4px] border-l-[#3498db]" />
                <KPIDisplay title="CO₂ Savings Pot." value={totalCO2.toLocaleString(undefined, {maximumFractionDigits:0})} unit="t" icon={Recycle} colorClass="flex-1 min-w-[200px] border-l-[4px] border-l-[#f39c12]" />
              </div>

              <div className="grid grid-cols-3 gap-[30px] h-[350px]">
                <div className="col-span-2 bg-white border border-[#dee2e6] rounded-[8px] p-[20px] flex flex-col shadow-sm">
                  <h3 className="text-[0.7rem] font-bold text-[#6c757d] uppercase tracking-[0.05em] mb-[20px] flex items-center gap-[8px]"><Recycle size={14}/> Materials by Structure Type</h3>
                  <div className="flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={materialByType} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e9ecef" vertical={false} />
                        <XAxis dataKey="type" stroke="#dee2e6" tick={{fill: '#6c757d', fontSize: 12}} />
                        <YAxis stroke="#dee2e6" tick={{fill: '#6c757d', fontSize: 12}} />
                        <RechartsTooltip cursor={{fill: '#f8f9fa'}} contentStyle={{backgroundColor: '#ffffff', borderColor: '#dee2e6', color: '#212529', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'}} />
                        <Legend wrapperStyle={{paddingTop: '10px', fontSize: '12px'}} />
                        <Bar dataKey="timber" stackId="a" fill="#2ecc71" name="Timber (m³)" />
                        <Bar dataKey="concrete" stackId="a" fill="#95a5a6" name="Concrete (m³)" />
                        <Bar dataKey="steel" stackId="a" fill="#3498db" name="Steel (t)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white border border-[#dee2e6] rounded-[8px] p-[20px] flex flex-col shadow-sm">
                  {/* FIX #8: title/label now honestly reflects what's being compared (estimated mass, tonnes) */}
                  <h3 className="text-[0.7rem] font-bold text-[#6c757d] uppercase tracking-[0.05em] mb-[4px] flex items-center gap-[8px]"><Activity size={14}/> Recoverable Mass Share</h3>
                  <p className="text-[0.65rem] text-[#6c757d] mb-[16px]">Estimated tonnes (timber ×0.5 t/m³, concrete ×2.4 t/m³)</p>
                  <div className="flex-1 w-full min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={5} dataKey="value" label={({name}) => `${name}`} stroke="none">
                          <Cell fill="#2ecc71" />
                          <Cell fill="#95a5a6" />
                          <Cell fill="#3498db" />
                        </Pie>
                        <RechartsTooltip
                          contentStyle={{backgroundColor: '#ffffff', borderColor: '#dee2e6', color: '#212529', borderRadius: '8px'}}
                          formatter={(value: number) => [`${value.toLocaleString(undefined, {maximumFractionDigits:0})} t`, 'Mass']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-[#dee2e6] rounded-[8px] flex flex-col shadow-sm overflow-hidden mt-6">
                 <div className="p-[20px] border-b border-[#dee2e6] bg-slate-50 flex items-center justify-between">
                    <h3 className="text-[0.7rem] font-bold text-[#6c757d] uppercase tracking-[0.05em]">Selected Buildings Directory</h3>
                 </div>
                 <div className="overflow-x-auto p-4 max-h-[400px]">
                    <table className="w-full text-left text-[0.85rem] whitespace-nowrap border-collapse">
                      <thead>
                        <tr className="border-b-2 border-[#dee2e6] text-[#6c757d] uppercase text-[0.7rem] tracking-[0.05em]">
                          <th className="pb-[12px] px-[12px] font-bold">ID</th>
                          <th className="pb-[12px] px-[12px] font-bold">Age</th>
                          <th className="pb-[12px] px-[12px] font-bold">Type</th>
                          <th className="pb-[12px] px-[12px] font-bold text-right">Floor Area (m²)</th>
                          <th className="pb-[12px] px-[12px] font-bold text-right">Timber (m³)</th>
                          <th className="pb-[12px] px-[12px] font-bold text-right">Concrete (m³)</th>
                          <th className="pb-[12px] px-[12px] font-bold text-right">Steel (t)</th>
                          <th className="pb-[12px] px-[12px] font-bold text-right">Priority Level</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 text-[#212529]">
                        {selectedBuildings.slice(0, 50).map(b => (
                          <tr key={b.id} className="hover:bg-[#f8f9fa] transition-colors">
                            <td className="py-[12px] px-[12px] font-mono text-[#3498db]">{b.id}</td>
                            <td className="py-[12px] px-[12px] font-mono">{b.age}y</td>
                            <td className="py-[12px] px-[12px]"><span className="px-2 py-1 bg-gray-100 rounded text-xs">{b.structureType}</span></td>
                            <td className="py-[12px] px-[12px] text-right font-mono">{b.totalFloorArea}</td>
                            <td className="py-[12px] px-[12px] text-right font-mono text-[#2ecc71]">{b.timber.toFixed(1)}</td>
                            <td className="py-[12px] px-[12px] text-right font-mono text-[#95a5a6]">{b.concrete.toFixed(1)}</td>
                            <td className="py-[12px] px-[12px] text-right font-mono text-[#3498db]">{b.steel.toFixed(2)}</td>
                            <td className="py-[12px] px-[12px] text-right font-bold text-xs">
                               <span className="px-2 py-1 rounded w-20 inline-block text-center" style={{backgroundColor: getRiskLevel(b.currentRisk).color + '20', color: getRiskLevel(b.currentRisk).color}}>
                                 {getRiskLevel(b.currentRisk).label}
                               </span>
                            </td>
                          </tr>
                        ))}
                        {selectedBuildings.length === 0 && (
                          <tr><td colSpan={8} className="text-center py-6 text-gray-500">No buildings selected. Use the map tab to select an area.</td></tr>
                        )}
                      </tbody>
                    </table>
                    {selectedBuildings.length > 50 && <div className="text-center text-xs text-gray-400 mt-4 italic">+ {selectedBuildings.length - 50} more in export</div>}
                 </div>
              </div>

            </div>
          </div>

          {/* TAB 3: RECOVERY PLAN */}
          <div className={cn("absolute inset-0 p-[30px] overflow-y-auto transition-opacity duration-300", activeTab === 'recovery' ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0")}>
            <div className="max-w-6xl mx-auto space-y-[30px]">

              {(() => {
                // FIX #11: rename to reflect that this is the total recovered mass value,
                // not just "incineration savings." Steel isn't incinerated; concrete typically isn't either.
                // Formula converts timber/concrete m³ to tonnes, then applies a unified per-tonne disposal-cost avoided rate.
                const totalRecoveredTonnes = totalTimber * 0.5 + totalConcrete * 2.4 + totalSteel;
                const disposalCostAvoidedYen = totalRecoveredTonnes * 15000;
                const treesPlanted = Math.floor(totalCO2 * 45);
                const carsOffRoad = Math.floor(totalCO2 / 4.6);

                return (
                  <>
                    <div className="flex justify-between items-center bg-white rounded-xl border border-gray-200 p-6 shadow-sm border-l-4 border-l-[#2ecc71]">
                       <div>
                         <h2 className="text-xl font-bold text-[#212529] mb-1 flex items-center gap-2"><Recycle className="text-[#2ecc71]"/> Impact Bottom Line</h2>
                         <p className="text-[#6c757d] text-sm max-w-2xl">
                           Strategic urban mining across {selectedBuildings.length} prioritized structures recovers <strong className="text-[#212529]">{totalRecoveredTonnes.toLocaleString(undefined, {maximumFractionDigits:0})} tonnes</strong> of materials, dramatically offsetting disposal footprints.
                         </p>
                       </div>
                       <button onClick={exportCSV} className="bg-[#2ecc71] hover:bg-[#27ae60] text-white px-4 py-2 rounded-lg font-bold shadow flex items-center gap-2 transition-colors shrink-0">
                           <Download size={16}/> Export Asset CSV
                       </button>
                    </div>

                    <div className="grid grid-cols-4 gap-6">
                       <div className="border border-gray-100 rounded-xl p-5 bg-white shadow-sm flex flex-col justify-center">
                          <div className="text-xs font-bold text-gray-500 uppercase mb-1">Disposal Cost Avoided</div>
                          <div className="text-2xl font-black text-[#212529]">¥{(disposalCostAvoidedYen/1000000).toFixed(1)}M</div>
                       </div>
                       <div className="border border-gray-100 rounded-xl p-5 bg-emerald-50 shadow-sm flex flex-col justify-center">
                          <div className="text-xs font-bold text-emerald-600 uppercase mb-1">CO₂ Avoided</div>
                          <div className="text-2xl font-black text-emerald-700">{totalCO2.toLocaleString(undefined, {maximumFractionDigits:0})} t</div>
                       </div>
                       <div className="border border-gray-100 rounded-xl p-5 bg-blue-50 shadow-sm flex flex-col justify-center">
                          <div className="text-xs font-bold text-blue-600 uppercase mb-1">Cars Off Road (Eqv)</div>
                          <div className="text-2xl font-black text-blue-700">{carsOffRoad.toLocaleString()}</div>
                       </div>
                       <div className="border border-gray-100 rounded-xl p-5 bg-orange-50 shadow-sm flex flex-col justify-center">
                          <div className="text-xs font-bold text-orange-600 uppercase mb-1">Trees Planted (Eqv)</div>
                          <div className="text-2xl font-black text-orange-700">{treesPlanted.toLocaleString()}</div>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                       <div className="bg-white border-t-4 border-t-[#2ecc71] border border-gray-200 rounded-xl p-5 shadow-sm">
                          <h3 className="font-bold text-lg text-[#212529] mb-4 flex items-center gap-2"><Leaf className="text-[#2ecc71]" size={18}/> Timber Facilities</h3>
                          <div className="space-y-3">
                             {nearestFacilities.timber.length > 0 ? nearestFacilities.timber.map((f, i) => (
                               <div key={i} className="bg-slate-50 border border-slate-100 rounded-lg p-3 hover:shadow-sm transition-shadow">
                                 <h4 className="font-bold text-green-900 text-sm mb-1 truncate" title={f.name}>{f.name}</h4>
                                 <div className="text-xs text-slate-500 mb-1 font-medium">📍 {f.distance_km} km away <span className="mx-1">•</span> 🏭 {f.type}</div>
                                 {f.opening_hours && <div className="text-xs text-slate-600 truncate">🕐 {f.opening_hours}</div>}
                                 {f.phone && <div className="text-xs text-slate-600">📞 {f.phone}</div>}
                               </div>
                             )) : <div className="text-sm text-gray-500 italic">No timber facilities found in radius.</div>}
                          </div>
                       </div>

                       <div className="bg-white border-t-4 border-t-[#95a5a6] border border-gray-200 rounded-xl p-5 shadow-sm">
                          <h3 className="font-bold text-lg text-[#212529] mb-4 flex items-center gap-2"><Building className="text-[#95a5a6]" size={18}/> Concrete Facilities</h3>
                          <div className="space-y-3">
                             {nearestFacilities.concrete.length > 0 ? nearestFacilities.concrete.map((f, i) => (
                               <div key={i} className="bg-slate-50 border border-slate-100 rounded-lg p-3 hover:shadow-sm transition-shadow">
                                 <h4 className="font-bold text-gray-700 text-sm mb-1 truncate" title={f.name}>{f.name}</h4>
                                 <div className="text-xs text-slate-500 mb-1 font-medium">📍 {f.distance_km} km away <span className="mx-1">•</span> 🏭 {f.type}</div>
                                 {f.opening_hours && <div className="text-xs text-slate-600 truncate">🕐 {f.opening_hours}</div>}
                                 {f.phone && <div className="text-xs text-slate-600">📞 {f.phone}</div>}
                               </div>
                             )) : <div className="text-sm text-gray-500 italic">No concrete facilities found in radius.</div>}
                          </div>
                       </div>

                       <div className="bg-white border-t-4 border-t-[#3498db] border border-gray-200 rounded-xl p-5 shadow-sm">
                          <h3 className="font-bold text-lg text-[#212529] mb-4 flex items-center gap-2"><Activity className="text-[#3498db]" size={18}/> Steel Facilities</h3>
                          <div className="space-y-3">
                             {nearestFacilities.steel.length > 0 ? nearestFacilities.steel.map((f, i) => (
                               <div key={i} className="bg-slate-50 border border-slate-100 rounded-lg p-3 hover:shadow-sm transition-shadow">
                                 <h4 className="font-bold text-blue-900 text-sm mb-1 truncate" title={f.name}>{f.name}</h4>
                                 <div className="text-xs text-slate-500 mb-1 font-medium">📍 {f.distance_km} km away <span className="mx-1">•</span> 🏭 {f.type}</div>
                                 {f.opening_hours && <div className="text-xs text-slate-600 truncate">🕐 {f.opening_hours}</div>}
                                 {f.phone && <div className="text-xs text-slate-600">📞 {f.phone}</div>}
                               </div>
                             )) : <div className="text-sm text-gray-500 italic">No steel facilities found in radius.</div>}
                          </div>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-[25px]">
                       <div className="bg-white border border-[#dee2e6] rounded-xl p-6 shadow-sm overflow-hidden min-h-[400px]">
                          <h3 className="font-bold text-xl text-[#212529] mb-4 pb-2 border-b border-gray-100">📋 Recovery Action Checklist</h3>

                          {selectedBuildings.length > 0 ? (
                            <div className="space-y-4 text-sm text-[#212529] mt-4">
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Contact nearest timber facility: <strong className="text-green-700">{nearestFacilities.timber[0]?.name || 'Unknown'}</strong> ({nearestFacilities.timber[0]?.distance_km || '0'} km)
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Contact nearest concrete processor: <strong className="text-gray-700">{nearestFacilities.concrete[0]?.name || 'Unknown'}</strong> ({nearestFacilities.concrete[0]?.distance_km || '0'} km)
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Contact nearest scrap metal yard: <strong className="text-blue-700">{nearestFacilities.steel[0]?.name || 'Unknown'}</strong> ({nearestFacilities.steel[0]?.distance_km || '0'} km)
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Arrange <strong className="font-mono text-lg">{totalTimber.toFixed(0)} m³</strong> timber pickup and transfer
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Arrange <strong className="font-mono text-lg">{totalConcrete.toFixed(0)} m³</strong> concrete crushing dispatch
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Arrange <strong className="font-mono text-lg">{totalSteel.toFixed(1)} t</strong> steel collection
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    File recovery plan with Tokyo Metro construction division
                                 </span>
                               </label>
                               <label className="flex items-start gap-4 cursor-pointer group">
                                 <input type="checkbox" className="mt-1 w-5 h-5 text-[#3498db] rounded border-gray-300" />
                                 <span className="group-hover:text-[#3498db] transition-colors leading-relaxed text-[15px]">
                                    Schedule site assessments for {selectedBuildings.filter(b => b.currentRisk >= 0.8).length} critical-priority buildings
                                 </span>
                               </label>
                            </div>
                          ) : (
                            <div className="text-gray-400 italic text-center py-20">Select buildings on the map to generate deployment checklist.</div>
                          )}
                       </div>

                       <div className="bg-white border border-[#dee2e6] rounded-xl overflow-hidden shadow-sm flex flex-col h-full min-h-[500px]">
                          <div className="flex items-center justify-between p-[20px] border-b border-gray-100 bg-slate-50 shrink-0">
                            <h3 className="text-[0.7rem] font-bold text-[#6c757d] uppercase tracking-[0.05em]"><MapIcon size={14} className="inline mr-2"/> Deployment Topology</h3>
                            <div className="flex gap-3 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#2ecc71]"></span> Timber</span>
                               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#bdc3c7]"></span> Concrete</span>
                               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#3498db]"></span> Steel</span>
                            </div>
                          </div>
                          <div className="flex-1 w-full relative">
                              <MapContainer
                                center={mapCenterObj.lat && mapCenterObj.lng ? [mapCenterObj.lat, mapCenterObj.lng] : [TOKYO_CENTER.lat, TOKYO_CENTER.lng]}
                                zoom={12}
                                className="w-full h-full"
                                zoomControl={true} scrollWheelZoom={true} doubleClickZoom={true} touchZoom={true}
                              >
                                {/* FIX #4: only fit bounds when Recovery tab is visible */}
                                <FitBounds buildings={selectedBuildings} enabled={activeTab === 'recovery'} />
                                <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                                <LayerGroup>
                                   {selectedBuildings.map(b => <CircleMarker key={b.id} center={[b.lat, b.lng]} radius={1} pathOptions={{color:'#bdc3c7', fillColor:'#bdc3c7', fillOpacity:1}} />)}

                                   {/* Facilities & Routes */}
                                   {nearestFacilities.timber.map((f, i) => (
                                     <React.Fragment key={`tf-${i}`}>
                                       <Polyline positions={[[mapCenterObj.lat, mapCenterObj.lng], [f.lat, f.lng]]} pathOptions={{ color: '#2ecc71', dashArray: '4,6', weight: 2, opacity: 0.8 }} />
                                       <CircleMarker center={[f.lat, f.lng]} radius={8} pathOptions={{ color: 'white', fillColor: '#2ecc71', fillOpacity: 1, weight: 2 }}>
                                          <Popup><b>{f.name}</b><br/>{f.type}<br/>Timber accepted</Popup>
                                       </CircleMarker>
                                     </React.Fragment>
                                   ))}

                                   {nearestFacilities.concrete.map((f, i) => (
                                     <React.Fragment key={`cf-${i}`}>
                                       <Polyline positions={[[mapCenterObj.lat, mapCenterObj.lng], [f.lat, f.lng]]} pathOptions={{ color: '#95a5a6', dashArray: '4,6', weight: 2, opacity: 0.8 }} />
                                       <CircleMarker center={[f.lat, f.lng]} radius={8} pathOptions={{ color: 'white', fillColor: '#95a5a6', fillOpacity: 1, weight: 2 }}>
                                          <Popup><b>{f.name}</b><br/>{f.type}<br/>Concrete accepted</Popup>
                                       </CircleMarker>
                                     </React.Fragment>
                                   ))}

                                   {nearestFacilities.steel.map((f, i) => (
                                     <React.Fragment key={`sf-${i}`}>
                                       <Polyline positions={[[mapCenterObj.lat, mapCenterObj.lng], [f.lat, f.lng]]} pathOptions={{ color: '#3498db', dashArray: '4,6', weight: 2, opacity: 0.8 }} />
                                       <CircleMarker center={[f.lat, f.lng]} radius={8} pathOptions={{ color: 'white', fillColor: '#3498db', fillOpacity: 1, weight: 2 }}>
                                          <Popup><b>{f.name}</b><br/>{f.type}<br/>Steel/Metal accepted</Popup>
                                       </CircleMarker>
                                     </React.Fragment>
                                   ))}

                                   {/* Center Pin */}
                                   {selectedBuildings.length > 0 && (
                                     <CircleMarker center={[mapCenterObj.lat, mapCenterObj.lng]} radius={5} pathOptions={{ color: 'white', fillColor: '#e74c3c', fillOpacity: 1, weight: 2 }}>
                                       <Popup>Selection Target Center</Popup>
                                     </CircleMarker>
                                   )}
                                </LayerGroup>
                              </MapContainer>
                          </div>
                       </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
