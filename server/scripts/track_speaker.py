"""Speaker tracking for the 9:16 reframe: Apple Vision face detection + a virtual-camera path.

Lusk crops a landscape source to 9:16 by sliding the video horizontally behind the frame.
This script finds where the subject is over one clip's time window and solves a camera
path for that slide, styled after a calm human operator: the camera HOLDS still while the
subject stays inside a dead zone and only PANS (minimum-jerk, with look-ahead) once they
have clearly moved — less motion beats more motion.

Three ways to decide who the subject is (`--mode`):

- `face`: the biggest, most confident face. Right for a solo host.
- `pick`: the person at `--subject-x`, chosen by hand. The pick seeds the track and keeps
  it on a short leash, so a blind stretch can't hop it to the neighbour.
- `speaker`: whoever is talking, judged from mouth movement on voiced audio, with hard
  CUTS between people instead of pans across the set.

Detection runs on the Apple Neural Engine via the Vision framework (pyobjc). Ported from
the sermon pipeline (track.py + speakers.py); the tunables are unchanged.

Output (`--out`): {"cropWidthFraction", "cuts", "keyframes": [{"t", "cx"}]} with `t` in
seconds from the clip start and `cx` the crop center as a fraction of the source width.
Progress goes to stdout as `PROGRESS <0-100>` lines, diagnostics to stderr.
"""

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np

# ---------------------------------------------------------------------------
# Camera tunables (units: fraction of source width, seconds)
SAMPLE_HZ = 10.0  # detection rate; the camera path is solved at SOLVE_HZ regardless
TEXT_HZ = 2.0  # on-screen text is read this often — overlays stay up for seconds
TEXT_MIN_H = 0.02  # of the frame height: smaller text is fine print, not a caption to keep
SOLVE_HZ = 50.0  # fine enough that per-frame sampling of the path stays kink-free
DETECT_WIDTH = 960  # frames are decoded at this width for detection
LANDMARK_DETECT_WIDTH = 1440  # ...and this much when lip aperture has to be read off them
OUT_ASPECT = 9 / 16  # the vertical crop
DEAD_ZONE = 0.058  # subject may drift this far from the crop center before a pan (~110 px @1920)
CONFIRM_SEC = 0.9  # subject must stay outside the dead zone this long to trigger a pan
CONFIRM_FRAC = 0.85  # ...for at least this fraction of the confirm window
REACTION_SEC = 0.35  # ...and must have already been drifting this long before the pan
# launches — a human operator reacts to movement they have seen, they don't anticipate it
REACTION_EMERGENCY_SEC = 0.15  # sudden big moves get the startle-reflex reaction instead
EXCURSION_WIN_SEC = 3.5  # brief excursions that return within this window are not followed...
EXCURSION_MIN_FRAC = 0.45  # ...unless the subject spends this fraction of it outside the zone
EMERGENCY_SPEED = 0.10  # but follow right away when the subject is outside the dead zone and
# observed moving away faster than this (width/s) — inferred from the past, not the future
MIN_HOLD_SEC = 0.6  # a completed pan is followed by at least this much stillness
PAN_SEC_BASE, PAN_SEC_PER_DIST = 0.5, 4.5  # pan duration = base + dist * per_dist
PAN_SEC_MIN, PAN_SEC_MAX = 1.1, 2.8
REPLAN_EVERY_SEC = 0.4  # while panning, re-aim at the subject's updated position
BRAKE_SEC = 0.5  # a pan never reverses direction: it brakes, holds, then pans anew
MEDIAN_WIN = 5  # samples; kills single-sample detector jumps
SCENE_THRESHOLD = 0.08  # ffmpeg scene score candidate threshold. Candidates are cheap: they
# only take effect when the subject position actually jumps across them. Low because a dark
# studio scores low — a hard cut between two angles of a podcast set measured 0.13, ordinary
# frames 0.003 (the sermon pipeline's 0.20 was tuned on a brightly lit stage)
CUT_MIN_JUMP = 0.075  # subject must jump this far across a candidate cut to accept it
FACE_MIN_CONFIDENCE = 0.3
TRACK_GATE = 0.08  # a detection this far from the running track is a different person...
TRACK_GATE_WIDEN = 0.4  # ...and the gate opens this fast (width/s) while the track is blind
TRACK_GATE_MAX = 0.5  # up to here — a speaker who crossed the set unseen is still theirs
PICKED_GATE_MAX = 0.12  # with a subject picked by hand the leash stays short instead: people
# side by side sit ~0.2 width apart, and no blind stretch may let the track hop to the next one
SPEAKER_CUT_JUMP = 0.4  # of the crop width: a new speaker nearer than this to the old one
# is already in frame, so handing them the shot is not something to cut on
KEYFRAME_EPSILON = 0.0008  # Douglas-Peucker tolerance on the emitted path

# ---------------------------------------------------------------------------
# Speaker tunables (units: fraction of frame width, normalized lip aperture, seconds)
MATCH_RADIUS = 0.05  # a face this close to a track's last position is the same person
TRACK_LOST_SEC = 3.0  # a track nothing matched for this long is closed. Generous, because
# a seated person does not leave their spot: they turn their head, put a hand over their
# mouth, look down at a note, and come back where they were. Every premature close is a
# fresh track — another chance to "switch speaker" to somebody who never moved.
MIN_TRACK_SEC = 0.8  # shorter tracks are detector noise, not people
ACTIVITY_WIN_SEC = 1.5  # mouth movement is measured over this window, centered on the
# sample — offline there is no reason to trail the way a live operator has to. Long enough
# to ride out the pauses between phrases, which is when a listener's smile can win.
MIN_VOICED_SAMPLES = 3  # a window with less speech than this judges nobody
VOICE_FLOOR_FRAC = 0.18  # voiced = envelope above this fraction of the clip's loud level
LOUD_PERCENTILE = 90  # ...which is this percentile of the envelope
MIN_MOUTH_ACTIVITY = 0.005  # aperture change per sample below this is a still mouth. Low on
# purpose: the number scales with how many pixels of lip the shot has. The margin below,
# which compares two mouths in the *same* frame, is the real test.
ACTIVITY_MARGIN = 2.2  # a challenger must beat the current speaker by this much...
SWITCH_CONFIRM_SEC = 0.9  # ...for this long, before the frame changes hands
MIN_DWELL_SEC = 2.0  # and no shot is shorter than this, whatever the mouths do
OWNER_LOST_SEC = 1.0  # the frame's owner unseen this long is gone, not pausing: their
# successor is confirmed on a startle reflex and the minimum shot is waived
LOST_CONFIRM_SEC = 0.3
# Where exactly a confirmed switch cuts. The window is centered, so a challenger "leads" up
# to half a window before they actually start — cutting there yanks the outgoing speaker
# away mid-sentence. The cut goes on the incoming mouth's first sustained movement instead:
ONSET_BACK_SEC = 0.5  # the boundary may trail the real onset this much...
ONSET_FWD_SEC = 2.0  # ...but mostly leads it, by up to half a window and change
ONSET_SPAN = 3  # consecutive samples of movement that count as "started talking"
BREATH_BACK_SEC = 0.6  # a pause ending within this of the onset is the breath before
# the line, and the cut belongs where speech resumes after it
SHOT_WIN_SEC = 0.4  # face population compared over this much either side of a scene spike
SHOT_MATCH_RADIUS = 0.08  # a face this close to one from the other side is the same person
SHOT_BIRTH_SEC = 0.5  # a track starting within this of a shot change was born by it
SHOT_SNAP_SEC = 1.5  # a switch confirmed this close to a shot change cuts exactly on it
PRESENCE_WIN_SEC = 1.0  # who counts as "on screen right now" when the owner is gone
AUDIO_RATE = 16000  # the envelope only needs speech band, so 16 kHz mono is plenty
SILENCE_FLOOR = 1e-4  # an envelope this weak at its loud percentile is digital silence
# ---------------------------------------------------------------------------

FFMPEG = "ffmpeg"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def progress(percent: float) -> None:
    print(f"PROGRESS {int(max(0, min(100, percent)))}", flush=True)


@dataclass
class Sample:
    t: float
    cx: float | None  # normalized [0..1] subject center, None = nothing detected
    kind: str  # "face" | "human" | "none"


@dataclass
class Face:
    """One face in one sampled frame, in normalized frame coordinates."""

    cx: float
    confidence: float
    # vertical inner-lip aperture as a fraction of the face's own box: comparable between
    # a face near the camera and one further away. None if landmarks failed.
    openness: float | None
    # face box height as a fraction of the frame height
    h: float = 0.0


@dataclass
class Track:
    """One person, followed across samples by position."""

    id: int
    t: list[float] = field(default_factory=list)
    cx: list[float] = field(default_factory=list)
    openness: list[float | None] = field(default_factory=list)

    @property
    def last_cx(self) -> float:
        return self.cx[-1]

    @property
    def last_t(self) -> float:
        return self.t[-1]


@dataclass
class Turn:
    """One stretch of the clip that belongs to one speaker."""

    start: float
    end: float
    track: int
    score: float = 0.0
    rival: float = 0.0


# ---------------------------------------------------------------------------
# Detection


def scene_cut_candidates(video: str, start: float, duration: float) -> list[float]:
    """Timestamps (relative to `start`) whose frame differs strongly from the previous one.

    `-t` bounds the *input*: `select` passes so few frames that an output limit is only
    noticed when one finally arrives, so ffmpeg would decode on to the next scene change
    anywhere in the episode."""
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", video,
         "-vf", f"scale=320:-2,select='gt(scene,{SCENE_THRESHOLD})',metadata=print:file=-",
         "-an", "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    )
    cuts = []
    for line in proc.stdout.splitlines():
        if "pts_time:" in line:
            cuts.append(float(line.rsplit("pts_time:", 1)[1]))
    return cuts


def lip_aperture(observation) -> float | None:
    """Vertical opening of the inner lips, as a fraction of the face's own box."""
    landmarks = observation.landmarks()
    region = landmarks.innerLips() if landmarks is not None else None
    count = region.pointCount() if region is not None else 0
    if count < 2:
        return None
    # pyobjc hands back an objc.varlist for the C point array — it has to be sliced to
    # pointCount(), because iterating it unbounded walks off the end of the buffer
    ys = [float(point.y) for point in region.normalizedPoints()[0:count]]
    return max(ys) - min(ys)


def detect_samples(video: str, width: int, height: int, start: float, duration: float,
                   seed_x: float | None = None, landmarks: bool = False,
                   ) -> tuple[list[Sample], list[list[Face]], list[list[tuple[float, float]]]]:
    """Decode frames at SAMPLE_HZ and find the main subject with the Vision framework.

    `seed_x` names the person to follow: the track starts there instead of on the biggest
    face, and keeps a short leash for the rest of the clip (`follow_pick` refines this
    across camera changes). Every face of every frame is returned too; `landmarks` swaps in
    the landmark detector so those faces carry their mouth aperture, which the speaker
    timeline needs — it also decodes wider, since a mouth is a few pixels of lip. The
    horizontal extent of every line of on-screen text is returned per frame as well (read
    at TEXT_HZ and carried between reads), for `fit_ranges`."""
    import Quartz
    import Vision

    src_ar = width / height
    w = LANDMARK_DETECT_WIDTH if landmarks else DETECT_WIDTH
    h = int(round(w / src_ar / 2) * 2)
    frame_bytes = w * h * 3
    expected = max(1, int(duration * SAMPLE_HZ))

    proc = subprocess.Popen(
        [FFMPEG, "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{duration:.3f}",
         "-vf", f"fps={SAMPLE_HZ},scale={w}:{h}",
         "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )

    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    samples: list[Sample] = []
    frames: list[list[Face]] = []
    texts: list[list[tuple[float, float]]] = []
    lines: list[tuple[float, float]] = []
    text_every = max(1, round(SAMPLE_HZ / TEXT_HZ))
    # (t, cx) of the last confident subject fix — a hand-picked subject is one already
    last: tuple[float, float] | None = None if seed_x is None else (0.0, seed_x)
    gate_max = TRACK_GATE_MAX if seed_x is None else PICKED_GATE_MAX

    index = 0
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        t = index / SAMPLE_HZ
        index += 1
        if index % 10 == 0:
            progress(5 + 85 * index / expected)

        # how far a detection may sit from the running track and still be the same
        # person; it opens while the track is blind, up to this mode's ceiling
        gate = 0.0 if last is None else min(TRACK_GATE + TRACK_GATE_WIDEN * (t - last[0]), gate_max)

        provider = Quartz.CGDataProviderCreateWithData(None, buf, frame_bytes, None)
        image = Quartz.CGImageCreate(
            w, h, 8, 24, w * 3, color_space, Quartz.kCGImageAlphaNone,
            provider, None, False, Quartz.kCGRenderingIntentDefault,
        )
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
        if landmarks:
            face_req = Vision.VNDetectFaceLandmarksRequest.alloc().init()
            face_req.setRevision_(Vision.VNDetectFaceLandmarksRequestRevision3)
        else:
            face_req = Vision.VNDetectFaceRectanglesRequest.alloc().init()
            face_req.setRevision_(Vision.VNDetectFaceRectanglesRequestRevision3)
        requests = [face_req]
        text_req = None
        if (index - 1) % text_every == 0:
            text_req = Vision.VNRecognizeTextRequest.alloc().init()
            text_req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelFast)
            text_req.setUsesLanguageCorrection_(False)
            requests.append(text_req)
        handler.performRequests_error_(requests, None)
        if text_req is not None:
            lines = []
            for r in text_req.results() or []:
                bb = r.boundingBox()
                if bb.size.height >= TEXT_MIN_H:
                    lines.append((float(bb.origin.x), float(bb.origin.x + bb.size.width)))
        texts.append(lines)

        seen: list[Face] = []
        candidates = []  # (score, cx, kind)
        results = face_req.results() or []
        for r in results:
            if r.confidence() < FACE_MIN_CONFIDENCE:
                continue
            bb = r.boundingBox()  # normalized, origin bottom-left
            cx = bb.origin.x + bb.size.width / 2
            seen.append(Face(float(cx), float(r.confidence()), lip_aperture(r) if landmarks else None,
                             float(bb.size.height)))
            score = r.confidence() * np.sqrt(bb.size.height)
            if last is not None:
                # favor the face nearest the running track, and drop the ones too far from
                # it to be the subject. A hand-picked subject holds that leash even when the
                # only face on screen is somebody else's.
                dist = abs(cx - last[1])
                if dist > gate and (seed_x is not None or len(results) > 1):
                    continue
                score -= 1.5 * dist
            candidates.append((score, cx, "face"))

        if not candidates:
            # face lost (turned away, occluded): fall back to the human-body detector
            human_req = Vision.VNDetectHumanRectanglesRequest.alloc().init()
            handler2 = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
            handler2.performRequests_error_([human_req], None)
            humans = human_req.results() or []
            for r in humans:
                if r.confidence() < FACE_MIN_CONFIDENCE:
                    continue
                bb = r.boundingBox()
                cx = bb.origin.x + bb.size.width / 2
                score = 0.5 * float(r.confidence()) * np.sqrt(bb.size.width)
                if last is not None:
                    if abs(cx - last[1]) > gate and (seed_x is not None or len(humans) > 1):
                        continue
                    score -= 1.5 * abs(cx - last[1])
                candidates.append((score, cx, "human"))

        if candidates:
            _, cx, kind = max(candidates, key=lambda c: c[0])
            samples.append(Sample(t, float(cx), kind))
            last = (t, float(cx))
        else:
            samples.append(Sample(t, None, "none"))
        frames.append(seen)

    proc.wait()
    return samples, frames, texts


def follow_pick(frames: list[list[Face]], shot_cuts: list[float], seed_x: float,
                seed_t: float) -> list[Sample]:
    """Follow the hand-picked person through the clip, across camera changes.

    The pick holds a short leash (PICKED_GATE_MAX) so a blind stretch can't hop it to the
    neighbour — but a camera change moves everybody at once: the host who sat at x=0.55 in
    the wide shot sits at x=0.37 in the close-up, and a leash alone would hold the crop on
    the empty spot. So each shot is followed on its own, starting from the one the pick was
    made in (at `seed_t`), and every neighbouring shot is re-attached to the person nearest
    to where the subject was when it ended — in a single-person shot, that person."""
    n = len(frames)
    bounds = [0.0, *shot_cuts, n / SAMPLE_HZ + 1.0]
    shots = [[i for i in range(n) if b0 <= i / SAMPLE_HZ < b1] for b0, b1 in zip(bounds, bounds[1:])]
    shots = [shot for shot in shots if shot]
    if not shots:
        return []
    home = next((k for k, shot in enumerate(shots) if shot[-1] / SAMPLE_HZ >= seed_t), len(shots) - 1)

    def nearest_person(shot: list[int], x: float) -> float:
        people = face_positions([f.cx for i in shot for f in frames[i]])
        return min(people, key=lambda p: abs(p - x)) if people else x

    def follow(shot: list[int], anchor: float, from_t: float) -> list[Sample]:
        """Leash-follow one shot, outward in time from `from_t` where the subject is `anchor`."""
        out: dict[int, Sample] = {}
        for order in (shot[::-1], shot):  # backward from the anchor, then forward
            last_t, last_x = from_t, anchor
            for i in order:
                t = i / SAMPLE_HZ
                if (order is shot) != (t >= from_t):
                    continue
                gate = min(TRACK_GATE + TRACK_GATE_WIDEN * abs(t - last_t), PICKED_GATE_MAX)
                near = [f for f in frames[i] if abs(f.cx - last_x) <= gate]
                if near:
                    face = min(near, key=lambda f: abs(f.cx - last_x))
                    out[i] = Sample(t, face.cx, "face")
                    last_t, last_x = t, face.cx
                else:
                    out[i] = Sample(t, None, "none")
        return [out[i] for i in shot]

    def edge_x(samples: list[Sample], last: bool, fallback: float) -> float:
        seen = [s.cx for s in (reversed(samples) if last else samples) if s.cx is not None]
        return seen[0] if seen else fallback

    tracked: list[list[Sample]] = [[] for _ in shots]
    home_shot = shots[home]
    seed_at = min(max(seed_t, home_shot[0] / SAMPLE_HZ), home_shot[-1] / SAMPLE_HZ)
    tracked[home] = follow(home_shot, seed_x, seed_at)
    for k in range(home + 1, len(shots)):  # later shots: from their start
        anchor = nearest_person(shots[k], edge_x(tracked[k - 1], True, seed_x))
        tracked[k] = follow(shots[k], anchor, shots[k][0] / SAMPLE_HZ)
    for k in range(home - 1, -1, -1):  # earlier shots: back from their end
        anchor = nearest_person(shots[k], edge_x(tracked[k + 1], False, seed_x))
        tracked[k] = follow(shots[k], anchor, shots[k][-1] / SAMPLE_HZ)
    return [s for shot in tracked for s in shot]


# ---------------------------------------------------------------------------
# Single-subject track cleanup and cut confirmation


def clean_track(samples: list[Sample], duration: float,
                fallback: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    """Return (t_grid, subject_x) at SOLVE_HZ: outlier-filtered and gap-interpolated."""
    obs_t = np.array([s.t for s in samples if s.cx is not None])
    obs_x = np.array([s.cx for s in samples if s.cx is not None])
    t_grid = np.arange(0.0, duration, 1.0 / SOLVE_HZ)
    if len(obs_t) == 0:
        return t_grid, np.full_like(t_grid, fallback)

    # rolling median over the observed track kills single-sample detector jumps
    if len(obs_x) >= MEDIAN_WIN:
        pad = MEDIAN_WIN // 2
        padded = np.concatenate([obs_x[:pad][::-1], obs_x, obs_x[-pad:][::-1]])
        obs_x = np.array([np.median(padded[i:i + MEDIAN_WIN]) for i in range(len(obs_x))])

    # linear interpolation across gaps; ends are held flat
    return t_grid, np.interp(t_grid, obs_t, obs_x)


def confirm_cuts(candidates: list[float], t_grid: np.ndarray, subject: np.ndarray) -> list[float]:
    """Keep only candidate cuts across which the subject position actually jumps — a
    graphic or lighting change behind the speaker scores high without any shot change."""
    cuts = []
    for c in candidates:
        before = subject[(t_grid >= c - 0.5) & (t_grid <= c - 0.04)]
        after = subject[(t_grid >= c + 0.04) & (t_grid <= c + 0.5)]
        if len(before) == 0 or len(after) == 0:
            continue
        if abs(float(np.median(after)) - float(np.median(before))) >= CUT_MIN_JUMP:
            if not cuts or c - cuts[-1] > 0.25:
                cuts.append(c)
    return cuts


# ---------------------------------------------------------------------------
# Speakers: who is talking, and when the camera should cut


def audio_envelope(video: str, start: float, duration: float, n_samples: int) -> np.ndarray | None:
    """Speech-band RMS of the soundtrack, one value per video sample; None without audio."""
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{duration:.3f}", "-vn",
         # the speech band only: room rumble and reverb are not somebody talking
         "-af", "highpass=f=180,lowpass=f=3800",
         "-ac", "1", "-ar", str(AUDIO_RATE), "-f", "f32le", "-"],
        capture_output=True, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        return None
    pcm = np.frombuffer(proc.stdout, dtype=np.float32)
    hop = AUDIO_RATE / SAMPLE_HZ
    envelope = np.zeros(n_samples)
    for i in range(n_samples):
        chunk = pcm[int(i * hop):int((i + 1) * hop)]
        if len(chunk):
            envelope[i] = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
    return envelope


def voiced_mask(envelope: np.ndarray | None, n_samples: int) -> np.ndarray:
    """Which samples have somebody speaking — all of them when there is no usable audio."""
    if envelope is None or not envelope.any():
        return np.ones(n_samples, dtype=bool)
    loud = float(np.percentile(envelope, LOUD_PERCENTILE))
    if loud < SILENCE_FLOOR:
        return np.ones(n_samples, dtype=bool)
    return envelope > VOICE_FLOOR_FRAC * loud


def face_positions(xs: list[float]) -> list[float]:
    """Cluster several samples' worth of face x's into the distinct people they show.
    A cluster seen only once is detector flicker, not a person."""
    groups: list[list[float]] = []
    for x in sorted(xs):
        if groups and x - groups[-1][-1] <= MATCH_RADIUS:
            groups[-1].append(x)
        else:
            groups.append([x])
    return [float(np.median(group)) for group in groups if len(group) >= 2]


def confirm_shot_cuts(frames: list[list[Face]], candidates: list[float]) -> list[float]:
    """Which scene-score spikes are real camera changes: the face population before the
    candidate does not survive into the one after it. This sees the whole frame, so a cut
    that swaps the *other* people on screen is still caught."""
    n = len(frames)
    win = max(2, int(round(SHOT_WIN_SEC * SAMPLE_HZ)))
    confirmed = []
    for c in candidates:
        k = int(round(c * SAMPLE_HZ))
        before = face_positions([f.cx for i in range(max(0, k - win), min(k, n)) for f in frames[i]])
        after = face_positions([f.cx for i in range(max(0, k), min(k + win, n)) for f in frames[i]])
        appeared = any(all(abs(a - b) > SHOT_MATCH_RADIUS for b in before) for a in after)
        vanished = any(all(abs(b - a) > SHOT_MATCH_RADIUS for a in after) for b in before)
        if appeared or vanished:
            confirmed.append(c)
    return confirmed


def build_tracks(frames: list[list[Face]], shot_cuts: list[float]) -> list[Track]:
    """Group per-frame faces into one track per person, by position (greedy nearest
    neighbour inside MATCH_RADIUS). A shot change orphans every live track: position means
    nothing across a camera change, and a track that straddled one would register the
    reframe itself as the mouth moving."""
    tracks: list[Track] = []
    live: list[Track] = []
    next_id = 0
    pending_cuts = sorted(shot_cuts)

    for index, faces in enumerate(frames):
        t = index / SAMPLE_HZ
        while pending_cuts and t >= pending_cuts[0]:
            live = []
            pending_cuts.pop(0)
        live = [tr for tr in live if t - tr.last_t <= TRACK_LOST_SEC]
        pairs = sorted(
            (abs(f.cx - tr.last_cx), fi, ti) for fi, f in enumerate(faces)
            for ti, tr in enumerate(live) if abs(f.cx - tr.last_cx) <= MATCH_RADIUS
        )
        taken_faces: set[int] = set()
        taken_tracks: set[int] = set()
        for _, fi, ti in pairs:
            if fi in taken_faces or ti in taken_tracks:
                continue
            taken_faces.add(fi)
            taken_tracks.add(ti)
            face, track = faces[fi], live[ti]
            track.t.append(t)
            track.cx.append(face.cx)
            track.openness.append(face.openness)
        for fi, face in enumerate(faces):
            if fi in taken_faces:
                continue
            track = Track(id=next_id)
            next_id += 1
            track.t.append(t)
            track.cx.append(face.cx)
            track.openness.append(face.openness)
            tracks.append(track)
            live.append(track)

    return [tr for tr in tracks if len(tr.t) >= MIN_TRACK_SEC * SAMPLE_HZ]


def mouth_activity(track: Track, n_samples: int) -> np.ndarray:
    """Per-sample |change in mouth aperture|, NaN where the person was not seen. Only
    measured between consecutive observations: across a gap the mouth may have done anything."""
    out = np.full(n_samples, np.nan)
    step = 1.0 / SAMPLE_HZ
    for i in range(1, len(track.t)):
        prev, now = track.openness[i - 1], track.openness[i]
        if prev is None or now is None or track.t[i] - track.t[i - 1] > 1.5 * step:
            continue
        index = int(round(track.t[i] * SAMPLE_HZ))
        if 0 <= index < n_samples:
            out[index] = abs(now - prev)
    return out


def track_positions(track: Track, n_samples: int) -> np.ndarray:
    """The track's x at every sample: interpolated over gaps, held flat past the ends."""
    grid = np.arange(n_samples) / SAMPLE_HZ
    return np.interp(grid, np.array(track.t), np.array(track.cx))


def refine_cut(track: Track, activity: np.ndarray, voiced: np.ndarray, voiced_wide: np.ndarray,
               guess: float, floor: float, shot_cuts: list[float]) -> float:
    """Where the incoming speaker actually starts — the editor's cut point. On the incoming
    mouth's first sustained movement near `guess` (after the breath before the line, when
    there is one), never before their face has been seen; or exactly on a shot change that
    brought them on screen, so the crop's jump hides inside the source's own cut."""
    born = track.t[0]
    snaps = [c for c in shot_cuts
             if abs(c - guess) <= SHOT_SNAP_SEC and 0.0 <= born - c <= SHOT_BIRTH_SEC and c >= floor]
    if snaps:
        return min(snaps, key=lambda c: abs(c - guess))

    n = len(voiced)
    moving = np.nan_to_num(activity)
    lo = max(0, int(np.ceil(floor * SAMPLE_HZ)), int(round((guess - ONSET_BACK_SEC) * SAMPLE_HZ)))
    hi = min(n - ONSET_SPAN, int(round((guess + ONSET_FWD_SEC) * SAMPLE_HZ)))
    cut = guess
    for k in range(lo, hi + 1):
        if (float(np.mean(moving[k:k + ONSET_SPAN])) >= MIN_MOUTH_ACTIVITY
                and bool(voiced_wide[k:k + ONSET_SPAN].any())):
            back = max(0, k - int(round(BREATH_BACK_SEC * SAMPLE_HZ)))
            quiet = [j for j in range(back, k) if not voiced[j]]
            cut = (quiet[-1] + 1) / SAMPLE_HZ if quiet else k / SAMPLE_HZ
            break
    return max(cut, floor, track.t[0])


def speaker_timeline(tracks: list[Track], envelope: np.ndarray | None, n_samples: int,
                     shot_cuts: list[float]) -> list[Turn]:
    """Split the clip into turns: which track owns the frame, from when to when.

    The loudest mouth on voiced samples wins each window; hysteresis keeps the frame — a
    challenger must lead by ACTIVITY_MARGIN for SWITCH_CONFIRM_SEC, and no shot is shorter
    than MIN_DWELL_SEC — so back-channel "mhm"s come to nothing."""
    if not tracks:
        return []
    duration = n_samples / SAMPLE_HZ
    if len(tracks) == 1:
        return [Turn(0.0, duration, tracks[0].id)]

    voiced = voiced_mask(envelope, n_samples)
    # movement measured *into* a sample happened during the previous bin, so speech in
    # either bin makes it attributable to talking — matters right at onsets
    voiced_wide = voiced.copy()
    voiced_wide[1:] |= voiced[:-1]
    activity = {tr.id: mouth_activity(tr, n_samples) for tr in tracks}
    by_id = {tr.id: tr for tr in tracks}
    half = max(1, int(round(ACTIVITY_WIN_SEC * SAMPLE_HZ / 2)))

    # when each track was last actually observed, per sample — a dead track's owner must
    # not keep the frame on the strength of nobody outscoring a corpse
    last_seen: dict[int, np.ndarray] = {}
    obs_cum: dict[int, np.ndarray] = {}
    for track in tracks:
        seen_at = np.full(n_samples, -np.inf)
        idx = np.clip(np.round(np.asarray(track.t) * SAMPLE_HZ).astype(int), 0, n_samples - 1)
        seen_at[idx] = np.asarray(track.t)
        last_seen[track.id] = np.maximum.accumulate(seen_at)
        seen = np.zeros(n_samples + 1)
        seen[idx + 1] = 1.0
        obs_cum[track.id] = np.cumsum(seen)

    presence_win = max(1, int(round(PRESENCE_WIN_SEC * SAMPLE_HZ)))

    def most_present(i: int) -> int | None:
        """The face most reliably on screen right now — a reaction shot has a subject too."""
        lo = max(0, i + 1 - presence_win)
        count, best_track = max(
            (float(obs_cum[tr.id][i + 1] - obs_cum[tr.id][lo]), tr.id) for tr in tracks
        )
        return best_track if count >= MIN_VOICED_SAMPLES else None

    def window_scores(i: int) -> dict[int, float]:
        """Each face's mouth movement around sample `i`, counted only where somebody is
        audibly speaking — a listener who nods or laughs in a pause contributes nothing."""
        lo, hi = max(0, i - half), min(n_samples, i + half + 1)
        window_voiced = voiced_wide[lo:hi]
        if int(window_voiced.sum()) < MIN_VOICED_SAMPLES:
            return {}
        scores = {}
        for track_id, series in activity.items():
            samples = series[lo:hi][window_voiced]
            samples = samples[~np.isnan(samples)]
            if len(samples) >= MIN_VOICED_SAMPLES:
                scores[track_id] = float(np.mean(samples))
        return scores

    turns: list[Turn] = []
    current: int | None = None
    turn_start, turn_score, turn_rival = 0.0, 0.0, 0.0
    challenger: int | None = None
    challenger_since = 0.0
    ordered_cuts = sorted(shot_cuts)
    last_shot_cut = -np.inf
    cut_index = 0

    for i in range(n_samples):
        t = i / SAMPLE_HZ
        while cut_index < len(ordered_cuts) and ordered_cuts[cut_index] <= t:
            last_shot_cut = ordered_cuts[cut_index]
            cut_index += 1
        scores = window_scores(i)
        best_id: int | None = None
        best = 0.0
        if scores:
            best_id, best = max(scores.items(), key=lambda item: item[1])
        if best < MIN_MOUTH_ACTIVITY:
            best_id, best = None, 0.0  # nobody's mouth is really moving
        if current is None:
            if best_id is not None:
                current, turn_start, turn_score = best_id, 0.0, best
                challenger = None
            continue
        held = scores.get(current, 0.0)
        owner_gone = t - float(last_seen[current][i]) > OWNER_LOST_SEC
        # ...but only a shot change since they were last seen proves they are OUT, not
        # just momentarily undetected
        owner_out_of_shot = owner_gone and float(last_seen[current][i]) < last_shot_cut
        if best_id is not None and best_id != current and best >= ACTIVITY_MARGIN * held:
            contender = best_id  # someone else is clearly the one talking
        elif best_id is None and owner_out_of_shot:
            contender = most_present(i)  # nobody talks, owner gone: show who's there
            if contender == current:
                contender = None
        else:
            contender = None
        if contender is None:
            challenger = None
            continue
        if challenger != contender:
            challenger, challenger_since = contender, t
            continue
        confirm = LOST_CONFIRM_SEC if owner_gone else SWITCH_CONFIRM_SEC
        if t - challenger_since >= confirm and (owner_gone or t - turn_start >= MIN_DWELL_SEC):
            floor = turn_start + (LOST_CONFIRM_SEC if owner_gone else MIN_DWELL_SEC)
            cut_at = refine_cut(by_id[contender], activity[contender], voiced, voiced_wide,
                                challenger_since, floor, shot_cuts)
            turns.append(Turn(turn_start, cut_at, current, turn_score, turn_rival))
            current, turn_start, challenger = contender, cut_at, None
            turn_score, turn_rival = scores.get(contender, 0.0), held

    if current is not None:
        turns.append(Turn(turn_start, duration, current, turn_score, turn_rival))
    return turns


def subject_path(turns: list[Turn], tracks: list[Track], t_grid: np.ndarray, n_samples: int,
                 min_jump: float) -> tuple[np.ndarray, list[float]]:
    """The subject position over time, stepping at each turn, plus the cut times. A turn
    boundary only becomes a cut when the frame actually has to move `min_jump`: a face lost
    for a moment comes back as a new track, and that handoff must not cut in place."""
    if not turns:
        return np.full_like(t_grid, 0.5), []
    by_id = {tr.id: track_positions(tr, n_samples) for tr in tracks}
    subject = np.full_like(t_grid, 0.5)
    for turn in turns:
        span = (t_grid >= turn.start) & (t_grid < turn.end)
        if not span.any():
            continue
        positions = by_id[turn.track]
        indices = np.clip(np.round(t_grid[span] * SAMPLE_HZ).astype(int), 0, n_samples - 1)
        subject[span] = positions[indices]

    cuts = []
    for turn in turns[1:]:
        i = int(np.searchsorted(t_grid, turn.start))
        if 0 < i < len(subject) and abs(subject[i] - subject[i - 1]) > min_jump:
            cuts.append(turn.start)
    return subject, cuts


def merge_cuts(*sources: list[float], min_gap: float = 0.25) -> list[float]:
    """One sorted cut list, with cuts closer together than `min_gap` collapsed."""
    merged: list[float] = []
    for cut in sorted(c for source in sources for c in source):
        if not merged or cut - merged[-1] > min_gap:
            merged.append(cut)
    return merged


def speaker_track(video: str, frames: list[list[Face]], span: float, start: float,
                  duration: float, min_jump: float, cut_candidates: list[float],
                  ) -> tuple[np.ndarray, np.ndarray, list[float]]:
    """Turn per-frame faces into a subject path that steps between speakers."""
    t_grid = np.arange(0.0, span, 1.0 / SOLVE_HZ)
    n = len(frames)

    shot_cuts = confirm_shot_cuts(frames, cut_candidates)
    if cut_candidates:
        log(f"shot changes: {len(shot_cuts)} confirmed of {len(cut_candidates)} scene candidates")

    tracks = build_tracks(frames, shot_cuts)
    if not tracks:
        log("no faces to attribute speech to — holding the crop centered")
        return t_grid, np.full_like(t_grid, 0.5), []

    envelope = audio_envelope(video, start, duration, n)
    if envelope is None:
        log("no audio on this clip — judging mouths alone, which is far less certain")
    turns = speaker_timeline(tracks, envelope, n, shot_cuts)
    subject, turn_cuts = subject_path(turns, tracks, t_grid, n, min_jump)

    where = {tr.id: float(np.median(tr.cx)) for tr in tracks}
    log(f"{len(tracks)} faces tracked ({', '.join(f'x={x:.2f}' for x in where.values())})")
    log(f"{len(turns)} speaker turns, {len(turn_cuts)} of them a cut")
    return t_grid, subject, merge_cuts(shot_cuts, turn_cuts)


# ---------------------------------------------------------------------------
# Virtual camera


def quintic(x0: float, v0: float, a0: float, x1: float, T: float) -> np.ndarray:
    """Minimum-jerk polynomial coefficients from (x0, v0, a0) to (x1, v=0, a=0) in T seconds."""
    d = x1 - x0 - v0 * T - 0.5 * a0 * T * T
    T2, T3, T4, T5 = T * T, T ** 3, T ** 4, T ** 5
    A = np.array([
        [T3, T4, T5],
        [3 * T2, 4 * T3, 5 * T4],
        [6 * T, 12 * T2, 20 * T3],
    ])
    b = np.array([d, -v0 - a0 * T, -a0])
    c3, c4, c5 = np.linalg.solve(A, b)
    return np.array([x0, v0, a0 / 2, c3, c4, c5])


def poly_eval(c: np.ndarray, t: float) -> tuple[float, float, float]:
    x = c[0] + c[1] * t + c[2] * t**2 + c[3] * t**3 + c[4] * t**4 + c[5] * t**5
    v = c[1] + 2 * c[2] * t + 3 * c[3] * t**2 + 4 * c[4] * t**3 + 5 * c[5] * t**4
    a = 2 * c[2] + 6 * c[3] * t + 12 * c[4] * t**2 + 20 * c[5] * t**3
    return float(x), float(v), float(a)


def solve_camera(t_grid: np.ndarray, subject: np.ndarray, cuts: list[float],
                 crop_half: float) -> np.ndarray:
    """The virtual operator: hold while the subject is inside the dead zone, pan smoothly
    (with look-ahead, re-aiming mid-pan) once they have clearly left it. Each cut starts a
    fresh segment, so the camera steps there instead of travelling."""
    lo, hi = crop_half, 1.0 - crop_half
    clamp = lambda x: float(np.clip(x, lo, hi))
    dt = 1.0 / SOLVE_HZ
    pan_sec = lambda dist: float(np.clip(PAN_SEC_BASE + PAN_SEC_PER_DIST * dist, PAN_SEC_MIN, PAN_SEC_MAX))
    confirm_n = max(1, int(round(CONFIRM_SEC * SOLVE_HZ)))
    excursion_n = max(1, int(round(EXCURSION_WIN_SEC * SOLVE_HZ)))
    react_n = max(1, int(round(REACTION_SEC * SOLVE_HZ)))
    react_fast_n = max(1, int(round(REACTION_EMERGENCY_SEC * SOLVE_HZ)))
    camera = np.empty_like(subject)

    bounds = [0.0, *cuts, t_grid[-1] + dt]
    for b0, b1 in zip(bounds, bounds[1:]):
        seg = np.where((t_grid >= b0) & (t_grid < b1))[0]
        if len(seg) == 0:
            continue
        s = subject[seg]
        n = len(seg)

        x = clamp(float(np.median(s[: min(n, int(1.0 * SOLVE_HZ))])))
        v = a = 0.0
        panning = False
        poly, tau, pan_T, target = None, 0.0, 0.0, x
        since_replan, hold_for = 0.0, 0.0

        def pan_target(k: int) -> float:
            """Aim where the subject will settle once a pan launched at step k lands."""
            rough_T = pan_sec(abs(s[min(k + confirm_n, n - 1)] - x))
            arrive = min(k + int(rough_T * SOLVE_HZ), n - 1)
            look = s[max(0, arrive - int(0.2 * SOLVE_HZ)): min(n, arrive + int(1.2 * SOLVE_HZ) + 1)]
            return clamp(float(np.median(look)))

        for k in range(n):
            if not panning:
                hold_for += dt
                win = s[k: min(k + confirm_n, n)]
                frac_out = float(np.mean(np.abs(win - x) > DEAD_ZONE))
                # brief excursions that come right back are ignored; the long window decides
                frac_out_long = float(np.mean(np.abs(s[k: min(k + excursion_n, n)] - x) > DEAD_ZONE))
                settled = frac_out >= CONFIRM_FRAC and frac_out_long >= EXCURSION_MIN_FRAC
                # outside the zone and visibly moving away -> chase now
                v_obs = (s[k] - s[k - react_fast_n]) / REACTION_EMERGENCY_SEC if k >= react_fast_n else 0.0
                emergency = abs(s[k] - x) > DEAD_ZONE and v_obs * np.sign(s[k] - x) > EMERGENCY_SPEED

                # the drift must have been visible for a moment already: pans react, never anticipate
                def seen_for(steps: int) -> bool:
                    recent = s[max(0, k - steps): k + 1]
                    return k >= steps and float(np.mean(np.abs(recent - x) > 0.6 * DEAD_ZONE)) >= 0.7

                ready = (settled and seen_for(react_n)) or (emergency and seen_for(react_fast_n))
                if hold_for >= MIN_HOLD_SEC and abs(s[k] - x) > 0.6 * DEAD_ZONE and ready:
                    target = pan_target(k)
                    if abs(target - x) > 0.4 * DEAD_ZONE:
                        # catch-up whips are brisker: the subject is escaping the frame
                        pan_T = pan_sec(abs(target - x)) * (0.72 if emergency else 1.0)
                        poly = quintic(x, v, a, target, pan_T)
                        tau, since_replan, panning = 0.0, 0.0, True
            else:
                tau += dt
                since_replan += dt
                if since_replan >= REPLAN_EVERY_SEC and pan_T - tau > 0.35:
                    fresh = pan_target(k)
                    if abs(fresh - target) > 0.75 * DEAD_ZONE:
                        # distance to the fresh target measured along the direction of travel
                        ahead = (fresh - x) * np.sign(v) if v else abs(fresh - x)
                        if abs(v) > 0.03 and ahead < abs(v) * 0.3:
                            # target now behind us: never whip back mid-pan — brake, hold, pan anew
                            stop = clamp(x + v * BRAKE_SEC * 0.35)
                            poly, target, pan_T, tau = quintic(x, v, a, stop, BRAKE_SEC), stop, BRAKE_SEC, dt
                        else:
                            remaining = max(pan_T - tau, 0.8 * pan_sec(abs(fresh - x)))
                            poly, target, pan_T, tau = quintic(x, v, a, fresh, remaining), fresh, remaining, dt
                    since_replan = 0.0
                if tau >= pan_T:
                    x, v, a, panning, hold_for = target, 0.0, 0.0, False, 0.0
                else:
                    x, v, a = poly_eval(poly, tau)
                    x = clamp(x)
            camera[seg[k]] = x

    return camera


FIT_MIN_SEC = 1.0  # nobody on screen for this long is a graphic (title card, diagram, quote)...
FIT_MERGE_SEC = 2.0  # ...two such stretches this close together are one graphic: a crop
# flashing up for a moment between them (a title Vision reads in pieces on some frames) is jumpy
FIT_SNAP_SEC = 0.6  # a graphic's edge within this of a scene change starts/ends exactly on it
FIT_TEXT_MIN_LINES = 3  # this many lines of text the crop cuts make a frame a graphic
FIT_TEXT_THROUGH_LINES = 2  # ... or this many when one is cut mid-word (E04's two-line chapter title)
TEXT_WHOLE = 0.97  # a line this much inside the crop counts as whole (Vision's boxes are loose)
TEXT_EDGE = 0.03  # ... and this little inside as wholly outside, not truncated
FIT_WINDOW_PAD = 0.03  # room left around the text and faces a fitted window has to show
FIT_WINDOW_FULL = 0.85  # a window this wide (of the frame width) is shown as the whole frame
FIT_FACE_MIN_H = 0.1  # smaller faces (of the frame height) are pictures, not people: the
# faces in E60's icon painting measured 0.07, the host 0.19+ even in E67's wide shot


def text_cut_off(lines: list[tuple[float, float]], center: float, crop_w: float) -> tuple[int, int]:
    """Text lines the crop centered at `center` would cut: (all of them — mostly or wholly
    outside it, or truncated; just the truncated ones — the crop edge runs through them)."""
    lo, hi = center - crop_w / 2, center + crop_w / 2
    cut = through = 0
    for a, b in lines:
        inside = max(0.0, min(b, hi) - max(a, lo)) / max(b - a, 1e-6)
        if inside < TEXT_WHOLE:
            cut += 1
            through += inside > TEXT_EDGE
    return cut, through


def text_is_graphic(lines: list[tuple[float, float]], center: float, crop_w: float) -> bool:
    cut, through = text_cut_off(lines, center, crop_w)
    return cut >= (FIT_TEXT_MIN_LINES if through == 0 else FIT_TEXT_THROUGH_LINES)


def fit_ranges(samples: list[Sample], frames: list[list[Face]],
               texts: list[list[tuple[float, float]]], centers: np.ndarray, crop_w: float,
               cut_candidates: list[float], span: float) -> list[list[float]]:
    """Stretches with nobody on screen — burned-in graphics, which a 9:16 crop of a 16:9
    frame cuts to an unreadable strip (E60's diagrams and quote cards). The composition
    shows these whole, fitted to the frame width over a blurred fill, instead of cropped.

    Judged on faces only, of anybody (so a pick that isn't on screen isn't a graphic):
    the body detector fires on the figures in an icon or a photo on a quote card. Every
    faceless stretch of a second or more measured on E60/E64/E67 was a graphic (verse
    and quote cards, diagrams, the logo bumper); the face detector does not lose a host
    who looks down at their notes for that long.

    Burned-in text beside the speaker counts too: E03's Bible verses run down the right
    third while the host talks, and the crop kept him and cut the verse off. Several lines
    the crop would cut make it a graphic, and so do two when the crop truncates one mid-word
    (E04's big two-line chapter title, cut off at the crop edge under the captions); a single
    line (a chapter label held for minutes, a name tag) doesn't.

    A stretch where the speaker stays on screen beside the text is fitted only as wide as
    the two need: `[start, end, x0, x1]`, the part of the frame width shown. Fitted to the
    whole width, E04's and E14's numbered tips in the corner left a 1080x608 strip for an
    entire short; the window around tip and host is nearly square. `[start, end]` shows
    the whole width."""
    empty = [not any(f.h >= FIT_FACE_MIN_H for f in frames[i])
             or text_is_graphic(texts[i], float(centers[i]), crop_w)
             for i in range(len(samples))]
    runs: list[list[float]] = []
    i = 0
    while i < len(empty):
        if not empty[i]:
            i += 1
            continue
        j = i
        while j < len(empty) and empty[j]:
            j += 1
        start, end = i / SAMPLE_HZ, min(span, j / SAMPLE_HZ)
        if runs and start - runs[-1][1] <= FIT_MERGE_SEC:
            runs[-1][1] = end
        else:
            runs.append([start, end])
        i = j

    def snap(t: float) -> float:
        near = [c for c in cut_candidates if abs(c - t) <= FIT_SNAP_SEC]
        return min(near, key=lambda c: abs(c - t)) if near else t

    out = []
    for start, end in runs:
        if end - start < FIT_MIN_SEC:
            continue
        a = 0.0 if start < 1.0 / SAMPLE_HZ else snap(start)
        b = span if end >= span - 1.0 / SAMPLE_HZ else snap(end)
        if b - a >= FIT_MIN_SEC:
            window = fit_window(frames, texts, round(start * SAMPLE_HZ), min(len(frames), round(end * SAMPLE_HZ)), crop_w)
            out.append([round(a, 3), round(b, 3), *(round(x, 3) for x in window or [])])
    return out


def fit_window(frames: list[list[Face]], texts: list[list[tuple[float, float]]],
               i0: int, i1: int, crop_w: float) -> tuple[float, float] | None:
    """The part of the frame width (x0, x1) a fitted stretch needs: its text and the
    people beside it. None for the whole width: someone is missing for part of it (a
    graphic on its own), or text and people span most of the frame anyway."""
    face_w = crop_w / OUT_ASPECT  # a face box is about as wide as tall: height/width of the frame
    lo, hi = 1.0, 0.0
    for i in range(i0, i1):
        faces = [f for f in frames[i] if f.h >= FIT_FACE_MIN_H]
        if not faces:
            return None
        for f in faces:
            lo, hi = min(lo, f.cx - f.h * face_w), max(hi, f.cx + f.h * face_w)
        for a, b in texts[i]:
            lo, hi = min(lo, a), max(hi, b)
    if hi <= lo:
        return None
    lo, hi = max(0.0, lo - FIT_WINDOW_PAD), min(1.0, hi + FIT_WINDOW_PAD)
    if hi - lo < crop_w:  # never narrower than the crop itself
        mid = min(1 - crop_w / 2, max(crop_w / 2, (lo + hi) / 2))
        lo, hi = mid - crop_w / 2, mid + crop_w / 2
    return None if hi - lo >= FIT_WINDOW_FULL else (lo, hi)


CUT_LEAD_SEC = 0.02  # a step lands this far before the cut — half a frame at 25 fps. The
# cut time is the pts of the new shot's first frame; the clip's own frame grid is offset
# from the source's by up to half a frame (its start is snapped to a frame), so stepping
# at the midpoint between the last old frame and the first new one is the robust choice.


def thin_keyframes(t_grid: np.ndarray, camera: np.ndarray, cuts: list[float]) -> list[dict]:
    """Douglas-Peucker per segment; a cut becomes two keyframes 1 ms apart (a step)."""

    def douglas_peucker(ts: np.ndarray, xs: np.ndarray) -> list[int]:
        keep = np.zeros(len(ts), dtype=bool)
        keep[0] = keep[-1] = True
        stack = [(0, len(ts) - 1)]
        while stack:
            i0, i1 = stack.pop()
            if i1 <= i0 + 1:
                continue
            span = ts[i1] - ts[i0] or 1.0
            interp = xs[i0] + (xs[i1] - xs[i0]) * (ts[i0 + 1:i1] - ts[i0]) / span
            dev = np.abs(xs[i0 + 1:i1] - interp)
            worst = int(np.argmax(dev))
            if dev[worst] > KEYFRAME_EPSILON:
                mid = i0 + 1 + worst
                keep[mid] = True
                stack.extend([(i0, mid), (mid, i1)])
        return list(np.where(keep)[0])

    keyframes: list[dict] = []
    bounds = [0.0, *cuts, float(t_grid[-1]) + 1.0]
    for b0, b1 in zip(bounds, bounds[1:]):
        seg = np.where((t_grid >= b0) & (t_grid < b1))[0]
        if len(seg) == 0:
            continue
        ts, xs = t_grid[seg], camera[seg]
        kept = douglas_peucker(ts, xs)
        if keyframes:
            # hold the outgoing position right up to the cut, then step — rather than
            # sliding across the gap between the two segments' solver samples. The old
            # segment's last samples may sit inside the lead; the hold replaces them.
            step = b0 - CUT_LEAD_SEC
            outgoing = keyframes[-1]["cx"]
            while len(keyframes) > 1 and keyframes[-1]["t"] >= step - 0.001:
                keyframes.pop()
            step = max(step, keyframes[-1]["t"] + 0.002)
            keyframes.append({"t": round(step - 0.001, 3), "cx": outgoing})
            keyframes.append({"t": round(step, 3), "cx": round(float(xs[0]), 5)})
            kept = kept[1:]
        for i in kept:
            keyframes.append({"t": round(float(ts[i]), 3), "cx": round(float(xs[i]), 5)})
    return keyframes


# ---------------------------------------------------------------------------
# Entry point


def main() -> None:
    global FFMPEG

    parser = argparse.ArgumentParser(description="Speaker tracking for the 9:16 reframe")
    parser.add_argument("--video", required=True)
    parser.add_argument("--start", type=float, required=True, help="clip start, seconds")
    parser.add_argument("--duration", type=float, required=True, help="clip length, seconds")
    parser.add_argument("--width", type=int, required=True, help="source pixel width")
    parser.add_argument("--height", type=int, required=True, help="source pixel height")
    parser.add_argument("--mode", choices=["face", "pick", "speaker"], required=True)
    parser.add_argument("--subject-x", type=float, help="normalized x of the person to follow (pick)")
    parser.add_argument("--subject-t", type=float, default=0.0,
                        help="seconds into the clip at which the person was picked")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    FFMPEG = args.ffmpeg

    if args.mode == "pick" and args.subject_x is None:
        parser.error("--mode pick needs --subject-x")
    subject_x = args.subject_x if args.mode == "pick" else None
    follow_speaker = args.mode == "speaker"

    progress(0)
    cut_candidates = scene_cut_candidates(args.video, args.start, args.duration)
    progress(5)
    samples, frames, texts = detect_samples(args.video, args.width, args.height, args.start, args.duration,
                                     seed_x=subject_x, landmarks=follow_speaker)
    raw_samples = list(samples)
    detected = sum(1 for s in samples if s.kind != "none")
    faces = sum(1 for s in samples if s.kind == "face")
    log(f"detections: {detected}/{len(samples)} samples ({faces} face, {detected - faces} body)")
    progress(90)

    # the decoded span, not the requested one: a clip may run past the end of the source
    span = len(samples) / SAMPLE_HZ if samples else args.duration
    span = max(span, 1.0 / SOLVE_HZ)
    # crop width as a fraction of source width (0.316 for 16:9 -> 9:16)
    crop_w = min(1.0, OUT_ASPECT * args.height / args.width)

    if follow_speaker:
        t_grid, subject, cuts = speaker_track(args.video, frames, span, args.start, args.duration,
                                              min_jump=SPEAKER_CUT_JUMP * crop_w,
                                              cut_candidates=cut_candidates)
    else:
        if subject_x is not None:
            shot_cuts = confirm_shot_cuts(frames, cut_candidates)
            samples = follow_pick(frames, shot_cuts, subject_x, args.subject_t)
            log(f"pick: followed across {len(shot_cuts)} camera change(s)")
        t_grid, subject = clean_track(samples, span,
                                      fallback=subject_x if subject_x is not None else 0.5)
        cuts = confirm_cuts(cut_candidates, t_grid, subject)
        if cut_candidates:
            log(f"cuts: {len(cuts)} confirmed of {len(cut_candidates)} scene-change candidates")

    camera = solve_camera(t_grid, subject, cuts, crop_half=crop_w / 2)
    keyframes = thin_keyframes(t_grid, camera, cuts)
    log(f"emitted {len(keyframes)} keyframes, {len(cuts)} cuts")

    with open(args.out, "w", encoding="utf-8") as f:
        centers = np.interp(np.arange(len(raw_samples)) / SAMPLE_HZ, t_grid, camera)
        fit = fit_ranges(raw_samples, frames, texts, centers, crop_w, cut_candidates, span)
        if fit:
            log(f"graphics shown whole: {', '.join(f'{r[0]:.1f}-{r[1]:.1f}s' + (f' (x {r[2]:.2f}-{r[3]:.2f})' if len(r) > 2 else '') for r in fit)}")
        json.dump({
            "fit": fit,
            "cropWidthFraction": round(crop_w, 6),
            "cuts": [round(c, 3) for c in cuts],
            "keyframes": keyframes,
        }, f)
    progress(100)


if __name__ == "__main__":
    main()
