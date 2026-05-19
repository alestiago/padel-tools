import logging
import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger(__name__)

_INPUT_SIZE = 640
_BALL_CLASS_ID = 0  # adjust if the model uses a different class index


class YoloDetector:
    def __init__(self, model_path: str, threshold: float = 0.5):
        self._threshold = threshold
        self._session = ort.InferenceSession(
            model_path,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name
        log.debug("YOLO model loaded: %s", model_path)

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        """Return (u, v) centroid of the highest-confidence ball box, or None."""
        h, w = frame_bgr.shape[:2]
        img, pad_x, pad_y, scale = _letterbox(frame_bgr, _INPUT_SIZE)

        # HWC BGR → CHW RGB float32 [0, 1]
        tensor = img[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
        tensor = tensor[np.newaxis]

        outputs = self._session.run(None, {self._input_name: tensor})
        # YOLOv8 output shape: (1, 84, num_boxes) — [cx, cy, cw, ch, cls0..cls79]
        preds = outputs[0][0].T  # (num_boxes, 84)

        best_conf = self._threshold
        best_box = None

        for pred in preds:
            cx, cy, bw, bh = pred[:4]
            scores = pred[4:]
            cls = int(np.argmax(scores))
            conf = float(scores[cls])
            if cls != _BALL_CLASS_ID or conf < best_conf:
                continue
            best_conf = conf
            best_box = (cx, cy, bw, bh)

        if best_box is None:
            return None

        cx, cy, _, _ = best_box
        # Map from letterboxed coords back to original frame coords
        u = (cx - pad_x) / scale
        v = (cy - pad_y) / scale
        return float(np.clip(u, 0, w - 1)), float(np.clip(v, 0, h - 1))

    def reset(self) -> None:
        pass


def _letterbox(
    img: np.ndarray, size: int
) -> tuple[np.ndarray, float, float, float]:
    h, w = img.shape[:2]
    scale = size / max(h, w)
    new_w, new_h = int(w * scale), int(h * scale)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    pad_x = (size - new_w) // 2
    pad_y = (size - new_h) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized
    return canvas, pad_x, pad_y, scale
