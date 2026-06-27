import * as THREE from "three";
import { Particle } from "/Particle.js";
import { Tiles } from '/Tile.js';

const FIXED_TIMESTEP = 1.0 / 20.0;

export class ParticleEngine {
  constructor(atlasTexture, scene, world = null) {
    this.atlas = atlasTexture;
    this.scene = scene;
    this.world = world;
    this.particles = [];

    this.accumulator = 0.0;

    // Accept either a camera directly or an object with a .camera property
    this.camera = null;

    this.tileSize = 1 / 16;
    this.topRowOffsetY = 1.0 - this.tileSize;
    this.pixelSize = 1.0 / 256.0;
    this.tileKeys = ["grass_top", "stone", "dirt", "grass_side", "wood", "cobble", "key6"];
  }

  setWorld(world) {
    this.world = world;
  }

  // Pass either a THREE.Camera or a player object with a .camera property
  setPlayer(playerOrCamera) {
    if (playerOrCamera && playerOrCamera.isCamera) {
      this.camera = playerOrCamera;
    } else if (playerOrCamera && playerOrCamera.camera) {
      this.camera = playerOrCamera.camera;
    } else {
      this.camera = playerOrCamera; // fallback, let Particle handle it
    }
  }

  getUVForBlockId(blockId, face = 0) {
    const tile = Tiles.byId[blockId];
    if (!tile) {
      return { u: 1 * this.tileSize, v: this.topRowOffsetY, scale: this.tileSize };
    }

    const texKey = tile.getTextureKey(face);
    const col = this.tileKeys.indexOf(texKey);

    let uOffset, vOffset;

    if (texKey === "cobble") {
      const stoneCol = Math.max(0, this.tileKeys.indexOf("stone"));
      uOffset = stoneCol * this.tileSize;
      vOffset = this.topRowOffsetY - this.pixelSize * 16;
    } else if (texKey === "key6") {
      uOffset = 15 * this.tileSize;
      vOffset = this.topRowOffsetY;
    } else {
      uOffset = Math.max(0, col) * this.tileSize;
      vOffset = this.topRowOffsetY;
    }

    return { u: uOffset, v: vOffset, scale: this.tileSize };
  }

  spawnAt(x, y, z, blockId, count = 8, options = {}) {
    if (!this.world) {
      console.warn("ParticleEngine: World not set, cannot spawn particles");
      return;
    }

    const {
      speed = 1.0,
      gravity = 0.04,
      drag = 0.98,
      friction = 0.7,
      life = 1.5,
      spread = 1.0
    } = options;

    const uvInfo = this.getUVForBlockId(blockId, 1);

    // subdivide the base tile into a 4x4 grid and pick a random quadrant per-particle
    // so each particle samples a different sub-region (matches Java-style uo/vo/4 subdivision)
    const subCols = 4;
    const subColsInv = 1.0 / subCols;
    // preserve the base uv so we can compute independent sub-quads per particle
    const baseU = uvInfo.u;
    const baseV = uvInfo.v;
    const baseScale = uvInfo.scale;

    // Force particle brightness to a consistent 0.8 (override world-based brightness)
    const brightness = 0.8;

    const spawnX = x + 0.5;
    const spawnY = y + 0.5;
    const spawnZ = z + 0.5;

    // Use requested particle count without doubling to reduce spawn pressure
    const actualCount = Math.max(1, Math.floor(count)) * 1;

    for (let i = 0; i < actualCount; i++) {
      let velX = (Math.random() * 2 - 1) * 0.4 * spread;
      let velY = (Math.random() * 2 - 1) * 0.4 * spread;
      let velZ = (Math.random() * 2 - 1) * 0.4 * spread;

      // pick a random sub-quad for this particle and compute its own uv info
      const subU = Math.floor(Math.random() * subCols);
      const subV = Math.floor(Math.random() * subCols);
      const uvLocal = {
        u: baseU + subU * (baseScale * subColsInv),
        v: baseV + subV * (baseScale * subColsInv),
        scale: baseScale * subColsInv
      };

      // 20% faster base speed
      const particleSpeed = (Math.random() + Math.random() + 1) * 0.18 * speed;
      const dd = Math.sqrt(velX * velX + velY * velY + velZ * velZ);

      if (dd > 0) {
        velX = velX / dd * particleSpeed * 0.4;
        // reduced upward bias so particles don't go as high
        velY = velY / dd * particleSpeed * 0.4 + 0.16;
        velZ = velZ / dd * particleSpeed * 0.4;
      }

      const lifetimeMultiplier = 1.0 + Math.random();
      const adjustedLife = life * lifetimeMultiplier;

      const p = new Particle(
        this.atlas,
        this.scene,
        this.world,
        spawnX,
        spawnY,
        spawnZ,
        velX,
        velY,
        velZ,
        uvLocal,
        blockId,
        adjustedLife,
        null,
        brightness
      );

      p.gravity = -gravity;
      p.drag = drag;
      p.friction = friction;
      // amplify per-spawn multiplier so particles appear much larger
      // make particles one-third of their previous spawn-time visual size,
      // then scale up slightly less to reduce overall size a touch.
      p.renderSize /= 3.0;
      p.renderSize *= 1.55;
      p.mesh.scale.set(p.renderSize, p.renderSize, p.renderSize);

      this.particles.push(p);
    }
  }

  add(particle) {
    this.particles.push(particle);
  }

  update(delta) {
    const clampedDelta = Math.min(delta, 0.1);
    this.accumulator += clampedDelta;

    while (this.accumulator >= FIXED_TIMESTEP) {
      this.accumulator -= FIXED_TIMESTEP;

      for (let i = this.particles.length - 1; i >= 0; --i) {
        const p = this.particles[i];
        p.fixedTick();

        if (p.removed) {
          p.dispose?.();
          this.particles.splice(i, 1);
        }
      }
    }

    const alpha = this.accumulator / FIXED_TIMESTEP;

    for (const p of this.particles) {
      // Pass camera directly — Particle.render() uses quaternion copy for billboard
      p.render(alpha, this.camera);
    }
  }

  tick(delta) {
    this.update(delta);
  }

  dispose() {
    for (const p of this.particles) {
      p.dispose?.();
    }
    this.particles = [];
    this.accumulator = 0.0;
  }
}