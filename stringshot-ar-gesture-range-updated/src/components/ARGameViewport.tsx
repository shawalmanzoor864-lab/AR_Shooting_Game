import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { audioEngine } from '../game/audio';
import { GAME_LEVELS } from '../game/levels';
import { MediaPipeGestureTracker } from '../game/mediapipeTracker';
import {
  AimReticleRig,
  ARGunRig,
  createAimReticle,
  createARGunModel,
  VIRTUAL_HAND_ANCHOR,
  createGuardianBox,
  createHangingTargetModel,
  GuardianBoxRig,
  HangingTargetRig,
  LoadedGameModels,
  loadGameModels,
  TARGET_BOARD_HEIGHT,
  TARGET_BOARD_WIDTH,
} from '../game/models';
import { SpatialTracker } from '../game/spatialTracking';
import {
  AimTargetHitInfo,
  CEILING_Y,
  FLOOR_Y,
  GamePhase,
  GUARDIAN_BOX_HALF_SIZE,
  HandGestureState,
  HudSnapshot,
  MAX_MAGAZINE_AMMO,
  MovementPattern,
} from '../game/types';

interface ActiveTarget {
  id: number;
  rig: HangingTargetRig;
  basePos: THREE.Vector3;
  currentPos: THREE.Vector3;
  pattern: MovementPattern;
  speed: number;
  phase: number;
  dropProgress: number; // 0 -> 1 drop-in from ceiling
  hitsRemaining: number;
  maxHits: number;
  pendulumAngleX: number;
  pendulumVelX: number;
  pendulumAngleZ: number;
  pendulumVelZ: number;
  destroyed: boolean;
  fadeOut: number;
}

interface BulletParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  rotVel: THREE.Vector3;
}

export interface GameControllerHandle {
  startLevel: (levelIndex: number) => void;
  reload: () => void;
  recenter: () => void;
  triggerSimRecoil: () => void;
  toggleSimGun: () => void;
  lookAtFeetSim: () => void;
  turnAroundSim: () => void;
  switchCameraFacing: () => void;
  enableSensors: () => Promise<boolean>;
}

interface ARGameViewportProps {
  phase: GamePhase;
  levelIndex: number;
  simModeEnabled: boolean;
  swapHand: boolean;
  cameraFacing: 'environment' | 'user';
  onHudUpdate: (hud: HudSnapshot) => void;
  onPhaseChange: (nextPhase: GamePhase) => void;
  controllerRef: React.MutableRefObject<GameControllerHandle | null>;
}

// Pre-allocated scratch math objects (zero GC in render loop)
const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
const _lookTarget = new THREE.Vector3();
const _boardNormal = new THREE.Vector3();
const _shotRaycaster = new THREE.Raycaster();
const _quatA = new THREE.Quaternion();
const _unitZ = new THREE.Vector3(0, 0, 1);
const _handPos = new THREE.Vector3();
const _handFwd = new THREE.Vector3();
const _handUp = new THREE.Vector3();
const _basisX = new THREE.Vector3();
const _basisM = new THREE.Matrix4();
const _anchorLocal = new THREE.Vector3();

// AR gun <-> hand fitting
const GUN_HAND_DISTANCE = 0.5; // metres in front of the camera the gun is drawn
const GUN_GRIP_LOCAL = new THREE.Vector3(0, -0.02, -0.02); // grip centre in rig space (barrel = +Z)

const BOARD_HALF_W = TARGET_BOARD_WIDTH * 0.5;
const BOARD_HALF_H = TARGET_BOARD_HEIGHT * 0.5;

export const ARGameViewport: React.FC<ARGameViewportProps> = ({
  phase,
  levelIndex,
  simModeEnabled,
  swapHand,
  cameraFacing,
  onHudUpdate,
  onPhaseChange,
  controllerRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Sync latest React props into refs so the WebGL loop never restarts on UI changes
  const phaseRef = useRef<GamePhase>(phase);
  const levelIndexRef = useRef<number>(levelIndex);
  const simModeRef = useRef<boolean>(simModeEnabled);
  const swapHandRef = useRef<boolean>(swapHand);
  const cameraFacingRef = useRef<'environment' | 'user'>(cameraFacing);
  const onHudUpdateRef = useRef(onHudUpdate);
  const onPhaseChangeRef = useRef(onPhaseChange);

  phaseRef.current = phase;
  levelIndexRef.current = levelIndex;
  simModeRef.current = simModeEnabled;
  swapHandRef.current = swapHand;
  cameraFacingRef.current = cameraFacing;
  onHudUpdateRef.current = onHudUpdate;
  onPhaseChangeRef.current = onPhaseChange;

  useEffect(() => {
    const mountEl = containerRef.current;
    const videoEl = videoRef.current;
    if (!mountEl || !videoEl) return;

    // 1. Software WebGL detection
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    // 2. Renderer + Scene + Camera
    const isMobile =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isSoftwareGl && !isMobile,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, isMobile ? 1.25 : 2));
    renderer.setSize(mountEl.clientWidth, mountEl.clientHeight);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    mountEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      62,
      mountEl.clientWidth / Math.max(1, mountEl.clientHeight),
      0.05,
      80,
    );

    // Mandatory studio environment map for metallic gun slide & sights
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 3-point balanced lighting rig
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.05);
    scene.add(hemiLight);
    const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.85);
    keyLight.position.set(4, 9, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    rimLight.position.set(-5, 3, -6);
    scene.add(rimLight);

    // Fallback training backdrop (automatically hidden when live camera stream is active)
    const fallbackBackdrop = new THREE.Group();
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(42, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0x0b121c,
        side: THREE.BackSide,
      }),
    );
    fallbackBackdrop.add(skyDome);

    const simFloorGrid = new THREE.GridHelper(32, 32, 0x1e3a5f, 0x111c2b);
    simFloorGrid.position.y = FLOOR_Y - 0.015;
    fallbackBackdrop.add(simFloorGrid);

    // Subtle overhead range gantry ring so strings visually anchor even without camera
    const gantryRing = new THREE.Mesh(
      new THREE.TorusGeometry(8.5, 0.04, 8, 64),
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6, metalness: 0.5 }),
    );
    gantryRing.rotation.x = Math.PI / 2;
    gantryRing.position.y = CEILING_Y + 0.04;
    fallbackBackdrop.add(gantryRing);
    scene.add(fallbackBackdrop);

    // 3. Procedural textures & persistent 3D rigs
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const guardianBox: GuardianBoxRig = createGuardianBox(maxAniso);
    scene.add(guardianBox.root);

    // GLB models (Samurai Edge pistol + shooting-range target) load asynchronously
    let gameModels: LoadedGameModels | null = null;
    let gunRig: ARGunRig | null = null;
    let pendingLevelStart: number | null = null;

    const aimReticle: AimReticleRig = createAimReticle();
    scene.add(aimReticle.root);

    // 4. Trackers
    const mpTracker = new MediaPipeGestureTracker();
    const spatialTracker = new SpatialTracker();

    // Load the pistol + target GLB models, then build the gun rig and start any queued level
    loadGameModels(maxAniso)
      .then((models) => {
        if (disposed) return;
        gameModels = models;
        const rig = createARGunModel(models.gunScene);
        rig.root.visible = false;
        scene.add(rig.root);
        gunRig = rig;
        if (pendingLevelStart !== null) beginLevel(pendingLevelStart);
      })
      .catch((err) => {
        console.error('Failed to load game models (assets/models/*.glb):', err);
      });

    // 5. Mutable simulation state
    let cameraActive = false;
    let currentStream: MediaStream | null = null;
    let activeTargets: ActiveTarget[] = [];
    let particles: BulletParticle[] = [];
    let nextTargetId = 1;
    let spawnedInLevel = 0;
    let clearedInLevel = 0;
    let score = 0;
    let shotsFired = 0;
    let shotsHit = 0;
    let bullseyes = 0;
    let ammo = MAX_MAGAZINE_AMMO;
    let isReloading = false;
    let reloadTimer = 0;
    const RELOAD_DURATION = 0.88;
    let health = 3;
    const MAX_HEALTH = 3;

    // Gun animation states
    let gunOpacitySmooth = 0;
    let gunKickPitch = 0;
    let slideBlowback = 0;
    let muzzleFlashTimer = 0;

    // Simulator / manual aim & recoil fallback
    let simGunActive = true;
    let simAimX = 0.5;
    let simAimY = 0.48;
    let simRecoilQueue = false;
    let isDraggingLook = false;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let pointerDownTime = 0;
    let pointerMovedDist = 0;

    let lastHitCounter = 0;
    let lastHitFeedback: HudSnapshot['lastHitFeedback'] = null;
    let outOfBoundsReason: string | null = null;
    let outsideBoxGraceTimer = 0;

    // Reusable geometries/materials for decals & particles
    const decalGeo = new THREE.CircleGeometry(0.024, 12);
    const decalMat = new THREE.MeshBasicMaterial({
      color: 0x090d12,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const decalRimGeo = new THREE.RingGeometry(0.024, 0.038, 12);
    const decalRimMat = new THREE.MeshBasicMaterial({
      color: 0xfef3c7,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const sparkGeo = new THREE.BoxGeometry(0.025, 0.025, 0.025);
    const casingGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.02, 8);
    const casingMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      metalness: 0.9,
      roughness: 0.2,
    });

    // Camera startup
    const startCamera = async (facing: 'environment' | 'user') => {
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
        currentStream = null;
      }
      cameraActive = false;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
        currentStream = stream;
        videoEl.srcObject = stream;
        await videoEl.play();
        cameraActive = true;
        fallbackBackdrop.visible = false;
      } catch {
        cameraActive = false;
        fallbackBackdrop.visible = true;
      }
    };

    // Init MediaPipe + Camera
    mpTracker.init();
    startCamera(cameraFacingRef.current);

    // Helper: Clear all targets from scene
    const clearAllTargets = () => {
      for (const t of activeTargets) {
        scene.remove(t.rig.root);
      }
      activeTargets = [];
    };

    // Helper: Spawn next target according to level design
    const spawnTarget = (lvlIdx: number, slotIndex: number) => {
      if (!gameModels) return;
      const lvl = GAME_LEVELS[lvlIdx] ?? GAME_LEVELS[0];
      const rig = createHangingTargetModel(gameModels.targetScene, TARGET_BOARD_HEIGHT);

      let azDeg = 0;
      if (lvl.fixedAzimuths && lvl.fixedAzimuths.length > 0) {
        azDeg = lvl.fixedAzimuths[slotIndex % lvl.fixedAzimuths.length];
      } else {
        const [minAz, maxAz] = lvl.azimuthRange;
        azDeg = minAz + Math.random() * (maxAz - minAz);
      }

      const [minDist, maxDist] = lvl.distanceRange;
      const dist = minDist + Math.random() * (maxDist - minDist);

      const [minEl, maxEl] = lvl.elevationRange;
      const baseY = minEl + Math.random() * (maxEl - minEl);

      const azRad = THREE.MathUtils.degToRad(azDeg);
      const x = Math.sin(azRad) * dist;
      const z = -Math.cos(azRad) * dist;

      const pattern = lvl.patterns[slotIndex % lvl.patterns.length];
      const [minSpd, maxSpd] = lvl.speedRange;
      const speed = minSpd + Math.random() * (maxSpd - minSpd);

      const basePos = new THREE.Vector3(x, baseY, z);
      const currentPos = basePos.clone();

      rig.boardGroup.position.copy(currentPos);
      // Orient board to face player origin (0,0,0)
      _lookTarget.set(0, currentPos.y, 0);
      rig.boardGroup.lookAt(_lookTarget);

      scene.add(rig.root);

      activeTargets.push({
        id: nextTargetId++,
        rig,
        basePos,
        currentPos,
        pattern,
        speed,
        phase: Math.random() * Math.PI * 2,
        dropProgress: 0,
        hitsRemaining: lvl.hitsToDestroy,
        maxHits: lvl.hitsToDestroy,
        pendulumAngleX: 0,
        pendulumVelX: 0,
        pendulumAngleZ: 0,
        pendulumVelZ: 0,
        destroyed: false,
        fadeOut: 1,
      });
    };

    const beginLevel = (lvlIdx: number) => {
      if (!gameModels) {
        // Models are still downloading - start this level as soon as they are ready
        pendingLevelStart = lvlIdx;
        return;
      }
      pendingLevelStart = null;
      clearAllTargets();
      const lvl = GAME_LEVELS[lvlIdx] ?? GAME_LEVELS[0];
      spawnedInLevel = 0;
      clearedInLevel = 0;
      ammo = MAX_MAGAZINE_AMMO;
      isReloading = false;
      reloadTimer = 0;
      health = MAX_HEALTH;
      outOfBoundsReason = null;
      outsideBoxGraceTimer = 0;
      spatialTracker.playerPos.set(0, 0, 0);

      // Spawn initial simultaneous targets
      const initialCount = Math.min(lvl.maxSimultaneous, lvl.totalTargets);
      for (let i = 0; i < initialCount; i++) {
        spawnTarget(lvlIdx, spawnedInLevel);
        spawnedInLevel++;
      }
    };

    const spawnBurstParticles = (worldPos: THREE.Vector3, colorHex: number, count: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: colorHex });
      for (let i = 0; i < count; i++) {
        const mesh = new THREE.Mesh(sparkGeo, mat);
        mesh.position.copy(worldPos);
        scene.add(mesh);
        particles.push({
          mesh,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 4.5,
            Math.random() * 3.2 + 0.5,
            (Math.random() - 0.5) * 4.5,
          ),
          life: 0,
          maxLife: 0.45 + Math.random() * 0.25,
          rotVel: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
        });
      }
    };

    const ejectBrassCasing = () => {
      const mesh = new THREE.Mesh(casingGeo, casingMat);
      if (gunRig) {
        gunRig.slide.getWorldPosition(_vec3A);
      } else {
        _vec3A.copy(camera.position);
      }
      mesh.position.copy(_vec3A);
      scene.add(mesh);
      const right = new THREE.Vector3(1, 0.8, 0.2).applyQuaternion(camera.quaternion).normalize();
      particles.push({
        mesh,
        vel: right.multiplyScalar(1.8 + Math.random() * 0.6),
        life: 0,
        maxLife: 0.65,
        rotVel: new THREE.Vector3(18, 24, 14),
      });
    };

    const triggerReload = () => {
      if (isReloading || ammo === MAX_MAGAZINE_AMMO) return;
      isReloading = true;
      reloadTimer = 0;
      audioEngine.playReload();
    };

    // Expose imperative handle to React UI buttons
    controllerRef.current = {
      startLevel: (idx: number) => {
        if (idx === 0) {
          score = 0;
          shotsFired = 0;
          shotsHit = 0;
          bullseyes = 0;
        }
        spatialTracker.recenter();
        beginLevel(idx);
      },
      reload: triggerReload,
      recenter: () => {
        spatialTracker.recenter();
        outOfBoundsReason = null;
        outsideBoxGraceTimer = 0;
      },
      triggerSimRecoil: () => {
        simRecoilQueue = true;
      },
      toggleSimGun: () => {
        simGunActive = !simGunActive;
      },
      lookAtFeetSim: () => {
        spatialTracker.setManualPitch(-0.85);
      },
      turnAroundSim: () => {
        spatialTracker.addManualYaw(Math.PI);
      },
      switchCameraFacing: () => {
        const next = cameraFacingRef.current === 'environment' ? 'user' : 'environment';
        cameraFacingRef.current = next;
        startCamera(next);
      },
      enableSensors: () => spatialTracker.enableSensors(),
    };

    // Pointer / Touch look & desktop sim aiming handlers
    const domCanvas = renderer.domElement;
    const onPointerDown = (e: PointerEvent) => {
      isDraggingLook = true;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      pointerDownTime = performance.now();
      pointerMovedDist = 0;
      audioEngine.unlock();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = domCanvas.getBoundingClientRect();
      simAimX = (e.clientX - rect.left) / Math.max(1, rect.width);
      simAimY = (e.clientY - rect.top) / Math.max(1, rect.height);

      if (isDraggingLook) {
        const dx = e.clientX - lastPointerX;
        const dy = e.clientY - lastPointerY;
        pointerMovedDist += Math.hypot(dx, dy);
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        spatialTracker.addManualLookDelta(dx, dy);
      }
    };

    const onPointerUp = () => {
      const elapsed = performance.now() - pointerDownTime;
      // Quick tap without dragging fires in Simulator Mode (when MediaPipe hand isn't present)
      if (
        isDraggingLook &&
        pointerMovedDist < 10 &&
        elapsed < 260 &&
        simModeRef.current &&
        phaseRef.current === 'playing' &&
        simGunActive
      ) {
        simRecoilQueue = true;
      }
      isDraggingLook = false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && phaseRef.current === 'playing') {
        e.preventDefault();
        if (simModeRef.current && simGunActive) {
          simRecoilQueue = true;
        }
      } else if (e.code === 'KeyR' && phaseRef.current === 'playing') {
        triggerReload();
      }
    };

    domCanvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    const onResize = () => {
      if (!mountEl) return;
      const w = mountEl.clientWidth;
      const h = Math.max(1, mountEl.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // Fire shot using the exact dispersion circle projected onto the board
    const executeShot = (
      aimX: number,
      aimY: number,
      stability: number,
      aimInfo: AimTargetHitInfo,
      rayHitPoint: THREE.Vector3 | null,
      rayHitTarget: ActiveTarget | null,
    ) => {
      if (isReloading) return;
      if (ammo <= 0) {
        audioEngine.playDryFire();
        return;
      }

      ammo--;
      shotsFired++;
      audioEngine.playGunshot();
      gunKickPitch = 0.28;
      slideBlowback = 0.055;
      muzzleFlashTimer = 0.06;
      ejectBrassCasing();

      // Determine final impact with precision dispersion based on hand steadiness
      if (rayHitTarget && rayHitPoint && !rayHitTarget.destroyed && gameModels) {
        const disp = aimInfo.dispersionRadiusMeters;
        const spreadAngle = Math.random() * Math.PI * 2;
        const spreadR = Math.pow(Math.random(), 0.75) * disp * (1.05 - stability * 0.55);
        const board = rayHitTarget.rig.boardGroup;

        // Convert the aimed point into target-local space and add the dispersion offset
        board.updateMatrixWorld(true);
        _vec3B.copy(rayHitPoint);
        board.worldToLocal(_vec3B);
        const localX = _vec3B.x + Math.cos(spreadAngle) * spreadR;
        const localY = _vec3B.y + Math.sin(spreadAngle) * spreadR;

        // Fire a ray straight into the 3D target from the displaced point - only the real
        // silhouette of the model can be hit (spread that lands off the body is a miss).
        board.getWorldQuaternion(_quatA);
        _vec3C.set(localX, localY, 0.6);
        board.localToWorld(_vec3C);
        _boardNormal.set(0, 0, -1).applyQuaternion(_quatA);
        _shotRaycaster.set(_vec3C, _boardNormal);
        const shotHits = _shotRaycaster.intersectObject(rayHitTarget.rig.hitDisc, false);

        if (shotHits.length > 0) {
          const shot = shotHits[0];

          // World-space impact point and surface normal
          _vec3A.copy(shot.point);
          if (shot.face) {
            _boardNormal.copy(shot.face.normal).transformDirection(shot.object.matrixWorld);
          } else {
            _boardNormal.set(0, 0, 1).applyQuaternion(_quatA);
          }

          // Stick 3D bullet hole decal onto the target surface (aligned to its normal)
          _vec3B.copy(_vec3A);
          board.worldToLocal(_vec3B);
          _quatA.invert();
          const localNormal = _boardNormal.clone().applyQuaternion(_quatA);
          const hole = new THREE.Mesh(decalGeo, decalMat);
          const rim = new THREE.Mesh(decalRimGeo, decalRimMat);
          hole.position.copy(_vec3B).addScaledVector(localNormal, 0.003);
          rim.position.copy(_vec3B).addScaledVector(localNormal, 0.0015);
          hole.quaternion.setFromUnitVectors(_unitZ, localNormal);
          rim.quaternion.copy(hole.quaternion);
          rayHitTarget.rig.decalGroup.add(hole, rim);

          const evalHit = shot.uv
            ? gameModels.sampleTargetZone(shot.uv.x, shot.uv.y)
            : { onSilhouette: false, zone: 'outer' as const, points: 0 };
          const { zone, points: pts } = evalHit;

          // Apply physical pendulum impulse to the hanging target
          const hitLocalX = _vec3B.x;
          const hitLocalY = _vec3B.y;
          rayHitTarget.pendulumVelX += 4.8 + (hitLocalY / BOARD_HALF_H) * 2.2;
          rayHitTarget.pendulumVelZ -= (hitLocalX / BOARD_HALF_W) * 3.8;

          if (evalHit.onSilhouette) {
            shotsHit++;
            if (zone === 'bullseye') bullseyes++;

            score += pts;
            lastHitCounter++;
            lastHitFeedback = { id: lastHitCounter, points: pts, zone };
            audioEngine.playTargetHit(zone);

            // World burst sparks at impact
            _vec3C.copy(_vec3A).addScaledVector(_boardNormal, 0.05);
            spawnBurstParticles(_vec3C, zone === 'bullseye' ? 0xfbbf24 : 0x38bdf8, 8);

            rayHitTarget.hitsRemaining--;
            if (rayHitTarget.hitsRemaining <= 0) {
              rayHitTarget.destroyed = true;
              clearedInLevel++;
              audioEngine.playTargetBreak();
              spawnBurstParticles(rayHitTarget.currentPos, 0xf59e0b, 16);

              const lvl = GAME_LEVELS[levelIndexRef.current] ?? GAME_LEVELS[0];
              if (clearedInLevel >= lvl.totalTargets) {
                audioEngine.playLevelClear();
                if (levelIndexRef.current >= GAME_LEVELS.length - 1) {
                  onPhaseChangeRef.current('victory');
                } else {
                  onPhaseChangeRef.current('level_clear');
                }
              } else if (spawnedInLevel < lvl.totalTargets) {
                // Spawn next target if under maxSimultaneous
                const aliveCount = activeTargets.filter((t) => !t.destroyed).length;
                if (aliveCount < lvl.maxSimultaneous) {
                  spawnTarget(levelIndexRef.current, spawnedInLevel);
                  spawnedInLevel++;
                }
              }
            }
          }
        }
      } else {
        // Missed shot: subtle tracer spark out in the direction of aim
        _ndc.set(aimX * 2 - 1, -(aimY * 2 - 1));
        _raycaster.setFromCamera(_ndc, camera);
        _vec3A.copy(_raycaster.ray.origin).addScaledVector(_raycaster.ray.direction, 6.5);
        spawnBurstParticles(_vec3A, 0x94a3b8, 4);
      }
    };

    // Main loop
    const clock = new THREE.Clock();
    let frameId = 0;
    let lastHudEmit = 0;
    let disposed = false;

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (disposed) return;
      const delta = Math.min(clock.getDelta(), 0.08);
      const elapsed = clock.getElapsedTime();
      const nowMs = performance.now();
      const curPhase = phaseRef.current;

      // Update camera spatial orientation & position
      spatialTracker.update(camera, delta);
      const cameraPitch = spatialTracker.getCameraPitch(camera);
      const isLookingAtFeet = cameraPitch < -0.95; // Looking steeply down (~55°+) at the floor/feet

      // Sync backdrop visibility with live camera feed
      fallbackBackdrop.visible = !cameraActive;

      // Process MediaPipe Hand & Foot landmarks if camera active
      const mirrored = cameraFacingRef.current === 'user';
      const mpState: HandGestureState = cameraActive && curPhase === 'playing'
        ? mpTracker.processVideoFrame(videoEl, nowMs, {
            mirrored,
            checkFeet: isLookingAtFeet,
            screenW: renderer.domElement.clientWidth || mountEl.clientWidth,
            screenH: renderer.domElement.clientHeight || mountEl.clientHeight,
          })
        : {
            handDetected: false,
            isGunPose: false,
            confidence: 0,
            handScreenX: 0.62,
            handScreenY: 0.72,
            aimScreenX: simAimX,
            aimScreenY: simAimY,
            handRoll: 0,
            handScale: 0.22,
            handUpX: 0,
            handUpY: 1,
            handUpZ: 0,
            handForwardX: 0,
            handForwardY: 0,
            handForwardZ: -1,
            handIsRight: true,
            stability: 0.85,
            recoilEnergy: 0,
            recoilTriggered: false,
            feetScreenPoints: [],
          };

      // Resolve effective gesture (live MediaPipe hand OR desktop sim fallback when hand not visible)
      const useSimGun = simModeRef.current && !mpState.isGunPose && simGunActive;
      const effectiveGunPose = mpState.isGunPose || (curPhase === 'playing' && useSimGun);
      // Live hand frame in world space: palm position, barrel (forward) and up directions
      let liveAimX = mpState.aimScreenX;
      let liveAimY = mpState.aimScreenY;
      if (mpState.isGunPose) {
        camera.updateMatrixWorld();
        _ndc.set(mpState.handScreenX * 2 - 1, -(mpState.handScreenY * 2 - 1));
        _vec3A.set(_ndc.x, _ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
        _handPos.copy(camera.position).addScaledVector(_vec3A, GUN_HAND_DISTANCE);
        _handFwd
          .set(mpState.handForwardX, mpState.handForwardY, mpState.handForwardZ)
          .applyQuaternion(camera.quaternion)
          .normalize();
        _handUp
          .set(mpState.handUpX, mpState.handUpY, mpState.handUpZ)
          .applyQuaternion(camera.quaternion);
        // Aim = where the barrel line lands on screen (the point 8 m along the hand's pointing direction)
        _vec3B.copy(_handPos).addScaledVector(_handFwd, 8);
        _vec3C.copy(_vec3B).applyMatrix4(camera.matrixWorldInverse);
        if (_vec3C.z < -0.3) {
          _vec3B.project(camera);
          liveAimX = THREE.MathUtils.clamp((_vec3B.x + 1) / 2, 0.03, 0.97);
          liveAimY = THREE.MathUtils.clamp((1 - _vec3B.y) / 2, 0.03, 0.97);
        }
      }
      const effAimX = mpState.isGunPose ? liveAimX : simAimX;
      const effAimY = mpState.isGunPose ? liveAimY : simAimY;
      const effHandX = mpState.isGunPose ? mpState.handScreenX : 0.64 + (simAimX - 0.5) * 0.25;
      const effHandY = mpState.isGunPose ? mpState.handScreenY : 0.74 + (simAimY - 0.5) * 0.18;
      const effStability = mpState.isGunPose ? mpState.stability : 0.88;
      const effRecoilTriggered = mpState.isGunPose
        ? mpState.recoilTriggered
        : useSimGun && simRecoilQueue;
      simRecoilQueue = false;

      // 1. Guardian Square Box Visibility & Boundary Check
      guardianBox.root.visible = isLookingAtFeet;
      const px = spatialTracker.playerPos.x;
      const pz = spatialTracker.playerPos.z;
      let boxDistNorm = Math.max(Math.abs(px), Math.abs(pz)) / GUARDIAN_BOX_HALF_SIZE;

      // If looking down at real feet via PoseLandmarker, project feet onto floor box!
      if (curPhase === 'playing' && isLookingAtFeet && mpState.feetScreenPoints.length > 0) {
        for (const fp of mpState.feetScreenPoints) {
          _ndc.set(fp.x * 2 - 1, -(fp.y * 2 - 1));
          _raycaster.setFromCamera(_ndc, camera);
          if (_raycaster.ray.intersectPlane(_floorPlane, _vec3A)) {
            const footNorm =
              Math.max(Math.abs(_vec3A.x), Math.abs(_vec3A.z)) / GUARDIAN_BOX_HALF_SIZE;
            if (footNorm > boxDistNorm) {
              boxDistNorm = footNorm;
            }
          }
        }
      }

      if (guardianBox.root.visible) {
        const boxColor =
          boxDistNorm > 1.0 ? 0xef4444 : boxDistNorm > 0.72 ? 0xf59e0b : 0x22d3ee;
        guardianBox.borderMaterial.color.setHex(boxColor);
        guardianBox.gridMaterial.color.setHex(boxColor);
        guardianBox.pillarMaterial.color.setHex(boxColor);
      }

      if (curPhase === 'playing') {
        if (boxDistNorm > 1.02) {
          outsideBoxGraceTimer += delta;
          if (outsideBoxGraceTimer > 0.35 && !outOfBoundsReason) {
            outOfBoundsReason =
              'You stepped outside the floor square box boundary.';
            audioEngine.playOutOfBoundsAlert();
            onPhaseChangeRef.current('out_of_bounds');
          }
        } else {
          outsideBoxGraceTimer = Math.max(0, outsideBoxGraceTimer - delta * 2);
        }
      }

      // 2. Reload animation timer
      if (isReloading) {
        reloadTimer += delta;
        if (reloadTimer >= RELOAD_DURATION) {
          isReloading = false;
          reloadTimer = 0;
          ammo = MAX_MAGAZINE_AMMO;
        }
      }

      // 3. Update Hanging Targets (drop-in, string scaling, movement patterns, pendulum physics)
      const lvl = GAME_LEVELS[levelIndexRef.current] ?? GAME_LEVELS[0];
      const hitDiscMeshes: THREE.Mesh[] = [];

      for (let i = activeTargets.length - 1; i >= 0; i--) {
        const t = activeTargets[i];

        if (t.destroyed) {
          t.fadeOut -= delta * 3.5;
          t.rig.root.scale.setScalar(Math.max(0.01, t.fadeOut));
          if (t.fadeOut <= 0.02) {
            scene.remove(t.rig.root);
            activeTargets.splice(i, 1);
          }
          continue;
        }

        // Smooth drop-in from ceiling on string
        t.dropProgress = Math.min(1, t.dropProgress + delta * 1.9);
        const dropEase = 1 - Math.pow(1 - t.dropProgress, 3);
        const dropOffsetY = (1 - dropEase) * (CEILING_Y - t.basePos.y);

        // Movement patterns
        if (t.pattern === 'horizontal') {
          const lateral = Math.sin(elapsed * t.speed + t.phase) * 2.1;
          _vec3A.set(t.basePos.z, 0, -t.basePos.x).normalize();
          t.currentPos.copy(t.basePos).addScaledVector(_vec3A, lateral);
        } else if (t.pattern === 'vertical') {
          t.currentPos.copy(t.basePos);
          t.currentPos.y = t.basePos.y + Math.sin(elapsed * t.speed * 1.15 + t.phase) * 1.05;
        } else if (t.pattern === 'diagonal') {
          const lateral = Math.sin(elapsed * t.speed + t.phase) * 1.85;
          _vec3A.set(t.basePos.z, 0, -t.basePos.x).normalize();
          t.currentPos.copy(t.basePos).addScaledVector(_vec3A, lateral);
          t.currentPos.y = t.basePos.y + Math.cos(elapsed * t.speed * 1.3 + t.phase) * 0.85;
        } else if (t.pattern === 'approaching') {
          // Move steadily toward the player
          _vec3A.set(px - t.currentPos.x, 0, pz - t.currentPos.z);
          const distToPlayer = _vec3A.length();
          if (distToPlayer > 0.01) {
            _vec3A.normalize();
            t.currentPos.addScaledVector(_vec3A, t.speed * delta);
          }
          t.currentPos.y = t.basePos.y + Math.sin(elapsed * 2.1 + t.phase) * 0.25;

          const breachDist = lvl.breachDistance ?? 1.7;
          if (curPhase === 'playing' && distToPlayer < breachDist) {
            // Target breached player perimeter!
            t.destroyed = true;
            health--;
            audioEngine.playOutOfBoundsAlert();
            spawnBurstParticles(t.currentPos, 0xef4444, 14);
            if (health <= 0) {
              onPhaseChangeRef.current('game_over');
            } else if (spawnedInLevel < lvl.totalTargets) {
              spawnTarget(levelIndexRef.current, spawnedInLevel);
              spawnedInLevel++;
            } else {
              // Respawn remaining target at distance so player can finish level
              spawnTarget(levelIndexRef.current, spawnedInLevel);
            }
            continue;
          }
        } else {
          // Subtle natural hanging sway
          t.currentPos.copy(t.basePos);
          t.currentPos.x += Math.sin(elapsed * 1.1 + t.phase) * 0.08;
        }

        const boardY = t.currentPos.y + dropOffsetY;
        t.rig.boardGroup.position.set(t.currentPos.x, boardY, t.currentPos.z);

        // Pendulum damping after being shot
        const springK = 28;
        const dampC = 4.5;
        t.pendulumVelX += (-springK * t.pendulumAngleX - dampC * t.pendulumVelX) * delta;
        t.pendulumAngleX += t.pendulumVelX * delta;
        t.pendulumVelZ += (-springK * t.pendulumAngleZ - dampC * t.pendulumVelZ) * delta;
        t.pendulumAngleZ += t.pendulumVelZ * delta;

        _lookTarget.set(px, boardY, pz);
        t.rig.boardGroup.lookAt(_lookTarget);
        t.rig.boardGroup.rotateX(t.pendulumAngleX);
        t.rig.boardGroup.rotateZ(t.pendulumAngleZ);

        // Stretch overhead string dynamically from top eyelet to ceiling trolley
        const eyeletY = boardY + BOARD_HALF_H + 0.11;
        const stringHeight = Math.max(0.05, CEILING_Y - eyeletY);
        t.rig.trolleyMesh.position.set(t.currentPos.x, CEILING_Y, t.currentPos.z);
        t.rig.stringMesh.position.set(t.currentPos.x, eyeletY + stringHeight * 0.5, t.currentPos.z);
        t.rig.stringMesh.scale.set(1, stringHeight, 1);

        t.rig.hitDisc.userData.targetRef = t;
        hitDiscMeshes.push(t.rig.hitDisc);
      }

      // 4. Raycast Aiming Circle in Front of Target Board
      const aimInfo: AimTargetHitInfo = {
        hasTargetLock: false,
        zone: 'none',
        distanceMeters: 0,
        dispersionRadiusMeters: 0.06,
      };
      let rayHitPoint: THREE.Vector3 | null = null;
      let rayHitTarget: ActiveTarget | null = null;

      if (curPhase === 'playing' && effectiveGunPose && !isLookingAtFeet && hitDiscMeshes.length > 0) {
        _ndc.set(effAimX * 2 - 1, -(effAimY * 2 - 1));
        _raycaster.setFromCamera(_ndc, camera);
        const intersects = _raycaster.intersectObjects(hitDiscMeshes, false);

        if (intersects.length > 0) {
          const hit = intersects[0];
          const targetObj = hit.object.userData.targetRef as ActiveTarget | undefined;
          if (targetObj && !targetObj.destroyed) {
            rayHitTarget = targetObj;
            rayHitPoint = hit.point.clone();

            // Compute dispersion radius based on hand steadiness & distance
            const dispRadius = THREE.MathUtils.lerp(0.115, 0.026, effStability);
            aimInfo.hasTargetLock = true;
            aimInfo.distanceMeters = hit.distance;
            aimInfo.dispersionRadiusMeters = dispRadius;

            // Hit zone evaluation from the target texture under the aim point
            const aimEval =
              hit.uv && gameModels
                ? gameModels.sampleTargetZone(hit.uv.x, hit.uv.y)
                : { onSilhouette: false, zone: 'outer' as const, points: 0 };
            aimInfo.zone = aimEval.onSilhouette ? aimEval.zone : 'none';

            // Place 3D targeting circle right in front of the board face
            _boardNormal.set(0, 0, 1).applyQuaternion(targetObj.rig.boardGroup.quaternion);
            aimReticle.root.visible = true;
            aimReticle.root.position.copy(hit.point).addScaledVector(_boardNormal, 0.032);
            aimReticle.root.quaternion.copy(targetObj.rig.boardGroup.quaternion);
            aimReticle.outerRing.scale.setScalar(Math.max(dispRadius, hit.distance * 0.02)); // stays visible at long range
            aimReticle.ticksGroup.rotation.z = elapsed * 1.4;

            const ringHex =
              aimInfo.zone === 'bullseye'
                ? 0xf59e0b
                : aimInfo.zone === 'inner'
                  ? 0x10b981
                  : 0x22d3ee;
            aimReticle.outerMaterial.color.setHex(ringHex);
            aimReticle.innerMaterial.color.setHex(
              aimInfo.zone === 'bullseye' ? 0xef4444 : 0xfbbf24,
            );
          }
        } else {
          aimReticle.root.visible = false;
        }
      } else {
        aimReticle.root.visible = false;
      }

      // 5. Update 3D AR Pistol in Hand
      const showGunTarget = curPhase === 'playing' && effectiveGunPose && !isLookingAtFeet ? 1 : 0;
      gunOpacitySmooth = THREE.MathUtils.damp(gunOpacitySmooth, showGunTarget, 14, delta);

      const gun = gunRig;
      if (gun && gunOpacitySmooth > 0.03) {
        gun.root.visible = true;
        const liveHand = mpState.isGunPose;
        gun.hand.visible = liveHand;

        // Scale: real hand size (pixels per metre) -> gun/hand units so everything is life-sized
        let fitScale = 0.9;
        if (liveHand) {
          fitScale = THREE.MathUtils.clamp(
            mpState.handScale * 2 * GUN_HAND_DISTANCE * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)),
            0.4,
            2.4,
          );
        }
        const gunScale01 = fitScale * gunOpacitySmooth;
        gun.root.scale.setScalar(gunScale01);

        if (liveHand) {
          // The gun + virtual hand take the REAL hand's exact orientation:
          //   +Z (barrel) = wrist -> knuckles, +Y (sights) = pinky -> index knuckle
          _handFwd.normalize();
          _handUp.addScaledVector(_handFwd, -_handUp.dot(_handFwd)).normalize();
          _basisX.crossVectors(_handUp, _handFwd).normalize();
          _basisM.makeBasis(_basisX, _handUp, _handFwd);
          gun.root.quaternion.setFromRotationMatrix(_basisM);

          // Left-hand mesh by default; mirror for a right hand (swap button fixes a wrong guess)
          const mirrorHand = mpState.handIsRight !== swapHandRef.current;
          gun.hand.scale.x = mirrorHand ? -1 : 1;

          // Put the virtual palm exactly on the real palm
          _anchorLocal.copy(VIRTUAL_HAND_ANCHOR);
          if (mirrorHand) _anchorLocal.x = -_anchorLocal.x;
          _vec3C.copy(_anchorLocal).multiplyScalar(gunScale01).applyQuaternion(gun.root.quaternion);
          gun.root.position.copy(_handPos).sub(_vec3C);
        } else {
          // Simulator gun (desktop test): fixed spot aiming at the reticle
          _ndc.set(effHandX * 2 - 1, -(effHandY * 2 - 1));
          _vec3A.set(_ndc.x, _ndc.y, 0.5).unproject(camera);
          _vec3A.sub(camera.position).normalize();
          gun.root.position.copy(camera.position).addScaledVector(_vec3A, GUN_HAND_DISTANCE);
          if (rayHitPoint) {
            _lookTarget.copy(rayHitPoint);
          } else {
            _ndc.set(effAimX * 2 - 1, -(effAimY * 2 - 1));
            _raycaster.setFromCamera(_ndc, camera);
            _lookTarget.copy(_raycaster.ray.origin).addScaledVector(_raycaster.ray.direction, 8);
          }
          gun.root.up.set(0, 1, 0);
          gun.root.lookAt(_lookTarget);
          _vec3C.copy(GUN_GRIP_LOCAL).multiplyScalar(gunScale01).applyQuaternion(gun.root.quaternion);
          gun.root.position.sub(_vec3C);
        }

        // Recoil kick, slide blowback, reload tilt, and muzzle flash
        gunKickPitch = THREE.MathUtils.damp(gunKickPitch, 0, 14, delta);
        slideBlowback = THREE.MathUtils.damp(slideBlowback, 0, 22, delta);
        const reloadTilt = isReloading ? Math.sin((reloadTimer / RELOAD_DURATION) * Math.PI) * 0.65 : 0;
        const magDrop = isReloading ? Math.sin((reloadTimer / RELOAD_DURATION) * Math.PI) * -0.11 : 0;

        // Barrel points along +Z: recoil kicks the muzzle up (-X rotation), reload tilts it down
        gun.gunPivot.rotation.set(reloadTilt - gunKickPitch, 0, 0);
        gun.slide.position.z = gun.slideRestZ - slideBlowback;
        gun.magazine.position.y = gun.magazineRestY + magDrop;

        if (muzzleFlashTimer > 0) {
          muzzleFlashTimer -= delta;
          gun.muzzleFlash.visible = true;
          gun.muzzleFlash.rotation.z += delta * 40;
        } else {
          gun.muzzleFlash.visible = false;
        }

        // Laser beam length stops at target board if locked
        const gunScale = Math.max(0.05, gun.root.scale.z);
        const beamLen = rayHitPoint
          ? Math.max(0.2, (gun.root.position.distanceTo(rayHitPoint) - 0.18 * gunScale) / gunScale)
          : 6.0;
        gun.laserBeam.scale.set(1, 1, beamLen);
      } else if (gun) {
        gun.root.visible = false;
      }

      // 6. Execute Recoil Shot if triggered
      if (curPhase === 'playing' && effRecoilTriggered && effectiveGunPose && !isLookingAtFeet) {
        executeShot(effAimX, effAimY, effStability, aimInfo, rayHitPoint, rayHitTarget);
      }

      // 7. Update Particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += delta;
        if (p.life >= p.maxLife) {
          scene.remove(p.mesh);
          particles.splice(i, 1);
          continue;
        }
        p.vel.y -= 9.8 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
        p.mesh.rotation.x += p.rotVel.x * delta;
        p.mesh.rotation.y += p.rotVel.y * delta;
        p.mesh.scale.setScalar(1 - p.life / p.maxLife);
      }

      // 8. Off-screen Target Direction Hints (especially helpful in Level 3 & Level 4 rear search!)
      let offscreenDirection: HudSnapshot['offscreenDirection'] = null;
      let offscreenCount = 0;
      if (curPhase === 'playing' && activeTargets.length > 0) {
        const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        let anyVisible = false;
        let bestDot = -2;
        let bestSide: 'left' | 'right' | 'behind' = 'behind';

        for (const t of activeTargets) {
          if (t.destroyed) continue;
          _vec3A.copy(t.currentPos).sub(camera.position).normalize();
          const fwdDot = camFwd.dot(_vec3A);
          if (fwdDot > 0.72) {
            anyVisible = true;
          } else {
            offscreenCount++;
            if (fwdDot > bestDot) {
              bestDot = fwdDot;
              if (fwdDot < -0.25) {
                bestSide = 'behind';
              } else {
                bestSide = camRight.dot(_vec3A) >= 0 ? 'right' : 'left';
              }
            }
          }
        }
        if (!anyVisible && offscreenCount > 0) {
          offscreenDirection = bestSide;
        }
      }

      // 9. Emit throttled HUD state (~20Hz) so React UI stays silky smooth without thrashing
      if (nowMs - lastHudEmit > 100) {
        lastHudEmit = nowMs;
        onHudUpdateRef.current({
          ammo,
          maxAmmo: MAX_MAGAZINE_AMMO,
          isReloading,
          reloadProgress: isReloading ? Math.min(1, reloadTimer / RELOAD_DURATION) : 0,
          score,
          shotsFired,
          shotsHit,
          bullseyes,
          targetsCleared: clearedInLevel,
          targetsTotal: lvl.totalTargets,
          health,
          maxHealth: MAX_HEALTH,
          isLookingAtFeet,
          boxDistanceNormalized: boxDistNorm,
          outOfBoundsReason,
          cameraActive,
          mediapipeReady: mpTracker.isReady(),
          mediapipeError: mpTracker.getError(),
          gyroActive: spatialTracker.isGyroActive(),
          offscreenDirection,
          offscreenCount,
          gesture: mpState,
          aimInfo,
          lastHitFeedback,
        });
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      domCanvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);

      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
      mpTracker.dispose();
      spatialTracker.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mountEl) {
        mountEl.removeChild(renderer.domElement);
      }
    };
  }, [controllerRef]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#090D12]">
      {/* Live Rear/Front Camera AR Video Feed */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={`absolute inset-0 w-full h-full object-cover z-0 ${
          cameraFacing === 'user' ? '-scale-x-100' : ''
        }`}
      />
      {/* Dedicated Three.js WebGL Mount Container */}
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full z-10 cursor-crosshair"
      />
    </div>
  );
};