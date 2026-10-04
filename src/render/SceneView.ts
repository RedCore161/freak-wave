import * as THREE from 'three';
import { GRID_H, GRID_W, WAVE_SPEED } from '../sim/constants.ts';
import { QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { distanceTo } from '../level/terrain.ts';
import { CITY_MIN_DISTANCE } from '../level/placement.ts';
import type { LevelData, SpawnArea } from '../level/types.ts';
import { rampInto } from './palette.ts';

const W = GRID_W;
const H = GRID_H;
/** World units of vertical displacement per metre of wave height. */
export const V_SCALE = 0.32;
const MAX_LIFT = 6;
const CAMERA_TILT = 0.5; // radians away from straight down
const QUAKE_Y = 2.2;

export interface QuakeVisual {
  id: number;
  kind: QuakeKind;
  x: number;
  y: number;
  angle: number;
  /** 0.1..1: quakes outside epicenters are smaller and dimmer. */
  power: number;
}

export interface CityVisualState {
  /** 0..1 share of hp dealt. */
  damage: number;
  ruined: boolean;
}

interface Building {
  mesh: THREE.Mesh;
  base: THREE.Vector3;
  tilt: THREE.Vector3;
}

interface CityVisual {
  group: THREE.Group;
  buildings: Building[];
  mat: THREE.MeshLambertMaterial;
  roofMat: THREE.MeshLambertMaterial;
  shake: number;
  collapse: number; // 0 standing .. 1 fallen
  ruined: boolean;
  x: number;
  y: number;
}

interface ZoneVisual {
  group: THREE.Group;
  hoopMat: THREE.MeshBasicMaterial;
  hoop: THREE.Mesh;
  hit: boolean;
}

interface Effect {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  grow: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
}

interface Tween {
  age: number;
  dur: number;
  fn: (k: number) => void;
}

/** Converts simulation cell coordinates to world space. */
export function toWorld(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x - (W - 1) / 2, 0, y - (H - 1) / 2);
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;
const easeOutBack = (k: number) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 1000);
  private camHome = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camIntro = 1;
  private raycaster = new THREE.Raycaster();
  private seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private water: THREE.Mesh;
  private waterPos: Float32Array;
  private waterCol: Float32Array;
  private land: Uint8Array = new Uint8Array(W * H);
  private landMesh: THREE.Mesh | null = null;
  private cities: CityVisual[] = [];
  private zones: ZoneVisual[] = [];
  private spawnGroup = new THREE.Group();
  private quakeMeshes = new Map<number, THREE.Group>();
  private quakeGroup = new THREE.Group();
  private ghost: THREE.Group;
  private ghostMat: THREE.MeshLambertMaterial;
  private selectRing: THREE.Mesh;
  private effects: Effect[] = [];
  private particles: Particle[] = [];
  private tweens: Tween[] = [];
  private clock = 0;
  private flash = 0;

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
    this.scene.add(this.water, this.spawnGroup, this.quakeGroup);

    this.ghostMat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55, flatShading: true });
    this.ghost = this.buildQuakeMesh('small', this.ghostMat);
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
    this.renderer.setSize(el.clientWidth, el.clientHeight, false);
    this.camera.aspect = el.clientWidth / el.clientHeight;
    this.fitCamera();
  }

  /** Finds the camera spot where the whole map fits; rotates the view in portrait. */
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
        return Math.abs(p.x) < 0.94 && Math.abs(p.y) < 0.8;
      });
      if (fits) hi = d;
      else lo = d;
    }
    this.placeCamera(hi, dir);
    this.camHome.copy(this.camera.position);
  }

  private placeCamera(dist: number, dir: THREE.Vector3): void {
    const off = dir.clone().multiplyScalar(Math.sin(CAMERA_TILT) * dist);
    this.camera.position.set(off.x, Math.cos(CAMERA_TILT) * dist, off.z);
    this.camLook.set(dir.x * 3, 0, dir.z * 3);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- level

  setLevel(level: LevelData, spawns: readonly SpawnArea[]): void {
    this.land = level.land;
    if (this.landMesh) {
      this.scene.remove(this.landMesh);
      this.landMesh.geometry.dispose();
    }
    this.landMesh = buildLandMesh(level.land, level.seed);
    this.scene.add(this.landMesh);
    const landMesh = this.landMesh;
    landMesh.scale.y = 0.01;
    this.tween(1.1, (k) => (landMesh.scale.y = Math.max(0.01, easeOutBack(k))));

    for (const c of this.cities) this.scene.remove(c.group);
    this.cities = level.cities.map((c, i) => this.buildCity(c.x, c.y, c.level, level.land, level.seed + i));
    this.resetCities(0.5);

    for (const z of this.zones) this.scene.remove(z.group);
    this.zones = level.zones.map((z) => this.buildZone(z.x, z.y, z.threshold));

    this.setSpawns(spawns, level.cities);
    this.setQuakes([], null);
    this.clearEffects();
    this.updateWater(null, null, null);
    // Fly in from high above.
    this.camIntro = 0;
  }

  setSpawns(spawns: readonly SpawnArea[], cities: readonly { x: number; y: number }[] = []): void {
    this.spawnGroup.clear();
    for (const c of cities) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(CITY_MIN_DISTANCE - 0.4, CITY_MIN_DISTANCE, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.35, depthTest: false }),
      );
      ring.renderOrder = 3;
      ring.position.copy(toWorld(c.x, c.y)).setY(0.2);
      ring.userData.noGo = true;
      this.spawnGroup.add(ring);
    }
    spawns.forEach((s, i) => {
      const g = new THREE.Group();
      g.position.copy(toWorld(s.x, s.y)).setY(0.25);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(s.r, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x5dff9a, transparent: true, opacity: 0.12, depthTest: false }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(s.r - 0.45, s.r, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x5dff9a, transparent: true, opacity: 0.8, depthTest: false }),
      );
      disc.renderOrder = 4;
      ring.renderOrder = 5;
      g.add(disc, ring);
      g.userData.phase = i * 1.7;
      g.scale.setScalar(0.01);
      this.tween(0.6, (k) => g.scale.setScalar(Math.max(0.01, easeOutBack(Math.min(1, Math.max(0, k * 1.6 - i * 0.25))))));
      this.spawnGroup.add(g);
    });
  }

  setSpawnsVisible(visible: boolean): void {
    this.spawnGroup.visible = visible;
  }

  private buildCity(x: number, y: number, level: number, land: Uint8Array, seed: number): CityVisual {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xf2efe6, flatShading: true });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0xe06d4f, flatShading: true });
    const inland = distanceTo(land, 0, 16);
    const count = [0, 5, 8, 12][level] ?? 12;
    const buildings: Building[] = [];
    let rnd = seed * 9301 + 49297;
    const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
    for (let k = 0; k < count * 6 && buildings.length < count; k++) {
      const bx = Math.round(x + (rand() - 0.5) * 7);
      const by = Math.round(y + (rand() - 0.5) * 7);
      if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
      const idx = by * W + bx;
      if (!land[idx]) continue;
      if (buildings.some((b) => Math.abs(b.base.x - (bx - (W - 1) / 2)) < 0.9 && Math.abs(b.base.z - (by - (H - 1) / 2)) < 0.9)) continue;
      const hgt = 0.9 + rand() * (0.8 + level * 0.7);
      const box = new THREE.BoxGeometry(0.9, hgt, 0.9);
      box.translate(0, hgt / 2, 0);
      const mesh = new THREE.Mesh(box, rand() < 0.3 ? roofMat : mat);
      const ground = 0.6 + Math.min(inland[idx], 8) * 0.55;
      const base = toWorld(bx, by).setY(ground);
      mesh.position.copy(base);
      group.add(mesh);
      buildings.push({ mesh, base, tilt: new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize() });
    }
    this.scene.add(group);
    return { group, buildings, mat, roofMat, shake: 0, collapse: 0, ruined: false, x, y };
  }

  /** New attempt: rebuild every city with a pop-up animation. */
  resetCities(delay = 0): void {
    this.cities.forEach((c, ci) => {
      c.ruined = false;
      c.collapse = 0;
      c.mat.color.setHex(0xf2efe6);
      c.roofMat.color.setHex(0xe06d4f);
      c.buildings.forEach((b, bi) => {
        b.mesh.position.copy(b.base);
        b.mesh.rotation.set(0, 0, 0);
        b.mesh.scale.set(1, 0.01, 1);
        const start = delay + ci * 0.15 + bi * 0.04;
        this.tween(0.5 + start, (k) => {
          const local = Math.max(0, Math.min(1, (k * (0.5 + start) - start) / 0.5));
          b.mesh.scale.y = Math.max(0.01, easeOutBack(local));
        });
      });
    });
  }

  updateCities(states: readonly CityVisualState[]): void {
    this.cities.forEach((c, i) => {
      const s = states[i];
      if (!s || c.ruined) return;
      // Walls redden as damage builds.
      const d = Math.min(1, s.damage);
      c.mat.color.setRGB(0.95, 0.94 - d * 0.45, 0.9 - d * 0.6);
    });
  }

  cityHit(i: number, strength: number): void {
    const c = this.cities[i];
    if (!c) return;
    c.shake = Math.min(1, c.shake + 0.35 + strength * 0.1);
    this.spawnEffect(c.x, c.y, '#e6f7ff', 0.6, 2, 4, 0.6);
  }

  cityRuin(i: number): void {
    const c = this.cities[i];
    if (!c || c.ruined) return;
    c.ruined = true;
    c.mat.color.setHex(0x6d6a66);
    c.roofMat.color.setHex(0x5a4a45);
    this.tween(1.4, (k) => (c.collapse = easeOut(k)));
    this.spawnEffect(c.x, c.y, '#ff8a5c', 1.2, 3, 9, 1);
    this.spawnEffect(c.x, c.y, '#ffe14d', 0.8, 2, 5, 1.5);
    this.flash = 1;
    const origin = toWorld(c.x, c.y).setY(2);
    for (let k = 0; k < 28; k++) {
      const geo = new THREE.TetrahedronGeometry(0.25 + Math.random() * 0.35);
      const mesh = new THREE.Mesh(geo, Math.random() < 0.5 ? c.mat : c.roofMat);
      mesh.position.copy(origin);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 9;
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * sp, 8 + Math.random() * 10, Math.sin(a) * sp),
        spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
        age: 0,
        life: 1.4 + Math.random() * 0.6,
      });
    }
  }

  private buildZone(x: number, y: number, threshold: number): ZoneVisual {
    const group = new THREE.Group();
    group.position.copy(toWorld(x, y));
    const top = threshold * V_SCALE;
    const hoopMat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9 });
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.3, 6, 24).rotateX(Math.PI / 2), hoopMat);
    hoop.position.y = top;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, top + 2, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.35 }),
    );
    pole.position.y = (top - 2) / 2;
    group.add(hoop, pole);
    this.scene.add(group);
    return { group, hoopMat, hoop, hit: false };
  }

  setZoneHit(i: number, hit: boolean): void {
    const z = this.zones[i];
    if (!z || z.hit === hit) return;
    z.hit = hit;
    z.hoopMat.color.setHex(hit ? 0xffffff : 0xffe14d);
    if (hit) {
      const p = z.group.position;
      this.spawnEffect(p.x + (W - 1) / 2, p.z + (H - 1) / 2, '#ffe14d', 0.9, 3, 5, z.hoop.position.y);
    }
  }

  // ---------------------------------------------------------------- quakes

  private buildQuakeMesh(kind: QuakeKind, mat?: THREE.MeshLambertMaterial): THREE.Group {
    const type = QUAKE_TYPES[kind];
    const material =
      mat ?? new THREE.MeshLambertMaterial({ color: type.color, flatShading: true, emissive: type.color, emissiveIntensity: 0.25 });
    const g = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(1.7 * type.size), material);
    gem.position.y = QUAKE_Y;
    g.add(gem);
    g.userData.gem = gem;
    if (type.length > 0) {
      // The fault line itself, lying on the water.
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(type.length, 0.25, 0.7),
        new THREE.MeshBasicMaterial({ color: type.color, transparent: true, opacity: 0.85, depthTest: false }),
      );
      bar.renderOrder = 6;
      bar.position.y = 0.4;
      g.add(bar);
      g.userData.bar = bar;
    }
    return g;
  }

  setQuakes(quakes: readonly QuakeVisual[], selectedId: number | null): void {
    const seen = new Set<number>();
    for (const q of quakes) {
      seen.add(q.id);
      let mesh = this.quakeMeshes.get(q.id);
      if (!mesh) {
        mesh = this.buildQuakeMesh(q.kind);
        this.quakeMeshes.set(q.id, mesh);
        this.quakeGroup.add(mesh);
        const m = mesh;
        m.scale.setScalar(0.01);
        this.tween(0.35, (k) => (m.userData.pop = easeOutBack(k)));
      }
      mesh.position.copy(toWorld(q.x, q.y));
      // Grid y maps to world z, so a positive cell angle turns clockwise from above.
      mesh.rotation.y = -q.angle;
      mesh.userData.selected = q.id === selectedId;
      mesh.userData.power = q.power;
      const gemMat = (mesh.userData.gem as THREE.Mesh).material as THREE.MeshLambertMaterial;
      gemMat.transparent = q.power < 1;
      gemMat.opacity = 0.35 + 0.65 * q.power;
    }
    for (const [id, mesh] of this.quakeMeshes) {
      if (seen.has(id)) continue;
      this.quakeGroup.remove(mesh);
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

  setGhost(ghost: { x: number; y: number; kind: QuakeKind; valid: boolean; power: number } | null): void {
    this.ghost.visible = !!ghost;
    if (!ghost) return;
    const type = QUAKE_TYPES[ghost.kind];
    const gem = this.ghost.userData.gem as THREE.Mesh;
    gem.scale.setScalar(type.size * (0.55 + 0.45 * ghost.power));
    this.ghostMat.opacity = 0.2 + 0.45 * ghost.power;
    this.ghostMat.color.set(ghost.valid ? type.color : '#ff3355');
    this.ghost.position.copy(toWorld(ghost.x, ghost.y));
  }

  // ---------------------------------------------------------------- water

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
              col[o] += (0.85 - col[o]) * 0.55;
              col[o + 1] += (0.95 - col[o + 1]) * 0.55;
              col[o + 2] += (1 - col[o + 2]) * 0.55;
            }
          }
        }
      }
    }
    const geo = this.water.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }

  // ---------------------------------------------------------------- effects

  /** Expanding ring where a quake fires. */
  spawnShock(x: number, y: number, color: string): void {
    this.spawnEffect(x, y, color, 1.1, 1.4, 14);
    const m = [...this.quakeMeshes.values()].find((g) => g.position.distanceTo(toWorld(x, y)) < 0.5);
    if (m) this.tween(0.4, (k) => (m.userData.kick = Math.sin(k * Math.PI)));
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
    for (const e of this.effects) this.scene.remove(e.mesh);
    for (const p of this.particles) this.scene.remove(p.mesh);
    this.effects = [];
    this.particles = [];
  }

  private tween(dur: number, fn: (k: number) => void): void {
    fn(0);
    this.tweens.push({ age: 0, dur, fn });
  }

  // ---------------------------------------------------------------- picking

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

  /** Screen position of a point above a city's skyline. */
  projectCity(i: number): { x: number; y: number } {
    const c = this.cities[i];
    return c ? this.project(c.x, c.y, 24) : { x: -999, y: -999 };
  }

  // ---------------------------------------------------------------- frame

  render(dt: number): void {
    this.clock += dt;

    this.tweens = this.tweens.filter((t) => {
      t.age += dt;
      t.fn(Math.min(1, t.age / t.dur));
      return t.age < t.dur;
    });

    if (this.camIntro < 1) {
      this.camIntro = Math.min(1, this.camIntro + dt / 1.4);
      const k = easeOut(this.camIntro);
      const from = this.camHome.clone().multiplyScalar(1.7).add(new THREE.Vector3(30, 0, -40));
      this.camera.position.lerpVectors(from, this.camHome, k);
      this.camera.lookAt(this.camLook);
      this.camera.updateMatrixWorld();
    }

    for (const g of this.quakeMeshes.values()) {
      const gem = g.userData.gem as THREE.Mesh;
      gem.rotation.y += dt * 0.8;
      const pop = (g.userData.pop as number | undefined) ?? 1;
      const kick = (g.userData.kick as number | undefined) ?? 0;
      const power = (g.userData.power as number | undefined) ?? 1;
      g.scale.setScalar(Math.max(0.01, pop * (0.55 + 0.45 * power) * (g.userData.selected ? 1.2 : 1) * (1 + kick * 0.4)));
    }
    (this.ghost.userData.gem as THREE.Mesh).rotation.y += dt * 0.8;

    this.spawnGroup.children.forEach((g) => {
      if (g.userData.noGo) return;
      const ring = g.children[1] as THREE.Mesh;
      const m = ring.material as THREE.MeshBasicMaterial;
      m.opacity = 0.55 + 0.35 * Math.sin(this.clock * 2.4 + g.userData.phase);
    });

    for (const z of this.zones) {
      z.hoop.rotation.y += dt * (z.hit ? 3 : 0.6);
      z.hoop.scale.setScalar(z.hit ? 1 + 0.08 * Math.sin(this.clock * 8) : 1);
    }

    for (const c of this.cities) {
      c.shake = Math.max(0, c.shake - dt * 2.5);
      c.buildings.forEach((b, i) => {
        const s = c.shake * 0.25;
        const jx = Math.sin(this.clock * 55 + i) * s;
        const jz = Math.cos(this.clock * 47 + i * 2) * s;
        const fall = c.collapse;
        b.mesh.position.set(b.base.x + jx + b.tilt.x * fall * 0.8, b.base.y - fall * 1.6, b.base.z + jz + b.tilt.z * fall * 0.8);
        b.mesh.rotation.set(b.tilt.z * fall * 1.1, 0, -b.tilt.x * fall * 1.1);
      });
    }

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

    this.particles = this.particles.filter((p) => {
      p.age += dt;
      if (p.age >= p.life) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        return false;
      }
      p.vel.y -= 30 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.scale.setScalar(1 - p.age / p.life);
      return true;
    });

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 2.5);
      (this.scene.background as THREE.Color).setRGB(0.024 + this.flash * 0.2, 0.082 + this.flash * 0.08, 0.145);
    }

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
