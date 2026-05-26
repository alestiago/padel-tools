# %%
# @title 1. Runtime check & install dependencies
# Run this cell first. Switch to a GPU runtime first:
#   Runtime → Change runtime type → T4 GPU

import subprocess, sys

result = subprocess.run(["nvidia-smi"], capture_output=True)
if result.returncode != 0:
    print("WARNING: No GPU detected. Switch Runtime → Change runtime type → T4 GPU for best speed.")
else:
    print(result.stdout.decode().split("\n")[0])

subprocess.check_call([
    sys.executable, "-m", "pip", "install", "-q",
    "opencv-python-headless>=4.9",
    "numpy>=1.26",
    "tqdm>=4.66",
    "onnxruntime-gpu>=1.18",   # GPU-aware; falls back to CPU if no CUDA
    "torch",
    "onnx",
])
print("Dependencies ready.")


# %%
# @title 2. (Optional) Mount Google Drive
# Mount Drive if your video / homography / model files live there.
# Skip this cell if you plan to upload files directly.

MOUNT_DRIVE = False  # @param {type:"boolean"}

if MOUNT_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    print("Drive mounted at /content/drive")


# %%
# @title 3. Upload input files
# Either upload files from your computer (next block) or set paths to Drive files below.
# Needed:
#   VIDEO_PATH       — your .mp4 / .mov recording
#   HOMOGRAPHY_PATH  — homography_video.json from homography-tool
#   MODEL_PATH       — tracknetv2.onnx  (build it in Cell 4 if you don't have it yet)

from google.colab import files as _colab_files

UPLOAD_FILES = True  # @param {type:"boolean"}

if UPLOAD_FILES:
    print("Select your files in the dialog. Upload all three at once: video, homography JSON, ONNX model.")
    uploaded = _colab_files.upload()
    for name in uploaded:
        print(f"  Uploaded: {name}")

# ── File paths ──────────────────────────────────────────────────────────────
# Adjust if using Drive or if filenames differ.
VIDEO_PATH      = ""   # e.g. "/content/match.mp4" or "/content/drive/MyDrive/padel/match.mp4"
HOMOGRAPHY_PATH = ""   # e.g. "/content/homography_video.json"
MODEL_PATH      = ""   # e.g. "/content/tracknetv2.onnx"  (or build below)

# ── Detection settings ───────────────────────────────────────────────────────
DETECTOR_VERSION = "v2"   # "v1" or "v2" (v2 adds NMS + wall penalty + camera-motion gate)
THRESHOLD        = 0.5    # confidence threshold
FRAME_STEP       = 2      # analyse every N frames  (2 = half frame rate)
OUTPUT_FORMAT    = "csv"  # "csv" or "json"


# %%
# @title 4. (Optional) Build ONNX model in Colab
# Run this cell only if you don't already have tracknetv2.onnx.
# It downloads the pretrained PyTorch weights (~11 MB) and exports to ONNX.
# Output: /content/tracknetv2.onnx

import urllib.request, pathlib, os
import torch, torch.nn as nn, onnx
from onnx.external_data_helper import load_external_data_for_model

BUILD_MODEL = False  # @param {type:"boolean"}

if BUILD_MODEL:
    WEIGHTS_URL  = "https://github.com/ChgygLin/TrackNetV2-pytorch/raw/main/tf2torch/track.pt"
    WEIGHTS_PATH = pathlib.Path("/content/track.pt")
    ONNX_OUT     = pathlib.Path("/content/tracknetv2.onnx")
    MODEL_H, MODEL_W = 288, 512

    class _Conv(nn.Module):
        def __init__(self, ic, oc, k=(3,3), bn_w=512, act=True):
            super().__init__()
            self.conv = nn.Conv2d(ic, oc, kernel_size=k, padding="same")
            self.bn   = nn.BatchNorm1d(bn_w)
            self.act  = nn.ReLU() if act else nn.Identity()
        def forward(self, x):
            out = self.act(self.conv(x))
            N, C, H, W = out.shape
            flat = out.permute(0,2,1,3).reshape(N*H*C, W)
            return self.bn(flat).reshape(N,H,C,W).permute(0,2,1,3)

    class _TrackNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.c1  = _Conv(9,   64,  bn_w=512); self.c2  = _Conv(64,  64,  bn_w=512)
            self.p1  = nn.MaxPool2d(2, 2)
            self.c3  = _Conv(64,  128, bn_w=256); self.c4  = _Conv(128, 128, bn_w=256)
            self.p2  = nn.MaxPool2d(2, 2)
            self.c5  = _Conv(128, 256, bn_w=128); self.c6  = _Conv(256, 256, bn_w=128)
            self.c7  = _Conv(256, 256, bn_w=128)
            self.p3  = nn.MaxPool2d(2, 2)
            self.c8  = _Conv(256, 512, bn_w=64);  self.c9  = _Conv(512, 512, bn_w=64)
            self.c10 = _Conv(512, 512, bn_w=64)
            self.u1  = nn.UpsamplingNearest2d(scale_factor=2)
            self.c11 = _Conv(768, 256, bn_w=128); self.c12 = _Conv(256, 256, bn_w=128)
            self.c13 = _Conv(256, 256, bn_w=128)
            self.u2  = nn.UpsamplingNearest2d(scale_factor=2)
            self.c14 = _Conv(384, 128, bn_w=256); self.c15 = _Conv(128, 128, bn_w=256)
            self.u3  = nn.UpsamplingNearest2d(scale_factor=2)
            self.c16 = _Conv(192, 64,  bn_w=512); self.c17 = _Conv(64,  64,  bn_w=512)
            self.c18 = nn.Conv2d(64, 3, kernel_size=(1,1), padding="same")
        def forward(self, x):
            x1 = self.c2(self.c1(x));  x = self.p1(x1)
            x2 = self.c4(self.c3(x));  x = self.p2(x2)
            x  = self.c5(x); x = self.c6(x); x3 = self.c7(x); x = self.p3(x3)
            x  = self.c10(self.c9(self.c8(x)))
            x  = self.c13(self.c12(self.c11(torch.cat([self.u1(x), x3], 1))))
            x  = self.c15(self.c14(torch.cat([self.u2(x), x2], 1)))
            x  = self.c17(self.c16(torch.cat([self.u3(x), x1], 1)))
            return torch.sigmoid(self.c18(x))

    class _Wrapped(nn.Module):
        def __init__(self, base): super().__init__(); self.base = base
        def forward(self, x): return self.base(x)[:, 2:3, :, :]

    print("Downloading pretrained weights …")
    req = urllib.request.Request(WEIGHTS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(WEIGHTS_PATH, "wb") as f:
        f.write(resp.read())

    with open(WEIGHTS_PATH, "rb") as f:
        if b"version https://git-lfs" in f.read(64):
            raise RuntimeError(
                "Weights file is a Git LFS pointer. Clone the repo and copy track.pt manually:\n"
                "  git clone https://github.com/ChgygLin/TrackNetV2-pytorch /tmp/tn\n"
                "  cp /tmp/tn/tf2torch/track.pt /content/track.pt"
            )

    print("Loading model …")
    model = _TrackNet()
    state = torch.load(WEIGHTS_PATH, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model" in state:
        state = state["model"]
    model.load_state_dict(state, strict=False)
    model.eval()

    wrapped = _Wrapped(model)
    wrapped.eval()

    print(f"Exporting to {ONNX_OUT} …")
    tmp = ONNX_OUT.with_suffix(".tmp.onnx")
    dummy = torch.zeros(1, 9, MODEL_H, MODEL_W)
    with torch.no_grad():
        torch.onnx.export(
            wrapped, dummy, str(tmp),
            export_params=True, opset_version=18, do_constant_folding=True,
            input_names=["input"], output_names=["output"],
        )

    m = onnx.load(str(tmp), load_external_data=True)
    onnx.save_model(m, str(ONNX_OUT), save_as_external_data=False)
    tmp.unlink(missing_ok=True)
    for p in ONNX_OUT.parent.glob("*.data"):
        p.unlink()

    onnx.checker.check_model(onnx.load(str(ONNX_OUT)))
    print(f"ONNX model ready: {ONNX_OUT}  ({ONNX_OUT.stat().st_size/1e6:.1f} MB)")
    MODEL_PATH = str(ONNX_OUT)


# %%
# @title 5. Run TrackNet detection

import collections, math, json, csv, os, logging
import cv2
import numpy as np
from tqdm.notebook import tqdm
import onnxruntime as ort

logging.basicConfig(level=logging.WARNING)

# ── Validate inputs ──────────────────────────────────────────────────────────
for label, path in [("Video", VIDEO_PATH), ("Homography", HOMOGRAPHY_PATH), ("Model", MODEL_PATH)]:
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"{label} not found: {path!r}  — set the path in Cell 3")

# ── Inlined helpers ──────────────────────────────────────────────────────────

def _hg_load(path):
    with open(path) as f:
        data = json.load(f)
    return {
        "H": np.array(data["H"], dtype=np.float64),
        "frame_size": data["frame_size"],
        "reprojection_error_m": data.get("reprojection_error_m"),
        "video_file": data.get("video_file", ""),
    }

def _apply_H(H, u, v):
    p = H @ np.array([u, v, 1.0])
    return float(p[0] / p[2]), float(p[1] / p[2])

def _in_court(x, y, margin=1.0):
    return -margin <= x <= 10 + margin and -margin <= y <= 20 + margin

def _velocity_compute(results, dt, window=5):
    MAX_KMH = 250.0
    for i, r in enumerate(results):
        prev = results[i-1] if i > 0 else None
        if prev is None or r["ball"] is None or prev["ball"] is None:
            r["raw_velocity_kmh"] = None; continue
        dx = r["ball"]["court_x_m"] - prev["ball"]["court_x_m"]
        dy = r["ball"]["court_y_m"] - prev["ball"]["court_y_m"]
        kmh = (math.hypot(dx, dy) / dt) * 3.6
        r["raw_velocity_kmh"] = kmh if kmh <= MAX_KMH else None
    half = window // 2
    for i, r in enumerate(results):
        vals = [results[j]["raw_velocity_kmh"]
                for j in range(max(0, i-half), min(len(results), i+half+1))
                if results[j]["raw_velocity_kmh"] is not None]
        r["velocity_kmh"] = sum(vals)/len(vals) if vals else None
    return results

# ── Detector classes (mirrors detector/tracknet.py and tracknet_v2.py) ───────

_MODEL_W, _MODEL_H = 512, 288

def _preprocess(frame_bgr):
    resized = cv2.resize(frame_bgr, (_MODEL_W, _MODEL_H), interpolation=cv2.INTER_LINEAR)
    rgb = resized[:, :, ::-1].astype(np.float32) / 255.0
    return rgb.transpose(2, 0, 1)


class _TrackNetDetector:
    def __init__(self, model_path, threshold=0.5):
        self._threshold = threshold
        self._session = ort.InferenceSession(
            model_path,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name
        self._buf = collections.deque(maxlen=3)
        provider = self._session.get_providers()[0]
        print(f"TrackNet v1 loaded — provider: {provider}")

    def detect(self, frame_bgr):
        plane = _preprocess(frame_bgr)
        self._buf.append(plane)
        if len(self._buf) < 3:
            return None
        tensor = np.concatenate(list(self._buf), axis=0)[np.newaxis]
        heatmap = self._session.run(None, {self._input_name: tensor})[0][0, 0]
        idx = int(np.argmax(heatmap))
        peak = float(heatmap.flat[idx])
        if peak < self._threshold:
            return None
        src_h, src_w = frame_bgr.shape[:2]
        u = (idx % _MODEL_W) / _MODEL_W * src_w
        v = (idx // _MODEL_W) / _MODEL_H * src_h
        return float(u), float(v)

    def reset(self):
        self._buf.clear()


class _TrackNetDetectorV2:
    """TrackNet with NMS, wall-proximity penalty, and camera-motion gate."""

    def __init__(
        self, model_path, threshold=0.5, nms_radius=15, max_peaks=3,
        wall_penalty_weight=0.3, pred_weight=0.3, pred_sigma_px=150.0,
        glass_attenuation=0.3, glass_wall_y=20.0, cam_motion_threshold=8,
        max_velocity_kmh=250.0, H_inv=None, court_margin_m=0.5,
    ):
        self._session = ort.InferenceSession(
            model_path,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name
        self._threshold       = threshold
        self._nms_radius      = nms_radius
        self._max_peaks       = max_peaks
        self._wall_penalty_w  = wall_penalty_weight
        self._pred_weight     = pred_weight
        self._pred_sigma_px   = pred_sigma_px
        self._glass_att       = glass_attenuation
        self._glass_wall_y    = glass_wall_y
        self._cam_threshold   = cam_motion_threshold
        self._max_vel_kmh     = max_velocity_kmh
        self._court_margin    = court_margin_m
        self._H_inv           = H_inv
        self._H               = np.linalg.inv(H_inv) if H_inv is not None else None
        self._buf             = collections.deque(maxlen=3)
        self._prev_gray       = None
        self._glass_mask      = None
        self._confirmed       = []
        provider = self._session.get_providers()[0]
        print(f"TrackNet v2 loaded — provider: {provider}")

    def detect(self, frame_bgr):
        src_h, src_w = frame_bgr.shape[:2]
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        if self._prev_gray is not None:
            if float(np.median(cv2.absdiff(gray, self._prev_gray))) > self._cam_threshold:
                self._buf.clear(); self._prev_gray = gray; return None
        self._prev_gray = gray

        if self._glass_mask is None and self._H is not None:
            cols = (np.arange(_MODEL_W) + 0.5) / _MODEL_W * src_w
            rows = (np.arange(_MODEL_H) + 0.5) / _MODEL_H * src_h
            U, V = np.meshgrid(cols, rows)
            H = self._H
            denom   = H[2,0]*U + H[2,1]*V + H[2,2]
            world_y = (H[1,0]*U + H[1,1]*V + H[1,2]) / denom
            self._glass_mask = world_y > self._glass_wall_y

        self._buf.append(_preprocess(frame_bgr))
        if len(self._buf) < 3:
            return None

        tensor = np.concatenate(list(self._buf), axis=0)[np.newaxis]
        heatmap = self._session.run(None, {self._input_name: tensor})[0][0, 0].copy()

        if self._glass_mask is not None:
            heatmap[self._glass_mask] *= self._glass_att

        peaks = self._nms(heatmap)
        if not peaks:
            return None

        pred_u, pred_v = self._predict_pixel()
        return self._rank(peaks, src_w, src_h, pred_u, pred_v)

    def confirm(self, wx, wy, t):
        self._confirmed.append((wx, wy, t))
        if len(self._confirmed) > 2:
            self._confirmed.pop(0)

    def velocity_gate(self, wx, wy, t):
        if not self._confirmed:
            return True
        px, py, pt = self._confirmed[-1]
        dt = t - pt
        if dt <= 0:
            return True
        if dt > 1.0:
            self._confirmed.clear(); return True
        if math.hypot(wx - px, wy - py) / dt * 3.6 > self._max_vel_kmh:
            return False
        return True

    def reset(self):
        self._buf.clear(); self._prev_gray = None; self._confirmed.clear()

    def _nms(self, heatmap):
        h, w = heatmap.shape
        order = np.argsort(heatmap.ravel())[::-1]
        visited = np.zeros((h, w), dtype=bool)
        peaks, r = [], self._nms_radius
        for idx in order:
            conf = float(heatmap.flat[idx])
            if conf < self._threshold:
                break
            row, col = divmod(int(idx), w)
            if visited[row, col]:
                continue
            peaks.append((row, col, conf))
            r0, r1 = max(0, row-r), min(h, row+r+1)
            c0, c1 = max(0, col-r), min(w, col+r+1)
            visited[r0:r1, c0:c1] = True
            if len(peaks) >= self._max_peaks:
                break
        return peaks

    def _rank(self, peaks, src_w, src_h, pred_u, pred_v):
        m = self._court_margin
        wall_band = 0.5
        scored = []
        for row, col, conf in peaks:
            u = (col + 0.5) / _MODEL_W * src_w
            v = (row + 0.5) / _MODEL_H * src_h
            if self._H is not None:
                p = self._H @ np.array([u, v, 1.0])
                x, y = float(p[0]/p[2]), float(p[1]/p[2])
            else:
                x, y = 5.0, 10.0
            if not (-m <= x <= 10+m and -m <= y <= 20+m):
                continue
            dist_wall = min(x+m, (10+m)-x, y+m, (20+m)-y)
            penalty = max(0.0, 1.0 - dist_wall/wall_band) * self._wall_penalty_w
            pred_score = (math.exp(-math.hypot(u-pred_u, v-pred_v)/self._pred_sigma_px)
                          if pred_u is not None else 0.5)
            scored.append((conf - penalty + self._pred_weight * pred_score, u, v))
        if not scored:
            return None
        scored.sort(key=lambda s: -s[0])
        return scored[0][1], scored[0][2]

    def _predict_pixel(self):
        if len(self._confirmed) < 2 or self._H_inv is None:
            return None, None
        (x1,y1,_), (x2,y2,_) = self._confirmed[-2], self._confirmed[-1]
        p = self._H_inv @ np.array([x2+(x2-x1), y2+(y2-y1), 1.0])
        w = p[2]
        return (float(p[0]/w), float(p[1]/w)) if abs(w) > 1e-9 else (None, None)


# ── Load homography & video ──────────────────────────────────────────────────

hom       = _hg_load(HOMOGRAPHY_PATH)
H         = hom["H"]
H_inv     = np.linalg.inv(H)
fs        = hom["frame_size"]
reproj    = hom.get("reprojection_error_m")
print(f"Homography loaded: frame_size={fs['width']}×{fs['height']}"
      + (f"  reproj_err={reproj:.3f} m" if reproj else ""))

cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
native_fps   = cap.get(cv2.CAP_PROP_FPS)
dt           = FRAME_STEP / native_fps
analyse_count = max(1, total_frames // FRAME_STEP)
print(f"Video: {total_frames} frames @ {native_fps:.1f} fps → {analyse_count} frames to analyse (step={FRAME_STEP})")

# ── Build detector ───────────────────────────────────────────────────────────

if DETECTOR_VERSION == "v2":
    detector = _TrackNetDetectorV2(MODEL_PATH, threshold=THRESHOLD, H_inv=H_inv)
    has_vgate = True
else:
    detector = _TrackNetDetector(MODEL_PATH, threshold=THRESHOLD)
    has_vgate = False

# ── Main loop ────────────────────────────────────────────────────────────────

results = []
frame_idx = 0

with tqdm(total=analyse_count, unit="frame") as bar:
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % FRAME_STEP != 0:
            frame_idx += 1
            continue

        time_s = frame_idx / native_fps
        orig_h, orig_w = frame.shape[:2]
        cal_w, cal_h   = fs["width"], fs["height"]
        if orig_w != cal_w or orig_h != cal_h:
            frame = cv2.resize(frame, (cal_w, cal_h), interpolation=cv2.INTER_LINEAR)

        detection = detector.detect(frame)
        ball = None
        if detection is not None:
            u, v = detection
            x, y = _apply_H(H, u, v)
            if _in_court(x, y):
                if not has_vgate or detector.velocity_gate(x, y, time_s):
                    ball = {"pixel_u": u, "pixel_v": v, "court_x_m": x, "court_y_m": y}
                    if has_vgate:
                        detector.confirm(x, y, time_s)

        results.append({
            "frame_index": frame_idx,
            "time_s":      time_s,
            "ball":        ball,
            "raw_velocity_kmh": None,
            "velocity_kmh":     None,
        })
        frame_idx += 1
        bar.update(1)

cap.release()

results = _velocity_compute(results, dt)

detected    = sum(1 for r in results if r["ball"])
velocities  = [r["velocity_kmh"] for r in results if r["velocity_kmh"] is not None]
detect_rate = detected / len(results) * 100 if results else 0
print(f"\nDetection rate: {detect_rate:.1f}%  ({detected}/{len(results)} frames)")
if velocities:
    peak = max(velocities)
    peak_t = next(r["time_s"] for r in results if r["velocity_kmh"] == peak)
    print(f"Peak smoothed velocity: {peak:.1f} km/h  (t={peak_t:.2f} s)")
else:
    print("No velocity data (insufficient consecutive detections).")


# %%
# @title 6. Save & download results

import os
from google.colab import files as _colab_files

stem       = os.path.splitext(os.path.basename(VIDEO_PATH))[0]
out_path   = f"/content/{stem}_velocity.{OUTPUT_FORMAT}"

if OUTPUT_FORMAT == "json":
    rows = []
    for r in results:
        b = r["ball"]
        rows.append({
            "frame_index":     r["frame_index"],
            "time_s":          round(r["time_s"], 4),
            "ball": {
                "ball_u_px":  round(b["pixel_u"],    2),
                "ball_v_px":  round(b["pixel_v"],    2),
                "ball_x_m":   round(b["court_x_m"],  4),
                "ball_y_m":   round(b["court_y_m"],  4),
            } if b else None,
            "raw_velocity_kmh": round(r["raw_velocity_kmh"], 2) if r["raw_velocity_kmh"] is not None else None,
            "velocity_kmh":     round(r["velocity_kmh"],     2) if r["velocity_kmh"]     is not None else None,
        })
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2)
else:
    fields = ["frame_index","time_s","ball_u_px","ball_v_px","ball_x_m","ball_y_m","raw_velocity_kmh","velocity_kmh"]
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in results:
            b = r["ball"]
            writer.writerow({
                "frame_index":      r["frame_index"],
                "time_s":           f"{r['time_s']:.4f}",
                "ball_u_px":        f"{b['pixel_u']:.2f}"   if b else "",
                "ball_v_px":        f"{b['pixel_v']:.2f}"   if b else "",
                "ball_x_m":         f"{b['court_x_m']:.4f}" if b else "",
                "ball_y_m":         f"{b['court_y_m']:.4f}" if b else "",
                "raw_velocity_kmh": f"{r['raw_velocity_kmh']:.2f}" if r["raw_velocity_kmh"] is not None else "",
                "velocity_kmh":     f"{r['velocity_kmh']:.2f}"     if r["velocity_kmh"]     is not None else "",
            })

print(f"Output written: {out_path}")
_colab_files.download(out_path)
