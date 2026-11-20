import * as THREE from 'three';

const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X for upright mobile camera
const _qScreen = new THREE.Quaternion();
const _zee = new THREE.Vector3(0, 0, 1);

export class SpatialTracker {
  private gyroEnabled = false;
  private hasGyroEvents = false;
  private headingOffset = 0;
  private targetQuat = new THREE.Quaternion();
  private smoothQuat = new THREE.Quaternion();

  // Manual look fallback (drag / touch pan when testing without gyro)
  private manualYaw = 0;
  private manualPitch = 0;

  // Player position inside the standing square box (x, z in meters relative to center 0,0)
  public playerPos = new THREE.Vector3(0, 0, 0);
  private velocity = new THREE.Vector3(0, 0, 0);
  private keys: Record<string, boolean> = {};

  private deviceAlpha = 0;
  private deviceBeta = 90;
  private deviceGamma = 0;
  private initialAlpha: number | null = null;

  private boundOrientationHandler: (e: DeviceOrientationEvent) => void;
  private boundMotionHandler: (e: DeviceMotionEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;

  constructor() {
    this.boundOrientationHandler = this.onDeviceOrientation.bind(this);
    this.boundMotionHandler = this.onDeviceMotion.bind(this);
    this.boundKeyDown = (e) => {
      this.keys[e.code] = true;
    };
    this.boundKeyUp = (e) => {
      this.keys[e.code] = false;
    };

    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  public async enableSensors(): Promise<boolean> {
    let granted = true;
    const DevOrient = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (DevOrient && typeof DevOrient.requestPermission === 'function') {
      try {
        const res = await DevOrient.requestPermission();
        granted = res === 'granted';
      } catch {
        granted = false;
      }
    }

    const DevMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (DevMotion && typeof DevMotion.requestPermission === 'function') {
      try {
        await DevMotion.requestPermission();
      } catch {
        // Ignore motion decline
      }
    }

    if (granted) {
      window.addEventListener('deviceorientation', this.boundOrientationHandler, true);
      window.addEventListener('devicemotion', this.boundMotionHandler, true);
      this.gyroEnabled = true;
    }

    return granted;
  }

  private onDeviceOrientation(e: DeviceOrientationEvent) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    this.hasGyroEvents = true;
    this.deviceAlpha = e.alpha;
    this.deviceBeta = e.beta;
    this.deviceGamma = e.gamma;

    if (this.initialAlpha === null) {
      this.initialAlpha = e.alpha;
    }
  }

  private onDeviceMotion(e: DeviceMotionEvent) {
    // High-pass linear acceleration step impulse to estimate walking outside the square box
    const acc = e.acceleration;
    if (!acc || acc.x === null || acc.z === null) return;

    const ax = Math.abs(acc.x) > 1.35 ? acc.x : 0;
    const az = Math.abs(acc.z) > 1.35 ? acc.z : 0;
    if (ax === 0 && az === 0) return;

    // Transform local phone lateral/forward impulse into world XZ using current camera heading
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.smoothQuat);
    forward.y = 0;
    if (forward.lengthSq() > 0.001) forward.normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.smoothQuat);
    right.y = 0;
    if (right.lengthSq() > 0.001) right.normalize();

    this.velocity.addScaledVector(right, ax * 0.012);
    this.velocity.addScaledVector(forward, -az * 0.012);
  }

  public addManualLookDelta(dx: number, dy: number) {
    this.manualYaw -= dx * 0.0045;
    this.manualPitch = Math.max(
      -Math.PI / 2 + 0.08,
      Math.min(Math.PI / 2 - 0.08, this.manualPitch - dy * 0.0045),
    );
  }

  public setManualPitch(pitchRad: number) {
    this.manualPitch = Math.max(-Math.PI / 2 + 0.08, Math.min(Math.PI / 2 - 0.08, pitchRad));
  }

  public addManualYaw(deltaRad: number) {
    this.manualYaw += deltaRad;
  }

  public recenter() {
    this.playerPos.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.manualYaw = 0;
    this.manualPitch = 0;
    if (this.hasGyroEvents) {
      this.initialAlpha = this.deviceAlpha;
    }
    this.headingOffset = 0;
  }

  public isGyroActive(): boolean {
    return this.gyroEnabled && this.hasGyroEvents;
  }

  public update(camera: THREE.PerspectiveCamera, delta: number) {
    // 1. Update position (WASD for desktop testing + IMU velocity damping)
    const walkSpeed = 1.6;
    let moveForward = 0;
    let moveRight = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) moveForward += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) moveForward -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) moveRight += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) moveRight -= 1;

    if (moveForward !== 0 || moveRight !== 0) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() > 0.001) fwd.normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      right.y = 0;
      if (right.lengthSq() > 0.001) right.normalize();

      this.playerPos.addScaledVector(fwd, moveForward * walkSpeed * delta);
      this.playerPos.addScaledVector(right, moveRight * walkSpeed * delta);
    }

    // Apply IMU velocity with exponential damping
    this.playerPos.addScaledVector(this.velocity, delta);
    const dampFactor = Math.exp(-6.5 * delta);
    this.velocity.multiplyScalar(dampFactor);

    camera.position.set(this.playerPos.x, 0, this.playerPos.z);

    // 2. Update orientation
    if (this.hasGyroEvents) {
      const alphaRad = THREE.MathUtils.degToRad(
        this.deviceAlpha - (this.initialAlpha ?? 0) + this.headingOffset,
      );
      const betaRad = THREE.MathUtils.degToRad(this.deviceBeta);
      const gammaRad = THREE.MathUtils.degToRad(this.deviceGamma);
      const orientRad = THREE.MathUtils.degToRad(window.screen?.orientation?.angle ?? 0);

      _euler.set(betaRad, alphaRad, -gammaRad, 'YXZ');
      this.targetQuat.setFromEuler(_euler);
      this.targetQuat.multiply(_q1);
      this.targetQuat.multiply(_qScreen.setFromAxisAngle(_zee, -orientRad));

      // Apply optional manual yaw offset on top
      _q0.setFromEuler(new THREE.Euler(this.manualPitch, this.manualYaw, 0, 'YXZ'));
      this.targetQuat.premultiply(_q0);
    } else {
      _euler.set(this.manualPitch, this.manualYaw, 0, 'YXZ');
      this.targetQuat.setFromEuler(_euler);
    }

    const slerpAlpha = 1 - Math.exp(-18 * delta);
    this.smoothQuat.slerp(this.targetQuat, slerpAlpha);
    camera.quaternion.copy(this.smoothQuat);
  }

  /** Returns camera pitch angle in radians (negative = looking down at floor/feet) */
  public getCameraPitch(camera: THREE.PerspectiveCamera): number {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  public dispose() {
    window.removeEventListener('deviceorientation', this.boundOrientationHandler, true);
    window.removeEventListener('devicemotion', this.boundMotionHandler, true);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
  }
}
