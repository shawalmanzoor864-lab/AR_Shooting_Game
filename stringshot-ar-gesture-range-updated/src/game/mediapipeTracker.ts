import {
  FilesetResolver,
  HandLandmarker,
  NormalizedLandmark,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import { HandGestureState } from './types';

type Vision = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

interface RecoilSample {
  t: number;
  knuckleY: number; // screen px (average of the four finger-base knuckles)
  wristY: number; // screen px
  unit: number; // screen px of ~9.5 cm of real hand (a "palm unit")
}

const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Hand detection runs ~24 times per second; the gun / hand are smoothed every rendered frame.
const MIN_DETECT_INTERVAL_MS = 42;
const POSE_INTERVAL_MS = 140;

// Recoil gesture tuning, measured in "palm units" (about 9.5 cm of real hand) so it works at any distance
const RECOIL_MIN_RISE = 0.28; // the hand must snap up at least this far ...
const RECOIL_MAX_RISE = 1.7; // ... but a huge arm lift is not a recoil
const RECOIL_MIN_VELOCITY = 2.4; // ... faster than this many units per second ...
const RECOIL_MAX_PRE_SPEED = 1.8; // ... after being fairly steady just before
const RECOIL_COOLDOWN_MS = 420;
const RECOIL_MIN_STABLE_FRAMES = 6; // hand must be tracked this many detections before it can fire

interface P2 {
  x: number;
  y: number;
}
interface V3 {
  x: number;
  y: number;
  z: number;
}

const dist2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len3 = (a: V3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => {
  const l = len3(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

type DetectOptions = { mirrored: boolean; checkFeet: boolean; screenW: number; screenH: number };

export class MediaPipeGestureTracker {
  private handLandmarker: HandLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private poseLoading = false;
  private vision: Vision | null = null;
  private ready = false;
  private loading = false;
  private error: string | null = null;

  private lastVideoTime = -1;
  private lastDetectMs = 0;
  private lastCallMs = 0;
  private lastPoseTime = 0;

  // Hand presence (ANY hand, ANY gesture)
  private handLostStreak = 99;
  private handPresentStreak = 0;
  private handLocked = false;
  private rightScore = 0;

  // Raw targets (updated at detection rate) ...
  private tgtHandX = 0.55;
  private tgtHandY = 0.65;
  private tgtAimX = 0.5;
  private tgtAimY = 0.45;
  private tgtScale = 1.8;
  private tgtRoll = 0;
  private tgtUp: V3 = { x: 0, y: 1, z: 0 };
  private tgtFwd: V3 = { x: 0, y: 0, z: -1 };
  private displayRight = true;

  // ... and smoothed values (stepped every rendered frame)
  private smoothHandX = 0.55;
  private smoothHandY = 0.65;
  private smoothAimX = 0.5;
  private smoothAimY = 0.45;
  private smoothScale = 1.8;
  private smoothRoll = 0;
  private smoothUp: V3 = { x: 0, y: 1, z: 0 };
  private smoothFwd: V3 = { x: 0, y: 0, z: -1 };

  private stability = 0.5;
  private fwdHistory: V3[] = [];
  private recoilBuffer: RecoilSample[] = [];
  private lastRecoilFireMs = 0;
  private recoilArmed = true;
  private calmFrames = 0;
  private recoilEnergy = 0;
  private pendingRecoil = false;
  private cachedFeet: P2[] = [];

  public async init(): Promise<void> {
    if (this.ready || this.loading) return;
    this.loading = true;
    this.error = null;

    try {
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      this.vision = vision;

      const baseOptions = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
        runningMode: 'VIDEO' as const,
        numHands: 1,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });

      try {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, baseOptions('GPU'));
      } catch {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, baseOptions('CPU'));
      }

      this.ready = true;
    } catch (err) {
      this.error =
        err instanceof Error ? err.message : 'Unable to initialize MediaPipe hand tracking';
    } finally {
      this.loading = false;
    }
  }

  // The (heavy) pose model is only needed when looking down at the feet, so load it lazily.
  private ensurePose() {
    if (this.poseLandmarker || this.poseLoading || !this.vision) return;
    this.poseLoading = true;
    PoseLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
    })
      .then((pose) => {
        this.poseLandmarker = pose;
      })
      .catch(() => {
        // Continue with motion-sensor boundary tracking if the pose model is unavailable
      })
      .finally(() => {
        this.poseLoading = false;
      });
  }

  public isReady(): boolean {
    return this.ready;
  }

  public getError(): string | null {
    return this.error;
  }

  public processVideoFrame(
    video: HTMLVideoElement,
    nowMs: number,
    options: DetectOptions,
  ): HandGestureState {
    const dt = clamp((nowMs - (this.lastCallMs || nowMs - 16)) / 1000, 0.001, 0.1);
    this.lastCallMs = nowMs;

    if (
      this.ready &&
      this.handLandmarker &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.currentTime !== this.lastVideoTime &&
      nowMs - this.lastDetectMs >= MIN_DETECT_INTERVAL_MS
    ) {
      this.lastVideoTime = video.currentTime;
      this.lastDetectMs = nowMs;
      try {
        this.detect(video, nowMs, options);
      } catch {
        // Ignore a transient bad frame
      }
    }

    if (!options.checkFeet) this.cachedFeet = [];
    this.stepSmoothing(dt);
    return this.buildState(options.checkFeet);
  }

  private detect(video: HTMLVideoElement, nowMs: number, options: DetectOptions) {
    // Optional foot detection when the phone points down at the floor
    if (options.checkFeet) {
      this.ensurePose();
      if (this.poseLandmarker && nowMs - this.lastPoseTime > POSE_INTERVAL_MS) {
        this.lastPoseTime = nowMs;
        try {
          const poseRes = this.poseLandmarker.detectForVideo(video, nowMs);
          const pts: P2[] = [];
          if (poseRes.landmarks && poseRes.landmarks.length > 0) {
            const lm = poseRes.landmarks[0];
            for (const idx of [27, 28, 31, 32]) {
              const p = lm[idx];
              if (p && (p.visibility ?? 1) > 0.35 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
                const px = this.toScreen(p, video, options);
                pts.push({ x: px.x / options.screenW, y: px.y / options.screenH });
              }
            }
          }
          this.cachedFeet = pts;
        } catch {
          // ignore
        }
      }
    }

    const handRes = this.handLandmarker!.detectForVideo(video, nowMs);
    if (!handRes.landmarks || handRes.landmarks.length === 0) {
      this.handLostStreak++;
      this.handPresentStreak = 0;
      if (this.handLostStreak > 9) {
        this.handLocked = false;
        this.recoilBuffer = [];
        this.fwdHistory = [];
      }
      return;
    }
    this.handLostStreak = 0;
    this.handPresentStreak++;
    if (this.handPresentStreak >= 2) this.handLocked = true;

    const lm = handRes.landmarks[0];
    const wl = handRes.worldLandmarks?.[0] as V3[] | undefined;
    const hasWorld = !!wl && wl.length >= 21;

    // ---- Which hand is it? MediaPipe assumes a mirrored image, so for raw video the label is swapped ----
    const label = handRes.handedness?.[0]?.[0]?.categoryName;
    if (label) {
      this.rightScore = clamp(this.rightScore + (label === 'Left' ? 1 : -1), -4, 4);
    }
    const actuallyRight = this.rightScore > 0;
    // What the person SEES: the front camera is displayed mirrored, which flips the hand's look
    this.displayRight = actuallyRight !== options.mirrored;

    // ---- Screen-space (pixel) landmarks, mapped through the object-cover video crop ----
    const P: P2[] = lm.map((l) => this.toScreen(l, video, options));
    const p0 = P[0];
    const p5 = P[5];
    const p9 = P[9];
    const p13 = P[13];
    const p17 = P[17];

    const palmPx = Math.max(dist2(p0, p9), dist2(p5, p17) * 1.1, 24);

    // ---- Real scale: screen pixels per real metre, immune to foreshortening ----
    let pxPerMeter = palmPx / 0.1;
    if (hasWorld) {
      const pairs: Array<[number, number]> = [
        [0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17], [5, 17],
      ];
      let pxSum = 0;
      let wSum = 0;
      for (const [i, j] of pairs) {
        pxSum += dist2(P[i], P[j]);
        wSum += Math.hypot(wl![i].x - wl![j].x, wl![i].y - wl![j].y);
      }
      if (wSum > 0.02) pxPerMeter = clamp(pxSum / wSum, palmPx / 0.17, palmPx / 0.055);
    }
    this.tgtScale = pxPerMeter / options.screenH;

    // ---- Palm centre (where the gun / virtual hand is anchored) ----
    const cx = p0.x * 0.2 + p5.x * 0.3 + p9.x * 0.2 + p13.x * 0.15 + p17.x * 0.15;
    const cy = p0.y * 0.2 + p5.y * 0.3 + p9.y * 0.2 + p13.y * 0.15 + p17.y * 0.15;
    this.tgtHandX = cx / options.screenW;
    this.tgtHandY = cy / options.screenH;

    // ---- Hand frame in camera space (three.js axes: x right, y up, z toward the viewer) ----
    const sx = options.mirrored ? -1 : 1;
    const cam = (i: number): V3 =>
      hasWorld
        ? { x: wl![i].x * sx, y: -wl![i].y, z: -wl![i].z }
        : { x: (lm[i].x - 0.5) * sx, y: -(lm[i].y - 0.5), z: -lm[i].z };

    const wrist = cam(0);
    const knuckleMid: V3 = {
      x: (cam(5).x + cam(9).x + cam(13).x + cam(17).x) / 4,
      y: (cam(5).y + cam(9).y + cam(13).y + cam(17).y) / 4,
      z: (cam(5).z + cam(9).z + cam(13).z + cam(17).z) / 4,
    };
    const fwd = norm(sub(knuckleMid, wrist)); // wrist -> knuckles = barrel direction
    let across = sub(cam(5), cam(17)); // pinky -> index knuckle = gun "up"
    const d = dot(across, fwd);
    across = { x: across.x - d * fwd.x, y: across.y - d * fwd.y, z: across.z - d * fwd.z };
    if (len3(across) > 1e-5 && len3(fwd) > 0.5) {
      this.tgtFwd = fwd;
      this.tgtUp = norm(across);
    }
    this.tgtRoll = Math.atan2(p5.y - p17.y, p5.x - p17.x);

    // Fallback aim (screen) in case the 3D direction is unusable
    this.tgtAimX = clamp((p9.x + (p9.x - p0.x) * 0.9) / options.screenW, 0.05, 0.95);
    this.tgtAimY = clamp((p9.y + (p9.y - p0.y) * 0.9) / options.screenH, 0.05, 0.95);

    // ---- Steadiness: how much the pointing direction jitters ----
    this.fwdHistory.push({ ...this.tgtFwd });
    if (this.fwdHistory.length > 8) this.fwdHistory.shift();
    let jitterSum = 0;
    for (let i = 1; i < this.fwdHistory.length; i++) {
      jitterSum += len3(sub(this.fwdHistory[i], this.fwdHistory[i - 1]));
    }
    const avgJitter = this.fwdHistory.length > 1 ? jitterSum / (this.fwdHistory.length - 1) : 0;
    this.stability = clamp(1 - avgJitter * 7, 0.15, 1);

    // ---- Recoil gesture (the ONLY thing that fires) ----
    const knuckleY = (p5.y + p9.y + p13.y + p17.y) / 4;
    this.updateRecoil(nowMs, knuckleY, p0.y, pxPerMeter * 0.095);
  }

  /**
   * A shot is fired ONLY by a recoil flick: the hand snaps upward quickly (a small, sharp kick like a
   * real pistol) after it was held fairly steady. Slow movement, big arm lifts, or just showing the
   * hand never fires. Works for any hand shape.
   */
  private updateRecoil(nowMs: number, knuckleY: number, wristY: number, unit: number) {
    this.recoilBuffer.push({ t: nowMs, knuckleY, wristY, unit });
    while (this.recoilBuffer.length > 14) this.recoilBuffer.shift();

    this.recoilEnergy = 0;
    const buf = this.recoilBuffer;
    if (buf.length < 3) return;

    const latest = buf[buf.length - 1];
    const prevSample = buf[buf.length - 2];
    const lastDt = Math.max(0.001, (latest.t - prevSample.t) / 1000);
    const instSpeed = Math.abs(latest.knuckleY - prevSample.knuckleY) / latest.unit / lastDt;

    // Re-arm once the hand has calmed down after a shot
    if (!this.recoilArmed) {
      this.calmFrames = instSpeed < 1.0 ? this.calmFrames + 1 : 0;
      if (this.calmFrames >= 2 && nowMs - this.lastRecoilFireMs > RECOIL_COOLDOWN_MS) {
        this.recoilArmed = true;
      }
    }

    if (!this.handLocked || this.handPresentStreak < RECOIL_MIN_STABLE_FRAMES) return;

    let bestScore = 0;
    let windowStartT = latest.t;
    for (let i = buf.length - 2; i >= 0; i--) {
      const prev = buf[i];
      const dt = (latest.t - prev.t) / 1000;
      if (dt < 0.04) continue;
      if (dt > 0.22) break;
      const rise = (prev.knuckleY - latest.knuckleY) / latest.unit;
      if (rise > RECOIL_MAX_RISE) continue;
      const velocity = rise / dt;
      const score = Math.min(rise / RECOIL_MIN_RISE, velocity / RECOIL_MIN_VELOCITY);
      if (score > bestScore) {
        bestScore = score;
        windowStartT = prev.t;
      }
    }
    this.recoilEnergy = clamp(bestScore, 0, 1);

    if (bestScore >= 1 && this.recoilArmed && nowMs - this.lastRecoilFireMs > RECOIL_COOLDOWN_MS) {
      // The hand must have been steady right before the flick
      let preMax = 0;
      for (let i = 1; i < buf.length; i++) {
        if (buf[i].t > windowStartT) break;
        const dt = Math.max(0.001, (buf[i].t - buf[i - 1].t) / 1000);
        preMax = Math.max(preMax, Math.abs(buf[i].knuckleY - buf[i - 1].knuckleY) / buf[i].unit / dt);
      }
      if (preMax <= RECOIL_MAX_PRE_SPEED) {
        this.pendingRecoil = true;
        this.lastRecoilFireMs = nowMs;
        this.recoilArmed = false;
        this.calmFrames = 0;
        this.recoilBuffer = [latest];
      }
    }
  }

  /** Map a normalized video landmark to screen pixels, honouring mirroring and object-cover cropping. */
  private toScreen(
    l: NormalizedLandmark,
    video: HTMLVideoElement,
    options: { mirrored: boolean; screenW: number; screenH: number },
  ): P2 {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const cover = Math.max(options.screenW / vw, options.screenH / vh);
    const dw = vw * cover;
    const dh = vh * cover;
    const ox = (options.screenW - dw) / 2;
    const oy = (options.screenH - dh) / 2;
    const nx = options.mirrored ? 1 - l.x : l.x;
    return { x: nx * dw + ox, y: l.y * dh + oy };
  }

  private stepSmoothing(dt: number) {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    const kPos = k(24);
    const kAim = k(18);
    const kScale = k(12);
    const kDir = k(14);
    this.smoothHandX += (this.tgtHandX - this.smoothHandX) * kPos;
    this.smoothHandY += (this.tgtHandY - this.smoothHandY) * kPos;
    this.smoothAimX += (this.tgtAimX - this.smoothAimX) * kAim;
    this.smoothAimY += (this.tgtAimY - this.smoothAimY) * kAim;
    this.smoothScale += (this.tgtScale - this.smoothScale) * kScale;
    this.smoothRoll += (this.tgtRoll - this.smoothRoll) * kDir;

    for (const [smooth, target] of [
      [this.smoothUp, this.tgtUp],
      [this.smoothFwd, this.tgtFwd],
    ] as Array<[V3, V3]>) {
      smooth.x += (target.x - smooth.x) * kDir;
      smooth.y += (target.y - smooth.y) * kDir;
      smooth.z += (target.z - smooth.z) * kDir;
      const l = len3(smooth) || 1;
      smooth.x /= l;
      smooth.y /= l;
      smooth.z /= l;
    }
  }

  private buildState(checkFeet: boolean): HandGestureState {
    const handDetected = this.handLostStreak <= 6;
    const recoilTriggered = this.pendingRecoil;
    this.pendingRecoil = false;
    return {
      handDetected,
      // Any visible hand, in ANY gesture, holds the gun
      isGunPose: this.handLocked && handDetected,
      confidence: this.handLocked ? 0.94 : handDetected ? 0.45 : 0,
      handScreenX: this.smoothHandX,
      handScreenY: this.smoothHandY,
      aimScreenX: this.smoothAimX,
      aimScreenY: this.smoothAimY,
      handRoll: this.smoothRoll,
      handScale: this.smoothScale,
      handUpX: this.smoothUp.x,
      handUpY: this.smoothUp.y,
      handUpZ: this.smoothUp.z,
      handForwardX: this.smoothFwd.x,
      handForwardY: this.smoothFwd.y,
      handForwardZ: this.smoothFwd.z,
      handIsRight: this.displayRight,
      stability: this.stability,
      recoilEnergy: this.recoilEnergy,
      recoilTriggered,
      feetScreenPoints: checkFeet ? this.cachedFeet : [],
    };
  }

  public dispose() {
    this.handLandmarker?.close();
    this.poseLandmarker?.close();
    this.handLandmarker = null;
    this.poseLandmarker = null;
    this.ready = false;
  }
}