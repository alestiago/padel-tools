from .blob import BlobDetector
from .blob_v2 import BlobDetectorV2
from .blob_v3 import BlobDetectorV3
from .blob_v4 import BlobDetectorV4
from .yolo import YoloDetector
from .tracknet import TrackNetDetector
from .tracknet_v2 import TrackNetDetectorV2

__all__ = ["BlobDetector", "BlobDetectorV2", "BlobDetectorV3", "BlobDetectorV4", "YoloDetector", "TrackNetDetector", "TrackNetDetectorV2"]

_NEEDS_H_INV = {"blob_v2", "blob_v3", "blob_v4", "tracknet_v2"}


def build(name: str, model_path: str | None, threshold: float, H_inv=None):
    if name == "blob":
        return BlobDetector()
    if name == "blob_v2":
        return BlobDetectorV2(H_inv=H_inv)
    if name == "blob_v3":
        return BlobDetectorV3(H_inv=H_inv)
    if name == "blob_v4":
        return BlobDetectorV4(H_inv=H_inv)
    if name == "tracknet_v2":
        if not model_path:
            raise ValueError("--model is required for the tracknet_v2 detector")
        return TrackNetDetectorV2(model_path=model_path, threshold=threshold, H_inv=H_inv)
    if name == "yolo":
        if not model_path:
            raise ValueError("--model is required for the yolo detector")
        return YoloDetector(model_path, threshold)
    if name == "tracknet":
        if not model_path:
            raise ValueError("--model is required for the tracknet detector")
        return TrackNetDetector(model_path, threshold)
    raise ValueError(f"Unknown detector: {name!r}")
