import logging
import collections
import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger(__name__)

MODEL_W = 512
MODEL_H = 288


class TrackNetDetector:
    def __init__(self, model_path: str, threshold: float = 0.5):
        self._threshold = threshold
        self._session = ort.InferenceSession(
            model_path,
            providers=["CoreMLExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name
        self._buf: collections.deque[np.ndarray] = collections.deque(maxlen=3)
        log.debug("TrackNet model loaded: %s", model_path)

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        """
        Accept frames one at a time; returns a detection only once 3 frames
        have been buffered. Mirrors the sliding-window approach in the TS tool.
        """
        src_h, src_w = frame_bgr.shape[:2]

        plane = _preprocess(frame_bgr)
        self._buf.append(plane)

        if len(self._buf) < 3:
            return None

        # Stack oldest → newest: shape (1, 9, H, W)
        tensor = np.concatenate(list(self._buf), axis=0)[np.newaxis]  # (1, 9, H, W)
        outputs = self._session.run(None, {self._input_name: tensor})
        heatmap = outputs[0][0, 0]  # (H, W)

        idx = int(np.argmax(heatmap))
        peak = float(heatmap.flat[idx])
        if peak < self._threshold:
            return None

        model_x = idx % MODEL_W
        model_y = idx // MODEL_W
        u = (model_x / MODEL_W) * src_w
        v = (model_y / MODEL_H) * src_h
        return float(u), float(v)

    def reset(self) -> None:
        self._buf.clear()


def _preprocess(frame_bgr: np.ndarray) -> np.ndarray:
    """Resize to MODEL_W×MODEL_H, return channel-first float32 RGB (3, H, W)."""
    resized = cv2.resize(frame_bgr, (MODEL_W, MODEL_H), interpolation=cv2.INTER_LINEAR)
    rgb = resized[:, :, ::-1].astype(np.float32) / 255.0  # (H, W, 3)
    return rgb.transpose(2, 0, 1)  # (3, H, W)
