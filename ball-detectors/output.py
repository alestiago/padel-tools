import csv
import json
import logging
import os

log = logging.getLogger(__name__)


def write(results: list[dict], path: str, fmt: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if fmt == "json":
        _write_json(results, path)
    else:
        _write_csv(results, path)
    log.info("Output written: %s (%d rows)", path, len(results))


def _write_csv(results: list[dict], path: str) -> None:
    fields = [
        "frame_index", "time_s",
        "ball_u_px", "ball_v_px",
        "ball_x_m", "ball_y_m",
        "raw_velocity_kmh", "velocity_kmh",
    ]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for r in results:
            ball = r.get("ball")
            writer.writerow({
                "frame_index": r["frame_index"],
                "time_s": f"{r['time_s']:.4f}",
                "ball_u_px": f"{ball['pixel_u']:.2f}" if ball else "",
                "ball_v_px": f"{ball['pixel_v']:.2f}" if ball else "",
                "ball_x_m": f"{ball['court_x_m']:.4f}" if ball else "",
                "ball_y_m": f"{ball['court_y_m']:.4f}" if ball else "",
                "raw_velocity_kmh": f"{r['raw_velocity_kmh']:.2f}" if r["raw_velocity_kmh"] is not None else "",
                "velocity_kmh": f"{r['velocity_kmh']:.2f}" if r["velocity_kmh"] is not None else "",
            })


def _write_json(results: list[dict], path: str) -> None:
    serialisable = []
    for r in results:
        ball = r.get("ball")
        serialisable.append({
            "frame_index": r["frame_index"],
            "time_s": round(r["time_s"], 4),
            "ball": {
                "ball_u_px": round(ball["pixel_u"], 2),
                "ball_v_px": round(ball["pixel_v"], 2),
                "ball_x_m": round(ball["court_x_m"], 4),
                "ball_y_m": round(ball["court_y_m"], 4),
            } if ball else None,
            "raw_velocity_kmh": round(r["raw_velocity_kmh"], 2) if r["raw_velocity_kmh"] is not None else None,
            "velocity_kmh": round(r["velocity_kmh"], 2) if r["velocity_kmh"] is not None else None,
        })
    with open(path, "w") as f:
        json.dump(serialisable, f, indent=2)


def summary(results: list[dict]) -> None:
    detected = [r for r in results if r["ball"] is not None]
    rate = len(detected) / len(results) * 100 if results else 0
    log.info("Detection rate: %.1f%% (%d/%d frames)", rate, len(detected), len(results))

    velocities = [r["velocity_kmh"] for r in results if r["velocity_kmh"] is not None]
    if velocities:
        peak = max(velocities)
        peak_frame = next(r for r in results if r["velocity_kmh"] == peak)
        log.info("Peak smoothed velocity: %.1f km/h  (t=%.2f s)", peak, peak_frame["time_s"])
    else:
        log.info("No velocity data computed (insufficient detections)")
