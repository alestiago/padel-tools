import json
import numpy as np

COURT_X = (-1.0, 11.0)
COURT_Y = (-1.0, 21.0)


def load(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    return {
        "H": np.array(data["H"], dtype=np.float64),
        "frame_size": data["frame_size"],
        "reprojection_error_m": data.get("reprojection_error_m"),
        "video_file": data.get("video_file", ""),
    }


def apply_H(H: np.ndarray, u: float, v: float) -> tuple[float, float]:
    p = H @ np.array([u, v, 1.0])
    return float(p[0] / p[2]), float(p[1] / p[2])


def in_court(x: float, y: float) -> bool:
    return COURT_X[0] <= x <= COURT_X[1] and COURT_Y[0] <= y <= COURT_Y[1]
