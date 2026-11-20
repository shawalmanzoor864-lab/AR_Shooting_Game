export type GamePhase =
  | 'menu'
  | 'playing'
  | 'level_clear'
  | 'out_of_bounds'
  | 'game_over'
  | 'victory';

export type MovementPattern =
  | 'static'
  | 'horizontal'
  | 'vertical'
  | 'diagonal'
  | 'approaching';

export interface LevelConfig {
  id: number;
  title: string;
  subtitle: string;
  briefing: string;
  totalTargets: number;
  maxSimultaneous: number;
  hitsToDestroy: number;
  distanceRange: [number, number];
  /** Azimuth angles in degrees relative to player starting forward (-Z = 0 deg) */
  azimuthRange: [number, number];
  /** Explicit azimuth slots if needed (e.g., Level 3 5-place AR spread) */
  fixedAzimuths?: number[];
  elevationRange: [number, number];
  patterns: MovementPattern[];
  speedRange: [number, number];
  breachDistance?: number;
  rearWarning?: boolean;
}

export interface HandGestureState {
  handDetected: boolean;
  isGunPose: boolean;
  confidence: number;
  /** Normalized screen coordinates [0..1] of the grip center */
  handScreenX: number;
  handScreenY: number;
  /** Normalized screen coordinates [0..1] of the aiming point */
  aimScreenX: number;
  aimScreenY: number;
  /** Roll angle in radians of the hand */
  handRoll: number;
  /** Apparent palm length as a fraction of the screen height (used to size the 3D AR gun) */
  handScale: number;
  /** Hand "up" direction (thumb / sights side) in camera space, used to roll the 3D gun with the hand */
  handUpX: number;
  handUpY: number;
  handUpZ: number;
  /** 0..1 steadiness of the hand (higher = tighter aiming dispersion circle) */
  stability: number;
  /** 0..1 instantaneous upward recoil impulse energy */
  recoilEnergy: number;
  /** True on the exact frame a recoil shot gesture triggers */
  recoilTriggered: boolean;
  /** Screen coordinates of detected feet/ankles if looking down */
  feetScreenPoints: Array<{ x: number; y: number }>;
}

export interface AimTargetHitInfo {
  hasTargetLock: boolean;
  zone: 'bullseye' | 'inner' | 'outer' | 'none';
  distanceMeters: number;
  dispersionRadiusMeters: number;
  targetScreenHint?: 'left' | 'right' | 'behind' | null;
}

export interface HudSnapshot {
  ammo: number;
  maxAmmo: number;
  isReloading: boolean;
  reloadProgress: number;
  score: number;
  shotsFired: number;
  shotsHit: number;
  bullseyes: number;
  targetsCleared: number;
  targetsTotal: number;
  health: number;
  maxHealth: number;
  isLookingAtFeet: boolean;
  boxDistanceNormalized: number; // 0 = dead center, 1 = on border, >1 = outside
  outOfBoundsReason: string | null;
  cameraActive: boolean;
  mediapipeReady: boolean;
  mediapipeError: string | null;
  gyroActive: boolean;
  offscreenDirection: 'left' | 'right' | 'behind' | null;
  offscreenCount: number;
  gesture: HandGestureState;
  aimInfo: AimTargetHitInfo;
  lastHitFeedback: {
    id: number;
    points: number;
    zone: 'bullseye' | 'inner' | 'outer';
  } | null;
}

export const MAX_MAGAZINE_AMMO = 20;
export const GUARDIAN_BOX_HALF_SIZE = 0.72; // 1.44m x 1.44m standing square box
export const FLOOR_Y = -1.45;
export const CEILING_Y = 4.2;