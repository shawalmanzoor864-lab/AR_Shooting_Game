import { useCallback, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Eye,
  Hand,
  RotateCcw,
  RotateCw,
  ShieldAlert,
  SwitchCamera,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { ARGameViewport, GameControllerHandle } from './components/ARGameViewport';
import { audioEngine } from './game/audio';
import { GAME_LEVELS } from './game/levels';
import { GamePhase, HudSnapshot, MAX_MAGAZINE_AMMO } from './game/types';

const INITIAL_HUD: HudSnapshot = {
  ammo: MAX_MAGAZINE_AMMO,
  maxAmmo: MAX_MAGAZINE_AMMO,
  isReloading: false,
  reloadProgress: 0,
  score: 0,
  shotsFired: 0,
  shotsHit: 0,
  bullseyes: 0,
  targetsCleared: 0,
  targetsTotal: GAME_LEVELS[0].totalTargets,
  health: 3,
  maxHealth: 3,
  isLookingAtFeet: false,
  boxDistanceNormalized: 0,
  outOfBoundsReason: null,
  cameraActive: false,
  mediapipeReady: false,
  mediapipeError: null,
  gyroActive: false,
  offscreenDirection: null,
  offscreenCount: 0,
  gesture: {
    handDetected: false,
    isGunPose: false,
    confidence: 0,
    handScreenX: 0.5,
    handScreenY: 0.65,
    aimScreenX: 0.5,
    aimScreenY: 0.5,
    handRoll: 0,
    handScale: 0.2,
    handUpX: 0,
    handUpY: 1,
    handUpZ: 0,
    stability: 0.85,
    recoilEnergy: 0,
    recoilTriggered: false,
    feetScreenPoints: [],
  },
  aimInfo: {
    hasTargetLock: false,
    zone: 'none',
    distanceMeters: 0,
    dispersionRadiusMeters: 0.06,
  },
  lastHitFeedback: null,
};

export default function App() {
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [levelIndex, setLevelIndex] = useState<number>(0);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [simModeEnabled, setSimModeEnabled] = useState<boolean>(
    () => !(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches),
  );
  const [cameraFacing, setCameraFacing] = useState<'environment' | 'user'>('environment');
  const [muted, setMuted] = useState<boolean>(false);
  const [showSimControls, setShowSimControls] = useState<boolean>(false);

  const controllerRef = useRef<GameControllerHandle | null>(null);
  const currentLevel = GAME_LEVELS[levelIndex] ?? GAME_LEVELS[0];

  const startMission = useCallback(async (idx: number) => {
    try {
      audioEngine.unlock();
    } catch {
      // ignore audio unlock failure
    }
    try {
      await controllerRef.current?.enableSensors();
    } catch {
      // sensors denied/unsupported: game still starts in simulator mode
    }
    setLevelIndex(idx);
    controllerRef.current?.startLevel(idx);
    setPhase('playing');
  }, []);

  const handleToggleMute = () => {
    const next = !muted;
    setMuted(next);
    audioEngine.setMuted(next);
  };

  const handleSwitchCamera = () => {
    const next = cameraFacing === 'environment' ? 'user' : 'environment';
    setCameraFacing(next);
    controllerRef.current?.switchCameraFacing();
  };

  const accuracyPct =
    hud.shotsFired > 0 ? Math.round((hud.shotsHit / hud.shotsFired) * 100) : 0;

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#090D12] text-slate-100">
      {/* Full-Viewport AR Camera + Three.js 3D World */}
      <ARGameViewport
        phase={phase}
        levelIndex={levelIndex}
        simModeEnabled={simModeEnabled}
        cameraFacing={cameraFacing}
        onHudUpdate={setHud}
        onPhaseChange={setPhase}
        controllerRef={controllerRef}
      />

      {/* TOP HUD BAR (Playing State) */}
      {phase === 'playing' && (
        <header className="pointer-events-none absolute top-0 inset-x-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-5">
          {/* Left: Level & Score */}
          <div className="pointer-events-auto bg-[#0C121B]/85 border border-slate-700/70 rounded-xl px-4 py-2.5 shadow-lg">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-semibold text-cyan-400">
                Level {currentLevel.id} of {GAME_LEVELS.length}
              </span>
              <span aria-hidden="true">·</span>
              <span>{currentLevel.title}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-4">
              <div>
                <span className="text-xs text-slate-400 mr-1.5">Targets</span>
                <span className="font-mono-num text-lg font-bold text-white">
                  {hud.targetsCleared}/{hud.targetsTotal}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-400 mr-1.5">Score</span>
                <span className="font-mono-num text-lg font-bold text-amber-400">
                  {hud.score}
                </span>
              </div>
              {currentLevel.id === 5 && (
                <div>
                  <span className="text-xs text-slate-400 mr-1.5">Shields</span>
                  <span className="font-mono-num text-lg font-bold text-rose-400">
                    {hud.health}/{hud.maxHealth}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Utility Action Controls */}
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => controllerRef.current?.recenter()}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0C121B]/85 hover:bg-slate-800 border border-slate-700/70 rounded-lg text-slate-200 transition-colors whitespace-nowrap"
              title="Recenter standing box and camera heading"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Recenter</span>
            </button>
            <button
              type="button"
              onClick={handleSwitchCamera}
              className="p-2 bg-[#0C121B]/85 hover:bg-slate-800 border border-slate-700/70 rounded-lg text-slate-200 transition-colors"
              title="Switch Rear / Front Camera"
              aria-label="Switch camera"
            >
              <SwitchCamera className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleToggleMute}
              className="p-2 bg-[#0C121B]/85 hover:bg-slate-800 border border-slate-700/70 rounded-lg text-slate-200 transition-colors"
              title={muted ? 'Unmute audio' : 'Mute audio'}
              aria-label={muted ? 'Unmute audio' : 'Mute audio'}
            >
              {muted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setPhase('menu')}
              className="px-3 py-2 text-xs font-medium bg-[#0C121B]/85 hover:bg-slate-800 border border-slate-700/70 rounded-lg text-slate-200 transition-colors whitespace-nowrap"
            >
              Menu
            </button>
          </div>
        </header>
      )}

      {/* COMPACT AMMO COUNT + SMALL RELOAD BUTTON (kept tiny so it never blocks the view) */}
      {phase === 'playing' && (
        <aside className="pointer-events-auto absolute right-2 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1.5">
          <div
            className={`px-2 py-0.5 rounded-full bg-[#0C121B]/70 border border-slate-700/60 font-mono-num text-[11px] font-bold ${
              hud.ammo === 0 ? 'text-rose-400' : hud.ammo <= 5 ? 'text-amber-400' : 'text-white'
            }`}
          >
            {hud.ammo}/{hud.maxAmmo}
          </div>
          <button
            type="button"
            aria-label="Reload"
            onClick={() => controllerRef.current?.reload()}
            disabled={hud.isReloading || hud.ammo === hud.maxAmmo}
            className={`w-10 h-10 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors ${
              hud.isReloading
                ? 'bg-amber-500/30 text-amber-200 border-amber-400/60'
                : hud.ammo === 0
                  ? 'bg-rose-600/90 text-white border-rose-300/60 animate-pulse'
                  : hud.ammo < hud.maxAmmo
                    ? 'bg-cyan-600/80 text-white border-cyan-300/50'
                    : 'bg-[#0C121B]/60 text-slate-500 border-slate-700/50'
            }`}
          >
            {hud.isReloading ? `${Math.round(hud.reloadProgress * 100)}` : <RotateCw className="w-4 h-4" />}
          </button>
        </aside>
      )}

      {/* FLOOR GUARDIAN BOX NOTICE (Only Visible When Camera Points Down At Feet) */}
      {phase === 'playing' && hud.isLookingAtFeet && (
        <div className="pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-xl bg-[#0C121B]/90 border border-cyan-500/50 text-center shadow-lg">
          <div className="font-display text-sm font-semibold text-cyan-300">
            {hud.boxDistanceNormalized > 0.75
              ? 'Boundary Warning — Step Back Inside Box'
              : 'Standing Square Box Active'}
          </div>
          <div className="text-xs text-slate-300 mt-0.5">
            Keep both feet inside the square perimeter. Tilt phone up to resume shooting.
          </div>
        </div>
      )}

      {/* OFF-SCREEN DIRECTIONAL TARGET CUE (Level 3 / Level 4 Rear Search / Level 5) */}
      {phase === 'playing' && !hud.isLookingAtFeet && hud.offscreenDirection && (
        <div className="pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0C121B]/90 border border-amber-500/60 text-amber-300 shadow-lg">
          {hud.offscreenDirection === 'left' && (
            <>
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs font-semibold">
                Pan Left — {hud.offscreenCount} Target{hud.offscreenCount > 1 ? 's' : ''}
              </span>
            </>
          )}
          {hud.offscreenDirection === 'right' && (
            <>
              <span className="text-xs font-semibold">
                Pan Right — {hud.offscreenCount} Target{hud.offscreenCount > 1 ? 's' : ''}
              </span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
          {hud.offscreenDirection === 'behind' && (
            <>
              <RotateCw className="w-4 h-4" />
              <span className="text-xs font-semibold">
                Turn Around Inside Box — Target Behind You
              </span>
            </>
          )}
        </div>
      )}

      {/* FLOATING HIT SCORE FEEDBACK */}
      {phase === 'playing' && hud.lastHitFeedback && (
        <div
          key={hud.lastHitFeedback.id}
          className="pointer-events-none absolute top-36 left-1/2 -translate-x-1/2 z-20 text-center animate-bounce"
        >
          <span
            className={`font-display text-lg font-bold ${
              hud.lastHitFeedback.zone === 'bullseye'
                ? 'text-amber-400'
                : hud.lastHitFeedback.zone === 'inner'
                  ? 'text-emerald-400'
                  : 'text-cyan-300'
            }`}
          >
            +{hud.lastHitFeedback.points}{' '}
            {hud.lastHitFeedback.zone === 'bullseye'
              ? 'Bullseye'
              : hud.lastHitFeedback.zone === 'inner'
                ? 'Inner Ring'
                : 'Hit'}
          </span>
        </div>
      )}

      {/* BOTTOM GESTURE TELEMETRY & OPTIONAL SIMULATOR CONTROLS */}
      {phase === 'playing' && (
        <div className="pointer-events-none absolute bottom-3 inset-x-3 sm:inset-x-5 z-20 flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3">
          {/* Bottom-Left: Real Hand Gesture & Aim Status */}
          <div className="pointer-events-none bg-[#0C121B]/60 border border-slate-700/50 rounded-lg px-2.5 py-1.5 text-[11px] max-w-[11.5rem] sm:max-w-xs w-auto">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 font-medium text-slate-200">
                <Hand className="w-3.5 h-3.5 text-cyan-400" />
                {hud.gesture.isGunPose
                  ? 'Hand Gun Active'
                  : simModeEnabled
                    ? 'Desktop Aim Ready'
                    : hud.gesture.handDetected
                      ? 'Point index, curl others'
                      : 'Show hand (30-40 cm)'}
              </span>
              <span className="font-mono-num text-slate-400">
                {hud.aimInfo.hasTargetLock
                  ? `${hud.aimInfo.distanceMeters.toFixed(1)}m Lock`
                  : 'Scanning'}
              </span>
            </div>

            {/* Recoil Impulse Meter */}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-slate-400 whitespace-nowrap">Recoil Trigger</span>
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-400 transition-all duration-75"
                  style={{ width: `${Math.round(hud.gesture.recoilEnergy * 100)}%` }}
                />
              </div>
            </div>

            <div className="mt-1.5 hidden sm:flex items-center gap-2 text-[11px] text-slate-400">
              <span>{hud.cameraActive ? 'Camera AR' : 'Training Range'}</span>
              <span aria-hidden="true">·</span>
              <span>
                {hud.mediapipeReady
                  ? 'MediaPipe Active'
                  : hud.mediapipeError
                    ? 'Sim Input'
                    : 'Loading Tracker'}
              </span>
            </div>
          </div>

          {/* Bottom-Right: Collapsible Practice/Desktop Controls */}
          <div className="pointer-events-auto flex flex-col items-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowSimControls((s) => !s)}
              className="px-3 py-1.5 text-xs font-medium bg-[#0C121B]/85 hover:bg-slate-800 border border-slate-700/70 rounded-lg text-slate-300 transition-colors"
            >
              {showSimControls ? 'Hide' : 'Test'}
            </button>

            {showSimControls && (
              <div className="flex flex-wrap items-center justify-end gap-1.5 bg-[#0C121B]/90 border border-slate-700/80 rounded-xl p-2">
                <button
                  type="button"
                  onClick={() => setSimModeEnabled((v) => !v)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    simModeEnabled
                      ? 'bg-cyan-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {simModeEnabled ? 'Sim Aim: On' : 'Sim Aim: Off'}
                </button>
                <button
                  type="button"
                  onClick={() => controllerRef.current?.triggerSimRecoil()}
                  className="px-2.5 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg transition-colors whitespace-nowrap"
                >
                  Recoil Fire (Space)
                </button>
                <button
                  type="button"
                  onClick={() => controllerRef.current?.lookAtFeetSim()}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Look at Feet
                </button>
                <button
                  type="button"
                  onClick={() => controllerRef.current?.turnAroundSim()}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  Turn 180°
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN MENU / CALIBRATION LOBBY */}
      {phase === 'menu' && (
        <div className="absolute inset-0 z-30 flex p-3 sm:p-4 bg-[#090D12]/80 overflow-y-auto" style={{ touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' }}>
          <div className="relative w-full max-w-3xl m-auto bg-[#0F1622] border border-slate-700/80 rounded-2xl p-4 sm:p-8 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div>
                <div className="text-xs font-medium text-cyan-400">
                  Augmented Reality Gesture Range
                </div>
                <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white mt-1">
                  StringShot AR
                </h1>
              </div>
              <button
                type="button"
                onClick={() => startMission(levelIndex)}
                className="hidden sm:inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-base transition-colors whitespace-nowrap shrink-0"
              >
                <Crosshair className="w-5 h-5" />
                Launch Level {levelIndex + 1}
              </button>
            </div>

            {/* 3 Core Gesture & Guardian Rules */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="text-xs font-semibold text-cyan-400">01. Pistol Hand Grip</div>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Hold your phone in one hand and extend your other hand in front of the camera in a pistol gesture. The 3D AR gun appears directly in your hand.
                </p>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="text-xs font-semibold text-amber-400">02. Aim & Recoil Fire</div>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Point at a hanging string target to project the bullet impact circle. Snap your hand upward like real gun recoil to fire from your 20-round magazine.
                </p>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="text-xs font-semibold text-emerald-400">03. Standing Square Box</div>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Look down toward your feet to reveal your standing square box. Moving your legs or stepping outside the square ends the run.
                </p>
              </div>
            </div>

            {/* 5-Level Selector */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-base font-semibold text-white">
                  Select Mission (5 Levels)
                </h2>
                <span className="text-xs text-slate-400">
                  {hud.cameraActive ? 'Live Camera Ready' : 'Range Simulator Fallback Ready'}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                {GAME_LEVELS.map((lvl, idx) => {
                  const selected = idx === levelIndex;
                  return (
                    <button
                      key={lvl.id}
                      type="button"
                      onClick={() => setLevelIndex(idx)}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        selected
                          ? 'bg-cyan-950/60 border-cyan-400 text-white'
                          : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      <div className="font-mono-num text-xs font-bold text-cyan-400">
                        Level {lvl.id}
                      </div>
                      <div className="font-display text-sm font-semibold mt-0.5 truncate">
                        {lvl.title}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1">
                        {lvl.totalTargets} Targets
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-slate-300 leading-relaxed bg-slate-900/50 border border-slate-800/80 rounded-xl px-4 py-3">
                <span className="font-semibold text-white">{currentLevel.subtitle}:</span>{' '}
                {currentLevel.briefing}
              </p>
            </div>

            {/* Mobile: always-visible launch button */}
            <div className="sm:hidden sticky bottom-0 -mx-4 -mb-4 mt-4 px-4 py-3 bg-[#0F1622]/95 border-t border-slate-800 rounded-b-2xl">
              <button
                type="button"
                onClick={() => startMission(levelIndex)}
                className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-amber-500 active:bg-amber-400 text-slate-950 font-display font-bold text-base"
              >
                <Crosshair className="w-5 h-5" />
                Launch Level {levelIndex + 1}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LEVEL CLEAR MODAL */}
      {phase === 'level_clear' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4 bg-[#090D12]/80">
          <div className="w-full max-w-md bg-[#0F1622] border border-emerald-500/50 rounded-2xl p-6 text-center shadow-2xl">
            <div className="text-xs font-semibold text-emerald-400">
              Level {currentLevel.id} Complete
            </div>
            <h2 className="font-display text-2xl font-bold text-white mt-1">
              {currentLevel.title} Cleared
            </h2>
            <div className="grid grid-cols-3 gap-3 my-5 py-4 border-y border-slate-800">
              <div>
                <div className="text-xs text-slate-400">Score</div>
                <div className="font-mono-num text-xl font-bold text-amber-400">{hud.score}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Accuracy</div>
                <div className="font-mono-num text-xl font-bold text-white">{accuracyPct}%</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Bullseyes</div>
                <div className="font-mono-num text-xl font-bold text-cyan-400">{hud.bullseyes}</div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPhase('menu')}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-200 transition-colors"
              >
                Menu
              </button>
              <button
                type="button"
                onClick={() => startMission(levelIndex + 1)}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-sm font-display font-bold text-slate-950 transition-colors"
              >
                Next: Level {levelIndex + 2}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OUT OF BOUNDS (STEPPED OUTSIDE SQUARE BOX) */}
      {phase === 'out_of_bounds' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4 bg-[#090D12]/85">
          <div className="w-full max-w-md bg-[#0F1622] border border-rose-500/70 rounded-2xl p-6 text-center shadow-2xl">
            <ShieldAlert className="w-10 h-10 text-rose-400 mx-auto" />
            <h2 className="font-display text-2xl font-bold text-white mt-3">
              Out of Square Box
            </h2>
            <p className="text-sm text-slate-300 mt-2">
              {hud.outOfBoundsReason ??
                'You moved outside the standing floor square boundary.'}
            </p>
            <div className="flex items-center justify-center gap-3 mt-6">
              <button
                type="button"
                onClick={() => setPhase('menu')}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-200 transition-colors"
              >
                Menu
              </button>
              <button
                type="button"
                onClick={() => startMission(levelIndex)}
                className="px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-sm font-display font-bold text-white transition-colors"
              >
                Retry Level {currentLevel.id}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GAME OVER (LEVEL 5 BREACHED) */}
      {phase === 'game_over' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4 bg-[#090D12]/85">
          <div className="w-full max-w-md bg-[#0F1622] border border-rose-500/60 rounded-2xl p-6 text-center shadow-2xl">
            <h2 className="font-display text-2xl font-bold text-white">Perimeter Breached</h2>
            <p className="text-sm text-slate-300 mt-2">
              Approaching targets reached your standing zone. Aim early and recoil-fire faster!
            </p>
            <div className="my-5 py-3 border-y border-slate-800 flex justify-around">
              <div>
                <div className="text-xs text-slate-400">Final Score</div>
                <div className="font-mono-num text-xl font-bold text-amber-400">{hud.score}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Accuracy</div>
                <div className="font-mono-num text-xl font-bold text-white">{accuracyPct}%</div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPhase('menu')}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-200 transition-colors"
              >
                Menu
              </button>
              <button
                type="button"
                onClick={() => startMission(levelIndex)}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-sm font-display font-bold text-slate-950 transition-colors"
              >
                Retry Level {currentLevel.id}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VICTORY (ALL 5 LEVELS CLEARED) */}
      {phase === 'victory' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-4 bg-[#090D12]/85">
          <div className="w-full max-w-md bg-[#0F1622] border border-amber-400/70 rounded-2xl p-6 text-center shadow-2xl">
            <div className="text-xs font-semibold text-amber-400">All 5 Levels Cleared</div>
            <h2 className="font-display text-3xl font-bold text-white mt-1">
              AR Range Master
            </h2>
            <p className="text-sm text-slate-300 mt-2">
              You neutralized every hanging string target across all 5 AR ranges while holding your square stance.
            </p>
            <div className="grid grid-cols-3 gap-3 my-5 py-4 border-y border-slate-800">
              <div>
                <div className="text-xs text-slate-400">Total Score</div>
                <div className="font-mono-num text-xl font-bold text-amber-400">{hud.score}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Accuracy</div>
                <div className="font-mono-num text-xl font-bold text-white">{accuracyPct}%</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Bullseyes</div>
                <div className="font-mono-num text-xl font-bold text-cyan-400">{hud.bullseyes}</div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPhase('menu')}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-200 transition-colors"
              >
                Level Select
              </button>
              <button
                type="button"
                onClick={() => startMission(0)}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-sm font-display font-bold text-slate-950 transition-colors"
              >
                Play Again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}