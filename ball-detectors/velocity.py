import math

MAX_REALISTIC_KMH = 250.0


def compute(results: list[dict], dt: float, window: int = 5) -> list[dict]:
    # Pass 1 — raw velocity between consecutive detections
    for i, r in enumerate(results):
        prev = results[i - 1] if i > 0 else None
        if prev is None or r["ball"] is None or prev["ball"] is None:
            r["raw_velocity_kmh"] = None
            continue
        dx = r["ball"]["court_x_m"] - prev["ball"]["court_x_m"]
        dy = r["ball"]["court_y_m"] - prev["ball"]["court_y_m"]
        kmh = (math.hypot(dx, dy) / dt) * 3.6
        r["raw_velocity_kmh"] = kmh if kmh <= MAX_REALISTIC_KMH else None

    # Pass 2 — sliding-window mean, ignoring nulls
    half = window // 2
    for i, r in enumerate(results):
        vals = [
            results[j]["raw_velocity_kmh"]
            for j in range(max(0, i - half), min(len(results), i + half + 1))
            if results[j]["raw_velocity_kmh"] is not None
        ]
        r["velocity_kmh"] = sum(vals) / len(vals) if vals else None

    return results
