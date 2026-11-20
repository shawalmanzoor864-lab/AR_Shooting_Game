import {
  FilesetResolver,
  HandLandmarker,
  NormalizedLandmark,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import { HandGestureState } from './types';

interface LandmarkFrame {
  t: number;
  wristY: number;
  tipY: number;
  mcpY: number;
  palmSize: number;
}

const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

function dist2D(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function angleAtJoint(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark,
): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const len1 = Math.hypot(v1x, v1y) || 1e-5;
  const len2 = Math.hypot(v2x, v2y) || 1e-5;
  const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

export class MediaPipeGestureTracker {
  private handLandmarker: HandLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private ready = false;
  private loading = false;
  private error: string | null = null;

  private lastVideoTime = -1;
  private lastPoseTime = 0;

  // Hysteresis & smoothing state
  private gunPoseStreak = 0;
  private gunLostStreak = 0;
  private gunLocked = false;

  private smoothHandX = 0.55;
  private smoothHandY = 0.65;
  private smoothAimX = 0.5;
  private smoothAimY = 0.45;
  private smoothRoll = 0;
  private smoothScale = 0.22;

  private aimHistory: Array<{ x: number; y: number }> = [];
  private recoilBuffer: LandmarkFrame[] = [];
  private lastRecoilFireMs = 0;
  private cachedFeet: Array<{ x: number; y: number }> = [];

  public async init(): Promise<void> {
    if (this.ready || this.loading) return;
    this.loading = true;
    this.error = null;

    try {
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');

      try {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.45,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.42,
        });
      } catch {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_URL,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.45,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.42,
        });
      }

      // Pose landmarker is optional (used when tilted down to track feet inside the standing square box)
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: POSE_MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
      })
        .then((pose) => {
          this.poseLandmarker = pose;
        })
        .catch(() => {
          // Silently continue with IMU/motion boundary tracking if pose model unavailable
        });

      this.ready = true;
    } catch (err) {
      this.error =
        err instanceof Error
          ? err.message
          : 'Unable to initialize MediaPipe hand tracking';
    } finally {
      this.loading = false;
    }
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
    options: { mirrored: boolean; checkFeet: boolean },
  ): HandGestureState {
    const emptyState: HandGestureState = {
      handDetected: false,
      isGunPose: false,
      confidence: 0,
      handScreenX: this.smoothHandX,
      handScreenY: this.smoothHandY,
      aimScreenX: this.smoothAimX,
      aimScreenY: this.smoothAimY,
      handRoll: this.smoothRoll,
      handScale: this.smoothScale,
      stability: 0.5,
      recoilEnergy: 0,
      recoilTriggered: false,
      feetScreenPoints: [],
    };

    if (!this.ready || !this.handLandmarker || video.readyState < 2) {
      return emptyState;
    }

    if (video.currentTime === this.lastVideoTime) {
      return {
        ...emptyState,
        handDetected: this.gunLocked,
        isGunPose: this.gunLocked,
        feetScreenPoints: options.checkFeet ? this.cachedFeet : [],
      };
    }
    this.lastVideoTime = video.currentTime;

    // 1. Optional Pose foot detection when camera points down at feet (~10Hz)
    if (options.checkFeet && this.poseLandmarker && nowMs - this.lastPoseTime > 95) {
      this.lastPoseTime = nowMs;
      try {
        const poseRes = this.poseLandmarker.detectForVideo(video, nowMs);
        const pts: Array<{ x: number; y: number }> = [];
        if (poseRes.landmarks && poseRes.landmarks.length > 0) {
          const lm = poseRes.landmarks[0];
          const footIndices = [27, 28, 31, 32]; // left/right ankle + foot index
          for (const idx of footIndices) {
            const p = lm[idx];
            if (p && (p.visibility ?? 1) > 0.35 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
              pts.push({
                x: options.mirrored ? 1 - p.x : p.x,
                y: p.y,
              });
            }
          }
        }
        this.cachedFeet = pts;
      } catch {
        // Ignore transient pose frame errors
      }
    } else if (!options.checkFeet) {
      this.cachedFeet = [];
    }

    // 2. Hand landmark detection
    const handRes = this.handLandmarker.detectForVideo(video, nowMs);
    if (!handRes.landmarks || handRes.landmarks.length === 0) {
      this.gunPoseStreak = 0;
      this.gunLostStreak++;
      if (this.gunLostStreak > 8) {
        this.gunLocked = false;
        this.recoilBuffer = [];
      }
      return {
        ...emptyState,
        isGunPose: this.gunLocked,
        feetScreenPoints: this.cachedFeet,
      };
    }

    const lm = handRes.landmarks[0];
    const wrist = lm[0];
    const thumbTip = lm[4];
    const indexMcp = lm[5];
    const indexPip = lm[6];
    const indexTip = lm[8];
    const middleMcp = lm[9];
    const middlePip = lm[10];
    const middleTip = lm[12];
    const ringMcp = lm[13];
    const ringPip = lm[14];
    const ringTip = lm[16];
    const pinkyMcp = lm[17];
    const pinkyPip = lm[18];
    const pinkyTip = lm[20];

    const palmSize = Math.max(dist2D(wrist, middleMcp), dist2D(wrist, indexMcp), 0.05);

    // Evaluate gun-holding gesture (index extended, middle/ring/pinky curled, thumb separated)
    const indexExtRatio = dist2D(indexTip, indexMcp) / palmSize;
    const indexAngle = angleAtJoint(indexMcp, indexPip, indexTip); // straight ~ PI (3.14)
    const indexExtended = indexExtRatio > 0.44 || indexAngle > 2.05;

    const isCurled = (mcp: NormalizedLandmark, pip: NormalizedLandmark, tip: NormalizedLandmark) => {
      const tipToWrist = dist2D(tip, wrist);
      const pipToWrist = dist2D(pip, wrist);
      const tipToMcp = dist2D(tip, mcp);
      return tipToWrist < pipToWrist * 1.18 || tipToMcp < palmSize * 0.88;
    };

    const curledCount =
      (isCurled(middleMcp, middlePip, middleTip) ? 1 : 0) +
      (isCurled(ringMcp, ringPip, ringTip) ? 1 : 0) +
      (isCurled(pinkyMcp, pinkyPip, pinkyTip) ? 1 : 0);

    const indexBeatsMiddle = dist2D(indexTip, wrist) > dist2D(middleTip, wrist) * 1.06;
    const thumbSpread = dist2D(thumbTip, indexMcp) / palmSize > 0.28;

    const rawGunDetected = indexExtended && curledCount >= 2 && (indexBeatsMiddle || thumbSpread);

    if (rawGunDetected) {
      this.gunPoseStreak++;
      this.gunLostStreak = 0;
      if (this.gunPoseStreak >= 2) {
        this.gunLocked = true;
      }
    } else {
      this.gunPoseStreak = 0;
      this.gunLostStreak++;
      if (this.gunLostStreak > 7) {
        this.gunLocked = false;
      }
    }

    // Compute hand screen coordinates & aiming point
    const mapX = (x: number) => (options.mirrored ? 1 - x : x);
    const gripX = mapX((wrist.x * 0.45 + indexMcp.x * 0.55));
    const gripY = wrist.y * 0.45 + indexMcp.y * 0.55;

    // Aim ray extends slightly forward from index MCP through index TIP
    const tipX = mapX(indexTip.x);
    const tipY = indexTip.y;
    const mcpX = mapX(indexMcp.x);
    const mcpY = indexMcp.y;

    const rawAimX = Math.max(0.05, Math.min(0.95, tipX + (tipX - mcpX) * 0.45));
    const rawAimY = Math.max(0.05, Math.min(0.95, tipY + (tipY - mcpY) * 0.45 - 0.03));

    const roll = Math.atan2(indexMcp.y - pinkyMcp.y, mapX(indexMcp.x) - mapX(pinkyMcp.x));

    // Exponential smoothing
    this.smoothHandX += (gripX - this.smoothHandX) * 0.35;
    this.smoothHandY += (gripY - this.smoothHandY) * 0.35;
    this.smoothAimX += (rawAimX - this.smoothAimX) * 0.32;
    this.smoothAimY += (rawAimY - this.smoothAimY) * 0.32;
    this.smoothRoll += (roll - this.smoothRoll) * 0.25;
    this.smoothScale += (palmSize - this.smoothScale) * 0.25;

    // Steadiness calculation (jitter variance over last 8 frames)
    this.aimHistory.push({ x: rawAimX, y: rawAimY });
    if (this.aimHistory.length > 8) this.aimHistory.shift();
    let jitterSum = 0;
    for (let i = 1; i < this.aimHistory.length; i++) {
      jitterSum += Math.hypot(
        this.aimHistory[i].x - this.aimHistory[i - 1].x,
        this.aimHistory[i].y - this.aimHistory[i - 1].y,
      );
    }
    const avgJitter = this.aimHistory.length > 1 ? jitterSum / (this.aimHistory.length - 1) : 0;
    const stability = Math.max(0.15, Math.min(1, 1 - avgJitter * 28));

    // Real-life upward recoil impulse detection
    this.recoilBuffer.push({
      t: nowMs,
      wristY: wrist.y,
      tipY: indexTip.y,
      mcpY: indexMcp.y,
      palmSize,
    });
    while (this.recoilBuffer.length > 12) {
      this.recoilBuffer.shift();
    }

    let recoilEnergy = 0;
    let recoilTriggered = false;

    if (this.gunLocked && this.recoilBuffer.length >= 4) {
      const latest = this.recoilBuffer[this.recoilBuffer.length - 1];
      // Compare against recent window ~50-110ms earlier
      let bestKick = 0;
      for (let i = this.recoilBuffer.length - 2; i >= 0; i--) {
        const prev = this.recoilBuffer[i];
        const dt = (latest.t - prev.t) / 1000;
        if (dt < 0.025 || dt > 0.14) continue;

        // Screen Y decreases as hand kicks UPWARD like gun recoil
        const tipLift = (prev.tipY - latest.tipY) / latest.palmSize;
        const wristLift = (prev.wristY - latest.wristY) / latest.palmSize;
        const combinedLift = tipLift * 0.65 + wristLift * 0.35;
        const upwardVelocity = combinedLift / dt;

        // Normalize into recoil energy 0..1 (threshold at ~2.1 palm-lengths/sec and >= 0.12 palm lift)
        if (combinedLift > 0.07) {
          const score = Math.min(1.5, upwardVelocity / 2.25);
          if (score > bestKick) bestKick = score;
        }
      }

      recoilEnergy = Math.min(1, bestKick);

      if (bestKick >= 1.0 && nowMs - this.lastRecoilFireMs > 290) {
        recoilTriggered = true;
        this.lastRecoilFireMs = nowMs;
        // Clear buffer so the recovery drop doesn't trigger anything
        this.recoilBuffer = [latest];
      }
    }

    return {
      handDetected: true,
      isGunPose: this.gunLocked,
      confidence: rawGunDetected ? 0.94 : 0.45,
      handScreenX: this.smoothHandX,
      handScreenY: this.smoothHandY,
      aimScreenX: this.smoothAimX,
      aimScreenY: this.smoothAimY,
      handRoll: this.smoothRoll,
      handScale: this.smoothScale,
      stability,
      recoilEnergy,
      recoilTriggered,
      feetScreenPoints: this.cachedFeet,
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
