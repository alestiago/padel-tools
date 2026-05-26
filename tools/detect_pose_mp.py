#!/usr/bin/env python3
"""Detect body pose landmarks using MediaPipe and export a pose-labeller v2 JSON.

The output is directly loadable via "Pre-load poses" in pose-labeller-tool.

Usage:
    python3 tools/detect_pose_mp.py \
        --video  path/to/video.mp4 \
        --output path/to/output_mp_poses.json

Options:
    --model  lite | full | heavy     Model complexity (default: full).
    --person N                       Which detected person to keep per frame,
                                     sorted by descending bounding-box area (default: 0).
    --every-n N                      Process every Nth frame (default: 1 = all frames).
    --vis-visible  FLOAT             Visibility score threshold for 'visible'  (default: 0.65).
    --vis-occluded FLOAT             Visibility score threshold for 'occluded' (default: 0.30).
                                     Scores below this are marked 'not_in_frame'.
"""

import argparse
import json
import math
import os
import sys
import urllib.request

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision

# ---------------------------------------------------------------------------
# Landmark index → pose-labeller keypoint ID
# ---------------------------------------------------------------------------

# Direct 1-to-1 mappings (MediaPipe landmark index → keypoint ID)
MP_LANDMARK_MAP: dict[str, int] = {
    "head":            0,   # NOSE
    "left_shoulder":   11,
    "right_shoulder":  12,
    "left_elbow":      13,
    "right_elbow":     14,
    "left_wrist":      15,
    "right_wrist":     16,
    "left_hip":        23,
    "right_hip":       24,
    "left_knee":       25,
    "right_knee":      26,
    "left_ankle":      27,
    "right_ankle":     28,
    "left_toe":        31,
    "right_toe":       32,
}

# Model URLs (MediaPipe CDN)
MODEL_URLS = {
    "lite":  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    "full":  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
}
CACHE_DIR = os.path.expanduser("~/.cache/mediapipe")

# ---------------------------------------------------------------------------
# Angle computation (ported from pose-labeller-tool/src/lib/angles.ts)
# ---------------------------------------------------------------------------

ANGLE_DEFS = [
    ("left_elbow",              "left_shoulder",  "left_elbow",   "left_wrist"),
    ("right_elbow",             "right_shoulder", "right_elbow",  "right_wrist"),
    ("left_knee",               "left_hip",       "left_knee",    "left_ankle"),
    ("right_knee",              "right_hip",      "right_knee",   "right_ankle"),
    ("left_shoulder_abduction", "neck",           "left_shoulder","left_elbow"),
    ("right_shoulder_abduction","neck",           "right_shoulder","right_elbow"),
    ("left_hip_flexion",        "left_shoulder",  "left_hip",     "left_knee"),
    ("right_hip_flexion",       "right_shoulder", "right_hip",    "right_knee"),
]


def _interior_angle(px, py, vx, vy, dx, dy) -> float:
    ax, ay = px - vx, py - vy
    bx, by = dx - vx, dy - vy
    len_a = math.sqrt(ax * ax + ay * ay)
    len_b = math.sqrt(bx * bx + by * by)
    if len_a == 0 or len_b == 0:
        return 0.0
    cos = max(-1.0, min(1.0, (ax * bx + ay * by) / (len_a * len_b)))
    return math.acos(cos) * (180.0 / math.pi)


def compute_angles(keypoints: dict) -> dict[str, float | None]:
    result: dict[str, float | None] = {}

    for angle_id, proximal, vertex, distal in ANGLE_DEFS:
        p = keypoints.get(proximal)
        v = keypoints.get(vertex)
        d = keypoints.get(distal)
        if not p or not v or not d:
            result[angle_id] = None
            continue
        if any(kp["visibility"] == "not_in_frame" for kp in (p, v, d)):
            result[angle_id] = None
            continue
        result[angle_id] = _interior_angle(p["x"], p["y"], v["x"], v["y"], d["x"], d["y"])

    # trunk_lean: neck → mid_hip → mid_knee
    neck = keypoints.get("neck")
    lh = keypoints.get("left_hip")
    rh = keypoints.get("right_hip")
    lk = keypoints.get("left_knee")
    rk = keypoints.get("right_knee")
    if neck and lh and rh and lk and rk and all(
        kp["visibility"] != "not_in_frame" for kp in (neck, lh, rh, lk, rk)
    ):
        mid_hip_x = (lh["x"] + rh["x"]) / 2
        mid_hip_y = (lh["y"] + rh["y"]) / 2
        mid_knee_x = (lk["x"] + rk["x"]) / 2
        mid_knee_y = (lk["y"] + rk["y"]) / 2
        result["trunk_lean"] = _interior_angle(
            neck["x"], neck["y"], mid_hip_x, mid_hip_y, mid_knee_x, mid_knee_y
        )
    else:
        result["trunk_lean"] = None

    return result


# ---------------------------------------------------------------------------
# Model download
# ---------------------------------------------------------------------------

def ensure_model(variant: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = os.path.join(CACHE_DIR, f"pose_landmarker_{variant}.task")
    if not os.path.exists(dest):
        url = MODEL_URLS[variant]
        print(f"Downloading {variant} model from MediaPipe CDN...")
        urllib.request.urlretrieve(url, dest)
        print(f"  Saved to {dest}")
    return dest


# ---------------------------------------------------------------------------
# Landmark helpers
# ---------------------------------------------------------------------------

def visibility_label(score: float, vis_visible: float, vis_occluded: float) -> str:
    if score >= vis_visible:
        return "visible"
    if score >= vis_occluded:
        return "occluded"
    return "not_in_frame"


def landmarks_to_keypoints(
    landmarks,
    width: int,
    height: int,
    vis_visible: float,
    vis_occluded: float,
) -> dict:
    """Convert a MediaPipe NormalizedLandmark list to a pose-labeller keypoints dict."""
    kps: dict = {}

    for kp_id, idx in MP_LANDMARK_MAP.items():
        lm = landmarks[idx]
        kps[kp_id] = {
            "x": lm.x * width,
            "y": lm.y * height,
            "visibility": visibility_label(lm.visibility, vis_visible, vis_occluded),
        }

    # neck: computed as nose + 0.35 * (mid_shoulder - nose)
    nose = landmarks[0]
    ls = landmarks[11]
    rs = landmarks[12]
    mid_sx = (ls.x + rs.x) / 2
    mid_sy = (ls.y + rs.y) / 2
    neck_x = (nose.x + 0.35 * (mid_sx - nose.x)) * width
    neck_y = (nose.y + 0.35 * (mid_sy - nose.y)) * height
    neck_vis = visibility_label(
        min(ls.visibility, rs.visibility), vis_visible, vis_occluded
    )
    kps["neck"] = {"x": neck_x, "y": neck_y, "visibility": neck_vis}

    return kps


def bbox_area(landmarks) -> float:
    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def select_person(pose_landmarks: list, person_idx: int):
    """Return landmarks for the chosen person (sorted by descending bbox area)."""
    if not pose_landmarks:
        return None
    sorted_people = sorted(pose_landmarks, key=bbox_area, reverse=True)
    if person_idx >= len(sorted_people):
        return sorted_people[-1]
    return sorted_people[person_idx]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="MediaPipe pose detection → pose-labeller v2 JSON"
    )
    parser.add_argument("--video",  required=True, help="Input video path")
    parser.add_argument("--output", required=True, help="Output poses JSON path")
    parser.add_argument(
        "--model", default="full", choices=["lite", "full", "heavy"],
        help="Model variant (default: full)",
    )
    parser.add_argument(
        "--person", type=int, default=0, metavar="N",
        help="Person index (0 = largest bbox, default: 0)",
    )
    parser.add_argument(
        "--every-n", type=int, default=1, metavar="N",
        help="Process every Nth frame (default: 1)",
    )
    parser.add_argument(
        "--vis-visible", type=float, default=0.65,
        help="Visibility score threshold for 'visible' (default: 0.65)",
    )
    parser.add_argument(
        "--vis-occluded", type=float, default=0.30,
        help="Visibility score threshold for 'occluded' (default: 0.30)",
    )
    args = parser.parse_args()

    video_path = os.path.expanduser(args.video)
    output_path = os.path.expanduser(args.output)
    model_path = ensure_model(args.model)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f"Error: could not open video {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}x{height} @ {fps:.2f} fps — {total} frames")

    opts = mp_vision.PoseLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_poses=max(1, args.person + 1),
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
        min_tracking_confidence=0.3,
    )

    poses: list[dict] = []
    detected = 0
    frame_idx = 0

    print(f"Running detection (model={args.model}, every-n={args.every_n}, person={args.person})...")
    with mp_vision.PoseLandmarker.create_from_options(opts) as landmarker:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % args.every_n == 0:
                timestamp_ms = int(round(frame_idx / fps * 1000))
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = landmarker.detect_for_video(mp_image, timestamp_ms)

                landmarks = select_person(result.pose_landmarks, args.person)
                if landmarks:
                    kps = landmarks_to_keypoints(
                        landmarks, width, height, args.vis_visible, args.vis_occluded
                    )
                    angles = compute_angles(kps)
                    poses.append({
                        "frame": frame_idx,
                        "timestampMs": timestamp_ms,
                        "keypoints": kps,
                        "angles": angles,
                    })
                    detected += 1

                if frame_idx % 300 == 0:
                    print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)"
                          f" — {detected} poses so far")

            frame_idx += 1

    cap.release()

    video_file = os.path.basename(video_path)
    export = {
        "version": 2,
        "videoFile": video_file,
        "fps": fps,
        "poses": poses,
    }

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(export, f, indent=2)

    print(f"\nDetected poses in {detected}/{total} frames → {output_path}")


if __name__ == "__main__":
    main()
