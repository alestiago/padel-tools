#!/usr/bin/env python3
"""Overlay pose keypoints and joint angles exported by pose-labeller-tool.

Usage (single frame → PNG):
    python3 tools/overlay_pose.py \
        --pose .dev/jugada1/jugada1_pose_42.json \
        --video .dev/jugada1/jugada1.mp4 \
        --output .dev/jugada1/jugada1_pose_42.png

Usage (multi-frame JSON from pose-labeller-tool "Export all" → annotated video):
    python3 tools/overlay_pose.py \
        --poses .dev/jugada1/jugada1_poses.json \
        --video .dev/jugada1/jugada1.mp4 \
        --output .dev/jugada1/jugada1_posed.mp4

Usage (directory of single-frame pose JSONs → annotated video):
    python3 tools/overlay_pose.py \
        --poses-dir .dev/jugada1/poses/ \
        --video .dev/jugada1/jugada1.mp4 \
        --output .dev/jugada1/jugada1_posed.mp4

Options:
    --no-angles         Omit angle arcs and degree labels.
    --no-skeleton       Omit skeleton bone connections.
    --no-keypoints      Omit keypoint circles.
    --label-color HEX   Text colour for angle labels (default: matches arc colour).
    --label-size PX     Font size for angle labels in pixels (default: 12).
    --label-bg HEX|none Background box colour, or "none" for no box (default: #000000).
"""

import argparse
import json
import math
import os
import glob
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

# ── constants ─────────────────────────────────────────────────────────────────

KP_RADIUS  = 6
ARC_RADIUS = 22
LABEL_DIST = ARC_RADIUS + 13

CONNECTIONS = [
    ('head',           'neck'),
    ('neck',           'left_shoulder'),
    ('neck',           'right_shoulder'),
    ('left_shoulder',  'left_elbow'),
    ('left_elbow',     'left_wrist'),
    ('right_shoulder', 'right_elbow'),
    ('right_elbow',    'right_wrist'),
    ('left_shoulder',  'left_hip'),
    ('right_shoulder', 'right_hip'),
    ('left_hip',       'right_hip'),
    ('left_shoulder',  'right_shoulder'),
    ('left_hip',       'left_knee'),
    ('right_hip',      'right_knee'),
    ('left_knee',      'left_ankle'),
    ('right_knee',     'right_ankle'),
    ('left_ankle',     'left_toe'),
    ('right_ankle',    'right_toe'),
]

ANGLE_DEFS = [
    dict(id='left_elbow',               label='L Elbow',    proximal='left_shoulder',  vertex='left_elbow',    distal='left_wrist',   safe_min=30,  safe_max=170),
    dict(id='right_elbow',              label='R Elbow',    proximal='right_shoulder', vertex='right_elbow',   distal='right_wrist',  safe_min=30,  safe_max=170),
    dict(id='left_knee',                label='L Knee',     proximal='left_hip',       vertex='left_knee',     distal='left_ankle',   safe_min=80,  safe_max=175),
    dict(id='right_knee',               label='R Knee',     proximal='right_hip',      vertex='right_knee',    distal='right_ankle',  safe_min=80,  safe_max=175),
    dict(id='left_shoulder_abduction',  label='L Shoulder', proximal='neck',           vertex='left_shoulder', distal='left_elbow',   safe_min=10,  safe_max=170),
    dict(id='right_shoulder_abduction', label='R Shoulder', proximal='neck',           vertex='right_shoulder',distal='right_elbow',  safe_min=10,  safe_max=170),
    dict(id='left_hip_flexion',         label='L Hip',      proximal='left_shoulder',  vertex='left_hip',      distal='left_knee',    safe_min=80,  safe_max=175),
    dict(id='right_hip_flexion',        label='R Hip',      proximal='right_shoulder', vertex='right_hip',     distal='right_knee',   safe_min=80,  safe_max=175),
]

# ── colour helpers ────────────────────────────────────────────────────────────

def _hex_bgr(h: str) -> tuple[int, int, int]:
    """Parse '#RRGGBB' → BGR tuple for OpenCV."""
    h = h.lstrip('#')
    r, g, b = int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16)
    return (b, g, r)

def _hex_rgb(h: str) -> tuple[int, int, int]:
    """Parse '#RRGGBB' → RGB tuple for PIL."""
    h = h.lstrip('#')
    return (int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16))

def _bgr_to_rgb(bgr: tuple) -> tuple[int, int, int]:
    return (bgr[2], bgr[1], bgr[0])

def _parse_label_color(s: str | None) -> tuple[int, int, int] | None:
    """Return RGB tuple, or None to use per-arc colour."""
    if s is None:
        return None
    return _hex_rgb(s)

def _parse_label_bg(s: str) -> tuple[int, int, int] | None:
    """Return RGB tuple, or None for no background box."""
    if s.lower() in ('none', 'null', 'no', ''):
        return None
    return _hex_rgb(s)

COLOR_LEFT     = _hex_bgr('#38bdf8')  # sky blue  – left-side keypoints
COLOR_RIGHT    = _hex_bgr('#fb923c')  # orange    – right-side keypoints
COLOR_CENTER   = _hex_bgr('#e2e8f0')  # slate     – midline keypoints (head, neck)
COLOR_SAFE     = _hex_bgr('#22c55e')  # green     – angle within safe range
COLOR_MARGINAL = _hex_bgr('#f59e0b')  # amber     – angle near boundary
COLOR_DANGER   = _hex_bgr('#ef4444')  # red       – angle outside safe range


def _kp_color(kp_id: str) -> tuple[int, int, int]:
    if kp_id.startswith('left_'):  return COLOR_LEFT
    if kp_id.startswith('right_'): return COLOR_RIGHT
    return COLOR_CENTER


def _angle_color_bgr(deg: float, safe_min: float, safe_max: float) -> tuple[int, int, int]:
    if safe_min <= deg <= safe_max:
        return COLOR_SAFE
    margin = (safe_max - safe_min) * 0.15
    if safe_min - margin <= deg <= safe_max + margin:
        return COLOR_MARGINAL
    return COLOR_DANGER

# ── PIL text rendering ────────────────────────────────────────────────────────

_font_cache: dict[int, object] = {}

def _pil_font(size: int):
    if size in _font_cache:
        return _font_cache[size]
    try:
        from PIL import ImageFont
        candidates = [
            '/System/Library/Fonts/Helvetica.ttc',
            '/System/Library/Fonts/SFNSText.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        ]
        font = None
        for path in candidates:
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, size)
                    break
                except Exception:
                    continue
        if font is None:
            font = ImageFont.load_default()
    except ImportError:
        sys.exit('Error: Pillow is required for label rendering. Install it with: pip install pillow')
    _font_cache[size] = font
    return font


# Label = (center_x, center_y, text, arc_color_bgr)
Label = tuple[int, int, str, tuple[int, int, int]]


def _render_labels(
    frame: np.ndarray,
    labels: list[Label],
    text_color_rgb: tuple[int, int, int] | None,
    font_size: int,
    bg_color_rgb: tuple[int, int, int] | None,
) -> None:
    """Draw all angle labels onto *frame* in-place using PIL (supports Unicode °)."""
    from PIL import Image, ImageDraw
    pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)
    font = _pil_font(font_size)

    for lx, ly, text, arc_bgr in labels:
        tcolor = text_color_rgb if text_color_rgb is not None else _bgr_to_rgb(arc_bgr)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad = 3
        tx = lx - tw // 2
        ty = ly - th // 2
        if bg_color_rgb is not None:
            draw.rectangle((tx - pad, ty - pad, tx + tw + pad, ty + th + pad), fill=bg_color_rgb)
        draw.text((tx, ty), text, fill=tcolor, font=font)

    np.copyto(frame, cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR))

# ── drawing primitives ────────────────────────────────────────────────────────

def _dashed_line(img: np.ndarray, p1: tuple, p2: tuple, color, thickness: int = 1,
                 dash: int = 6, gap: int = 4) -> None:
    x1, y1 = float(p1[0]), float(p1[1])
    x2, y2 = float(p2[0]), float(p2[1])
    dx, dy = x2 - x1, y2 - y1
    dist = math.hypot(dx, dy)
    if dist < 1:
        return
    ux, uy = dx / dist, dy / dist
    pos, on = 0.0, True
    while pos < dist:
        seg = min(dash if on else gap, dist - pos)
        if on:
            s = (int(x1 + ux * pos), int(y1 + uy * pos))
            e = (int(x1 + ux * (pos + seg)), int(y1 + uy * (pos + seg)))
            cv2.line(img, s, e, color, thickness, cv2.LINE_AA)
        pos += seg
        on = not on


def _draw_angle_arc(
    img: np.ndarray, kp: dict,
    proximal: str, vertex: str, distal: str,
    deg: float, safe_min: float, safe_max: float,
) -> Label | None:
    """Draw the arc on *img* and return a Label tuple for deferred text rendering."""
    p, v, d = kp.get(proximal), kp.get(vertex), kp.get(distal)
    if not (p and v and d):
        return None
    if any(k['visibility'] == 'not_in_frame' for k in (p, v, d)):
        return None

    vx, vy = int(round(v['x'])), int(round(v['y']))
    ax, ay = p['x'] - v['x'], p['y'] - v['y']
    bx, by = d['x'] - v['x'], d['y'] - v['y']

    # shorter arc between the two limb vectors (image / y-down space)
    start_deg = math.degrees(math.atan2(ay, ax))
    end_deg   = math.degrees(math.atan2(by, bx))
    diff = end_deg - start_deg
    while diff >  180: diff -= 360
    while diff < -180: diff += 360

    # cv2.ellipse draws CW from arc_s to arc_e
    arc_s, arc_e = (start_deg, start_deg + diff) if diff >= 0 else (end_deg, end_deg + (-diff))

    color = _angle_color_bgr(deg, safe_min, safe_max)
    cv2.ellipse(img, (vx, vy), (ARC_RADIUS, ARC_RADIUS), 0, arc_s, arc_e, color, 2, cv2.LINE_AA)

    # label position along bisector
    len_a = math.hypot(ax, ay)
    len_b = math.hypot(bx, by)
    if len_a > 0 and len_b > 0:
        bisx = ax / len_a + bx / len_b
        bisy = ay / len_a + by / len_b
        bis = math.hypot(bisx, bisy)
        lx = int(vx + (bisx / bis) * LABEL_DIST) if bis > 0 else vx
        ly = int(vy + (bisy / bis) * LABEL_DIST) if bis > 0 else vy - LABEL_DIST
    else:
        lx, ly = vx, vy - LABEL_DIST

    return (lx, ly, f"{round(deg)}°", color)


def draw_pose(
    frame: np.ndarray,
    pose_data: dict,
    draw_skeleton: bool = True,
    draw_angles: bool = True,
    draw_keypoints: bool = True,
    label_color_rgb: tuple[int, int, int] | None = None,
    label_size: int = 12,
    label_bg_rgb: tuple[int, int, int] | None = (0, 0, 0),
) -> None:
    """Annotate *frame* in-place with skeleton, angles, and keypoints."""
    kp     = pose_data.get('keypoints', {})
    angles = pose_data.get('angles', {})

    # ── skeleton connections (semi-transparent white) ──────────────────────
    if draw_skeleton:
        conn_layer = np.zeros_like(frame)
        for a_id, b_id in CONNECTIONS:
            a, b = kp.get(a_id), kp.get(b_id)
            if not (a and b):
                continue
            if a['visibility'] == 'not_in_frame' or b['visibility'] == 'not_in_frame':
                continue
            p1 = (int(round(a['x'])), int(round(a['y'])))
            p2 = (int(round(b['x'])), int(round(b['y'])))
            occluded = a['visibility'] == 'occluded' or b['visibility'] == 'occluded'
            if occluded:
                _dashed_line(conn_layer, p1, p2, (255, 255, 255))
            else:
                cv2.line(conn_layer, p1, p2, (255, 255, 255), 1, cv2.LINE_AA)
        # blend at 40% — matches rgba(255,255,255,0.4) in PoseCanvas
        alpha = np.max(conn_layer, axis=2).astype(np.float32) / 255.0 * 0.4
        alpha = alpha[:, :, np.newaxis]
        blended = frame.astype(np.float32) * (1.0 - alpha) + conn_layer.astype(np.float32) * alpha
        np.copyto(frame, np.clip(blended, 0, 255).astype(np.uint8))

    # ── angle arcs (arcs drawn now; labels collected for PIL pass) ─────────
    labels: list[Label] = []
    if draw_angles:
        for d in ANGLE_DEFS:
            deg = angles.get(d['id'])
            if deg is None:
                continue
            label = _draw_angle_arc(frame, kp, d['proximal'], d['vertex'], d['distal'],
                                    deg, d['safe_min'], d['safe_max'])
            if label:
                labels.append(label)

        # trunk lean uses virtual midpoints between hips and between knees
        trunk_deg = angles.get('trunk_lean')
        if trunk_deg is not None:
            neck = kp.get('neck')
            lh, rh = kp.get('left_hip'),  kp.get('right_hip')
            lk, rk = kp.get('left_knee'), kp.get('right_knee')
            if neck and lh and rh and lk and rk:
                mid_hip  = {'x': (lh['x'] + rh['x']) / 2, 'y': (lh['y'] + rh['y']) / 2, 'visibility': 'visible'}
                mid_knee = {'x': (lk['x'] + rk['x']) / 2, 'y': (lk['y'] + rk['y']) / 2, 'visibility': 'visible'}
                virtual  = {**kp, '_mid_hip': mid_hip, '_mid_knee': mid_knee}
                label = _draw_angle_arc(frame, virtual, 'neck', '_mid_hip', '_mid_knee', trunk_deg, 140, 180)
                if label:
                    labels.append(label)

        if labels:
            _render_labels(frame, labels, label_color_rgb, label_size, label_bg_rgb)

    # ── keypoint circles ───────────────────────────────────────────────────
    if draw_keypoints:
        for kp_id, data in kp.items():
            if data['visibility'] == 'not_in_frame':
                continue
            cx, cy = int(round(data['x'])), int(round(data['y']))
            color = _kp_color(kp_id)
            if data['visibility'] == 'occluded':
                # dashed circle: 12 × 15° arcs with 15° gaps
                for start in range(0, 360, 30):
                    cv2.ellipse(frame, (cx, cy), (KP_RADIUS, KP_RADIUS),
                                0, start, start + 15, color, 2, cv2.LINE_AA)
            else:
                cv2.circle(frame, (cx, cy), KP_RADIUS, color, -1, cv2.LINE_AA)
                cv2.circle(frame, (cx, cy), KP_RADIUS, (0, 0, 0), 1, cv2.LINE_AA)

# ── I/O helpers ───────────────────────────────────────────────────────────────

def _load_pose(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _seek_frame(cap: cv2.VideoCapture, frame_idx: int) -> np.ndarray | None:
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    return frame if ret else None


def _video_frame_for_pose(pose: dict, video_fps: float, label_fps: float | None) -> int:
    """Return the video frame index that corresponds to this pose annotation.

    Uses timestampMs (preferred) or an explicit label_fps to remap the stored
    frame number to the video's actual frame rate, avoiding off-by-N errors when
    the labeller FPS and the video FPS differ.
    """
    if label_fps is not None:
        return round(pose['frame'] * video_fps / label_fps)
    ts_ms = pose.get('timestampMs')
    if ts_ms is not None and ts_ms > 0:
        return round(ts_ms / 1000.0 * video_fps)
    return pose['frame']


def _open_video(path: str) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"Error: cannot open video {path}")
    return cap


def _video_writer(path: str, fps: float, width: int, height: int) -> cv2.VideoWriter:
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(path, fourcc, fps, (width, height))
    if not out.isOpened():
        sys.exit(f"Error: cannot open output writer for {path}")
    return out


def _reenc_ffmpeg(tmp: str, orig_video: str, output: str) -> None:
    subprocess.run(
        [
            'ffmpeg', '-y',
            '-i', tmp,
            '-i', orig_video,
            '-map', '0:v:0', '-map', '1:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-c:a', 'copy',
            output,
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

# ── modes ─────────────────────────────────────────────────────────────────────

def _draw_opts(args) -> dict:
    return dict(
        draw_skeleton=not args.no_skeleton,
        draw_angles=not args.no_angles,
        draw_keypoints=not args.no_keypoints,
        label_color_rgb=_parse_label_color(args.label_color),
        label_size=args.label_size,
        label_bg_rgb=_parse_label_bg(args.label_bg),
    )


def mode_single(args) -> None:
    pose      = _load_pose(args.pose)
    cap       = _open_video(args.video)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_idx = _video_frame_for_pose(pose, video_fps, args.label_fps)
    print(f"Video fps: {video_fps:.4f}  |  label frame: {pose['frame']}  →  seek frame: {frame_idx}")
    frame     = _seek_frame(cap, frame_idx)
    cap.release()
    if frame is None:
        sys.exit(f"Error: could not read frame {frame_idx} from {args.video}")
    draw_pose(frame, pose, **_draw_opts(args))
    cv2.imwrite(args.output, frame)
    print(f"Saved → {args.output}")


def mode_multi(args) -> None:
    """Multi-frame poses JSON (version 2, from 'Export all') → annotated video."""
    data = _load_pose(args.poses)
    if data.get('version') != 2:
        sys.exit(f"Error: {args.poses} is not a version-2 multi-frame poses JSON. Use --pose for single-frame files.")
    raw_poses = data.get('poses', [])
    print(f"Loaded {len(raw_poses)} pose(s) from {args.poses}")

    cap    = _open_video(args.video)
    fps    = cap.get(cv2.CAP_PROP_FPS)
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}×{height} @ {fps:.2f} fps — {total} frames")

    poses: dict[int, dict] = {}
    for p in raw_poses:
        idx = _video_frame_for_pose(p, fps, args.label_fps)
        poses[idx] = p

    use_ffmpeg = shutil.which('ffmpeg') is not None
    if use_ffmpeg:
        fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
        os.close(fd)
        write_path = tmp_path
    else:
        write_path = args.output

    opts      = _draw_opts(args)
    out       = _video_writer(write_path, fps, width, height)
    frame_idx = 0
    print('Rendering...')

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in poses:
            draw_pose(frame, poses[frame_idx], **opts)
        out.write(frame)
        frame_idx += 1
        if frame_idx % 300 == 0:
            print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print('Re-encoding to H.264...')
        _reenc_ffmpeg(tmp_path, args.video, args.output)
        os.unlink(tmp_path)

    print(f"Done → {args.output}")


def mode_video(args) -> None:
    json_paths = sorted(glob.glob(os.path.join(args.poses_dir, '*.json')))
    if not json_paths:
        sys.exit(f"Error: no .json files found in {args.poses_dir}")

    raw_poses = [_load_pose(p) for p in json_paths]
    print(f"Loaded {len(raw_poses)} pose annotation(s)")

    cap    = _open_video(args.video)
    fps    = cap.get(cv2.CAP_PROP_FPS)

    poses: dict[int, dict] = {}
    for data in raw_poses:
        idx = _video_frame_for_pose(data, fps, args.label_fps)
        poses[idx] = data
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}×{height} @ {fps:.2f} fps — {total} frames")

    use_ffmpeg = shutil.which('ffmpeg') is not None
    if use_ffmpeg:
        fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
        os.close(fd)
        write_path = tmp_path
    else:
        write_path = args.output

    opts      = _draw_opts(args)
    out       = _video_writer(write_path, fps, width, height)
    frame_idx = 0
    print('Rendering...')

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in poses:
            draw_pose(frame, poses[frame_idx], **opts)
        out.write(frame)
        frame_idx += 1
        if frame_idx % 300 == 0:
            print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print('Re-encoding to H.264...')
        _reenc_ffmpeg(tmp_path, args.video, args.output)
        os.unlink(tmp_path)

    print(f"Done → {args.output}")

# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Pose overlay for padel video frames.')
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument('--pose',      metavar='JSON', help='Single-frame pose JSON → output PNG')
    src.add_argument('--poses',     metavar='JSON', help='Multi-frame poses JSON (version 2, from "Export all") → output video')
    src.add_argument('--poses-dir', metavar='DIR',  help='Directory of single-frame pose JSONs → output video')
    parser.add_argument('--video',  required=True, help='Input video path')
    parser.add_argument('--output', default=None,  help='Output path (default: derived from input)')
    parser.add_argument('--no-angles',    action='store_true', help='Omit angle arcs and labels')
    parser.add_argument('--no-skeleton',  action='store_true', help='Omit skeleton connections')
    parser.add_argument('--no-keypoints', action='store_true', help='Omit keypoint circles')
    parser.add_argument('--label-color',  default=None,       metavar='HEX',
                        help='Label text colour as #RRGGBB (default: matches arc colour)')
    parser.add_argument('--label-size',   default=12,  type=int, metavar='PX',
                        help='Label font size in pixels (default: 12)')
    parser.add_argument('--label-bg',     default='#000000',  metavar='HEX|none',
                        help='Label background colour as #RRGGBB, or "none" (default: #000000)')
    parser.add_argument('--label-fps',    default=None, type=float, metavar='FPS',
                        help='FPS the labeller used (overrides timestampMs-based remap). '
                             'Use when the JSON lacks timestampMs or you need explicit control.')
    args = parser.parse_args()

    if args.output is None:
        if args.pose:
            args.output = os.path.splitext(args.pose)[0] + '_overlay.png'
        else:
            stem = os.path.splitext(args.video)[0]
            args.output = stem + '_posed.mp4'

    if args.pose:
        mode_single(args)
    elif args.poses:
        mode_multi(args)
    else:
        mode_video(args)


if __name__ == '__main__':
    main()
