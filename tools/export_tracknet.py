#!/usr/bin/env python3
"""
Download TrackNetV2 pretrained weights and export to ONNX.

Usage:
    python3 tools/export_tracknet.py

Output: ball-velocity-tool/public/tracknetv2.onnx
"""

import os
import sys
import urllib.request
import pathlib

import torch
import torch.nn as nn

# ---------------------------------------------------------------------------
# Model definition — must match ChgygLin/TrackNetV2-pytorch exactly so
# the pretrained state_dict loads without key mismatches.
# ---------------------------------------------------------------------------

class Conv(nn.Module):
    """Conv → ReLU → BN, where BN normalises over the spatial W (width) dimension.

    The original Keras model used BatchNormalization(axis=-1) with channels_first,
    which normalises over the last axis (W).  The TF→PyTorch weight conversion
    preserves this: checkpoint BN tensors have shape (W_at_level,), not (out_channels,).
    """
    def __init__(self, ic: int, oc: int, k: tuple = (3, 3), bn_w: int = 512, act: bool = True):
        super().__init__()
        self.conv = nn.Conv2d(ic, oc, kernel_size=k, padding="same")
        self.bn   = nn.BatchNorm1d(bn_w)   # normalises over width dimension
        self.act  = nn.ReLU() if act else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.act(self.conv(x))               # (N, oc, H, W)
        N, C, H, W = out.shape
        flat = out.permute(0, 2, 1, 3).reshape(N * H * C, W)
        return self.bn(flat).reshape(N, H, C, W).permute(0, 2, 1, 3)


class TrackNet(nn.Module):
    def __init__(self):
        super().__init__()
        # Encoder — BN width follows spatial W after each pooling:
        #   level 0: W=512, level 1: W=256, level 2: W=128, bottleneck: W=64
        self.conv2d_1     = Conv(9,   64,  bn_w=512)
        self.conv2d_2     = Conv(64,  64,  bn_w=512)
        self.max_pooling_1 = nn.MaxPool2d((2, 2), stride=(2, 2))  # W: 512→256

        self.conv2d_3     = Conv(64,  128, bn_w=256)
        self.conv2d_4     = Conv(128, 128, bn_w=256)
        self.max_pooling_2 = nn.MaxPool2d((2, 2), stride=(2, 2))  # W: 256→128

        self.conv2d_5     = Conv(128, 256, bn_w=128)
        self.conv2d_6     = Conv(256, 256, bn_w=128)
        self.conv2d_7     = Conv(256, 256, bn_w=128)
        self.max_pooling_3 = nn.MaxPool2d((2, 2), stride=(2, 2))  # W: 128→64

        self.conv2d_8     = Conv(256, 512, bn_w=64)
        self.conv2d_9     = Conv(512, 512, bn_w=64)
        self.conv2d_10    = Conv(512, 512, bn_w=64)

        # Decoder — BN width mirrors the upsampling stages
        self.up_sampling_1 = nn.UpsamplingNearest2d(scale_factor=2)  # W: 64→128
        self.conv2d_11    = Conv(768, 256, bn_w=128)
        self.conv2d_12    = Conv(256, 256, bn_w=128)
        self.conv2d_13    = Conv(256, 256, bn_w=128)

        self.up_sampling_2 = nn.UpsamplingNearest2d(scale_factor=2)  # W: 128→256
        self.conv2d_14    = Conv(384, 128, bn_w=256)
        self.conv2d_15    = Conv(128, 128, bn_w=256)

        self.up_sampling_3 = nn.UpsamplingNearest2d(scale_factor=2)  # W: 256→512
        self.conv2d_16    = Conv(192, 64,  bn_w=512)
        self.conv2d_17    = Conv(64,  64,  bn_w=512)
        self.conv2d_18    = nn.Conv2d(64, 3, kernel_size=(1, 1), padding="same")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.conv2d_2(self.conv2d_1(x))
        x  = self.max_pooling_1(x1)

        x2 = self.conv2d_4(self.conv2d_3(x))
        x  = self.max_pooling_2(x2)

        x  = self.conv2d_5(x)
        x  = self.conv2d_6(x)
        x3 = self.conv2d_7(x)
        x  = self.max_pooling_3(x3)

        x  = self.conv2d_8(x)
        x  = self.conv2d_9(x)
        x  = self.conv2d_10(x)

        x  = torch.cat([self.up_sampling_1(x), x3], dim=1)
        x  = self.conv2d_13(self.conv2d_12(self.conv2d_11(x)))

        x  = torch.cat([self.up_sampling_2(x), x2], dim=1)
        x  = self.conv2d_15(self.conv2d_14(x))

        x  = torch.cat([self.up_sampling_3(x), x1], dim=1)
        x  = self.conv2d_17(self.conv2d_16(x))
        return torch.sigmoid(self.conv2d_18(x))


class TrackNetLastFrame(nn.Module):
    """Wraps TrackNet and returns only the last frame's heatmap: (B,1,H,W)."""
    def __init__(self, base: TrackNet):
        super().__init__()
        self.base = base

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.base(x)[:, 2:3, :, :]


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

WEIGHTS_URL = (
    "https://github.com/ChgygLin/TrackNetV2-pytorch"
    "/raw/main/tf2torch/track.pt"
)
WEIGHTS_PATH = pathlib.Path("tools/track.pt")
OUTPUT_PATH  = pathlib.Path("ball-velocity-tool/public/tracknetv2.onnx")

MODEL_H, MODEL_W = 288, 512


def download_weights() -> None:
    if WEIGHTS_PATH.exists():
        print(f"  Weights already at {WEIGHTS_PATH}, skipping download.")
        return
    print(f"  Downloading {WEIGHTS_URL} …")
    WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(WEIGHTS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(WEIGHTS_PATH, "wb") as f:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        while chunk := resp.read(1 << 16):
            f.write(chunk)
            downloaded += len(chunk)
            if total:
                print(f"\r  {downloaded / 1e6:.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()

    # Detect Git LFS pointer (text file, not a PyTorch binary)
    with open(WEIGHTS_PATH, "rb") as f:
        header = f.read(64)
    if b"version https://git-lfs" in header:
        WEIGHTS_PATH.unlink()
        sys.exit(
            "\nThe weights file is stored in Git LFS and cannot be downloaded\n"
            "directly via the raw GitHub URL. Clone the repo instead:\n\n"
            "    git clone https://github.com/ChgygLin/TrackNetV2-pytorch /tmp/tracknetv2\n"
            "    cp /tmp/tracknetv2/tf2torch/track.pt tools/track.pt\n\n"
            "Then re-run this script."
        )


def main() -> None:
    repo_root = pathlib.Path(__file__).parent.parent
    os.chdir(repo_root)
    print(f"Working directory: {repo_root}")

    download_weights()

    print("Loading model …")
    model = TrackNet()
    state = torch.load(WEIGHTS_PATH, map_location="cpu", weights_only=True)
    # Some checkpoints wrap the weights under a key
    if isinstance(state, dict) and "model" in state:
        state = state["model"]
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"  Missing keys ({len(missing)}): {missing[:5]}")
        if len(missing) > 5:
            print(f"  … and {len(missing)-5} more")
    if unexpected:
        print(f"  Unexpected keys ({len(unexpected)}): {unexpected[:5]}")
    model.eval()

    wrapped = TrackNetLastFrame(model)
    wrapped.eval()

    print(f"Exporting to ONNX → {OUTPUT_PATH} …")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = OUTPUT_PATH.with_suffix(".tmp.onnx")

    dummy = torch.zeros(1, 9, MODEL_H, MODEL_W)
    with torch.no_grad():
        torch.onnx.export(
            wrapped,
            dummy,
            str(tmp_path),
            export_params=True,
            opset_version=18,
            do_constant_folding=True,
            input_names=["input"],
            output_names=["output"],
        )

    # The new PyTorch exporter may split weights to an external .data file.
    # ONNX Runtime Web needs a single self-contained file, so merge them.
    import onnx
    from onnx.external_data_helper import load_external_data_for_model, convert_model_to_external_data
    m = onnx.load(str(tmp_path), load_external_data=True)
    onnx.save_model(m, str(OUTPUT_PATH), save_as_external_data=False)

    # Clean up temp files
    tmp_path.unlink(missing_ok=True)
    for p in OUTPUT_PATH.parent.glob("*.data"):
        p.unlink()

    onnx.checker.check_model(onnx.load(str(OUTPUT_PATH)))
    size_mb = OUTPUT_PATH.stat().st_size / 1e6
    print(f"  ONNX model OK — {size_mb:.1f} MB (single file)")
    print("Done.")


if __name__ == "__main__":
    main()
