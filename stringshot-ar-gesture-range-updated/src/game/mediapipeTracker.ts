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
  tipY: number; // screen px
  wristY: number; // screen px
  palmPx: number;
}

const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Run hand detection at most ~24 times per second. The 3D scene and gun keep rendering at full
// speed in between (the gun is smoothed every frame), so the game stays fluid on phones.
const MIN_DETECT_INTERVAL_MS = 42;
const POSE_INTERVAL_MS = 140;

// Recoil gesture tuning (distances are in "palm lengths" so it works at any hand distance)
const RECOIL_MIN_TIP_RISE = 0.24; // fingertip must flick up by this many palm lengths ...
const RECOIL_MIN_VELOCITY = 2.6; // ... faster than this many palm lengths per second ...
const RECOIL_MIN_RELATIVE_RISE = 0.08; // ... and rise more than the wrist (finger pitches up)
const RECOIL_MAX_PRE_SPEED = 2.0; // hand must have been fairly steady just before the flick
const RECOIL_COOLDOWN_MS = 420;
const RECOIL_MIN_STABLE_FRAMES = 5; // gun pose must be held this many detections before it can fire

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
const dist3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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

  // Gesture hysteresis
  private gunPoseStreak = 0;
  private gunLostStreak = 0;
  private gunLocked = false;
  private handLostStreak = 99;
  private stableFrames = 0;

  // Raw targets (updated at detection rate) ...
  private tgtHandX = 0.55;
  private tgtHandY = 0.65;
  private tgtAimX = 0.5;
  private tgtAimY = 0.45;
  private tgtScale = 0.16;
  private tgtRoll = 0;
  private tgtUp: V3 = { x: 0, y: 1, z: 0 };

  // ... and smoothed values (stepped every rendered frame)
  private smoothHandX = 0.55;
  private smoothHandY = 0.65;
  private smoothAimX = 0.5;
  private smoothAimY = 0.45;
  private smoothScale = 0.16;
  private smoothRoll = 0;
  private smoothUp: V3 = { x: 0, y: 1, z: 0 };

  private stability = 0.5;
  private aimHistory: P2[] = [];
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
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
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
    options: { mirrored: boolean; checkFeet: boolean; screenW: number; screenH: number },
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

  private detect(
    video: HTMLVideoElement,
    nowMs: number,
    options: { mirrored: boolean; checkFeet: boolean; screenW: number; screenH: number },
  ) {
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
      this.gunPoseStreak = 0;
      this.gunLostStreak++;
      this.stableFrames = 0;
      if (this.gunLostStreak > 6) {
        this.gunLocked = false;
        this.recoilBuffer = [];
      }
      return;
    }
    this.handLostStreak = 0;

    const lm = handRes.landmarks[0];
    const wl = handRes.worldLandmarks?.[0] as V3[] | undefined;

    // ---- Screen-space (pixel) landmarks, correctly mapped through the object-cover video crop ----
    const px = (i: number): P2 => this.toScreen(lm[i], video, options);
    const p0 = px(0);
    const p5 = px(5);
    const p8 = px(8);
    const p9 = px(9);
    const p13 = px(13);
    const p17 = px(17);

    const palmLen = dist2(p0, p9);
    const palmWid = dist2(p5, p17) * 1.1;
    const palmPx = Math.max(palmLen, palmWid, 24);

    // ---- Gun pose classification using real 3D (world) landmarks: immune to foreshortening ----
    let rawGun = false;
    if (wl && wl.length >= 21) {
      const w0 = wl[0];
      const ratio = (tip: number, mcp: number) => dist3(wl[tip], w0) / Math.max(dist3(wl[mcp], w0), 1e-4);
      const indexR = ratio(8, 5);
      const midR = ratio(12, 9);
      const ringR = ratio(16, 13);
      const pinkyR = ratio(20, 17);
      const curled =
        (midR < 1.4 ? 1 : 0) + (ringR < 1.4 ? 1 : 0) + (pinkyR < 1.4 ? 1 : 0);
      const indexExtended = indexR > 1.5;
      const indexLeads = indexR > Math.max(midR, ringR, pinkyR) + 0.3;
      rawGun = indexExtended && curled >= 2 && indexLeads;
    } else {
      const idxLen = dist2(p8, p5) / palmPx;
      const midTip = px(12);
      const ringTip = px(16);
      const pinkyTip = px(20);
      const curledTip = (t: P2, base: P2) => dist2(t, base) < palmPx * 0.85;
      rawGun =
        idxLen > 0.55 &&
        (curledTip(midTip, p9) ? 1 : 0) + (curledTip(ringTip, p13) ? 1 : 0) + (curledTip(pinkyTip, p17) ? 1 : 0) >= 2;
    }

    if (rawGun) {
      this.gunPoseStreak++;
      this.gunLostStreak = 0;
      this.stableFrames++;
      if (this.gunPoseStreak >= 2) this.gunLocked = true;
    } else {
      this.gunPoseStreak = 0;
      this.gunLostStreak++;
      this.stableFrames = 0;
      if (this.gunLostStreak > 6) this.gunLocked = false;
    }

    // ---- Where the gun grip sits: the centre of the palm ----
    const cx = p0.x * 0.2 + p5.x * 0.3 + p9.x * 0.2 + p13.x * 0.15 + p17.x * 0.15;
    const cy = p0.y * 0.2 + p5.y * 0.3 + p9.y * 0.2 + p13.y * 0.15 + p17.y * 0.15;
    this.tgtHandX = cx / options.screenW;
    this.tgtHandY = cy / options.screenH;
    this.tgtScale = palmPx / options.screenH;

    // ---- Aim point: continue the index finger line slightly past the fingertip ----
    const ax = p8.x + (p8.x - p5.x) * 0.45;
    const ay = p8.y + (p8.y - p5.y) * 0.45 - 0.02 * options.screenH;
    const rawAimX = clamp(ax / options.screenW, 0.05, 0.95);
    const rawAimY = clamp(ay / options.screenH, 0.05, 0.95);
    this.tgtAimX = rawAimX;
    this.tgtAimY = rawAimY;
    this.tgtRoll = Math.atan2(p5.y - p17.y, p5.x - p17.x);

    // ---- Hand "up" vector (thumb/sights side) so the gun rolls exactly with the hand ----
    if (wl && wl.length >= 21) {
      const sx = options.mirrored ? -1 : 1;
      const toCam = (v: V3): V3 => ({ x: v.x * sx, y: -v.y, z: -v.z });
      const a = toCam(wl[5]);
      const b = toCam(wl[17]);
      const t = toCam(wl[8]);
      const fwd = { x: t.x - a.x, y: t.y - a.y, z: t.z - a.z };
      const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
      fwd.x /= fl;
      fwd.y /= fl;
      fwd.z /= fl;
      const up = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
      const d = up.x * fwd.x + up.y * fwd.y + up.z * fwd.z;
      up.x -= d * fwd.x;
      up.y -= d * fwd.y;
      up.z -= d * fwd.z;
      const ul = Math.hypot(up.x, up.y, up.z);
      if (ul > 1e-4) {
        this.tgtUp = { x: up.x / ul, y: up.y / ul, z: up.z / ul };
      }
    }

    // ---- Steadiness (jitter over recent detections) ----
    this.aimHistory.push({ x: rawAimX, y: rawAimY });
    if (this.aimHistory.length > 8) this.aimHistory.shift();
    let jitterSum = 0;
    for (let i = 1; i < this.aimHistory.length; i++) {
      jitterSum += dist2(this.aimHistory[i], this.aimHistory[i - 1]);
    }
    const avgJitter = this.aimHistory.length > 1 ? jitterSum / (this.aimHistory.length - 1) : 0;
    this.stability = clamp(1 - avgJitter * 28, 0.15, 1);

    // ---- Recoil gesture ----
    this.updateRecoil(nowMs, p8.y, p0.y, palmPx, rawGun);
  }

  /**
   * A shot is fired ONLY by a real recoil flick: the fingertip snaps upward quickly (the finger
   * pitches up relative to the wrist) after the hand was held steady, while the gun pose is held.
   * Slow hand movement, sweeping the whole arm, or just raising the hand never fires.
   */
  private updateRecoil(nowMs: number, tipY: number, wristY: number, palmPx: number, rawGun: boolean) {
    this.recoilBuffer.push({ t: nowMs, tipY, wristY, palmPx });
    while (this.recoilBuffer.length > 14) this.recoilBuffer.shift();

    this.recoilEnergy = 0;
    const buf = this.recoilBuffer;
    if (buf.length < 3) return;

    const latest = buf[buf.length - 1];
    const prevSample = buf[buf.length - 2];
    const lastDt = Math.max(0.001, (latest.t - prevSample.t) / 1000);
    const instSpeed = Math.abs(latest.tipY - prevSample.tipY) / latest.palmPx / lastDt;

    // Re-arm once the hand has calmed down after a shot
    if (!this.recoilArmed) {
      this.calmFrames = instSpeed < 1.0 ? this.calmFrames + 1 : 0;
      if (this.calmFrames >= 2 && nowMs - this.lastRecoilFireMs > RECOIL_COOLDOWN_MS) {
        this.recoilArmed = true;
      }
    }

    if (!this.gunLocked || !rawGun || this.stableFrames < RECOIL_MIN_STABLE_FRAMES) return;

    let bestScore = 0;
    let windowStartT = latest.t;
    for (let i = buf.length - 2; i >= 0; i--) {
      const prev = buf[i];
      const dt = (latest.t - prev.t) / 1000;
      if (dt < 0.04) continue;
      if (dt > 0.22) break;
      const tipRise = (prev.tipY - latest.tipY) / latest.palmPx;
      const wristRise = (prev.wristY - latest.wristY) / latest.palmPx;
      const velocity = tipRise / dt;
      const relative = tipRise - Math.max(0, wristRise) * 0.6;
      const score = Math.min(
        tipRise / RECOIL_MIN_TIP_RISE,
        velocity / RECOIL_MIN_VELOCITY,
        relative / RECOIL_MIN_RELATIVE_RISE,
      );
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
        preMax = Math.max(preMax, Math.abs(buf[i].tipY - buf[i - 1].tipY) / buf[i].palmPx / dt);
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
    const kRoll = k(16);
    this.smoothHandX += (this.tgtHandX - this.smoothHandX) * kPos;
    this.smoothHandY += (this.tgtHandY - this.smoothHandY) * kPos;
    this.smoothAimX += (this.tgtAimX - this.smoothAimX) * kAim;
    this.smoothAimY += (this.tgtAimY - this.smoothAimY) * kAim;
    this.smoothScale += (this.tgtScale - this.smoothScale) * kScale;
    this.smoothRoll += (this.tgtRoll - this.smoothRoll) * kRoll;

    const u = this.smoothUp;
    u.x += (this.tgtUp.x - u.x) * kRoll;
    u.y += (this.tgtUp.y - u.y) * kRoll;
    u.z += (this.tgtUp.z - u.z) * kRoll;
    const l = Math.hypot(u.x, u.y, u.z) || 1;
    u.x /= l;
    u.y /= l;
    u.z /= l;
  }

  private buildState(checkFeet: boolean): HandGestureState {
    const handDetected = this.handLostStreak <= 6;
    const recoilTriggered = this.pendingRecoil;
    this.pendingRecoil = false;
    return {
      handDetected,
      isGunPose: this.gunLocked && handDetected,
      confidence: this.gunLocked ? 0.94 : handDetected ? 0.45 : 0,
      handScreenX: this.smoothHandX,
      handScreenY: this.smoothHandY,
      aimScreenX: this.smoothAimX,
      aimScreenY: this.smoothAimY,
      handRoll: this.smoothRoll,
      handScale: this.smoothScale,
      handUpX: this.smoothUp.x,
      handUpY: this.smoothUp.y,
      handUpZ: this.smoothUp.z,
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