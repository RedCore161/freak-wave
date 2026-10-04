import * as THREE from 'three';
import { GRID_H, GRID_W, TARGET_EXCLUSION, WAVE_SPEED } from '../sim/constants.ts';
import { QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { distanceTo } from '../level/terrain.ts';
import type { LevelData } from '../level/types.ts';
import { rampInto } from './palette.ts';

const W = GRID_W;
const H = GRID_H;
/** World units of vertical displacement per metre of wave height. */
export const V_SCALE = 0.32;
const MAX_LIFT = 6;
const CAMERA_TILT = 0.5; // radians away from straight down

export interface QuakeVisual {
  id: number;
  kind: QuakeKind;
  x: number;
  y: number;
}

interface TargetVisual {
  group: THREE.Group;
  hoop: THREE.Mesh;
  hoopMat: THREE.MeshBasicMaterial;
  pole: THREE.Mesh;
  exclusion: THREE.Mesh;
  required: number;
}

interface Effect {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  grow: number;
}

/** Converts simulation cell coordinates to world space. */
export function toWorld(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x - (W - 1) / 2, 0, y - (H - 1) / 2);
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 1000);
  private raycaster = new THREE.Raycaster();
  private seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private water: THREE.Mesh;
  private waterPos: Float32Array;
  private waterCol: Float32Array;
  private land: Uint8Array = new Uint8Array(W * H);
  private landMesh: THREE.Mesh | null = null;
  private targets: TargetVisual[] = [];
  private quakeMeshes = new Map<number, THREE.Mesh>();
  private quakeGroup = new THREE.Group();
  private ghost: THREE.Mesh;
  private ghostMat: THREE.MeshLambertMaterial;
  private selectRing: THREE.Mesh;
  private effects: Effect[] = [];
  private clock = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x061525);

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0b1a2a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-40, 90, 50);
    this.scene.add(sun);

    const geo = makeGrid();
    this.waterPos = geo.getAttribute('position').array as Float32Array;
    this.waterCol = new Float32Array(W * H * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(this.waterCol, 3));
    this.water = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.scene.add(this.water);
    this.scene.add(this.quakeGroup);

    this.ghostMat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55, flatShading: true });
    this.ghost = new THREE.Mesh(new THREE.OctahedronGeometry(1.7), this.ghostMat);
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.selectRing = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 3.8, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.selectRing.renderOrder = 10;
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);

    this.resize();
  }

  resize(): void {
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitCamera();
  }

  /** Places the camera so the whole map fits; rotates the view in portrait. */
  private fitCamera(): void {
    const portrait = this.camera.aspect < 0.9;
    const dir = portrait ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const corners = [toWorld(0, 0), toWorld(W - 1, 0), toWorld(0, H - 1), toWorld(W - 1, H - 1)];
    let lo = 20;
    let hi = 2000;
    for (let it = 0; it < 30; it++) {
      const d = (lo + hi) / 2;
      this.placeCamera(d, dir);
      const fits = corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) < 0.94 && Math.abs(p.y) < 0.86;
      });
      if (fits) hi = d;
      else lo = d;
    }
    this.placeCamera(hi, dir);
  }

  private placeCamera(dist: number, dir: THREE.Vector3): void {
    const off = dir.clone().multiplyScalar(Math.sin(CAMERA_TILT) * dist);
    this.camera.position.set(off.x, Math.cos(CAMERA_TILT) * dist, off.z);
    // Nudge the look-at point so the map sits slightly below the HUD.
    this.camera.lookAt(dir.x * 3, 0, dir.z * 3);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  setLevel(level: LevelData): void {
    this.land = level.land;
    if (this.landMesh) {
      this.scene.remove(this.landMesh);
      this.landMesh.geometry.dispose();
    }
    this.landMesh = buildLandMesh(level.land, level.seed);
    this.scene.add(this.landMesh);

    for (const t of this.targets) this.scene.remove(t.group);
    this.targets = level.targets.map((t) => this.buildTarget(t.x, t.y, t.required));
    this.setQuakes([], null);
    this.clearEffects();
    this.updateWater(null, null, null);
  }

  private buildTarget(x: number, y: number, required: number): TargetVisual {
    const group = new THREE.Group();
    group.position.copy(toWorld(x, y));
    const top = required * V_SCALE;
    const hoopMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.32, 6, 24).rotateX(Math.PI / 2), hoopMat);
    hoop.position.y = top;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, top + 2, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }),
    );
    pole.position.y = (top - 2) / 2;
    const exclusion = new THREE.Mesh(
      new THREE.RingGeometry(TARGET_EXCLUSION - 0.5, TARGET_EXCLUSION, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.45, depthTest: false }),
    );
    exclusion.renderOrder = 5;
    exclusion.position.y = 0.2;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(TARGET_EXCLUSION, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.07, depthTest: false }),
    );
    disc.renderOrder = 4;
    exclusion.add(disc);
    group.add(hoop, pole, exclusion);
    this.scene.add(group);
    return { group, hoop, hoopMat, pole, exclusion, required };
  }

  setExclusionVisible(visible: boolean): void {
    for (const t of this.targets) t.exclusion.visible = visible;
  }

  /** Target hoop state: peak so far and whether it has been hit. */
  updateTargets(state: readonly { best: number; hit: boolean }[]): void {
    this.targets.forEach((t, k) => {
      const s = state[k];
      if (!s) return;
      if (s.hit) t.hoopMat.color.setHex(0xffd84d);
      else {
        const f = Math.min(1, s.best / t.required);
        t.hoopMat.color.setRGB(1, 1 - f * 0.25, 1 - f * 0.7);
      }
      const pulse = s.hit ? 1 + 0.08 * Math.sin(this.clock * 8) : 1;
      t.hoop.scale.setScalar(pulse);
    });
  }

  setQuakes(quakes: readonly QuakeVisual[], selectedId: number | null): void {
    const seen = new Set<number>();
    for (const q of quakes) {
      seen.add(q.id);
      let mesh = this.quakeMeshes.get(q.id);
      if (!mesh) {
        const type = QUAKE_TYPES[q.kind];
        mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(1.7 * type.size),
          new THREE.MeshLambertMaterial({ color: type.color, flatShading: true, emissive: type.color, emissiveIntensity: 0.25 }),
        );
        this.quakeMeshes.set(q.id, mesh);
        this.quakeGroup.add(mesh);
      }
      const p = toWorld(q.x, q.y);
      mesh.position.set(p.x, 2.2, p.z);
      mesh.userData.selected = q.id === selectedId;
    }
    for (const [id, mesh] of this.quakeMeshes) {
      if (seen.has(id)) continue;
      this.quakeGroup.remove(mesh);
      mesh.geometry.dispose();
      this.quakeMeshes.delete(id);
    }
    const sel = selectedId !== null ? quakes.find((q) => q.id === selectedId) : undefined;
    this.selectRing.visible = !!sel;
    if (sel) this.selectRing.position.copy(toWorld(sel.x, sel.y)).setY(0.3);
  }

  setQuakesVisible(visible: boolean): void {
    this.quakeGroup.visible = visible;
    if (!visible) this.selectRing.visible = false;
  }

  setGhost(ghost: { x: number; y: number; kind: QuakeKind; valid: boolean } | null): void {
    this.ghost.visible = !!ghost;
    if (!ghost) return;
    const type = QUAKE_TYPES[ghost.kind];
    this.ghost.scale.setScalar(type.size);
    this.ghostMat.color.set(ghost.valid ? type.color : '#ff3355');
    this.ghost.position.copy(toWorld(ghost.x, ghost.y)).setY(2.2);
  }

  /**
   * Updates water geometry and colour. `u` is the current surface (metres),
   * `env` a decaying envelope that keeps wave paths readable, `iso` an
   * optional water-distance field drawn as one-second arrival rings.
   */
  updateWater(u: Float32Array | null, env: Float32Array | null, iso: Float32Array | null): void {
    const pos = this.waterPos;
    const col = this.waterCol;
    const land = this.land;
    const t = this.clock;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const idx = j * W + i;
        const o = idx * 3;
        if (land[idx]) {
          pos[o + 1] = -2.5;
          col[o] = col[o + 1] = col[o + 2] = 0;
          continue;
        }
        let h: number;
        let shade: number;
        if (u) {
          h = u[idx];
          const a = h < 0 ? -h : h;
          const e = env ? env[idx] * 0.85 : 0;
          shade = a > e ? a : e;
        } else {
          // Idle swell so the sea looks alive before the quakes fire.
          h = 0.35 * Math.sin(i * 0.31 + t * 1.3) * Math.sin(j * 0.27 - t * 0.9);
          shade = 0.4 + 0.3 * h;
        }
        let lift = h * V_SCALE;
        if (lift > MAX_LIFT) lift = MAX_LIFT;
        else if (lift < -MAX_LIFT) lift = -MAX_LIFT;
        pos[o + 1] = lift;
        rampInto(shade, col, o);
        if (iso) {
          const d = iso[idx];
          if (d !== Infinity) {
            const sec = d / WAVE_SPEED;
            const f = sec - Math.floor(sec);
            if (f < 0.07 || f > 0.97) {
              const k = 0.55;
              col[o] += (0.85 - col[o]) * k;
              col[o + 1] += (0.95 - col[o + 1]) * k;
              col[o + 2] += (1 - col[o + 2]) * k;
            }
          }
        }
      }
    }
    const geo = this.water.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }

  /** Expanding ring where a quake fires. */
  spawnShock(x: number, y: number, color: string): void {
    this.spawnEffect(x, y, color, 1.1, 1.4, 14);
  }

  /** Golden flash when a target is hit. */
  spawnBurst(x: number, y: number, height: number): void {
    this.spawnEffect(x, y, '#ffe14d', 0.9, 3, 5, height * V_SCALE);
  }

  private spawnEffect(x: number, y: number, color: string, life: number, r0: number, grow: number, lift = 0.4): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(r0 * 0.8, r0, 40).rotateX(-Math.PI / 2), mat);
    mesh.renderOrder = 20;
    mesh.position.copy(toWorld(x, y)).setY(lift);
    this.scene.add(mesh);
    this.effects.push({ mesh, mat, age: 0, life, grow });
  }

  private clearEffects(): void {
    for (const e of this.effects) {
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
    }
    this.effects = [];
  }

  /** Cell coordinates under a screen point, or null if off the map. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.seaPlane, hit)) return null;
    const x = hit.x + (W - 1) / 2;
    const y = hit.z + (H - 1) / 2;
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
    return { x, y };
  }

  /** Screen position (CSS pixels, relative to the canvas) of a map point at a height. */
  project(x: number, y: number, metres = 0): { x: number; y: number } {
    const p = toWorld(x, y).setY(metres * V_SCALE).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height };
  }

  render(dt: number): void {
    this.clock += dt;
    for (const mesh of this.quakeMeshes.values()) {
      mesh.rotation.y += dt * 0.8;
      const s = mesh.userData.selected ? 1.25 : 1;
      mesh.scale.setScalar(s);
    }
    this.ghost.rotation.y += dt * 0.8;
    this.effects = this.effects.filter((e) => {
      e.age += dt;
      const k = e.age / e.life;
      if (k >= 1) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        return false;
      }
      e.mesh.scale.setScalar(1 + k * e.grow);
      e.mat.opacity = 0.9 * (1 - k);
      return true;
    });
    this.renderer.render(this.scene, this.camera);
  }
}

/** Indexed grid with one vertex per simulation cell. */
function makeGrid(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = toWorld(i, j);
      const o = (j * W + i) * 3;
      pos[o] = p.x;
      pos[o + 2] = p.z;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      // Alternate the diagonal for a less regular, more low-poly look.
      if ((i + j) % 2 === 0) index.push(a, c, b, b, c, d);
      else index.push(a, c, d, a, d, b);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  return geo;
}

const LAND_COLORS = [
  { below: 0.15, color: new THREE.Color(0xcdb98a) },
  { below: 1.1, color: new THREE.Color(0xe8d6a5) },
  { below: 2.6, color: new THREE.Color(0x7fb069) },
  { below: 3.8, color: new THREE.Color(0x5b8a4e) },
  { below: Infinity, color: new THREE.Color(0x9a9a8e) },
];

/** Faceted island mesh; heights grow with distance from the shore. */
function buildLandMesh(land: Uint8Array, seed: number): THREE.Mesh {
  const inland = distanceTo(land, 0, 16);
  const height = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!land[i]) {
      height[i] = -1.8;
      continue;
    }
    const jitter = Math.sin(i * 12.9898 + seed) * 43758.5453;
    const n = jitter - Math.floor(jitter);
    height[i] = 0.6 + Math.min(inland[i], 8) * 0.55 + n * 0.45;
  }
  const pos: number[] = [];
  const col: number[] = [];
  const vtx = (i: number, j: number) => {
    const p = toWorld(i, j);
    return [p.x, height[j * W + i], p.z];
  };
  const tri = (a: number[], b: number[], c: number[]) => {
    pos.push(...a, ...b, ...c);
    const avg = (a[1] + b[1] + c[1]) / 3;
    const color = LAND_COLORS.find((l) => avg < l.below)!.color;
    for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const cells = [j * W + i, j * W + i + 1, (j + 1) * W + i, (j + 1) * W + i + 1];
      if (!cells.some((c) => land[c])) continue;
      const a = vtx(i, j);
      const b = vtx(i + 1, j);
      const c = vtx(i, j + 1);
      const d = vtx(i + 1, j + 1);
      if ((i + j) % 2 === 0) {
        tri(a, c, b);
        tri(b, c, d);
      } else {
        tri(a, c, d);
        tri(a, d, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}
