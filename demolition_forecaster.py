"""
Demolition Forecaster — PLATEAU 3D City Model Risk Assessment Tool
===================================================================
Processes building data from a PLATEAU GeoJSON file and produces:
  1. A JSON report: demolition_forecast_report.json
  2. A human-readable console summary

Usage:
    python demolition_forecaster.py path/to/buildings.geojson

Dependencies:
    pip install geopandas pandas numpy

Assumptions:
  - Current year is fixed to 2026 for all age calculations.
  - Buildings with missing or invalid yearOfConstruction are skipped.
  - Missing structureType defaults to "unknown".
  - Missing or zero totalFloorArea defaults to 100 m².
  - Ward names may appear in English (Shibuya) or Japanese (渋谷区);
    both forms are recognized for dense-ward classification.
  - Waste "at risk" totals in the ward summary include only High/Critical buildings.
"""

import argparse
import json
import logging
import math
import sys
from collections import defaultdict
from math import ceil

import geopandas as gpd
import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.WARNING,
    format="%(levelname)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CURRENT_YEAR = 2026
WEIBULL_SHAPE_K = 2.0
# Pre-computed: log(2)^(1/k) used in Weibull scale calculation (k=2 → sqrt(ln2))
WEIBULL_LN2_FACTOR = math.log(2) ** (1.0 / WEIBULL_SHAPE_K)  # ≈ 0.8326

MEDIAN_LIFESPAN = {
    "木造":   38,   # timber
    "RC造":   68,   # reinforced concrete
    "鉄骨造": 50,   # steel frame
    "S造":    50,   # steel (alternate designation)
    "default": 45,
}

WASTE_COEFFICIENTS = {
    "木造":    {"timber": 0.20, "concrete": 0.05, "steel_kg": 5},
    "RC造":    {"timber": 0.02, "concrete": 0.40, "steel_kg": 80},
    "鉄骨造":  {"timber": 0.05, "concrete": 0.10, "steel_kg": 120},
    "S造":     {"timber": 0.05, "concrete": 0.10, "steel_kg": 120},
    "default": {"timber": 0.05, "concrete": 0.20, "steel_kg": 20},
}

# Recognize both English transliterations and original Japanese ward names
DENSE_WARDS = {
    "Shibuya", "Shinjuku", "Chiyoda",
    "渋谷区", "新宿区", "千代田区",
}

DEFAULT_FLOOR_AREA = 100.0   # m² assumed when totalFloorArea is absent or invalid
RISK_CAP_PCT = 99.0          # maximum reported risk percentage
HIGH_RISK_THRESHOLD = 60.0   # 24-month risk % above which recommendation is generated
TIMBER_PER_COLLECTION_POINT = 500.0  # m³ of timber per temporary collection point


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="demolition_forecaster.py",
        description=(
            "Demolition Forecaster: compute Weibull-based demolition risk and "
            "waste estimates from a PLATEAU GeoJSON building dataset."
        ),
    )
    parser.add_argument(
        "geojson_file",
        metavar="GEOJSON_FILE",
        type=str,
        help="Path to the input GeoJSON file containing building features.",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_geojson(filepath: str) -> gpd.GeoDataFrame:
    """Load a GeoJSON file into a GeoDataFrame.

    Exits with status 1 on any read error.
    """
    try:
        gdf = gpd.read_file(filepath)
        log.info("Loaded %d features from '%s'.", len(gdf), filepath)
        return gdf
    except FileNotFoundError:
        log.critical("File not found: '%s'", filepath)
        sys.exit(1)
    except Exception as exc:
        log.critical("Failed to read GeoJSON '%s': %s", filepath, exc)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Per-building extraction and sanitisation
# ---------------------------------------------------------------------------

def extract_building_properties(row: pd.Series) -> dict | None:
    """Extract and validate properties from a single GeoDataFrame row.

    Returns a dict of cleaned fields, or None if the row must be skipped
    (e.g. missing or invalid yearOfConstruction).
    """
    # --- building_id ---
    raw_id = row.get("gml_id") or row.get("id")
    building_id = str(raw_id) if (raw_id is not None and str(raw_id).strip()) else f"building_{row.name}"

    # --- ward ---
    raw_ward = row.get("ward")
    ward = str(raw_ward).strip() if (raw_ward is not None and str(raw_ward).strip()) else "Unknown"

    # --- yearOfConstruction (mandatory; skip if invalid) ---
    raw_year = row.get("yearOfConstruction")
    if raw_year is None or (isinstance(raw_year, float) and math.isnan(raw_year)):
        log.warning("Skipping %s: yearOfConstruction is missing.", building_id)
        return None
    try:
        year = int(float(raw_year))
    except (ValueError, TypeError):
        log.warning("Skipping %s: yearOfConstruction '%s' is not numeric.", building_id, raw_year)
        return None
    if year < 1800 or year > CURRENT_YEAR:
        log.warning("Skipping %s: yearOfConstruction %d is out of plausible range.", building_id, year)
        return None

    # --- structureType ---
    raw_struct = row.get("structureType")
    if raw_struct is None or str(raw_struct).strip() == "" or str(raw_struct).lower() == "nan":
        structure_type = "unknown"
    else:
        structure_type = str(raw_struct).strip()

    # --- totalFloorArea ---
    raw_area = row.get("totalFloorArea")
    try:
        floor_area = float(raw_area) if raw_area is not None else None
    except (ValueError, TypeError):
        floor_area = None

    if floor_area is None or math.isnan(floor_area) or floor_area <= 0:
        if floor_area is not None and floor_area <= 0:
            log.debug("%s: totalFloorArea is %s, defaulting to %.1f m².", building_id, floor_area, DEFAULT_FLOOR_AREA)
        floor_area = DEFAULT_FLOOR_AREA

    age = max(0, CURRENT_YEAR - year)

    return {
        "building_id":         building_id,
        "ward":                ward,
        "year_of_construction": year,
        "structure_type":      structure_type,
        "floor_area_m2":       float(floor_area),
        "age":                 int(age),
    }


# ---------------------------------------------------------------------------
# Weibull survival analysis
# ---------------------------------------------------------------------------

def get_weibull_scale(structure_type: str) -> float:
    """Return the Weibull scale parameter λ for the given structure type.

    scale = median_life / (ln(2))^(1/k)
    """
    median = MEDIAN_LIFESPAN.get(structure_type, MEDIAN_LIFESPAN["default"])
    return median / WEIBULL_LN2_FACTOR


def compute_weibull_risk(age: int, T_years: float, scale: float) -> float:
    """Compute the conditional probability (%) of demolition within T_years.

    Given a building that has survived to `age` years, returns the probability
    it will be demolished in the next T_years under a Weibull(k=2) model.

    Returns a percentage value in [0, RISK_CAP_PCT].
    """
    k = WEIBULL_SHAPE_K
    S_A = math.exp(-((age / scale) ** k))

    # Guard: if survival at current age is effectively zero, cap risk at maximum
    if S_A == 0.0:
        return RISK_CAP_PCT

    S_AT = math.exp(-(((age + T_years) / scale) ** k))
    risk_pct = (S_A - S_AT) / S_A * 100.0
    return min(risk_pct, RISK_CAP_PCT)


# ---------------------------------------------------------------------------
# Waste estimation
# ---------------------------------------------------------------------------

def compute_waste(structure_type: str, floor_area_m2: float) -> dict:
    """Estimate demolition waste volumes for a building.

    Returns dict with keys: timber_m3, concrete_m3, steel_tons.
    """
    coefs = WASTE_COEFFICIENTS.get(structure_type, WASTE_COEFFICIENTS["default"])
    return {
        "timber_m3":    floor_area_m2 * coefs["timber"],
        "concrete_m3":  floor_area_m2 * coefs["concrete"],
        "steel_tons":   (floor_area_m2 * coefs["steel_kg"]) / 1000.0,
    }


# ---------------------------------------------------------------------------
# Risk classification
# ---------------------------------------------------------------------------

def classify_risk_level(risk_24m_pct: float) -> str:
    """Map a 24-month risk percentage to a qualitative risk level label."""
    if risk_24m_pct >= 81.0:
        return "Critical"
    if risk_24m_pct >= 61.0:
        return "High"
    if risk_24m_pct >= 31.0:
        return "Medium"
    return "Low"


# ---------------------------------------------------------------------------
# Intervention recommendation
# ---------------------------------------------------------------------------

def build_recommendation(props: dict, waste: dict, risk_24m_pct: float) -> dict | None:
    """Build an intervention recommendation for High/Critical buildings.

    Returns None if 24-month risk does not exceed HIGH_RISK_THRESHOLD.
    """
    if risk_24m_pct <= HIGH_RISK_THRESHOLD:
        return None

    timber_m3   = waste["timber_m3"]
    concrete_m3 = waste["concrete_m3"]
    steel_tons  = waste["steel_tons"]

    collection_points = int(ceil(timber_m3 / TIMBER_PER_COLLECTION_POINT))

    # Sort materials by volume/weight descending to identify priority
    material_volumes = [
        ("timber_m3",   timber_m3),
        ("concrete_m3", concrete_m3),
        ("steel_tons",  steel_tons),
    ]
    priority_materials = [
        name for name, _ in sorted(material_volumes, key=lambda x: x[1], reverse=True)
    ]

    placement_radius_m = 300 if props["ward"] in DENSE_WARDS else 500
    co2_savings_tons   = timber_m3 * 0.9

    return {
        "collection_points":   collection_points,
        "priority_materials":  priority_materials,
        "placement_radius_m":  placement_radius_m,
        "co2_savings_tons":    round(co2_savings_tons, 4),
    }


# ---------------------------------------------------------------------------
# Per-building orchestrator
# ---------------------------------------------------------------------------

def process_building(row: pd.Series) -> dict | None:
    """Run all calculations for a single building row.

    Returns a per-building assessment dict, or None if the row is skipped.
    """
    props = extract_building_properties(row)
    if props is None:
        return None

    scale      = get_weibull_scale(props["structure_type"])
    risk_12m   = compute_weibull_risk(props["age"], 1.0, scale)
    risk_24m   = compute_weibull_risk(props["age"], 2.0, scale)
    risk_36m   = compute_weibull_risk(props["age"], 3.0, scale)

    waste      = compute_waste(props["structure_type"], props["floor_area_m2"])
    risk_level = classify_risk_level(risk_24m)
    rec        = build_recommendation(props, waste, risk_24m)

    record: dict = {
        "building_id":     props["building_id"],
        "ward":            props["ward"],
        "age":             props["age"],
        "structure_type":  props["structure_type"],
        "floor_area_m2":   round(props["floor_area_m2"], 2),
        "risk_12m_pct":    round(risk_12m, 2),
        "risk_24m_pct":    round(risk_24m, 2),
        "risk_36m_pct":    round(risk_36m, 2),
        "waste_timber_m3":   round(waste["timber_m3"], 4),
        "waste_concrete_m3": round(waste["concrete_m3"], 4),
        "waste_steel_tons":  round(waste["steel_tons"], 4),
        "risk_level":      risk_level,
    }
    if rec is not None:
        record["recommendation"] = rec

    return record


# ---------------------------------------------------------------------------
# Ward-level aggregation
# ---------------------------------------------------------------------------

def compute_ward_summary(buildings: list[dict]) -> dict:
    """Aggregate per-building records into a ward-level summary.

    Waste totals and ward timber rankings are computed only for
    High/Critical buildings (i.e., buildings "at risk").
    """
    total_timber_at_risk   = 0.0
    total_concrete_at_risk = 0.0
    total_steel_at_risk    = 0.0
    total_co2_savings      = 0.0
    high_risk_count        = 0
    ward_timber: dict[str, float] = defaultdict(float)

    for b in buildings:
        is_at_risk = b["risk_level"] in {"High", "Critical"}
        if is_at_risk:
            high_risk_count        += 1
            total_timber_at_risk   += b["waste_timber_m3"]
            total_concrete_at_risk += b["waste_concrete_m3"]
            total_steel_at_risk    += b["waste_steel_tons"]
            ward_timber[b["ward"]] += b["waste_timber_m3"]
        if "recommendation" in b:
            total_co2_savings += b["recommendation"]["co2_savings_tons"]

    top_3_wards = sorted(ward_timber, key=ward_timber.__getitem__, reverse=True)[:3]

    return {
        "total_buildings_analyzed":      len(buildings),
        "high_risk_buildings_count":     high_risk_count,
        "total_timber_at_risk_m3":       round(total_timber_at_risk, 4),
        "total_concrete_at_risk_m3":     round(total_concrete_at_risk, 4),
        "total_steel_at_risk_tons":      round(total_steel_at_risk, 4),
        "total_potential_co2_savings_tons": round(total_co2_savings, 4),
        "top_3_priority_wards":          top_3_wards,
    }


# ---------------------------------------------------------------------------
# Output — JSON report
# ---------------------------------------------------------------------------

def write_json_report(
    buildings: list[dict],
    ward_summary: dict,
    output_path: str = "demolition_forecast_report.json",
) -> None:
    """Write the full report as a UTF-8 encoded JSON file."""
    report = {"buildings": buildings, "ward_summary": ward_summary}
    try:
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"JSON report written to: {output_path}")
    except OSError as exc:
        log.critical("Cannot write report to '%s': %s", output_path, exc)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Output — Console summary
# ---------------------------------------------------------------------------

def print_console_summary(buildings: list[dict], ward_summary: dict) -> None:
    """Print a human-readable summary to stdout."""
    sep = "=" * 62
    print(f"\n{sep}")
    print("  DEMOLITION FORECASTER — SUMMARY REPORT (2026)")
    print(sep)

    ws = ward_summary
    print(f"\n  Total buildings analysed:       {ws['total_buildings_analyzed']:>8,}")
    print(f"  High/Critical risk buildings:   {ws['high_risk_buildings_count']:>8,}")
    print(f"  Total timber at risk:           {ws['total_timber_at_risk_m3']:>10,.1f} m³")
    print(f"  Total concrete at risk:         {ws['total_concrete_at_risk_m3']:>10,.1f} m³")
    print(f"  Total steel at risk:            {ws['total_steel_at_risk_tons']:>10,.2f} t")
    print(f"  Potential CO₂ savings (timber): {ws['total_potential_co2_savings_tons']:>10,.2f} t CO₂")

    wards_display = ", ".join(ws["top_3_priority_wards"]) if ws["top_3_priority_wards"] else "(none)"
    print(f"  Top 3 priority wards:           {wards_display}")

    print(f"\n{sep}")
    print("  TOP 5 HIGH-RISK BUILDINGS (by 24-month demolition probability)")
    print(sep)
    print(f"  {'ID':<20} {'Ward':<12} {'Age':>4} {'Structure':<10} {'Risk 24m':>9} {'Level':<9}")
    print(f"  {'-'*20} {'-'*12} {'-'*4} {'-'*10} {'-'*9} {'-'*9}")

    top5 = sorted(buildings, key=lambda b: b["risk_24m_pct"], reverse=True)[:5]
    if not top5:
        print("  (no buildings processed)")
    else:
        for b in top5:
            print(
                f"  {b['building_id']:<20} {b['ward']:<12} {b['age']:>4} "
                f"{b['structure_type']:<10} {b['risk_24m_pct']:>8.1f}% {b['risk_level']:<9}"
            )

    print(f"{sep}\n")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point: parse args, run pipeline, write outputs."""
    args = parse_args()
    filepath = args.geojson_file

    import os
    if not os.path.exists(filepath):
        log.critical("File not found: '%s'", filepath)
        sys.exit(1)

    gdf = load_geojson(filepath)

    if len(gdf) == 0:
        print("Warning: GeoJSON file contains no features. Nothing to process.")
        sys.exit(0)

    buildings: list[dict] = []
    skipped = 0
    for _, row in gdf.iterrows():
        result = process_building(row)
        if result is None:
            skipped += 1
        else:
            buildings.append(result)

    print(
        f"Processed {len(buildings)} building(s); "
        f"skipped {skipped} due to missing or invalid data."
    )

    if not buildings:
        print("No valid buildings to report. Exiting.")
        sys.exit(0)

    ward_summary = compute_ward_summary(buildings)
    write_json_report(buildings, ward_summary)
    print_console_summary(buildings, ward_summary)


if __name__ == "__main__":
    main()
