import * as THREE from "three";
import { AABB } from "/AABB.js";
import { Tiles } from "/Tile.js";

/**
 * Returns an event handler suitable for window.addEventListener('player:checkExposure', handler).
 * The handler will call world.checkExposureAt(x,y,z) and, if it indicates a change, invoke onChanged(x,y,z).
 * Additionally, when a change is detected it dispatches a 'player:convertGrass' event so runtime
 * code can immediately attempt a grass->dirt conversion reaction.
 */
export function makeExposureHandler(world, onChanged) {
  return function (ev) {
    try {
      if (!world || typeof world.checkExposureAt !== "function") return;
      const d = ev && ev.detail;
      if (!d) return;
      const x = d.x, y = d.y, z = d.z;
      const changed = world.checkExposureAt(x, y, z);
      if (changed && typeof onChanged === "function") {
        try { onChanged(x, y, z); } catch (e) { console.warn('onChanged callback failed', e); }
      }
      // Always attempt to notify runtime to convert grass immediately when exposure check reports change.
      // This mirrors the player's direct convert dispatch and ensures checkExposure triggers conversion hooks.
      try {
        const conv = new CustomEvent('player:convertGrass', { detail: { x: x, y: y, z: z } });
        window.dispatchEvent(conv);
      } catch (e) {
        // non-fatal, just log
        console.warn('player:convertGrass dispatch failed from makeExposureHandler', e);
      }
    } catch (err) {
      console.warn('player:checkExposure handler failed', err);
    }
  };
}

 // Local fixed-step and movement constants (kept in sync with main.js defaults)
 // These ensure Player.js is self-contained and won't throw ReferenceError if main.js globals are not available.
 const FIXED_DT = 3.0 / 64.0; // slowed to one-third tick rate (3x the original timestep)
 // Reduce movement "energy" to one-third: lower base per-tick movement multipliers.
 const GROUND_SPEED_PER_TICK_BASE = 0.01;     // previously 0.03
 const AIR_SPEED_PER_TICK_BASE = 0.0066666667; // previously 0.01
 const GROUND_SPEED_PER_TICK_BOOSTED = GROUND_SPEED_PER_TICK_BASE * 1.5;
 const AIR_SPEED_PER_TICK_BOOSTED = AIR_SPEED_PER_TICK_BASE * 1.5;

export class Player {
  constructor(scene, camera, world) {
    this.scene = scene; this.camera = camera; this.world = world;
    this.x = 0; this.y = 0; this.z = 0;
    this.prevX = 0; this.prevY = 0; this.prevZ = 0;
    this.motionX = 0; this.motionY = 0; this.motionZ = 0;
    this.xRotation = 0; this.yRotation = 0;
    this.onGround = false; this.width = 0.3; this.height = 0.9;
    this.boundingBox = new AABB(0,0,0,0,0,0);
    this.controls = { forward:false, backward:false, left:false, right:false, jump:false };
    this.onMouseMove = this.onMouseMove.bind(this);

    // Y-axis inversion flag (toggle with KeyY)
    this.invertY = false;

    // short-lived post-jump velocity boost ticks (applied after jump without raising initial impulse)
    this._jumpBoostTicks = 0;

    this.initControls();
    this.initPointerLock();
    this.resetPosition();
    this.fallStartY = null;
    this._wasOnGround = false;
    this._isLowPerf = false; // cache low-perf detection

    // internal guard so we only patch the water material once
    this._waterMatPatched = false;
  }
  
  initControls() {
    // input enabled flag - handlers will ignore input when !this.enabled
    if (typeof this.enabled === 'undefined') this.enabled = true;

    document.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      switch (e.code) {
        case "KeyW": case "ArrowUp": this.controls.forward = true; break;
        case "KeyS": case "ArrowDown": this.controls.backward = true; break;
        case "KeyA": case "ArrowLeft": this.controls.left = true; break;
        case "KeyD": case "ArrowRight": this.controls.right = true; break;
        case "Space": this.controls.jump = true; break;
        case "KeyR": this.resetPosition(); break;
        // Toggle mouse Y inversion
        case "KeyY":
          this.invertY = !this.invertY;
          console.log("Invert Y:", this.invertY);
          break;
      }
    });

    document.addEventListener("keyup", (e) => {
      if (!this.enabled) return;
      switch (e.code) {
        case "KeyW": case "ArrowUp": this.controls.forward = false; break;
        case "KeyS": case "ArrowDown": this.controls.backward = false; break;
        case "KeyA": case "ArrowLeft": this.controls.left = false; break;
        case "KeyD": case "ArrowRight": this.controls.right = false; break;
        case "Space": this.controls.jump = false; break;
      }
    });
  }
  
  initPointerLock() {
    const canvas = document.getElementById("canvas");
    if (!canvas) return;
    // only request pointer lock when player input is enabled
    canvas.addEventListener("click", () => {
      try {
        if (this.enabled) canvas.requestPointerLock();
      } catch (e) { /* ignore */ }
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === canvas) {
        // attach mousemove only when pointer locked AND input enabled
        if (this.enabled) document.addEventListener("mousemove", this.onMouseMove, false);
      } else {
        document.removeEventListener("mousemove", this.onMouseMove, false);
      }
    });
  }
  
  onMouseMove(e) {
    const mx = e.movementX || 0, my = e.movementY || 0;
    // apply inversion flag to mouse Y movement
    const myAdj = my * (this.invertY ? -1 : 1);
    this.yRotation -= 0.15 * mx;
    this.xRotation -= 0.15 * myAdj;
    this.xRotation = Math.max(-90, Math.min(90, this.xRotation));
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.set(THREE.MathUtils.degToRad(this.xRotation), THREE.MathUtils.degToRad(this.yRotation), 0);
  }
  
  resetPosition() {
    this.setPosition(Math.random() * this.world.width, this.world.depth + 5, Math.random() * this.world.height);
    this.motionY = -0.12;
  }
  
  update() { this.tick(FIXED_DT); }
  
  // Fixed timestep: dt parameter is ignored; always uses FIXED_DT (1/60s)
  // Reworked to mirror classic Minecraft jump / water/lava behavior.
  tick(delta) {
    // Ensure the engine's water (and lava) materials render correctly relative to opaque
    // geometry WITHOUT disturbing render order of solid blocks in the same chunk mesh.
    //
    // Previous behavior (removed): this block forced depthWrite=true on the water material AND
    // set mesh.renderOrder = 1000 on the *entire* chunk mesh whenever that chunk contained any
    // water. Because a chunk mesh contains every block type in that chunk as material groups on
    // one THREE.Mesh, bumping renderOrder at the mesh level reordered solid-block faces too —
    // not just the water faces — relative to neighboring chunks (which render at the default
    // order). Combined with depthWrite:true on a transparent material, this caused water's
    // translucent quads to write depth values that opaque blocks in adjacent/neighboring chunks
    // then incorrectly failed the depth test against, producing the "transparency disables
    // textures of blocks around it" symptom.
    //
    // Correct, standard approach: translucent surfaces should NOT write depth (depthWrite:
    // false) — that's what lets opaque geometry behind/beside them continue to depth-test and
    // render normally regardless of draw order. They should still depth-test (depthTest: true)
    // so solid blocks correctly occlude them. Three.js's default transparent-object sorting
    // (back-to-front by distance) then handles correct visual layering without us having to
    // hand-reorder whole chunk meshes. We only nudge the water material's OWN renderOrder
    // slightly above default so multiple overlapping transparent water quads sort predictably;
    // solid block faces in the same mesh are untouched since renderOrder lives on the mesh, but
    // since we no longer touch mesh.renderOrder here, all chunk meshes share the same default
    // render order and sort purely by Three.js's normal opaque/transparent passes.
    if (!this._waterMatPatched) {
      try {
        const matMap = (this.world && this.world.materialIndexMap) ? this.world.materialIndexMap : null;
        const mats = (this.world && this.world.blockMaterials) ? this.world.blockMaterials : null;
        if (matMap && mats && typeof matMap['water'] !== 'undefined') {
          const midx = matMap['water'];
          const wmat = mats[midx];
          if (wmat) {
            // Translucent, depth-tested, but NOT depth-writing: lets opaque neighbors render
            // correctly regardless of draw order, while water itself still gets properly
            // occluded by solid blocks in front of it.
            wmat.transparent = true;
            wmat.depthWrite = false;
            wmat.depthTest = true;
            wmat.side = THREE.DoubleSide; // allow both faces for chunk geometry
            wmat.blending = THREE.NormalBlending;

            wmat.polygonOffset = false;
            wmat.polygonOffsetFactor = 0.0;
            wmat.polygonOffsetUnits = 0.0;

            // small alpha cutoff helps drop near-transparent texels that can produce noise at seams
            if (typeof wmat.alphaTest === "undefined") wmat.alphaTest = 0.01;

            try { wmat.needsUpdate = true; } catch (e) {}
          }

          // No longer touch mesh.renderOrder or mesh.userData.containsWater for render-ordering
          // purposes. We still tag containsWater on userData (other systems, e.g. loadChunk's
          // frustum-culling decision, use this flag), but we no longer use it to reorder draw
          // order at the mesh level — that was the source of the bug.
          try {
            if (this.world && this.world.loadedChunkMeshes) {
              for (const mesh of this.world.loadedChunkMeshes.values()) {
                const matArr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (!matArr || !matArr.length) continue;

                let containsWater = false;
                for (let m of matArr) {
                  if (m === wmat) { containsWater = true; break; }
                }

                try {
                  mesh.userData = mesh.userData || {};
                  mesh.userData.containsWater = containsWater;
                  // Intentionally NOT setting mesh.renderOrder here anymore.
                } catch (e) {
                  // ignore userData failures on exotic objects
                }

                for (let wm of matArr) {
                  if (!wm) continue;
                  if (wm === wmat) {
                    wm.transparent = true;
                    wm.depthWrite = false;
                    wm.depthTest = true;
                    wm.side = THREE.DoubleSide;
                    wm.blending = THREE.NormalBlending;
                    wm.polygonOffset = false;
                    if (typeof wm.alphaTest === "undefined") wm.alphaTest = 0.01;
                    try { wm.needsUpdate = true; } catch (e) {}
                  }
                }
              }
            }
          } catch (e) {
            console.warn('Failed to propagate water material flags to chunk meshes', e);
          }
        }
      } catch (e) {
        // non-fatal
        console.warn('water material patch failed', e);
      } finally {
        this._waterMatPatched = true;
      }
    }

    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;

    // Input axes: forward/back (ya) and left/right (xa)
    let xa = 0, ya = 0;
    if (this.controls.forward) ya -= 1;
    if (this.controls.backward) ya += 1;
    if (this.controls.left) xa -= 1;
    if (this.controls.right) xa += 1;

    // Liquid detection: check the block at the player's eye/feet position against the world's
    // actual liquid tile ids. Previously these were hardcoded to false (stubbed), so swimming
    // physics never actually engaged even when standing in water/lava.
    let inWater = false, inLava = false;
    try {
      const footY = Math.floor(this.y - 1.62);
      const bx = Math.floor(this.x), bz = Math.floor(this.z);
      if (this.world && typeof this.world.getTile === 'function') {
        const id = this.world.getTile(bx, footY, bz);
        const WATER_ID = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
        const CALM_WATER_ID = (typeof Tiles !== "undefined" && Tiles.calmWater) ? Tiles.calmWater.id : null;
        const LAVA_ID = (typeof Tiles !== "undefined" && Tiles.lava) ? Tiles.lava.id : null;
        const CALM_LAVA_ID = (typeof Tiles !== "undefined" && Tiles.calmLava) ? Tiles.calmLava.id : null;

        inWater = (WATER_ID !== null && id === WATER_ID) || (CALM_WATER_ID !== null && id === CALM_WATER_ID);
        inLava = (LAVA_ID !== null && id === LAVA_ID) || (CALM_LAVA_ID !== null && id === CALM_LAVA_ID);
      }
    } catch (e) { /* ignore */ }

    // Jump handling follows decompiled Java:
    if (this.controls.jump) {
      if (inWater) {
        // halve upward boost when jumping in water
        this.motionY += 0.02;
      } else if (inLava) {
        this.motionY += 0.04;
      } else if (this.onGround) {
        // Use a lower per-tick gravity but keep jump apex the same by reducing the initial impulse.
        // Original values: gravity ~= 0.02, jump impulse = 0.20664 -> apex h = v^2/(2g).
        // New gravity chosen below is 0.01, so scale initial velocity by sqrt(0.01/0.02).
        this.motionY = 0.14612; // adjusted jump impulse to preserve apex with reduced gravity
        // consume jump press so it behaves like the original (one-shot)
        this.controls.jump = false;
      }
    }

    // Movement input: use reduced per-tick moveRelative values (one-third of previous energy)
    const moveSpeed = this.onGround ? 0.0333333333 : 0.0066666667; // ground: ~0.1/3, air: ~0.02/3
    this.moveRelative(xa, ya, moveSpeed);

    // Apply movement & collisions
    this.move(this.motionX, this.motionY, this.motionZ);

    // Damping & gravity per environment (mirrors Java multipliers)
    if (inWater) {
      this.motionX *= 0.8;
      this.motionY *= 0.8;
      this.motionZ *= 0.8;
      // halve downward acceleration while in water
      this.motionY -= 0.01;
      // Classic behaviour: small upward nudge if colliding horizontally and space above
      // (best-effort approximation; world.isFree not present here so skip complex check)
    } else if (inLava) {
      this.motionX *= 0.5;
      this.motionY *= 0.5;
      this.motionZ *= 0.5;
      this.motionY -= 0.02;
    } else {
      // air / ground
      this.motionX *= 0.91;
      // slow per-tick vertical progression so jumps take more ticks to advance, but with a smaller gravity value.
      this.motionY *= 0.995;   // weaker vertical damping for slower tickwise change
      this.motionZ *= 0.91;

      // Lower gravity acceleration per tick (was 0.02). Using 0.01 reduces downward acceleration
      // but we adjusted the jump impulse above so peak height remains effectively unchanged.
      this.motionY -= 0.01;

      if (this.onGround) {
        this.motionX *= 0.6;
        this.motionZ *= 0.6;
      }
    }

    // Update camera and track previous ground state
    this.camera.position.set(this.x, this.y, this.z);
    this._wasOnGround = this.onGround;
  }
  
  moveRelative(strafe, forward, speed) {
    let len2 = strafe*strafe + forward*forward;
    if (len2 >= 0.01) {
      const s = speed / Math.sqrt(len2);
      strafe *= s; forward *= s;
      const rad = THREE.MathUtils.degToRad(this.yRotation);
      const sin = Math.sin(rad), cos = Math.cos(rad);
      this.motionX += forward * sin + strafe * cos;
      this.motionZ += forward * cos - strafe * sin;
    }
  }
  
  move(dx, dy, dz) {
    let sx = dx, sy = dy, sz = dz;
    const expanded = this.boundingBox.expand(dx, dy, dz);
    const cubes = this.world.getCubes(expanded);
    for (const c of cubes) dy = c.clipYCollide(this.boundingBox, dy);
    this.boundingBox.move(0, dy, 0);
    for (const c of cubes) dx = c.clipXCollide(this.boundingBox, dx);
    this.boundingBox.move(dx, 0, 0);
    for (const c of cubes) dz = c.clipZCollide(this.boundingBox, dz);
    this.boundingBox.move(0, 0, dz);
    this.onGround = sy !== dy && sy < 0;
    if (sx !== dx) this.motionX = 0;
    if (sy !== dy) this.motionY = 0;
    if (sz !== dz) this.motionZ = 0;
    this.x = (this.boundingBox.minX + this.boundingBox.maxX) / 2;
    this.y = this.boundingBox.minY + 1.62;
    this.z = (this.boundingBox.minZ + this.boundingBox.maxZ) / 2;

    // Dispatch exposure check signal so main.js can react (convert grass<->dirt via world tick system)
    try {
      const footX = Math.floor(this.x);
      const footY = Math.floor(this.y - 1.62); // player's feet block Y
      const footZ = Math.floor(this.z);
      const ev = new CustomEvent('player:checkExposure', { detail: { x: footX, y: footY, z: footZ } });
      window.dispatchEvent(ev);

      // NEW: also emit a dedicated convert-grass signal so the main runtime can immediately
      // evaluate and convert any grass block under the player's feet that lost sunlight (or became covered).
      try {
        const conv = new CustomEvent('player:convertGrass', { detail: { x: footX, y: footY, z: footZ } });
        window.dispatchEvent(conv);
      } catch (innerErr) {
        console.warn('player:convertGrass dispatch failed', innerErr);
      }
    } catch (e) {
      // non-fatal; don't break game if events fail
      console.warn('player:checkExposure dispatch failed', e);
    }
  }
  
  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    const w = this.width, h = this.height;
    this.boundingBox = new AABB(x - w, y - h, z - w, x + w, y + h, z + w);
    this.camera.position.set(this.x, this.y, this.z);
  }
  
  // Called periodically to update low-perf detection
  updateLowPerfStatus(fpsSmoothed) {
    const isLowPerf = (window.devicePixelRatio && window.devicePixelRatio > 1.5) ||
                      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
                      (typeof fpsSmoothed === "number" && fpsSmoothed < 50);
    this._isLowPerf = isLowPerf;
  }
}

export class World {
  constructor(materials, materialIndexMap, superflat = false) {
    this.width = 256; this.height = 256; this.depth = 64;
    this.blocks = new Uint8Array(this.width * this.height * this.depth);
    this.lightDepths = new Uint8Array(this.width * this.height);
    // Exposure timers: allocated once, reused (not recreated)
    this.exposedTimers = new Float32Array(this.width * this.height * this.depth);
    this.blockMaterials = materials; this.materialIndexMap = materialIndexMap;
    this.chunkSizeX = 16; this.chunkSizeY = this.depth; this.chunkSizeZ = 16;
    this.loadedChunkMeshes = new Map();
    this.superflat = !!superflat;

    // Tracks which blocks were created as "dirt" by world generation so we can avoid
    // auto-converting those to grass via processExposure.
    this.generatedDirt = new Uint8Array(this.width * this.height * this.depth);
  }
  
  async init() {
    this.generate();
    this.calcLightDepths(0, 0, this.width, this.height);
  }
  
  generate() {
    if (this.superflat) {
      // superflat: single grass top, a few dirt layers, then stone
      const topY = Math.max(1, Math.floor(this.depth / 3));
      const dirtDepth = 3;
      for (let x = 0; x < this.width; x++) {
        for (let z = 0; z < this.height; z++) {
          for (let y = 0; y < this.depth; y++) {
            const worldY = y;
            if (worldY === 0) {
              this.setTile(x, worldY, z, Tiles.stone.id);
            } else if (worldY < topY - dirtDepth) {
              this.setTile(x, worldY, z, Tiles.stone.id);
            } else if (worldY >= topY - dirtDepth && worldY < topY) {
              this.setTile(x, worldY, z, Tiles.dirt.id);
            } else if (worldY === topY) {
              this.setTile(x, worldY, z, Tiles.grass_top.id);
            } else {
              this.setTile(x, worldY, z, 0);
            }
          }
        }
      }

      // small lightweight cave carving to avoid completely solid stone
      const count = Math.max(1, Math.floor(this.width * this.height / 16384));
      for (let i = 0; i < count; i++) {
        let cx = Math.floor(Math.random() * this.width);
        let cy = Math.floor(Math.random() * (this.depth / 2));
        let cz = Math.floor(Math.random() * this.height);
        let length = 20 + Math.floor(Math.random() * 80);
        let dir1 = Math.random() * Math.PI * 2;
        let dir2 = Math.random() * Math.PI * 2;
        for (let l = 0; l < length; l++) {
          cx += Math.sin(dir1) * Math.cos(dir2);
          cz += Math.cos(dir1) * Math.cos(dir2);
          cy += Math.sin(dir2);
          dir1 += (Math.random() - Math.random()) * 0.3;
          dir2 += (Math.random() - Math.random()) * 0.1;
          const size = Math.sin(l * Math.PI / length) * 1.5 + 0.6;
          for (let xx = Math.floor(cx - size); xx <= Math.floor(cx + size); xx++) {
            for (let yy = Math.floor(cy - size); yy <= Math.floor(cy + size); yy++) {
              for (let zz = Math.floor(cz - size); zz <= Math.floor(cz + size); zz++) {
                if (xx > 0 && yy > 0 && zz > 0 && xx < this.width - 1 && yy < this.depth - 1 && zz < this.height - 1) {
                  const xd = xx - cx, yd = yy - cy, zd = zz - cz;
                  const dd = xd * xd + yd * yd * 2 + zd * zd;
                  if (dd < size * size && this.getTile(xx, yy, zz) === Tiles.stone.id) {
                    this.setTile(xx, yy, zz, 0);
                  }
                }
              }
            }
          }
        }
      }
    } else {
      const top = Math.floor(2 * this.depth / 3);
      for (let x = 0; x < this.width; x++)
        for (let y = 0; y < this.depth; y++)
          for (let z = 0; z < this.height; z++) {
            const id = y <= top ? Tiles.stone.id : 0;
            this.setTile(x, y, z, id);
          }
      for (let x = 0; x < this.width; x++)
        for (let z = 0; z < this.height; z++)
          if (top >= 0) {
            this.setTile(x, top, z, Tiles.grass_top.id);
            for (let s = top - 1; s >= Math.max(0, top - 3); s--) this.setTile(x, s, z, Tiles.dirt.id);
          }
    }

    // Reset exposure timers (reuse existing array)
    for (let i = 0; i < this.exposedTimers.length; i++) this.exposedTimers[i] = 0;

    // Mark generated dirt for this freshly generated world so processExposure can skip it.
    try {
      const DIRT_ID = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
      for (let i = 0, len = this.blocks.length; i < len; i++) {
        this.generatedDirt[i] = (this.blocks[i] === DIRT_ID) ? 1 : 0;
      }
    } catch (e) {
      // non-fatal: if marking fails, leave generatedDirt as zeros
      for (let i = 0; i < this.generatedDirt.length; i++) this.generatedDirt[i] = 0;
    }
  }
  
  calcLightDepths(startX, startZ, w, h) {
    for (let x = startX; x < startX + w; ++x)
      for (let z = startZ; z < startZ + h; ++z) {
        let y;
        for (y = this.depth - 1; y >= 0 && this.getTile(x, y, z) === 0; --y);
        this.lightDepths[x + z * this.width] = y;
      }
  }

  // Mark which dirt blocks in the current blocks array were generated by the world generator.
  // This allows runtime systems (processExposure) to avoid auto-converting generator-placed dirt.
  markGeneratedDirtFromBlocks() {
    try {
      const DIRT_ID = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
      if (!this.generatedDirt || this.generatedDirt.length !== this.blocks.length) {
        this.generatedDirt = new Uint8Array(this.blocks.length);
      }
      for (let i = 0; i < this.blocks.length; i++) {
        this.generatedDirt[i] = (this.blocks[i] === DIRT_ID) ? 1 : 0;
      }
    } catch (e) {
      // non-fatal: ensure array exists but keep it cleared on error
      try {
        this.generatedDirt = new Uint8Array(this.blocks.length);
      } catch (inner) {}
    }
  }
  
 getBrightness(x, y, z, face) {
    let nx = x, ny = y, nz = z;
    switch (face) {
      case 0: ny += 1; break;
      case 1: ny -= 1; break;
      case 2: nz -= 1; break;
      case 3: nz += 1; break;
      case 4: nx += 1; break;
      case 5: nx -= 1; break;
      default: return { finalBrightness: 1, isSunlit: true };
    }
    if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.depth || nz < 0 || nz >= this.height)
      return { finalBrightness: 1, isSunlit: true };

    // If this column or any immediately adjacent column contains water above this Y,
    // treat the block as submerged so all faces get the same underwater dimming.
    try {
      const waterId = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
      if (waterId !== null) {
        // check 3x3 neighborhood columns centered on (nx,nz) for the highest water surface
        let highestWater = -1;
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const cx = nx + ox, cz = nz + oz;
            if (cx < 0 || cx >= this.width || cz < 0 || cz >= this.height) continue;
            for (let yy = this.depth - 1; yy >= 0; yy--) {
              if (this.getTile(cx, yy, cz) === waterId) { 
                if (yy > highestWater) highestWater = yy;
                break;
              }
            }
          }
        }
        if (highestWater >= 0 && highestWater > ny) {
          // submerged: depthUnder = highestWater - ny
          const depthUnder = highestWater - ny;
          // Surface-anchored falloff: even a single block underwater (depthUnder = 1) takes a
          // real, visible brightness hit instead of barely dimming. SURFACE_DROP sets that
          // immediate hit at the surface; DECAY_RATE controls how much further it darkens with
          // additional depth below that.
          const SURFACE_DROP = 0.65;   // brightness multiplier applied at depthUnder = 1
          const DECAY_RATE = 0.18;     // how quickly it keeps darkening with further depth
          const dim = SURFACE_DROP * Math.exp(-DECAY_RATE * (depthUnder - 1));
          const finalBrightness = Math.max(0.18, Math.min(1.0, dim));
          return { finalBrightness: finalBrightness, isSunlit: false };
        }
      }
    } catch (e) {
      // fall through to normal logic if underwater check fails
    }

    // Strict vertical check (default behavior for non-submerged blocks)
    let sun = ny >= this.lightDepths[nx + nz * this.width];
    return { finalBrightness: sun ? 1.0 : 0.5, isSunlit: sun };
  }

  /* shouldRenderFaceAgainst — single source of truth for "does block `id` need a face drawn
     against neighbor `neighborId`?" Used by all three face-emission passes (top greedy-mesh,
     bottom per-block, side per-block) so culling rules can't drift between them.

     Rules (in order):
       1. Neighbor out of bounds or air (id 0)        -> always draw (nothing there to hide it).
       2. Neighbor has preventsCulling (cobble/key6 etc, non-cube/cutout geometry) -> always draw.
       3. If the neighbor is a liquid -> always draw (we never let liquids hide adjacent faces).
       4. If this block is a liquid and neighbor is a different liquid -> draw (different liquids show faces).
       5. Otherwise -> standard opaque-neighbor culling (don't draw).
  */
  shouldRenderFaceAgainst(id, neighborId) {
    // Air or out-of-bounds -> always draw.
    if (neighborId === 0) return true;

    const neighborTile = Tiles.byId[neighborId];
    // Unknown neighbor -> be conservative and draw.
    if (!neighborTile) return true;

    // If neighbor explicitly prevents culling (cutout / special geometry) -> draw.
    if (neighborTile.preventsCulling) return true;

    const thisTile = Tiles.byId[id];

    // If this block is a liquid:
    if (thisTile && thisTile.isLiquid) {
      // Same liquid (same id) -> cull internal faces between touching same-liquid blocks.
      if (neighborTile.isLiquid && neighborId === id) return false;
      // Any other neighbor (different liquid, solid, partial) -> always draw the liquid face.
      // This ensures water sides are visible from every angle and at all chunk borders.
      return true;
    }

    // If this block is solid and neighbor is liquid -> draw the solid face so the boundary is visible once.
    if (neighborTile.isLiquid) return true;

    // Otherwise (solid vs solid non-special): cull (do not draw this face).
    return false;
  }

  buildChunkMesh(chunkX, chunkZ) {
    const positions = [], normals = [], uvs = [], colors = [], isSunlit = [], isSideBoundaryFace = [], isBottomBoundaryFace = [], faceIds = [];
    const indices = [], groups = [];
    let vertexCount = 0;

    const startX = chunkX * this.chunkSizeX;
    const endX = Math.min((chunkX + 1) * this.chunkSizeX, this.width);
    const startZ = chunkZ * this.chunkSizeZ;
    const endZ = Math.min((chunkZ + 1) * this.chunkSizeZ, this.height);

    const isEdgeFace = (x, z, face) => (face === 2 && z === this.height - 1) || (face === 3 && z === 0) || (face === 4 && x === 0) || (face === 5 && x === this.width - 1);

    const pushQuad = (x0, y0, z0, x1, y1, z1, matIndex, brightness, sun, sideBoundary, bottomBoundary, faceId = 0) => {
      // Produce vertices in a consistent, planar order to ensure greedy merged quads
      // are real rectangles (no twisted / non-genuine quads at long distances).
      // Vertex order: bottom-left, bottom-right, top-left, top-right (in local XY/Z ordering).
      positions.push(
        x0, y0, z0, // bottom-left
        x1, y0, z0, // bottom-right
        x0, y1, z1, // top-left
        x1, y1, z1  // top-right
      );
      // consistent upward normals for top-like quads
      normals.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
      const quadW = Math.abs(x1 - x0);
      const quadH = Math.abs(z1 - z0);
      // UVs laid out to match vertex order above
      // If this quad's material is the registered water material, emit world-space XZ UVs so
      // water sampling is continuous across chunk borders and top faces align with sides.
      const isWaterMat = (typeof this.materialIndexMap !== 'undefined' && typeof this.materialIndexMap['water'] !== 'undefined' && matIndex === this.materialIndexMap['water']);
      if (isWaterMat) {
        // Use world-space XZ coordinates as UVs (consistent sampling for water shaders that compute
        // UVs from world position). Vertex order: (x0,z0),(x1,z0),(x0,z1),(x1,z1)
        uvs.push(x0, z0, x1, z0, x0, z1, x1, z1);
      } else {
        uvs.push(0, 0, quadW, 0, 0, quadH, quadW, quadH);
      }
      for (let i = 0; i < 4; i++) {
        colors.push(brightness, brightness, brightness);
        isSunlit.push(sun ? 1 : 0);
        isSideBoundaryFace.push(sideBoundary ? 1 : 0);
        isBottomBoundaryFace.push(bottomBoundary ? 1 : 0);
        faceIds.push(faceId);
      }
      // triangle indices consistent with vertex winding
      indices.push(vertexCount, vertexCount+2, vertexCount+1, vertexCount+1, vertexCount+2, vertexCount+3);
      groups.push({ materialIndex: matIndex, start: indices.length - 6, count: 6 });
      vertexCount += 4;
    };

    // Top faces: greedy meshed for optimization
    for (let y = 0; y < this.depth; y++) {
      const maskW = endX - startX;
      const maskH = endZ - startZ;
      const mask = new Int32Array(maskW * maskH);
      const brightnessMask = new Float32Array(maskW * maskH);
      const sunMask = new Uint8Array(maskW * maskH);
      const sideBoundaryMask = new Uint8Array(maskW * maskH);
      const bottomBoundaryMask = new Uint8Array(maskW * maskH);

      for (let ix = startX; ix < endX; ix++) {
        for (let iz = startZ; iz < endZ; iz++) {
          const localX = ix - startX, localZ = iz - startZ;
          const id = this.getTile(ix, y, iz);
          const above = this.getTile(ix, y + 1, iz);
          const maskIndex = localX + localZ * maskW;
          
          const thisTileTop = Tiles.byId[id];
          // Partial-height liquid tiles (calm water/lava) always render their top face,
          // even when the block above is the same liquid — they sit lower than a full block
          // so the top surface must be visible.
          const forceTopFace = thisTileTop && thisTileTop.isPartialHeight;
          if (id !== 0 && (forceTopFace || this.shouldRenderFaceAgainst(id, above))) {
            if (Tiles.key6 && id === Tiles.key6.id) {
              mask[maskIndex] = -1;
              continue;
            }
            const tile = Tiles.byId[id];
            if (!tile) { mask[maskIndex] = -1; continue; }
            const texKey = tile.getTextureKey(0);
            let matIndex = this.materialIndexMap[texKey];
            // If this is the very bottom-most world row, prefer the dedicated rock_plane material when available.
            if (typeof y === 'number' && y === 0 && typeof this.materialIndexMap['rock_plane'] !== 'undefined') {
              matIndex = this.materialIndexMap['rock_plane'];
            }
            if (matIndex === undefined) { mask[maskIndex] = -1; continue; }
            const { finalBrightness: b, isSunlit: sun } = this.getBrightness(ix, y, iz, 0);
            mask[maskIndex] = matIndex;
            brightnessMask[maskIndex] = b;
            sunMask[maskIndex] = sun ? 1 : 0;
            sideBoundaryMask[maskIndex] = isEdgeFace(ix, iz, 0) ? 1 : 0;
            bottomBoundaryMask[maskIndex] = (y === 0) ? 1 : 0;
          } else {
            mask[maskIndex] = -1;
          }
        }
      }

      // Greedy merge rectangles on top faces
      for (let z = 0; z < maskH; z++) {
        for (let x = 0; x < maskW; x++) {
          const n = x + z * maskW;
          const mat = mask[n];
          if (mat === -1) continue;
          
          // Cache the starting block's properties
          const bVal = brightnessMask[n];
          const sunVal = sunMask[n];
          const sideVal = sideBoundaryMask[n];
          const botVal = bottomBoundaryMask[n];
          
          let w = 1;
          while (
            x + w < maskW && 
            mask[n + w] === mat &&
            brightnessMask[n + w] === bVal &&
            sunMask[n + w] === sunVal &&
            sideBoundaryMask[n + w] === sideVal &&
            bottomBoundaryMask[n + w] === botVal
          ) w++;
          
          let h = 1;
          outer: while (z + h < maskH) {
            for (let k = 0; k < w; k++) {
              const idx = n + k + h * maskW;
              if (
                mask[idx] !== mat || 
                brightnessMask[idx] !== bVal ||
                sunMask[idx] !== sunVal ||
                sideBoundaryMask[idx] !== sideVal ||
                bottomBoundaryMask[idx] !== botVal
              ) break outer;
            }
            h++;
          }
          
          for (let dz = 0; dz < h; dz++) {
            for (let dx = 0; dx < w; dx++) {
              mask[n + dx + dz * maskW] = -1;
            }
          }

          const x0 = startX + x;
          const x1 = startX + x + w;
          const z0 = startZ + z;
          const z1 = startZ + z + h;
          // Partial-height liquids (calm water/lava) render their top face slightly
          // below full block height to show a visible water surface.
          const topTile = Tiles.byId[mask[n] < 0 ? 0 : (mat >= 0 ? mat : 0)];
          // Identify if the original block at the starting cell is partial-height
          const startBlockId = this.getTile(startX + x, y, startZ + z);
          const startTile = Tiles.byId[startBlockId];
          const topYOffset = (startTile && startTile.isPartialHeight) ? -0.125 : 0.0;
          const topY = y + 1.0 + topYOffset;

          pushQuad(
            x0, topY, z0, 
            x1, topY, z1, 
            mat, 
            bVal, 
            sunVal > 0, 
            sideVal > 0, 
            botVal > 0, 
            0
          );
        }
      }
    }

    // Bottom and side faces: per-block emission
    for (let x = startX; x < endX; x++) {
      for (let y = 0; y < this.depth; y++) {
        for (let z = startZ; z < endZ; z++) {
          const id = this.getTile(x, y, z);
          if (id === 0) continue;
          if (Tiles.key6 && id === Tiles.key6.id) continue;

          const belowId = this.getTile(x, y - 1, z);
          if (this.shouldRenderFaceAgainst(id, belowId)) {
            const tile = Tiles.byId[id];
            const texKey = tile ? tile.getTextureKey(1) : null;
            if (texKey) {
              const matIndex = this.materialIndexMap[texKey];
              if (matIndex !== undefined) {
                const { finalBrightness: b, isSunlit: sun } = this.getBrightness(x, y, z, 1);
                const sideBoundary = (y === 0 && 1 === 1);
                const bottomBoundary = (y === 0);
                const bottomYOffset = 0.0;
                positions.push(x, y + bottomYOffset, z, x+1, y + bottomYOffset, z, x, y + bottomYOffset, z+1, x+1, y + bottomYOffset, z+1);
                normals.push(0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0);
                uvs.push(0,0, 1,0, 0,1, 1,1);
                for (let i = 0; i < 4; i++) {
                  colors.push(b, b, b);
                  isSunlit.push(sun ? 1 : 0);
                  isSideBoundaryFace.push(sideBoundary ? 1 : 0);
                  isBottomBoundaryFace.push(bottomBoundary ? 1 : 0);
                  faceIds.push(1);
                }
                indices.push(vertexCount, vertexCount+2, vertexCount+1, vertexCount+1, vertexCount+2, vertexCount+3);
                groups.push({ materialIndex: matIndex, start: indices.length - 6, count: 6 });
                vertexCount += 4;
              }
            }
          }

          const sideChecks = [
            { face: 2, nx: x, ny: y, nz: z - 1 },
            { face: 3, nx: x, ny: y, nz: z + 1 },
            { face: 4, nx: x + 1, ny: y, nz: z },
            { face: 5, nx: x - 1, ny: y, nz: z }
          ];

          for (const sf of sideChecks) {
            const nx = sf.nx, ny = sf.ny, nz = sf.nz;
            let emit = false;

            if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.depth || nz < 0 || nz >= this.height) {
              emit = true;
            } else {
              const neighborId = this.getTile(nx, ny, nz);
              emit = this.shouldRenderFaceAgainst(id, neighborId);
            }

            if (!emit) continue;

            const face = sf.face;
            const tile = Tiles.byId[id];
            if (typeof tile !== "object" || tile === null) continue;
            const texKey = tile.getTextureKey(face);
            const matIndex = this.materialIndexMap[texKey];
            if (matIndex === undefined) continue;
            // Partial-height liquid tiles (calm water/lava) have their top surface
            // lowered by 0.125, so their side faces also end at y+0.875 not y+1.0.
            const sideTopY = (tile && tile.isPartialHeight) ? (y + 0.875) : (y + 1.0);
            const sideBottomY = y;
            let verts, norms;
            if (face === 2) {
              verts = [x, sideBottomY, z, x+1, sideBottomY, z, x, sideTopY, z, x+1, sideTopY, z];
              norms = [0,0,-1,0,0,-1,0,0,-1,0,0,-1];
            } else if (face === 3) {
              verts = [x+1, sideBottomY, z+1, x, sideBottomY, z+1, x+1, sideTopY, z+1, x, sideTopY, z+1];
              norms = [0,0,1,0,0,1,0,0,1,0,0,1];
            } else if (face === 4) {
              verts = [x+1, sideBottomY, z, x+1, sideBottomY, z+1, x+1, sideTopY, z, x+1, sideTopY, z+1];
              norms = [1,0,0,1,0,0,1,0,0,1,0,0];
            } else {
              verts = [x, sideBottomY, z+1, x, sideBottomY, z, x, sideTopY, z+1, x, sideTopY, z];
              norms = [-1,0,0,-1,0,0,-1,0,0,-1,0,0];
            }
            const { finalBrightness: b, isSunlit: sun } = this.getBrightness(x, y, z, face);
            const sideBoundary = isEdgeFace(x, z, face);
            const bottomBoundary = (y === 0 && face === 1);
            for (let i = 0; i < 4; i++) {
              colors.push(b, b, b);
              isSunlit.push(sun ? 1 : 0);
              isSideBoundaryFace.push(sideBoundary ? 1 : 0);
              isBottomBoundaryFace.push(bottomBoundary ? 1 : 0);
              faceIds.push(face);
            }
            positions.push(...verts);
            normals.push(...norms);
            const vOffset = 1.0 / 16.0;
            // If this side uses the water material, prefer world-space UVs (using X/Z or Y/Z depending on face)
            const sideIsWater = (typeof this.materialIndexMap !== 'undefined' && typeof this.materialIndexMap['water'] !== 'undefined' && matIndex === this.materialIndexMap['water']);
            if (sideIsWater) {
              if (face === 4 || face === 5) {
                // +X / -X faces: use world-space ZY (z,y) so sampling remains continuous
                uvs.push(z, y, z+1, y, z, y+1, z+1, y+1);
              } else {
                // +/-Z faces: use world-space XY (x,y)
                uvs.push(x, y, x+1, y, x, y+1, x+1, y+1);
              }
            } else {
              uvs.push(0, vOffset, 1, vOffset, 0, 1, 1, 1);
            }
            indices.push(vertexCount, vertexCount+2, vertexCount+1, vertexCount+1, vertexCount+2, vertexCount+3);
            groups.push({ materialIndex: matIndex, start: indices.length - 6, count: 6 });
            vertexCount += 4;
          }
        }
      }
    }

    // Special: key6 X geometry (after normal face processing)
    for (let x = startX; x < endX; x++) {
      for (let y = 0; y < this.depth; y++) {
        for (let z = startZ; z < endZ; z++) {
          const id = this.getTile(x, y, z);
          if (Tiles.key6 && id === Tiles.key6.id) {
            const matIndex = this.materialIndexMap[Tiles.key6.getTextureKey(2)];
            if (matIndex !== undefined) {
              const bInfo = this.getBrightness(x, y, z, 2);
              const b = bInfo.finalBrightness;
              const sun = bInfo.isSunlit;
              const sideBoundary = isEdgeFace(x, z, 2);
              const bottomBoundary = (y === 0);

              const y0 = y + 0.0 + 0.03;
              const y1 = y + 1.0 + 0.03;
              const NOFF = 0.001;

              // Diagonal A
              positions.push(
                x,      y1, z + NOFF,
                x + 1,  y1, z + 1 + NOFF,
                x + 1,  y0, z + 1 + NOFF,
                x,      y0, z + NOFF
              );
              normals.push(0,0,1, 0,0,1, 0,0,1, 0,0,1);
              uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
              for (let i = 0; i < 4; i++) {
                colors.push(b, b, b);
                isSunlit.push(sun ? 1 : 0);
                isSideBoundaryFace.push(sideBoundary ? 1 : 0);
                isBottomBoundaryFace.push(bottomBoundary ? 1 : 0);
                faceIds.push(2);
              }
              indices.push(vertexCount, vertexCount+2, vertexCount+1, vertexCount+1, vertexCount+2, vertexCount+3);
              groups.push({ materialIndex: matIndex, start: indices.length - 6, count: 6 });
              vertexCount += 4;

              // Diagonal B
              positions.push(
                x + 1,  y1, z - NOFF,
                x,      y1, z + 1 - NOFF,
                x,      y0, z + 1 - NOFF,
                x + 1,  y0, z - NOFF
              );
              normals.push(0,0,1, 0,0,1, 0,0,1, 0,0,1);
              uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
              for (let i = 0; i < 4; i++) {
                colors.push(b, b, b);
                isSunlit.push(sun ? 1 : 0);
                isSideBoundaryFace.push(sideBoundary ? 1 : 0);
                isBottomBoundaryFace.push(bottomBoundary ? 1 : 0);
                faceIds.push(2);
              }
              indices.push(vertexCount, vertexCount+2, vertexCount+1, vertexCount+1, vertexCount+2, vertexCount+3);
              groups.push({ materialIndex: matIndex, start: indices.length - 6, count: 6 });
              vertexCount += 4;
            }
          }
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute("isSunlit", new THREE.Float32BufferAttribute(isSunlit, 1));
    geom.setAttribute("isSideBoundaryFace", new THREE.Float32BufferAttribute(isSideBoundaryFace, 1));
    geom.setAttribute("isBottomBoundaryFace", new THREE.Float32BufferAttribute(isBottomBoundaryFace, 1));
    geom.setAttribute("faceId", new THREE.Float32BufferAttribute(faceIds, 1));
    geom.setIndex(indices);

    let currentMat = -1, start = 0, count = 0;
    for (const g of groups) {
      if (g.materialIndex !== currentMat) {
        if (count > 0) geom.addGroup(start, count, currentMat);
        currentMat = g.materialIndex;
        start = g.start;
        count = g.count;
      } else {
        count += g.count;
      }
    }
    if (count > 0) geom.addGroup(start, count, currentMat);

    return new THREE.Mesh(geom, this.blockMaterials);
  }
  
  loadChunk(cx, cz, scene) {
    const key = `${cx}_${cz}`;
    if (this.loadedChunkMeshes.has(key)) return;

    const mesh = this.buildChunkMesh(cx, cz);

    // Frustum culling: water-containing chunks are NEVER frustum-culled. The previous approach
    // decided frustumCulled once, at load time, based on whether the camera happened to be above
    // or below the water surface at that moment — but that decision was never re-evaluated as the
    // player moved, so it went stale and produced "fine from a distance, breaks up close." Simplest
    // correct fix: just don't frustum-cull water chunks at all; the perf cost is negligible
    // relative to eliminating an entire category of stale-state bugs.
    try {
      const WATER_ID = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
      let containsWater = false;

      if (WATER_ID !== null) {
        const startX = cx * this.chunkSizeX;
        const endX = Math.min((cx + 1) * this.chunkSizeX, this.width);
        const startZ = cz * this.chunkSizeZ;
        const endZ = Math.min((cz + 1) * this.chunkSizeZ, this.height);

        outer: for (let x = startX; x < endX; x++) {
          for (let z = startZ; z < endZ; z++) {
            for (let y = 0; y < this.depth; y++) {
              if (this.getTile(x, y, z) === WATER_ID) {
                containsWater = true;
                break outer;
              }
            }
          }
        }
      }

      // Water-containing chunks must NEVER be frustum-culled: the chunk's bounding sphere
      // exits the camera frustum when looking at water from an angle, even when water quads
      // remain fully visible. This causes the "water falls apart" effect. The perf cost of
      // always rendering water chunks is negligible (there are few of them).
      // Non-water chunks keep normal frustum culling for performance.
      mesh.userData = mesh.userData || {};
      mesh.userData.containsWater = containsWater;
      mesh.frustumCulled = !containsWater;
    } catch (e) {
      // on error, leave default frustum behavior enabled
      mesh.frustumCulled = true;
      console.warn('loadChunk: frustum-culling water-scan failed', e);
    }

    scene.add(mesh);
    this.loadedChunkMeshes.set(key, mesh);
  }
  
  unloadChunk(cx, cz, scene) {
    const key = `${cx}_${cz}`;
    const mesh = this.loadedChunkMeshes.get(key);
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    this.loadedChunkMeshes.delete(key);
  }
  
  getTile(x, y, z) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.depth || z < 0 || z >= this.height) return 0;
    return this.blocks[x + y * this.width + z * this.width * this.depth];
  }
  
  setTile(x, y, z, v) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.depth || z < 0 || z >= this.height) return;
    this.blocks[x + y * this.width + z * this.width * this.depth] = v;
  }
  
  getGroundHeight(x, z) {
    for (let y = this.depth - 1; y >= 0; y--) if (this.getTile(x, y, z) !== 0) return y;
    return 0;
  }

  /* isLiquidId — true if the given tile id is water/lava (still or flowing). Mirrors the
     decompiled LiquidTile: liquids have no collision AABB (getAABB() returns null) and are
     never solid (isSolid() returns false). Used by getCubes() below to exclude liquid tiles
     from the collidable cube list, so the player floats/swims through water instead of
     standing on it like a solid block. */
  isLiquidId(id) {
    if (id === 0) return false;
    const tile = (typeof Tiles !== "undefined" && Tiles.byId) ? Tiles.byId[id] : null;
    if (tile && typeof tile.isLiquid === "boolean") return tile.isLiquid;
    // Fallback: match against known liquid tile ids directly in case isLiquid isn't set on the tile def.
    if (typeof Tiles === "undefined") return false;
    return (
      (Tiles.water && id === Tiles.water.id) ||
      (Tiles.calmWater && id === Tiles.calmWater.id) ||
      (Tiles.lava && id === Tiles.lava.id) ||
      (Tiles.calmLava && id === Tiles.calmLava.id)
    );
  }
  
  getCubes(aabb) {
    const cubes = [];
    const i0 = Math.max(0, Math.floor(aabb.minX) - 1);
    const i1 = Math.min(this.width, Math.ceil(aabb.maxX) + 1);
    const j0 = Math.max(0, Math.floor(aabb.minY) - 1);
    const j1 = Math.min(this.depth, Math.ceil(aabb.maxY) + 1);
    const k0 = Math.max(0, Math.floor(aabb.minZ) - 1);
    const k1 = Math.min(this.height, Math.ceil(aabb.maxZ) + 1);
    for (let x = i0; x < i1; ++x)
      for (let y = j0; y < j1; ++y)
        for (let z = k0; z < k1; ++z) {
          const id = this.getTile(x, y, z);
          if (id === 0) continue;
          // Liquids are never solid/collidable (matches LiquidTile.getAABB() == null /
          // isSolid() == false in the original Java) — skip them so the player passes through
          // and falls/floats via the swimming physics in Player.tick() instead of standing on
          // top of water like solid ground.
          if (this.isLiquidId(id)) continue;
          cubes.push(new AABB(x, y, z, x+1, y+1, z+1));
        }

    if (this.entities && this.entities.length) {
      for (let i = 0; i < this.entities.length; i++) {
        const ent = this.entities[i];
        if (!ent || !ent.bb) continue;
        if (ent.removed) continue;
        if (ent.bb.intersects(aabb)) {
          cubes.push(new AABB(ent.bb.minX, ent.bb.minY, ent.bb.minZ, ent.bb.maxX, ent.bb.maxY, ent.bb.maxZ));
        }
      }
    }

    // Include any non-block world border boxes (added by the renderer/engine) so entities collide with map edges.
    try {
      // Legacy support: world.borderBoxes (if someone still sets it)
      if (this.borderBoxes && this.borderBoxes.length) {
        for (let i = 0; i < this.borderBoxes.length; i++) {
          const b = this.borderBoxes[i];
          if (!b) continue;
          if (b.intersects(aabb)) cubes.push(new AABB(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ));
        }
      }
      // Client-owned border boxes set by the engine (kept out of save files) e.g. window.rubyDung._clientBorderBoxes
      try {
        if (typeof window !== "undefined" && window.rubyDung && window.rubyDung._clientBorderBoxes && window.rubyDung._clientBorderBoxes.length) {
          for (let i = 0; i < window.rubyDung._clientBorderBoxes.length; i++) {
            const b = window.rubyDung._clientBorderBoxes[i];
            if (!b) continue;
            if (b.intersects(aabb)) cubes.push(new AABB(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ));
          }
        }
      } catch (innerE) {
        // non-fatal; just continue if client boxes can't be read
      }
    } catch (e) {
      // Non-fatal: if border boxes are malformed, ignore them.
      console.warn('World.getCubes borderBoxes check failed', e);
    }

    return cubes;
  }

  processExposure(dt = 0) {
    const changed = [];
    if (typeof dt !== "number" || dt <= 0) return changed;

    // NOTE: avoid recalculating lightDepths every tick here (expensive and breaks buried-grass logic).
    // Light depths should be updated when blocks change (e.g. updateChunksAroundBlock already calls calcLightDepths).

    const DIRT_ID = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
    const GRASS_ID = (typeof Tiles !== "undefined" && Tiles.grass_top) ? Tiles.grass_top.id : 1;
    const w = this.width, h = this.height, d = this.depth;

    // --- Dirt -> Grass (top-exposed growth) ---
    // Increase growth threshold to ~9 seconds (tripled from previous ~3s).
    const GROWTH_THRESHOLD = 9.0;

    for (let x = 0; x < w; x++) {
      for (let z = 0; z < h; z++) {
        const topY = this.lightDepths[x + z * w];
        if (topY < 0 || topY >= d) continue;

        const id = this.getTile(x, topY, z);
        const idxTop = x + topY * w + z * (w * d);

        if (id === DIRT_ID) {
          // If this dirt was produced by worldgen, don't auto-promote it to grass.
          if (this.generatedDirt && this.generatedDirt[idxTop]) {
            // ensure timer stays reset for generated dirt and skip growth
            if (this.exposedTimers[idxTop] && this.exposedTimers[idxTop] !== 0) this.exposedTimers[idxTop] = 0;
            continue;
          }

          // Only grow when the top face is sunlit.
          const bInfo = this.getBrightness(x, topY, z, 0);
          if (bInfo && bInfo.isSunlit) {
            this.exposedTimers[idxTop] = (this.exposedTimers[idxTop] || 0) + dt;
            if (this.exposedTimers[idxTop] >= GROWTH_THRESHOLD) {
              this.setTile(x, topY, z, GRASS_ID);
              this.exposedTimers[idxTop] = 0;
              changed.push({ x, y: topY, z });
            }
          } else {
            // not sunlit: don't accumulate growth timer
          }
          continue;
        }

        // If not dirt, ensure top timer reset
        if (this.exposedTimers[idxTop] && this.exposedTimers[idxTop] !== 0) this.exposedTimers[idxTop] = 0;
      }
    }

    // --- Grass -> Dirt (buried grass) ---
    // Tripled conversion threshold from ~3s to ~9s and process buried-grass candidates in a randomized order
    // so conversions do NOT strictly follow the order in which blocks lost sunlight.
    const CONVERT_THRESHOLD = 9.0;
    const SCAN_DEPTH = 12; // how many blocks below topY we scan for buried grass

    // Collect buried-grass candidates first
    const buriedCandidates = [];

    for (let x = 0; x < w; x++) {
      for (let z = 0; z < h; z++) {
        const topY = this.lightDepths[x + z * w];
        if (topY < 0 || topY >= d) continue;

        for (let gy = topY - 1; gy >= Math.max(0, topY - SCAN_DEPTH); gy--) {
          const gid = this.getTile(x, gy, z);
          if (gid === 0) {
            // air: keep scanning downward
            continue;
          }
          if (gid !== GRASS_ID) {
            // any solid that's not grass blocks further buried-grass checks in this column
            break;
          }

          // Found a grass block that is now buried (something above it exists).
          // Defer processing; push candidate into list to be handled in randomized order.
          buriedCandidates.push({ x, y: gy, z });
          // Only consider the first buried grass encountered per column
          break;
        }
      }
    }

    // Shuffle candidates with Fisher-Yates so the processing order is randomized each tick
    for (let i = buriedCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = buriedCandidates[i];
      buriedCandidates[i] = buriedCandidates[j];
      buriedCandidates[j] = tmp;
    }

    // Now process shuffled candidates, increment timers and convert when threshold reached.
    for (const cand of buriedCandidates) {
      const { x, y: gy, z } = cand;
      const gIdx = x + gy * w + z * (w * d);
      this.exposedTimers[gIdx] = (this.exposedTimers[gIdx] || 0) + dt;
      if (this.exposedTimers[gIdx] >= CONVERT_THRESHOLD) {
        this.setTile(x, gy, z, DIRT_ID);
        this.exposedTimers[gIdx] = 0;
        changed.push({ x, y: gy, z });
      }
    }

    return changed;
  }

  checkExposureAt(x, y, z) {
    // Bounds check
    if (x < 0 || x >= this.width || y < 0 || y >= this.depth || z < 0 || z >= this.height) return false;

    const DIRT_ID = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
    const GRASS_ID = (typeof Tiles !== "undefined" && Tiles.grass_top) ? Tiles.grass_top.id : 1;

    const id = this.getTile(x, y, z);
    const idx = x + y * this.width + z * (this.width * this.depth);

    // If tile is dirt and is exposed to air above, start/reset its exposed timer so the
    // existing processExposure tick-based system can convert it to grass after the threshold.
    if (id === DIRT_ID) {
      for (let ay = y + 1; ay < this.depth; ay++) {
        if (this.getTile(x, ay, z) !== 0) {
          // blocked above, nothing to do
          return false;
        }
      }
      // Exposed — reset timer and allow processExposure to handle conversion
      if (this.exposedTimers && this.exposedTimers.length > idx) this.exposedTimers[idx] = 0;
      return false;
    }

    // If tile is grass and has become covered (solid block above), start/reset its exposed timer
    // so the same tick-based processExposure will revert it to dirt after the threshold.
    if (id === GRASS_ID) {
      const aboveY = y + 1;
      const aboveId = (aboveY >= this.depth) ? 0 : this.getTile(x, aboveY, z);
      if (aboveId !== 0) {
        if (this.exposedTimers && this.exposedTimers.length > idx) this.exposedTimers[idx] = 0;
        return false;
      }
    }

    return false;
  }
}