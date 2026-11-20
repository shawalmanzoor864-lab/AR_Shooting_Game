import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CEILING_Y, FLOOR_Y, GUARDIAN_BOX_HALF_SIZE } from './types';

export interface ARGunRig {
  root: THREE.Group;
  gunPivot: THREE.Group;
  /** Animated slide group (blowback is applied on its local Z, rig forward = +Z) */
  slide: THREE.Object3D;
  /** Animated magazine group (reload drop is applied on its local Y) */
  magazine: THREE.Object3D;
  slideRestZ: number;
  magazineRestY: number;
  muzzleFlash: THREE.Group;
  muzzlePoint: THREE.Object3D;
  laserBeam: THREE.Mesh;
}

export interface HangingTargetRig {
  root: THREE.Group;
  boardGroup: THREE.Group;
  /** The target mesh itself - used for aiming / hit raycasts so only the real silhouette is hittable */
  hitDisc: THREE.Mesh;
  stringMesh: THREE.Mesh;
  trolleyMesh: THREE.Mesh;
  decalGroup: THREE.Group;
}

export interface GuardianBoxRig {
  root: THREE.Group;
  borderMaterial: THREE.MeshBasicMaterial;
  gridMaterial: THREE.MeshBasicMaterial;
  pillarMaterial: THREE.MeshBasicMaterial;
}

export interface AimReticleRig {
  root: THREE.Group;
  outerRing: THREE.Mesh;
  innerDot: THREE.Mesh;
  ticksGroup: THREE.Group;
  outerMaterial: THREE.MeshBasicMaterial;
  innerMaterial: THREE.MeshBasicMaterial;
}

export interface TargetZoneResult {
  onSilhouette: boolean;
  zone: 'bullseye' | 'inner' | 'outer';
  points: number;
}

export interface LoadedGameModels {
  gunScene: THREE.Object3D;
  targetScene: THREE.Object3D;
  /** Scores a hit from the UV coordinates of a raycast intersection on the target mesh */
  sampleTargetZone: (u: number, v: number) => TargetZoneResult;
}

// ---------------------------------------------------------------------------
// Model files (served from /public/assets/models)
// ---------------------------------------------------------------------------
const GUN_MODEL_FILE = 'assets/models/samurai-edge.glb';
const TARGET_MODEL_FILE = 'assets/models/shooting-range-target.glb';

// The shooting-range-target.glb figure is 1.8 m tall and stands on a wooden stand.
// The chest/head "bust" (the part with the scoring rings) spans y = 0.62 .. 1.80 m, which is
// 1.18 m tall - exactly the old board height. The game's "board centre" is the bust centre.
export const TARGET_BOARD_WIDTH = 0.79;
export const TARGET_BOARD_HEIGHT = 1.18;
const TARGET_MODEL_OFFSET_Y = -1.2; // moves the bust centre to local y = 0
const TARGET_MODEL_OFFSET_Z = 0.011; // puts the front face at ~ +0.02 like the old board

// Samurai Edge GLB: muzzle points toward -X, grip toward +X, up = +Y, ~0.229 m long, centred.
// Game rig convention: barrel points along +Z (Object3D.lookAt aims +Z at the aim point).
const GUN_FORWARD_OFFSET_Z = 0.05; // slides the gun forward so the grip sits near the hand anchor
const GUN_BORE_Y = 0.052;
const GUN_MUZZLE_Z = 0.114 + GUN_FORWARD_OFFSET_Z + 0.01;

const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');

function buildZoneSampler(map: THREE.Texture | null): (u: number, v: number) => TargetZoneResult {
  // Read the target texture once so hits can be scored from the colour / position under the bullet.
  let data: Uint8ClampedArray | null = null;
  let texW = 1;
  let texH = 1;
  const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (img && img.width > 0 && img.height > 0) {
    try {
      texW = img.width;
      texH = img.height;
      const canvas = document.createElement('canvas');
      canvas.width = texW;
      canvas.height = texH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, texW, texH);
        data = ctx.getImageData(0, 0, texW, texH).data;
      }
    } catch {
      data = null;
    }
  }

  return (u: number, v: number): TargetZoneResult => {
    // Ring geometry measured on the 1024 x 1024 base colour texture (pixels)
    const px = u * 1024;
    const py = v * 1024;
    const chest = Math.hypot(px - 212, py - 759);
    const head = Math.hypot(px - 104, py - 507);

    if (chest <= 24 || head <= 14) return { onSilhouette: true, zone: 'bullseye', points: 100 };
    if (chest <= 60 || head <= 28) return { onSilhouette: true, zone: 'inner', points: 75 };
    if (chest <= 86 || head <= 41) return { onSilhouette: true, zone: 'outer', points: 50 };

    if (data) {
      const x = Math.min(texW - 1, Math.max(0, Math.floor(u * texW)));
      const y = Math.min(texH - 1, Math.max(0, Math.floor(v * texH)));
      const i = (y * texW + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Orange / brown pixels belong to the wooden stand - it is not a scoring surface
      const isWood = r > 90 && r > g && g > b && r - b > 25;
      if (isWood) return { onSilhouette: false, zone: 'outer', points: 0 };
    }
    return { onSilhouette: true, zone: 'outer', points: 25 };
  };
}

export async function loadGameModels(maxAnisotropy: number): Promise<LoadedGameModels> {
  const base = (((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL) ?? '/');
  const loader = new GLTFLoader();
  const [gunGltf, targetGltf] = await Promise.all([
    loader.loadAsync(`${base}${GUN_MODEL_FILE}`),
    loader.loadAsync(`${base}${TARGET_MODEL_FILE}`),
  ]);

  const tune = (root: THREE.Object3D) => {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        for (const tex of [std.map, std.normalMap, std.metalnessMap, std.aoMap]) {
          if (tex) tex.anisotropy = maxAnisotropy;
        }
      }
    });
  };
  tune(gunGltf.scene);
  tune(targetGltf.scene);

  let targetMap: THREE.Texture | null = null;
  targetGltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && !targetMap) {
      const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      targetMap = m.map ?? null;
    }
  });

  return {
    gunScene: gunGltf.scene,
    targetScene: targetGltf.scene,
    sampleTargetZone: buildZoneSampler(targetMap),
  };
}

export function createGuardianFloorTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);

  // Translucent safety floor fill
  ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
  ctx.fillRect(0, 0, size, size);

  // Diagonal hazard stripes near outer edge
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 3;
  const step = 64;
  for (let i = 0; i <= size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  // Center foot stance marker
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 54, 0, Math.PI * 2);
  ctx.stroke();

  // Outer crisp border
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 18;
  ctx.strokeRect(9, 9, size - 18, size - 18);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

export function createARGunModel(gunScene: THREE.Object3D): ARGunRig {
  const root = new THREE.Group();
  const gunPivot = new THREE.Group();
  root.add(gunPivot);

  // Each animated part gets a "holder" (moved in rig space: +Z = barrel direction) and an inner
  // "orient" group that rotates the GLB's native axes (muzzle toward -X) into the rig axes.
  const makePart = () => {
    const holder = new THREE.Group();
    const orient = new THREE.Group();
    orient.rotation.y = Math.PI / 2; // native -X (muzzle) -> rig +Z
    orient.position.z = GUN_FORWARD_OFFSET_Z;
    holder.add(orient);
    gunPivot.add(holder);
    return { holder, orient };
  };
  const bodyPart = makePart();
  const slidePart = makePart();
  const magPart = makePart();

  const source = gunScene.clone(true);
  for (const child of [...source.children]) {
    const key = normName(child.name);
    const mat = child instanceof THREE.Mesh
      ? ((Array.isArray(child.material) ? child.material[0] : child.material) as THREE.Material)
      : null;
    if (key === 'cylinderhigh002' || key === 'cylinderbhigh002') {
      slidePart.orient.add(child); // slide + top sights: blowback
    } else if (key === 'maghigh003' || mat?.name === 'Mag-black') {
      magPart.orient.add(child); // magazine: reload drop
    } else {
      bodyPart.orient.add(child); // frame, barrel, grips
    }
  }

  // Thin laser guide ray starting at the muzzle (scaled along Z by the game loop)
  const laserGeo = new THREE.CylinderGeometry(0.0014, 0.0014, 1, 6);
  laserGeo.translate(0, 0.5, 0);
  laserGeo.rotateX(Math.PI / 2); // +Y -> +Z
  const laserMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const laserBeam = new THREE.Mesh(laserGeo, laserMat);
  laserBeam.position.set(0, GUN_BORE_Y, GUN_MUZZLE_Z + 0.004);
  gunPivot.add(laserBeam);

  // Muzzle point & dynamic flash
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, GUN_BORE_Y, GUN_MUZZLE_Z);
  gunPivot.add(muzzlePoint);

  const muzzleFlash = new THREE.Group();
  muzzleFlash.position.copy(muzzlePoint.position);
  muzzleFlash.visible = false;
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 3; i++) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.06), flashMat);
    plane.rotation.z = (i * Math.PI) / 3;
    muzzleFlash.add(plane);
  }
  muzzleFlash.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 10), flashMat));
  gunPivot.add(muzzleFlash);

  return {
    root,
    gunPivot,
    slide: slidePart.holder,
    magazine: magPart.holder,
    slideRestZ: 0,
    magazineRestY: 0,
    muzzleFlash,
    muzzlePoint,
    laserBeam,
  };
}

export function createHangingTargetModel(
  targetScene: THREE.Object3D,
  boardHeight = TARGET_BOARD_HEIGHT,
): HangingTargetRig {
  const root = new THREE.Group();
  const boardGroup = new THREE.Group();
  root.add(boardGroup);

  const halfH = boardHeight * 0.5;

  // 1. Overhead ceiling trolley puck
  const trolleyMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.4,
    metalness: 0.75,
  });
  const trolleyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.08, 16), trolleyMat);
  trolleyMesh.position.set(0, CEILING_Y, 0);
  root.add(trolleyMesh);

  // 2. Taut vertical suspension string (unit height = 1, scaled dynamically)
  const stringMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 1, 8),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.65, metalness: 0.1 }),
  );
  root.add(stringMesh);

  // 3. The shooting-range target model (bust centred on the board origin)
  const model = targetScene.clone(true);
  model.position.set(0, TARGET_MODEL_OFFSET_Y, TARGET_MODEL_OFFSET_Z);
  boardGroup.add(model);

  let hitDisc: THREE.Mesh | null = null;
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && !hitDisc) hitDisc = mesh;
  });
  if (!hitDisc) {
    throw new Error('shooting-range-target.glb contains no mesh');
  }

  // 4. Steel hanger: short rod from the top of the head up to the string eyelet
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.32,
    metalness: 0.85,
  });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 8), rimMat);
  rod.position.set(0, halfH + 0.06, 0);
  boardGroup.add(rod);

  const bracketMesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 0.05), rimMat);
  bracketMesh.position.set(0, halfH + 0.085, 0);
  boardGroup.add(bracketMesh);

  const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.01, 8, 16), rimMat);
  eyelet.position.set(0, halfH + 0.11, 0);
  boardGroup.add(eyelet);

  // 5. Decal group for 3D bullet holes stuck onto the target
  const decalGroup = new THREE.Group();
  boardGroup.add(decalGroup);

  return {
    root,
    boardGroup,
    hitDisc,
    stringMesh,
    trolleyMesh,
    decalGroup,
  };
}

export function createGuardianBox(maxAnisotropy: number): GuardianBoxRig {
  const root = new THREE.Group();
  root.position.set(0, FLOOR_Y, 0);
  root.visible = false; // Strictly hidden until camera pitches down toward feet!

  const half = GUARDIAN_BOX_HALF_SIZE;
  const full = half * 2;

  const gridTex = createGuardianFloorTexture(maxAnisotropy);
  const gridMaterial = new THREE.MeshBasicMaterial({
    map: gridTex,
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const floorPlane = new THREE.Mesh(new THREE.PlaneGeometry(full, full), gridMaterial);
  floorPlane.rotation.x = -Math.PI / 2;
  root.add(floorPlane);

  // Glowing perimeter bars
  const borderMaterial = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.95,
  });

  const barThickness = 0.035;
  const barHeight = 0.02;
  const edges: Array<[number, number, number, number]> = [
    [0, -half, full, barThickness],
    [0, half, full, barThickness],
    [-half, 0, barThickness, full],
    [half, 0, barThickness, full],
  ];
  for (const [x, z, w, d] of edges) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, barHeight, d), borderMaterial);
    bar.position.set(x, barHeight * 0.5 + 0.005, z);
    root.add(bar);
  }

  // Vertical corner boundary beacons so the square box reads clearly in 3D space
  const pillarMaterial = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.65,
  });
  const corners: Array<[number, number]> = [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ];
  for (const [cx, cz] of corners) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.42, 8), pillarMaterial);
    post.position.set(cx, 0.21, cz);
    root.add(post);
  }

  return {
    root,
    borderMaterial,
    gridMaterial,
    pillarMaterial,
  };
}

export function createAimReticle(): AimReticleRig {
  const root = new THREE.Group();
  root.visible = false;

  const outerMaterial = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
  });

  const innerMaterial = new THREE.MeshBasicMaterial({
    color: 0xf59e0b,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
  });

  const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 40), outerMaterial);
  outerRing.renderOrder = 50;
  root.add(outerRing);

  const innerDot = new THREE.Mesh(new THREE.CircleGeometry(0.018, 20), innerMaterial);
  innerDot.renderOrder = 51;
  root.add(innerDot);

  const ticksGroup = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.07), outerMaterial);
    const angle = (i * Math.PI) / 2;
    tick.position.set(Math.cos(angle) * 0.14, Math.sin(angle) * 0.14, 0);
    tick.rotation.z = angle + Math.PI / 2;
    tick.renderOrder = 50;
    ticksGroup.add(tick);
  }
  root.add(ticksGroup);

  return {
    root,
    outerRing,
    innerDot,
    ticksGroup,
    outerMaterial,
    innerMaterial,
  };
}
