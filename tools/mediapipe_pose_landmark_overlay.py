#!/usr/bin/env python3
"""Render a pose skeleton overlay on a video using MediaPipe or a pre-computed poses JSON.

Two modes:
  Live    — runs MediaPipe Pose Landmarker per frame (no --poses flag).
  Replay  — reads a pose-labeller v2 JSON and draws stored keypoints (no model needed).

Usage:
    # Live detection
    python3 tools/mediapipe_pose_landmark_overlay.py \
        --video  path/to/video.mp4 \
        --output path/to/output_overlay.mp4

    # Replay from pre-computed JSON
    python3 tools/mediapipe_pose_landmark_overlay.py \
        --video  path/to/video.mp4 \
        --poses  path/to/poses.json \
        --output path/to/output_overlay.mp4

Options:
    --model  lite | full | heavy   Model variant for live mode (default: full).
    --person N                     Which detected person to draw (default: 0 = largest bbox).
    --show-angles                  Draw joint angle labels at each vertex.
    --point-radius N               Keypoint circle radius in pixels (default: 6).
    --line-thickness N             Skeleton line thickness (default: 2).
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Skeleton definition (mirrored from pose-labeller-tool/src/lib/skeleton.ts)
# ---------------------------------------------------------------------------

BONES: list[tuple[str, str]] = [
    ("head",          "neck"),
    ("neck",          "left_shoulder"),
    ("neck",          "right_shoulder"),
    ("left_shoulder", "left_elbow"),
    ("left_elbow",    "left_wrist"),
    ("right_shoulder","right_elbow"),
    ("right_elbow",   "right_wrist"),
    ("left_shoulder", "left_hip"),
    ("right_shoulder","right_hip"),
    ("left_hip",      "right_hip"),
    ("left_shoulder", "right_shoulder"),
    ("left_hip",      "left_knee"),
    ("right_hip",     "right_knee"),
    ("left_knee",     "left_ankle"),
    ("right_knee",    "right_ankle"),
    ("left_ankle",    "left_toe"),
    ("right_ankle",   "right_toe"),
]

# BGR colours per body segment
SEGMENT_COLORS: dict[str, tuple[int, int, int]] = {
    "head":   (200, 200, 200),
    "arm_l":  ( 80, 200,  80),
    "arm_r":  ( 80,  80, 220),
    "trunk":  (200, 200,  50),
    "leg_l":  ( 80, 180, 180),
    "leg_r":  (200, 100, 200),
}

def _bone_color(a: str, b: str) -> tuple[int, int, int]:
    pair = {a, b}
    if pair <= {"head", "neck"}:
        return SEGMENT_COLORS["head"]
    if pair & {"left_shoulder", "left_elbow", "left_wrist"}:
        return SEGMENT_COLORS["arm_l"]
    if pair & {"right_shoulder", "right_elbow", "right_wrist"}:
        return SEGMENT_COLORS["arm_r"]
    if pair & {"left_hip", "left_knee", "left_ankle", "left_toe"}:
        return SEGMENT_COLORS["leg_l"]
    if pair & {"right_hip", "right_knee", "right_ankle", "right_toe"}:
        return SEGMENT_COLORS["leg_r"]
    return SEGMENT_COLORS["trunk"]

VISIBILITY_COLORS = {
    "visible":      (  0, 220,   0),
    "occluded":     (  0, 165, 255),
    "not_in_frame": ( 80,  80,  80),
}

# ---------------------------------------------------------------------------
# Angle computation (shared logic — same as detect_pose_mp.py)
# ---------------------------------------------------------------------------

ANGLE_DEFS = [
    ("left_elbow",               "left_shoulder",  "left_elbow",    "left_wrist"),
    ("right_elbow",              "right_shoulder", "right_elbow",   "right_wrist"),
    ("left_knee",                "left_hip",       "left_knee",     "left_ankle"),
    ("right_knee",               "right_hip",      "right_knee",    "right_ankle"),
    ("left_shoulder_abduction",  "neck",           "left_shoulder", "left_elbow"),
    ("right_shoulder_abduction", "neck",           "right_shoulder","right_elbow"),
    ("left_hip_flexion",         "left_shoulder",  "left_hip",      "left_knee"),
    ("right_hip_flexion",        "right_shoulder", "right_hip",     "right_knee"),
]

ANGLE_VERTEX = {angle_id: vertex for angle_id, _, vertex, _ in ANGLE_DEFS}

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
        p, v, d = keypoints.get(proximal), keypoints.get(vertex), keypoints.get(distal)
        if not p or not v or not d:
            result[angle_id] = None
        elif any(kp["visibility"] == "not_in_frame" for kp in (p, v, d)):
            result[angle_id] = None
        else:
            result[angle_id] = _interior_angle(p["x"], p["y"], v["x"], v["y"], d["x"], d["y"])
    neck, lh, rh, lk, rk = (keypoints.get(k) for k in ("neck","left_hip","right_hip","left_knee","right_knee"))
    if neck and lh and rh and lk and rk and all(
        kp["visibility"] != "not_in_frame" for kp in (neck, lh, rh, lk, rk)
    ):
        mhx, mhy = (lh["x"]+rh["x"])/2, (lh["y"]+rh["y"])/2
        mkx, mky = (lk["x"]+rk["x"])/2, (lk["y"]+rk["y"])/2
        result["trunk_lean"] = _interior_angle(neck["x"], neck["y"], mhx, mhy, mkx, mky)
    else:
        result["trunk_lean"] = None
    return result

# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

def draw_pose(
    frame: np.ndarray,
    keypoints: dict,
    angles: dict | None = None,
    point_radius: int = 6,
    line_thickness: int = 2,
    show_angles: bool = True,
    point_color: tuple[int, int, int] | None = None,
    line_color: tuple[int, int, int] | None = None,
) -> None:
    # Bones
    for a, b in BONES:
        kp_a = keypoints.get(a)
        kp_b = keypoints.get(b)
        if not kp_a or not kp_b:
            continue
        if kp_a["visibility"] == "not_in_frame" or kp_b["visibility"] == "not_in_frame":
            continue
        p1 = (int(round(kp_a["x"])), int(round(kp_a["y"])))
        p2 = (int(round(kp_b["x"])), int(round(kp_b["y"])))
        color = line_color if line_color is not None else _bone_color(a, b)
        alpha_line = 0.5 if "occluded" in (kp_a["visibility"], kp_b["visibility"]) else 1.0
        overlay = frame.copy()
        cv2.line(overlay, p1, p2, color, line_thickness, cv2.LINE_AA)
        cv2.addWeighted(overlay, alpha_line, frame, 1 - alpha_line, 0, frame)

    # Keypoints
    for kp_id, kp in keypoints.items():
        if kp["visibility"] == "not_in_frame":
            continue
        cx, cy = int(round(kp["x"])), int(round(kp["y"]))
        color = point_color if point_color is not None else VISIBILITY_COLORS[kp["visibility"]]
        cv2.circle(frame, (cx, cy), point_radius, color, -1, cv2.LINE_AA)
        cv2.circle(frame, (cx, cy), point_radius, (0, 0, 0), 1, cv2.LINE_AA)

    # Angle labels — OpenCV Hershey fonts are ASCII-only, use "deg" instead of degree symbol
    if show_angles and angles:
        for angle_id, deg in angles.items():
            if deg is None:
                continue
            vertex_id = ANGLE_VERTEX.get(angle_id)
            if angle_id == "trunk_lean":
                lh = keypoints.get("left_hip")
                rh = keypoints.get("right_hip")
                if not lh or not rh:
                    continue
                vx = int((lh["x"] + rh["x"]) / 2)
                vy = int((lh["y"] + rh["y"]) / 2)
            elif vertex_id:
                kp = keypoints.get(vertex_id)
                if not kp or kp["visibility"] == "not_in_frame":
                    continue
                vx, vy = int(round(kp["x"])), int(round(kp["y"]))
            else:
                continue
            label = f"{int(round(deg))}deg"
            cv2.putText(
                frame, label, (vx + point_radius + 2, vy - point_radius),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 2, cv2.LINE_AA,
            )
            cv2.putText(
                frame, label, (vx + point_radius + 2, vy - point_radius),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA,
            )

# ---------------------------------------------------------------------------
# MediaPipe helpers (only used in live mode)
# ---------------------------------------------------------------------------

MODEL_URLS = {
    "lite":  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    "full":  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
}
CACHE_DIR = os.path.expanduser("~/.cache/mediapipe")

def ensure_model(variant: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = os.path.join(CACHE_DIR, f"pose_landmarker_{variant}.task")
    if not os.path.exists(dest):
        print(f"Downloading {variant} model...")
        urllib.request.urlretrieve(MODEL_URLS[variant], dest)
    return dest

def visibility_label(score: float, vis_visible=0.65, vis_occluded=0.30) -> str:
    if score >= vis_visible:
        return "visible"
    if score >= vis_occluded:
        return "occluded"
    return "not_in_frame"

MP_LANDMARK_MAP: dict[str, int] = {
    "head": 0, "left_shoulder": 11, "right_shoulder": 12,
    "left_elbow": 13, "right_elbow": 14, "left_wrist": 15, "right_wrist": 16,
    "left_hip": 23, "right_hip": 24, "left_knee": 25, "right_knee": 26,
    "left_ankle": 27, "right_ankle": 28, "left_toe": 31, "right_toe": 32,
}

def bbox_area(landmarks) -> float:
    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))

def landmarks_to_keypoints(landmarks, width, height) -> dict:
    kps: dict = {}
    for kp_id, idx in MP_LANDMARK_MAP.items():
        lm = landmarks[idx]
        kps[kp_id] = {
            "x": lm.x * width,
            "y": lm.y * height,
            "visibility": visibility_label(lm.visibility),
        }
    nose, ls, rs = landmarks[0], landmarks[11], landmarks[12]
    mid_sx = (ls.x + rs.x) / 2
    mid_sy = (ls.y + rs.y) / 2
    kps["neck"] = {
        "x": (nose.x + 0.35 * (mid_sx - nose.x)) * width,
        "y": (nose.y + 0.35 * (mid_sy - nose.y)) * height,
        "visibility": visibility_label(min(ls.visibility, rs.visibility)),
    }
    return kps

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pose skeleton overlay — live MediaPipe or replay from poses JSON"
    )
    parser.add_argument("--video",  required=True, help="Input video path")
    parser.add_argument("--output", required=True, help="Output video path")
    parser.add_argument("--poses",  default=None,  help="Pre-computed poses JSON (replay mode)")
    parser.add_argument("--model",  default="full", choices=["lite", "full", "heavy"])
    parser.add_argument("--person", type=int, default=0)
    parser.add_argument("--no-angles", action="store_true", help="Hide joint angle labels")
    parser.add_argument("--point-radius",   type=int, default=6)
    parser.add_argument("--line-thickness", type=int, default=2)
    parser.add_argument(
        "--point-color", default=None, metavar="R,G,B",
        help="Override keypoint colour, e.g. 255,255,0 (default: per-visibility coloring)",
    )
    parser.add_argument(
        "--line-color", default=None, metavar="R,G,B",
        help="Override bone line colour, e.g. 255,255,0 (default: per-segment coloring)",
    )
    args = parser.parse_args()

    def parse_color(s: str) -> tuple[int, int, int]:
        r, g, b = (int(v) for v in s.split(","))
        return (b, g, r)  # OpenCV uses BGR

    point_color = parse_color(args.point_color) if args.point_color else None
    line_color  = parse_color(args.line_color)  if args.line_color  else None

    video_path  = os.path.expanduser(args.video)
    output_path = os.path.expanduser(args.output)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f"Error: could not open video {video_path}")

    fps    = cap.get(cv2.CAP_PROP_FPS)
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}x{height} @ {fps:.2f} fps — {total} frames")

    # --- load pre-computed poses or prepare live detector ---
    pose_map: dict[int, dict] = {}
    landmarker = None

    if args.poses:
        poses_path = os.path.expanduser(args.poses)
        with open(poses_path) as f:
            data = json.load(f)
        for entry in data.get("poses", []):
            pose_map[int(entry["frame"])] = entry
        print(f"Replay mode — loaded {len(pose_map)} frames from {poses_path}")
    else:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision as mp_vision

        model_path = ensure_model(args.model)
        opts = mp_vision.PoseLandmarkerOptions(
            base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_poses=max(1, args.person + 1),
            min_pose_detection_confidence=0.3,
            min_pose_presence_confidence=0.3,
            min_tracking_confidence=0.3,
        )
        landmarker = mp_vision.PoseLandmarker.create_from_options(opts)
        print(f"Live mode — model={args.model}, person={args.person}")

    use_ffmpeg = shutil.which("ffmpeg") is not None
    if use_ffmpeg:
        fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        write_path = tmp_path
    else:
        write_path = output_path

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(write_path, fourcc, fps, (width, height))
    if not out.isOpened():
        cap.release()
        sys.exit(f"Error: could not open output writer for {write_path}")

    frame_idx = 0
    drawn = 0

    print("Rendering...")
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            keypoints = None
            angles = None

            if args.poses:
                entry = pose_map.get(frame_idx)
                if entry:
                    keypoints = entry.get("keypoints", {})
                    angles = (entry.get("angles") or compute_angles(keypoints)) if not args.no_angles else None
            else:
                timestamp_ms = int(round(frame_idx / fps * 1000))
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                import mediapipe as mp
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = landmarker.detect_for_video(mp_image, timestamp_ms)
                if result.pose_landmarks:
                    sorted_people = sorted(result.pose_landmarks, key=bbox_area, reverse=True)
                    lm = sorted_people[min(args.person, len(sorted_people) - 1)]
                    keypoints = landmarks_to_keypoints(lm, width, height)
                    angles = compute_angles(keypoints) if not args.no_angles else None

            if keypoints:
                draw_pose(
                    frame, keypoints, angles,
                    point_radius=args.point_radius,
                    line_thickness=args.line_thickness,
                    show_angles=not args.no_angles,
                    point_color=point_color,
                    line_color=line_color,
                )
                drawn += 1

            out.write(frame)
            frame_idx += 1

            if frame_idx % 300 == 0:
                print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)")

    finally:
        cap.release()
        out.release()
        if landmarker:
            landmarker.close()

    if use_ffmpeg:
        print("Re-encoding to H.264...")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", tmp_path,
                "-i", video_path,
                "-map", "0:v:0", "-map", "1:a?",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-c:a", "copy",
                output_path,
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"\nDrawn on {drawn}/{total} frames → {output_path}")


if __name__ == "__main__":
    main()
