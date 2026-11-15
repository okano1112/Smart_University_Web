#!/usr/bin/env python3
"""Send COCO-17 skeletons from CiRA or local MoveNet to Node-RED."""
import argparse
import json
import math
import re
import secrets
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

# OpenPose BODY_25 -> COCO-17. MoveNet already uses COCO-17 ordering.
BODY25 = (0, 16, 15, 18, 17, 5, 2, 6, 3, 7, 4, 12, 9, 13, 10, 14, 11)
MAX_BYTES = 128 * 1024


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def point(x, y, score):
    if not all(number(v) for v in (x, y, score)) or not 0 <= score <= 1:
        raise ValueError('invalid joint')
    if not 0 <= x <= 1 or not 0 <= y <= 1:
        return {'x': 0, 'y': 0, 'score': 0}
    return {'x': round(x, 6), 'y': round(y, 6), 'score': round(score, 6)}


def frame_header(frame):
    width, height, stamp = (frame[k] for k in ('width', 'height', 'captured_at'))
    if (type(width) is not int or type(height) is not int or
            not 16 <= width <= 8192 or not 16 <= height <= 8192 or
            not .25 <= width / height <= 4 or type(stamp) is not int or stamp <= 0):
        raise ValueError('invalid frame dimensions or capture time')
    return width, height, stamp


def normalize_frame(frame, format_name, units):
    width, height, stamp = frame_header(frame)
    records = frame['people']
    if not isinstance(records, list) or len(records) > 64:
        raise ValueError('invalid people list')
    people, used = [], set()
    for record in records:
        if format_name == 'openpose-body25':
            raw = record['pose_keypoints_2d']
            if not isinstance(raw, list) or len(raw) != 75:
                raise ValueError('expected OpenPose BODY_25')
            joints = [raw[i * 3:i * 3 + 3] for i in BODY25]
        else:
            raw = record['keypoints']
            if not isinstance(raw, list) or len(raw) != 17:
                raise ValueError('expected COCO-17')
            joints = [(p['x'], p['y'], p['score']) for p in raw]
        scale_x, scale_y = (width, height) if units == 'pixels' else (1, 1)
        joints = [point(x / scale_x, y / scale_y, score) for x, y, score in joints]
        person = {'keypoints': joints}
        track_id = record.get('track_id', record.get('id'))
        if track_id is not None:
            if type(track_id) not in (str, int) or not re.fullmatch(r'[A-Za-z0-9_-]{1,48}', str(track_id)):
                raise ValueError('expected an opaque track_id')
            person['id'] = str(track_id)
            if person['id'] in used:
                raise ValueError('duplicate track_id')
            used.add(person['id'])
        people.append(person)
    if used and len(used) != len(people):
        raise ValueError('use either track IDs for every person or no track IDs')
    return {'width': width, 'height': height, 'captured_at': stamp, 'people': people}


def torso(joints, aspect):
    points = [joints[i] for i in (5, 6, 11, 12)]
    if any(p['score'] < .35 for p in points):
        return None
    x = [p['x'] * aspect for p in points]
    y = [p['y'] for p in points]
    length = math.hypot((x[0] + x[1] - x[2] - x[3]) / 2, (y[0] + y[1] - y[2] - y[3]) / 2)
    return (sum(x) / 4, sum(y) / 4, length) if length >= .025 else None


class Tracker:
    """Conservative short-lived image-space tracking. Break ties by resetting IDs."""
    def __init__(self):
        self.previous = []
        self.context = None
        self.stamp = 0
        self.prefix = secrets.token_hex(4)
        self.next_id = 0

    def assign(self, frame):
        width, height, stamp = frame_header(frame)
        if stamp <= self.stamp:
            raise ValueError('capture times must increase')
        people = frame['people']
        gap = stamp - self.stamp
        if gap > 500 or self.context != (width, height):
            self.previous = []
        self.context, self.stamp = (width, height), stamp
        if not people or 'id' in people[0]:
            self.previous = []
            return frame
        features = [torso(p['keypoints'], width / height) for p in people]
        matches = [[] for _ in people]
        reverse = [[] for _ in self.previous]
        for i, feature in enumerate(features):
            if feature is None:
                continue
            x, y, scale = feature
            for j, (_, (px, py, previous_scale)) in enumerate(self.previous):
                distance = math.hypot(x - px, y - py) / max(scale, previous_scale)
                if .70 <= scale / previous_scale <= 1.42 and distance <= .24 + 2.7 * gap / 1000:
                    matches[i].append((distance, j))
                    reverse[j].append((distance, i))
        def best(items):
            items.sort()
            return items[0][1] if items and (len(items) == 1 or items[1][0] - items[0][0] >= .16) else None
        following = []
        for i, (person, feature) in enumerate(zip(people, features)):
            candidate = best(matches[i])
            if candidate is not None and best(reverse[candidate]) == i:
                track_id = self.previous[candidate][0]
            else:
                self.next_id += 1
                track_id = f'p-{self.prefix}-{self.next_id}'
            person['id'] = track_id
            if feature is not None:
                following.append((track_id, feature))
        self.previous = following
        return frame


def decode_multipose(rows, width, height, stamp, content_width, content_height, canvas_width, canvas_height):
    if len(rows) != 6 or any(len(row) != 56 for row in rows):
        raise ValueError('expected MoveNet MultiPose output [1, 6, 56]')
    people = []
    for row in rows:
        detection = float(row[55])
        if not math.isfinite(detection) or not 0 <= detection <= 1:
            raise ValueError('invalid pose confidence')
        if detection < .25:
            continue
        joints = [
            point(float(row[i + 1]) * canvas_width / content_width,
                  float(row[i]) * canvas_height / content_height, float(row[i + 2]))
            for i in range(0, 51, 3)
        ]
        people.append({'keypoints': joints})
    return {'width': width, 'height': height, 'captured_at': stamp, 'people': people}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def post_frame(frame, opener, port):
    body = json.dumps(frame, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > MAX_BYTES:
        raise ValueError('pose frame exceeds maximum body size')
    request = Request(f'http://127.0.0.1:{port}/cira-pose-frame', data=body,
                      headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with opener.open(request, timeout=1.5) as response:
        if response.status not in (200, 202) or json.loads(response.read(1024)).get('ok') is not True:
            raise ValueError('bridge did not accept the frame')


def json_frames(format_name, units):
    while line := sys.stdin.buffer.readline(MAX_BYTES + 1):
        if len(line) > MAX_BYTES:
            while line and not line.endswith(b'\n'):
                line = sys.stdin.buffer.readline(MAX_BYTES + 1)
            yield None
            continue
        try:
            yield normalize_frame(json.loads(line), format_name, units)
        except (KeyError, TypeError, OverflowError, ValueError):
            yield None


class MoveNet:
    def __init__(self, model_path):
        try:
            import cv2
            import numpy as np
            try:
                from ai_edge_litert.interpreter import Interpreter
            except ImportError:
                import tensorflow as tf
                Interpreter = tf.lite.Interpreter
        except ImportError as exc:
            raise ValueError('install OpenCV and LiteRT or TensorFlow for model mode') from exc

        self.cv2, self.np = cv2, np
        self.model = Interpreter(model_path=model_path, num_threads=2)
        inputs, outputs = self.model.get_input_details(), self.model.get_output_details()
        if len(inputs) != 1 or len(outputs) != 1:
            raise ValueError('expected official MoveNet MultiPose Lightning model')
        self.spec, self.output = inputs[0], outputs[0]['index']
        signature = self.spec['shape_signature']
        if (self.spec['dtype'] not in (np.uint8, np.int32) or len(signature) != 4 or
                (signature[0], signature[3]) != (1, 3)):
            raise ValueError('unexpected MoveNet input tensor')
        self.dynamic = all(value == -1 for value in signature[1:3])
        self.previous_shape = None

    def predict(self, bgr, stamp):
        np, cv2, spec, model = self.np, self.cv2, self.spec, self.model
        if not isinstance(bgr, np.ndarray) or bgr.ndim != 3 or bgr.shape[2] != 3 or bgr.dtype != np.uint8:
            raise ValueError('expected an 8-bit BGR frame')
        height, width = bgr.shape[:2]
        frame_header({'width': width, 'height': height, 'captured_at': stamp})
        if self.dynamic:
            scale = 256 / max(width, height)
            resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
            canvas_width = math.ceil(resized_width / 32) * 32
            canvas_height = math.ceil(resized_height / 32) * 32
        else:
            canvas_height, canvas_width = map(int, spec['shape'][1:3])
            if min(canvas_width, canvas_height) < 32:
                raise ValueError('unexpected fixed MoveNet input dimensions')
            scale = min(canvas_width / width, canvas_height / height)
            resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
        shape = (1, canvas_height, canvas_width, 3)
        if self.previous_shape != shape:
            if self.dynamic:
                model.resize_tensor_input(spec['index'], shape, strict=True)
            model.allocate_tensors()
            self.previous_shape = shape
        image = np.zeros(shape, dtype=spec['dtype'])
        rgb = cv2.cvtColor(cv2.resize(bgr, (resized_width, resized_height)), cv2.COLOR_BGR2RGB)
        image[0, :resized_height, :resized_width] = rgb
        model.set_tensor(spec['index'], image)
        model.invoke()
        result = model.get_tensor(self.output)
        if result.shape != (1, 6, 56) or result.dtype.kind != 'f':
            raise ValueError('unexpected MoveNet output tensor')
        return decode_multipose(result[0], width, height, stamp, resized_width, resized_height, canvas_width, canvas_height)


def model_frames(options):
    detector = MoveNet(options.model)
    capture = detector.cv2.VideoCapture(options.video if options.video is not None else options.camera)
    if not capture.isOpened():
        capture.release()
        raise ValueError('could not open video source')
    period = 1 / options.fps
    try:
        while True:
            started = time.monotonic()
            ok, bgr = capture.read()
            if not ok:
                if options.video is None:
                    raise ValueError('camera stopped delivering frames')
                return
            yield detector.predict(bgr, time.time_ns() // 1_000_000)
            time.sleep(max(0, period - (time.monotonic() - started)))
    finally:
        capture.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=1880, help='local Node-RED or forwarded port')
    modes = parser.add_subparsers(dest='mode', required=True)
    json_mode = modes.add_parser('json', help='read CiRA pose frames as newline-delimited JSON on stdin')
    json_mode.add_argument('--format', choices=['coco17', 'openpose-body25'], required=True)
    json_mode.add_argument('--units', choices=['normalized', 'pixels'], required=True)
    model_mode = modes.add_parser('model', help='run local MoveNet when CiRA cannot run the model directly')
    model_mode.add_argument('--model', required=True, help='path to official MultiPose Lightning TFLite model')
    source = model_mode.add_mutually_exclusive_group(required=True)
    source.add_argument('--camera', type=int)
    source.add_argument('--video', help='local video file for commissioning')
    model_mode.add_argument('--fps', type=float, default=10)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or (args.mode == 'model' and not 4 <= args.fps <= 15):
        parser.error('port or frame rate is out of range')
    frames = json_frames(args.format, args.units) if args.mode == 'json' else model_frames(args)
    tracker = Tracker()
    opener = build_opener(ProxyHandler({}), NoRedirect())
    last_error = 0
    try:
        for frame in frames:
            try:
                if frame is None:
                    raise ValueError('invalid pose frame')
                post_frame(tracker.assign(frame), opener, args.port)
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
                now = time.monotonic()
                if now - last_error > 3:
                    reason = f'HTTP {error.code}' if isinstance(error, HTTPError) else type(error).__name__
                    print(f'Pose frame dropped ({reason}); check bridge and input.', file=sys.stderr)
                    last_error = now
    except KeyboardInterrupt:
        return 0
    except (ValueError, OSError) as error:
        print(f'Pose source stopped: {error}', file=sys.stderr)
        return 1
    finally:
        frames.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
