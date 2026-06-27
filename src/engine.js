/* engine.js — RubyDung core engine.
   Terrain generation now uses a ported Minecraft classic LevelGen (Synth / ImprovedNoise /
   PerlinNoise / Distort) instead of the old diamond-square NoiseMap, converted to this file's
   conventions:
     - flat Uint8Array indexed as  x + y*w + z*(w*d)
     - Tiles.* ids (grass_top, dirt, stone, bedrock, water, calmLava/lava) instead of Tile.grass/
       dirt/rock/calmWater/calmLava
   LevelGen's own border + random-lake flood-fill liquid placement is layered together with this
   file's pre-existing extra behavior (forced sea-level fill, perimeter water ring, lake-neighbor
   fill, lava pools, small-hollow filler). Lava is given its own ShaderMaterial backed by
   /lava.png and registered in materialIndexMap so flood-filled lava tiles render correctly
   instead of falling back to the atlas/rock texture.
*/
import * as THREE from "three";
import { Zombie } from "/Zombie.js";
import { ParticleEngine } from "/ParticleEngine.js";
import { Particle } from "/Particle.js";
import { Tiles } from '/Tile.js';
import { Player, World, makeExposureHandler } from "/Player.js";
import { AABB } from "/AABB.js";
import WaterManager from "/water.js";

/* ===========
   Frame-rate Independent Speed Constants
   =========== */
const FIXED_DT = 1.0 / 60.0;

/* ============================================================
   JavaRandom — port of java.util.Random (48-bit LCG) so terrain
   generation is seed-reproducible the same way the original
   Minecraft classic LevelGen was.
   ============================================================ */
class JavaRandom {
  constructor(seed) {
    this.setSeed(seed ?? Date.now());
  }

  setSeed(seed) {
    this.seed = (BigInt(Math.trunc(seed)) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
  }

  next(bits) {
    this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound) {
    if (bound <= 0) throw new Error("bound must be positive");
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    let bits, val;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (bits - val + (bound - 1) < 0);
    return val;
  }

  nextFloat() {
    return this.next(24) / (1 << 24);
  }

  nextDouble() {
    return (this.next(26) * Math.pow(2, 27) + this.next(27)) * Math.pow(2, -53);
  }
}

/* ============================================================
   Synth / ImprovedNoise / PerlinNoise / Distort
   Ported from com.mojang.minecraft.level.levelgen.synth.*
   ============================================================ */
class Synth {
  getValue(x, z) {
    throw new Error("getValue() must be implemented by subclass");
  }
}

class ImprovedNoise extends Synth {
  constructor(random) {
    super();
    this.p = new Array(512).fill(0);

    for (let n = 0; n < 256; ++n) {
      this.p[n] = n;
    }
    for (let n = 0; n < 256; ++n) {
      const n2 = random.nextInt(256 - n) + n;
      const tmp = this.p[n];
      this.p[n] = this.p[n2];
      this.p[n2] = tmp;
      this.p[n + 256] = this.p[n];
    }
  }

  static fade(d) {
    return d * d * d * (d * (d * 6.0 - 15.0) + 10.0);
  }

  static lerp(d, d2, d3) {
    return d2 + d * (d3 - d2);
  }

  static grad(n, d, d2, d3) {
    n = n & 0xF;
    const d4 = n < 8 ? d : d2;
    const d6 = n < 4 ? d2 : (n === 12 || n === 14 ? d : d3);
    return ((n & 1) === 0 ? d4 : -d4) + ((n & 2) === 0 ? d6 : -d6);
  }

  getValue(x, z) {
    let d5 = x;
    let d4 = z;

    let n = Math.floor(d5) & 0xFF;
    let n2 = Math.floor(d4) & 0xFF;
    const n3idx = Math.floor(0.0) & 0xFF;

    d5 -= Math.floor(d5);
    d4 -= Math.floor(d4);
    const dz = 0.0 - Math.floor(0.0);

    const d6 = ImprovedNoise.fade(d5);
    const d7 = ImprovedNoise.fade(d4);
    const d8 = ImprovedNoise.fade(dz);

    let n4 = this.p[n] + n2;
    let n5 = this.p[n4] + n3idx;
    n4 = this.p[n4 + 1] + n3idx;
    n = this.p[n + 1] + n2;
    n2 = this.p[n] + n3idx;
    n = this.p[n + 1] + n3idx;

    return ImprovedNoise.lerp(
      d8,
      ImprovedNoise.lerp(
        d7,
        ImprovedNoise.lerp(
          d6,
          ImprovedNoise.grad(this.p[n5], d5, d4, dz),
          ImprovedNoise.grad(this.p[n2], d5 - 1.0, d4, dz)
        ),
        ImprovedNoise.lerp(
          d6,
          ImprovedNoise.grad(this.p[n4], d5, d4 - 1.0, dz),
          ImprovedNoise.grad(this.p[n], d5 - 1.0, d4 - 1.0, dz)
        )
      ),
      ImprovedNoise.lerp(
        d7,
        ImprovedNoise.lerp(
          d6,
          ImprovedNoise.grad(this.p[n5 + 1], d5, d4, dz - 1.0),
          ImprovedNoise.grad(this.p[n2 + 1], d5 - 1.0, d4, dz - 1.0)
        ),
        ImprovedNoise.lerp(
          d6,
          ImprovedNoise.grad(this.p[n4 + 1], d5, d4 - 1.0, dz - 1.0),
          ImprovedNoise.grad(this.p[n + 1], d5 - 1.0, d4 - 1.0, dz - 1.0)
        )
      )
    );
  }
}

class PerlinNoise extends Synth {
  constructor(random, levels) {
    super();
    this.levels = 8;
    this.noiseLevels = new Array(8);
    for (let n = 0; n < 8; ++n) {
      this.noiseLevels[n] = new ImprovedNoise(random);
    }
  }

  getValue(x, z) {
    let total = 0.0;
    let scale = 1.0;
    for (let i = 0; i < this.levels; ++i) {
      total += this.noiseLevels[i].getValue(x / scale, z / scale) * scale;
      scale *= 2.0;
    }
    return total;
  }
}

class Distort extends Synth {
  constructor(source, distort) {
    super();
    this.source = source;
    this.distort = distort;
  }

  getValue(x, z) {
    return this.source.getValue(x + this.distort.getValue(x, z), z);
  }
}

/* ============================================================
   LevelGen — ported from com.mojang.minecraft.level.levelgen.LevelGen,
   converted to this engine's flat-array indexing (x + y*w + z*(w*d))
   and Tiles.* ids. Produces { blocks, lightDepths, width, height, depth }.

   Behavior layered on top of the original Java algorithm (kept additive,
   not replacing the ported logic):
     - forced sea-level water fill
     - perimeter water ring
     - lake neighbor-fill pass
     - lava pools
     - small-hollow filler
   addLava() lava is placed with Tiles.calmLava.id (falling back to Tiles.lava.id),
   which is registered against a dedicated lava ShaderMaterial backed by /lava.png
   (see createLavaMaterial / engine init below) so it renders correctly instead of
   the rock/atlas fallback.
   ============================================================ */
class LevelGen {
  constructor(progressCallback, seed) {
    this.onProgress = typeof progressCallback === "function" ? progressCallback : () => {};
    this.random = new JavaRandom(seed);
    this.width = 0;
    this.height = 0;
    this.depth = 0;
    this.blocks = null;
    this.coords = new Int32Array(0x100000);
  }

  setNextPhase(n) {
    try { this.onProgress(n); } catch (e) { /* non-fatal */ }
  }

  idx(x, y, z) {
    return x + y * this.width + z * (this.width * this.height === 0 ? 1 : 1); // placeholder, unused
  }

  // Engine indexing: x + y*w + z*(w*d)
  blockIndex(x, y, z) {
    return x + y * this.width + z * (this.width * this.depth);
  }

  generateLevel(width, height, depth, superflat) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.blocks = new Uint8Array(width * height * depth);

    const ID_AIR     = 0;
    const ID_GRASS   = (Tiles.grass_top && Tiles.grass_top.id) || 1;
    const ID_DIRT    = (Tiles.dirt && Tiles.dirt.id) || 3;
    const ID_ROCK    = (Tiles.stone && Tiles.stone.id) || 2;
    const ID_BEDROCK = (Tiles.bedrock && Tiles.bedrock.id) || ID_ROCK;
    const ID_WATER   = (Tiles.calmWater && Tiles.calmWater.id) || (Tiles.water && Tiles.water.id) || 0;
    const ID_LAVA    = (Tiles.calmLava && Tiles.calmLava.id) || (Tiles.lava && Tiles.lava.id) || null;

    this.IDS = { ID_AIR, ID_GRASS, ID_DIRT, ID_ROCK, ID_BEDROCK, ID_WATER, ID_LAVA };

    if (superflat) {
      this.generateSuperflat();
      this.computeLightDepths();
      return { blocks: this.blocks, lightDepths: this.lightDepths, width, height, depth };
    }

    // ---- Raising: height map from two distorted Perlin sources + a detail source ----
    this.setNextPhase(0);
    const heightSource  = new Distort(new PerlinNoise(this.random, 8), new PerlinNoise(this.random, 8));
    const heightDistort = new Distort(new PerlinNoise(this.random, 8), new PerlinNoise(this.random, 8));
    const detail = new PerlinNoise(this.random, 8);

    // heightMap is a 2D (x,z) array — kept as its own width*height buffer (no y component)
    const heightMap = new Int32Array(width * height);

    for (let x = 0; x < width; ++x) {
      this.setNextPhase(Math.floor((x * 33) / (width - 1)));
      for (let z = 0; z < height; ++z) {
        let d = heightSource.getValue(x, z) / 8.0 - 8.0;
        let d2 = heightDistort.getValue(x, z) / 8.0 + 8.0;
        const d3 = detail.getValue(x, z) / 8.0;
        if (d3 > 2.0) {
          d2 = d;
        }
        let d4 = Math.max(d, d2);
        d4 = (d4 * d4 * d4 / 100.0 + d4 * 3.0) / 8.0;
        heightMap[x + z * width] = Math.trunc(d4);
      }
    }

    // ---- Eroding ----
    const erodeA = new Distort(new PerlinNoise(this.random, 8), new PerlinNoise(this.random, 8));
    const erodeB = new Distort(new PerlinNoise(this.random, 8), new PerlinNoise(this.random, 8));

    for (let x = 0; x < width; ++x) {
      this.setNextPhase(33 + Math.floor((x * 16) / (width - 1)));
      for (let z = 0; z < height; ++z) {
        const d = erodeA.getValue(x << 1, z << 1) / 8.0;
        const n5 = erodeB.getValue(x << 1, z << 1) > 0.0 ? 1 : 0;
        if (d > 2.0) {
          const i2 = x + z * width;
          const val = heightMap[i2];
          heightMap[i2] = (Math.trunc((val - n5) / 2) << 1) + n5;
        }
      }
    }

    // ---- Soiling: turn the height map into grass/dirt/rock columns ----
    for (let x = 0; x < width; ++x) {
      this.setNextPhase(49 + Math.floor((x * 16) / (width - 1)));
      for (let y = 0; y < depth; ++y) {
        for (let z = 0; z < height; ++z) {
          const surfaceLevel = heightMap[x + z * width] + Math.trunc(depth / 2);
          const rockLevel = surfaceLevel - 2;

          let blockId = ID_AIR;
          if (y === surfaceLevel && y >= Math.trunc(depth / 2) - 1) {
            blockId = ID_GRASS;
          } else if (y <= surfaceLevel) {
            blockId = ID_DIRT;
          }
          if (y <= rockLevel) {
            blockId = ID_ROCK;
          }
          if (y === 0) {
            blockId = ID_BEDROCK;
          }

          this.blocks[this.blockIndex(x, y, z)] = blockId;
        }
      }
    }

    // ---- Carving: worm-style caves ----
    this.setNextPhase(65);
    const caveCount = Math.floor((width * height * depth) / 256 / 64);
    for (let c = 0; c < caveCount; ++c) {
      this.setNextPhase(65 + Math.floor((c * 15) / Math.max(1, caveCount - 1)));

      let fx = this.random.nextFloat() * width;
      let fy = this.random.nextFloat() * depth;
      let fz = this.random.nextFloat() * height;

      const steps = Math.trunc(this.random.nextFloat() + this.random.nextFloat() * 150.0);

      let yaw = this.random.nextFloat() * Math.PI * 2.0;
      let yawVel = 0.0;
      let pitch = this.random.nextFloat() * Math.PI * 2.0;
      let pitchVel = 0.0;

      for (let i = 0; i < steps; ++i) {
        fx += Math.sin(yaw) * Math.cos(pitch);
        fz += Math.cos(yaw) * Math.cos(pitch);
        fy += Math.sin(pitch);

        yaw += yawVel * 0.2;
        yawVel *= 0.9;
        yawVel += this.random.nextFloat() - this.random.nextFloat();

        pitch += pitchVel * 0.5;
        pitch *= 0.5;
        pitchVel *= 0.9;
        pitchVel += this.random.nextFloat() - this.random.nextFloat();

        const radius = Math.sin((i * Math.PI) / steps) * 2.5 + 1.0;

        for (let j = Math.trunc(fx - radius); j <= Math.trunc(fx + radius); ++j) {
          for (let k = Math.trunc(fy - radius); k <= Math.trunc(fy + radius); ++k) {
            for (let l = Math.trunc(fz - radius); l <= Math.trunc(fz + radius); ++l) {
              const dx = j - fx;
              const dy = k - fy;
              const dz2 = l - fz;
              const distSq = dx * dx + dy * dy * 2.0 + dz2 * dz2;

              if (
                distSq < radius * radius &&
                j >= 1 && k >= 1 && l >= 1 &&
                j < width - 1 && k < depth - 1 && l < height - 1
              ) {
                const bi = this.blockIndex(j, k, l);
                if (this.blocks[bi] === ID_ROCK) {
                  this.blocks[bi] = ID_AIR;
                }
              }
            }
          }
        }
      }
    }

    // ---- Watering: LevelGen's own border + random-lake flood fill ----
    this.setNextPhase(80);
    if (ID_WATER) {
      let totalFilled = 0n;
      for (let x = 0; x < width; ++x) {
        totalFilled += this.floodFillLiquid(x, Math.trunc(depth / 2) - 1, 0, ID_WATER);
        totalFilled += this.floodFillLiquid(x, Math.trunc(depth / 2) - 1, height - 1, ID_WATER);
      }
      for (let z = 0; z < height; ++z) {
        totalFilled += this.floodFillLiquid(0, Math.trunc(depth / 2) - 1, z, ID_WATER);
        totalFilled += this.floodFillLiquid(width - 1, Math.trunc(depth / 2) - 1, z, ID_WATER);
      }

      const lakeAttempts = Math.floor((width * height) / 200);
      for (let i = 0; i < lakeAttempts; ++i) {
        const lx = this.random.nextInt(width);
        const ly = Math.trunc(depth / 2) - 1 - this.random.nextInt(3);
        const lz = this.random.nextInt(height);
        if (this.blocks[this.blockIndex(lx, ly, lz)] === ID_AIR) {
          totalFilled += this.floodFillLiquid(lx, ly, lz, ID_WATER);
        }
      }
      console.log(`LevelGen: flood filled ${totalFilled} water tiles`);
    }

    this.setNextPhase(90);
    this.addLava();

    this.setNextPhase(95);
    this.applyExtraWorldFeatures();

    this.setNextPhase(98);
    this.computeLightDepths();

    this.setNextPhase(100);
    return { blocks: this.blocks, lightDepths: this.lightDepths, width, height, depth };
  }

  generateSuperflat() {
    const { ID_AIR, ID_GRASS, ID_DIRT, ID_ROCK, ID_BEDROCK } = this.IDS;
    const topY = Math.max(1, Math.floor(this.depth / 3));
    const dirtDepth = 3;
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.height; z++) {
        for (let y = 0; y < this.depth; y++) {
          const idx = this.blockIndex(x, y, z);
          if (y === 0) this.blocks[idx] = ID_BEDROCK;
          else if (y < topY - dirtDepth) this.blocks[idx] = ID_ROCK;
          else if (y >= topY - dirtDepth && y < topY) this.blocks[idx] = ID_DIRT;
          else if (y === topY) this.blocks[idx] = ID_GRASS;
          else this.blocks[idx] = ID_AIR;
        }
      }
    }
  }

  /* addLava — port of LevelGen.addLava(), using Tiles.calmLava.id (or Tiles.lava.id fallback)
     so flood-filled lava renders via the dedicated lava material/lava.png rather than falling
     back to rock/atlas. */
  addLava() {
    const { ID_AIR, ID_LAVA } = this.IDS;
    if (!ID_LAVA) {
      console.warn("LevelGen.addLava: no Tiles.calmLava/Tiles.lava id available, skipping lava placement");
      return;
    }
    let lavaCount = 0;
    const attempts = Math.floor((this.width * this.height * this.depth) / 10000);
    for (let i = 0; i < attempts; ++i) {
      const x = this.random.nextInt(this.width);
      const y = this.random.nextInt(Math.max(1, Math.trunc(this.depth / 2) - 4));
      const z = this.random.nextInt(this.height);
      if (this.blocks[this.blockIndex(x, y, z)] === ID_AIR) {
        ++lavaCount;
        this.floodFillLiquid(x, y, z, ID_LAVA);
      }
    }
    console.log("LevelGen: LavaCount =", lavaCount);
  }

  /* floodFillLiquid — port of LevelGen.floodFillLiquid(), reindexed for x + y*w + z*(w*d) storage.
     Stack entries encode (y, z, x) the same way the original encoded them via bit-shifts, just
     using engine.js's linear index directly. */
  floodFillLiquid(startX, startY, startZ, tileId) {
    const { ID_AIR, ID_ROCK } = this.IDS;
    const fillByte = tileId & 0xFF;

    const w = this.width, h = this.height, d = this.depth;
    const layerSize = w * h; // one Y-layer's worth of x*z cells, but our layering is x + y*w + z*(w*d)
    // For our indexing (x + y*w + z*(w*d)):
    //   moving +x  -> index += 1
    //   moving +y  -> index += w
    //   moving +z  -> index += w*d
    const stepX = 1;
    const stepY = w;
    const stepZ = w * d;

    let overflowStacks = [];
    let stackSize = 0;
    if (this.coords.length < 0x100000) this.coords = new Int32Array(0x100000);

    let totalFilled = 0n;

    this.coords[stackSize++] = this.blockIndex(startX, startY, startZ);

    while (stackSize > 0) {
      let pos = this.coords[--stackSize];

      if (stackSize === 0 && overflowStacks.length > 0) {
        this.coords = overflowStacks.pop();
        stackSize = this.coords.length;
      }

      // Decompose pos back into (x, y, z) using our indexing scheme.
      const z = Math.floor(pos / stepZ);
      const remAfterZ = pos - z * stepZ;
      const y = Math.floor(remAfterZ / stepY);
      let x = remAfterZ - y * stepY;

      // scan left/right along x at this (y, z)
      let left = x;
      let right = x;
      let scanPos = pos;

      while (left > 0 && this.blocks[scanPos - stepX] === ID_AIR) {
        --left;
        scanPos -= stepX;
      }
      let rightScanPos = scanPos + (x - left) * stepX;
      while (right < w - 1 && this.blocks[rightScanPos + stepX] === ID_AIR) {
        ++right;
        rightScanPos += stepX;
      }

      let spreadUp = 0;
      let spreadDown = 0;
      let spreadLayer = 0;

      totalFilled += BigInt(right - left + 1);

      let curPos = pos - (x - left) * stepX;
      for (let cx = left; cx <= right; ++cx, curPos += stepX) {
        this.blocks[curPos] = fillByte;

        // -Z neighbor
        if (z > 0) {
          const canSpread = this.blocks[curPos - stepZ] === ID_AIR ? 1 : 0;
          if (canSpread && !spreadUp) {
            if (stackSize === this.coords.length) {
              overflowStacks.push(this.coords);
              this.coords = new Int32Array(0x100000);
              stackSize = 0;
            }
            this.coords[stackSize++] = curPos - stepZ;
          }
          spreadUp = canSpread;
        }

        // +Z neighbor
        if (z < h - 1) {
          const canSpread = this.blocks[curPos + stepZ] === ID_AIR ? 1 : 0;
          if (canSpread && !spreadDown) {
            if (stackSize === this.coords.length) {
              overflowStacks.push(this.coords);
              this.coords = new Int32Array(0x100000);
              stackSize = 0;
            }
            this.coords[stackSize++] = curPos + stepZ;
          }
          spreadDown = canSpread;
        }

        // -Y neighbor (down), with lava/water interaction producing rock
        if (y > 0) {
          const belowPos = curPos - stepY;
          const below = this.blocks[belowPos];
          const isLavaFill = (this.IDS.ID_LAVA !== null && fillByte === this.IDS.ID_LAVA);
          const belowIsWater = (this.IDS.ID_WATER !== null && below === this.IDS.ID_WATER);

          if (isLavaFill && belowIsWater) {
            this.blocks[belowPos] = ID_ROCK;
          }

          const canSpread = below === ID_AIR ? 1 : 0;
          if (canSpread && !spreadLayer) {
            if (stackSize === this.coords.length) {
              overflowStacks.push(this.coords);
              this.coords = new Int32Array(0x100000);
              stackSize = 0;
            }
            this.coords[stackSize++] = belowPos;
          }
          spreadLayer = canSpread;
        }
      }
    }

    return totalFilled;
  }

  /* applyExtraWorldFeatures — engine.js's pre-existing extras, layered on top of the ported
     LevelGen algorithm: forced sea-level fill, perimeter water ring, lake neighbor-fill,
     lava pools, small-hollow filler. Operates on this.blocks using this.blockIndex(). */
  applyExtraWorldFeatures() {
    const { ID_AIR, ID_DIRT, ID_ROCK, ID_WATER, ID_LAVA } = this.IDS;
    const w = this.width, h = this.height, d = this.depth;

    // --- forced sea-level water fill ---
    const forcedSeaLevel = Math.min(Math.trunc(d / 3), 30);
    if (ID_WATER) {
      for (let x = 0; x < w; x++) {
        for (let z = 0; z < h; z++) {
          for (let y = 0; y <= forcedSeaLevel && y < d; y++) {
            const idx = this.blockIndex(x, y, z);
            if (this.blocks[idx] === ID_AIR) this.blocks[idx] = ID_WATER;
          }
        }
      }

      // --- perimeter water ring at sea level ---
      const ringY = Math.max(0, Math.min(d - 1, forcedSeaLevel));
      for (let x = 0; x < w; x++) {
        const idxFront = this.blockIndex(x, ringY, 0);
        const idxBack  = this.blockIndex(x, ringY, h - 1);
        if (this.blocks[idxFront] === ID_AIR) this.blocks[idxFront] = ID_WATER;
        if (this.blocks[idxBack] === ID_AIR)  this.blocks[idxBack]  = ID_WATER;
      }
      for (let z = 1; z < h - 1; z++) {
        const idxLeft  = this.blockIndex(0, ringY, z);
        const idxRight = this.blockIndex(w - 1, ringY, z);
        if (this.blocks[idxLeft] === ID_AIR)  this.blocks[idxLeft]  = ID_WATER;
        if (this.blocks[idxRight] === ID_AIR) this.blocks[idxRight] = ID_WATER;
      }

      // --- lake neighbor-fill pass ---
      for (let x = 1; x < w - 1; x++) {
        for (let z = 1; z < h - 1; z++) {
          let topY = -1;
          for (let y = d - 1; y >= 0; y--) {
            if (this.blocks[this.blockIndex(x, y, z)] !== ID_AIR) { topY = y; break; }
          }
          if (topY < 0) continue;

          let neighborWaterMax = -1;
          const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const [nx_off, nz_off] of neighbors) {
            const nx = x + nx_off, nz = z + nz_off;
            for (let y = 0; y < d; y++) {
              if (this.blocks[this.blockIndex(nx, y, nz)] === ID_WATER) {
                neighborWaterMax = Math.max(neighborWaterMax, y);
                break;
              }
            }
          }
          if (neighborWaterMax > topY) {
            const fillTo = Math.min(neighborWaterMax, topY + 2, forcedSeaLevel);
            for (let y = 0; y <= fillTo; y++) {
              const idx = this.blockIndex(x, y, z);
              if (this.blocks[idx] === ID_AIR || this.blocks[idx] === ID_DIRT) this.blocks[idx] = ID_WATER;
            }
          }
        }
      }
    }

    // --- lava pools ---
    if (ID_LAVA) {
      for (let i = 0; i < Math.floor((w * h) / 2000); i++) {
        const lx = this.random.nextInt(w);
        const lz = this.random.nextInt(h);
        let surfaceY = -1;
        for (let y = d - 1; y >= 0; y--) {
          if (this.blocks[this.blockIndex(lx, y, lz)] !== ID_AIR) { surfaceY = y; break; }
        }
        if (surfaceY > 0 && surfaceY <= forcedSeaLevel - 4) {
          const radius = 1 + this.random.nextInt(2);
          for (let ox = -radius; ox <= radius; ox++) {
            for (let oz = -radius; oz <= radius; oz++) {
              const tx = lx + ox, tz = lz + oz;
              if (tx <= 0 || tz <= 0 || tx >= w - 1 || tz >= h - 1) continue;
              if (Math.abs(ox) + Math.abs(oz) > radius) continue;
              for (let y = 0; y <= surfaceY; y++) {
                const idx = this.blockIndex(tx, y, tz);
                if (this.blocks[idx] === ID_ROCK) this.blocks[idx] = ID_LAVA;
              }
            }
          }
        }
      }
    }

    // --- small-hollow filler: fill narrow vertical air shafts (height <= 3) bounded by solid blocks ---
    const MAX_FILL_HEIGHT = 3;
    for (let x = 1; x < w - 1; x++) {
      for (let z = 1; z < h - 1; z++) {
        let y = 1;
        while (y < d - 1) {
          if (this.blocks[this.blockIndex(x, y, z)] !== ID_AIR) { y++; continue; }
          const runBottom = y;
          let runTop = y;
          while (runTop < d && this.blocks[this.blockIndex(x, runTop, z)] === ID_AIR) runTop++;
          const runHeight = runTop - runBottom;

          const belowSolid = runBottom - 1 >= 0 && this.blocks[this.blockIndex(x, runBottom - 1, z)] !== ID_AIR;
          const aboveSolid = runTop < d && this.blocks[this.blockIndex(x, runTop, z)] !== ID_AIR;

          if (runHeight > 0 && runHeight <= MAX_FILL_HEIGHT && belowSolid && aboveSolid) {
            for (let fy = runBottom; fy < runTop; fy++) {
              const idx = this.blockIndex(x, fy, z);
              if (this.blocks[idx] === ID_AIR) this.blocks[idx] = ID_DIRT;
            }
          }
          y = runTop + 1;
        }
      }
    }
  }

  computeLightDepths() {
    const w = this.width, h = this.height, d = this.depth;
    const { ID_AIR } = this.IDS;
    const lightDepths = new Uint8Array(w * h);
    for (let x = 0; x < w; ++x) {
      for (let z = 0; z < h; ++z) {
        let y;
        for (y = d - 1; y >= 0; --y) {
          if (this.blocks[this.blockIndex(x, y, z)] !== ID_AIR) break;
        }
        lightDepths[x + z * w] = y >= 0 ? y : 0;
      }
    }
    this.lightDepths = lightDepths;
  }
}

/* ===========
   Main app (extracted)
   =========== */
class RubyDung {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 866 / 480, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas: document.querySelector("#canvas"), antialias: true });
    this.renderer.shadowMap.enabled = false;
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));

    const useFullWindowCanvas = !!window.__FS_FULLSIZE;
    const initialWidth = useFullWindowCanvas ? window.innerWidth : 866;
    const initialHeight = useFullWindowCanvas ? window.innerHeight : 480;
    this.renderer.setSize(initialWidth, initialHeight);
    // Save the renderer's default clear color so we can restore it after an underwater tint.
    try {
      this._savedClearColor = this.renderer.getClearColor(new THREE.Color()).clone();
      this._isUnderwaterTintActive = false;
    } catch (e) {
      this._savedClearColor = new THREE.Color(0x000000);
      this._isUnderwaterTintActive = false;
    }

    if (useFullWindowCanvas) {
      this.camera.aspect = initialWidth / initialHeight;
      this.camera.updateProjectionMatrix();
      const canvasEl = this.renderer.domElement;
      if (canvasEl) {
        canvasEl.style.position = 'fixed';
        canvasEl.style.left = '0';
        canvasEl.style.top = '0';
        canvasEl.style.width = '100%';
        canvasEl.style.height = '100%';
      }
    }

    this.player = null;
    this._lastDebugLog = 0;
    this.world = null;
    this.textureCache = {};
    this.worldInitialized = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameCount = 0;
    this.startTime = 0;
    this.worldRevealStartTime = 0;
    this.layerRevealDuration = 100;
    this.blockMaterials = [];
    this.materialIndexMap = {};
    this.renderDistance = 16;
    this.currentLoadedChunkCount = 0;
    this.raycaster = new THREE.Raycaster();
    this.crosshairElement = null;

    this.highlightFaceMesh = null;
    this.fpsSmoothed = 60;
    this.lowPerfUpdateCounter = 0;
    this.zombies = [];
    this.zombieTexture = null;

    this.selectedBlockKey = "stone";
    this.selectedBlockId = Tiles.stone.id || 2;
    this.updateSelectedUI = () => {
      const ui = document.getElementById("ui");
      if (ui) ui.style.display = "none";
    };
    this.updateSelectedUI();

    this.invertMouseButtons = false;
    this._pendingGrassTimers = new Map();

    // World-gen seed: stable per session unless caller changes it. Exposed so regenerateWorld()
    // can reuse it, advance it, or be set externally before calling init()/regenerateWorld().
    this.worldSeed = Date.now();

    // Cache for water chunk detection to avoid scanning blocks every frame
    this._waterChunkCache = new Map();
    // Water culling radius (units)
    this._waterCullingRadius = 96;
    this._waterCullingRadiusSq = 96 * 96;

    this.init();
  }

  async loadTexture(url) {
    if (this.textureCache[url]) return this.textureCache[url];
    try {
      const name = String(url).split('/').pop();
      console.log(name);
    } catch (e) {
      console.log(url);
    }
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    this.textureCache[url] = tex;
    return tex;
  }

  async spawnZombie(x, y, z) {
    if (!this.zombieTexture) {
      this.zombieTexture = await this.loadTexture("./char.png");
    }
    const zombie = new Zombie(this.mobGroup, this.world, this.zombieTexture, x, y, z);
    this.zombies.push(zombie);
    return zombie;
  }

  async spawnInitialZombies() {
    const count = 6;
    for (let i = 0; i < count; i++) {
      const x = Math.random() * this.world.width;
      const z = Math.random() * this.world.height;
      let y;
      for (y = this.world.depth - 1; y >= 0; y--) {
        if (this.world.getTile(Math.floor(x), y, Math.floor(z)) !== 0) {
          y++;
          break;
        }
      }
      if (y > 0) {
        await this.spawnZombie(x + 0.5, y, z + 0.5);
      }
    }
    console.log(`Spawned ${count} zombies at world surface`);
  }

  /* createLavaMaterial — dedicated ShaderMaterial backed by /lava.png so flood-filled lava
     (Tiles.calmLava / Tiles.lava) renders with its own animated texture instead of falling back
     to the rock/atlas material. Mirrors the water material's structure (scrolling UV + glow). */
  async createLavaMaterial(atlasFallback) {
    let lavaTex = null;
    try {
      lavaTex = await this.loadTexture("/lava.png");
    } catch (e) {
      console.warn('Failed to load /lava.png, falling back to atlas for lava material:', e);
    }
    const texForMat = (lavaTex && lavaTex.isTexture) ? lavaTex : atlasFallback;
    try {
      if (texForMat && texForMat.isTexture) {
        texForMat.wrapS = THREE.RepeatWrapping;
        texForMat.wrapT = THREE.RepeatWrapping;
        texForMat.magFilter = THREE.NearestFilter;
        texForMat.minFilter = THREE.NearestFilter;
        texForMat.generateMipmaps = false;
        texForMat.needsUpdate = true;
      }
    } catch (e) {
      console.warn('Could not configure lava texture sampling', e);
    }

    const lavaMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: texForMat },
        uOpacity: { value: 1.0 },
        uTime:    { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform float uOpacity;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vNormal;

        void main() {
          // slow scroll, lava moves more sluggishly than water
          vec2 scrollUv = fract(vUv + vec2(uTime * 0.006, uTime * 0.004));

          float rippleX = sin((vUv.y * 10.0) + uTime * 0.6) * 0.003;
          float rippleY = cos((vUv.x * 10.0) + uTime * 0.5) * 0.003;
          vec2 warped = fract(scrollUv + vec2(rippleX, rippleY));

          vec4 texSample = texture2D(tDiffuse, warped);
          if (texSample.a < 0.01) discard;

          // warm glow boost, slight pulsing
          float pulse = 0.92 + 0.08 * sin(uTime * 1.4);
          vec3 glow = texSample.rgb * pulse;

          gl_FragColor = vec4(glow, texSample.a * uOpacity);
        }
      `,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide
    });
    lavaMat.needsUpdate = true;
    return lavaMat;
  }

  /* registerLavaMaterial — pushes the lava material into blockMaterials and maps both the
     'lava' key and Tiles.calmLava.id / Tiles.lava.id to it, so any lookup path (string key or
     tile id) resolves to the lava.png-backed material instead of defaulting elsewhere. */
  async registerLavaMaterial(atlasFallback) {
    try {
      const lavaMat = await this.createLavaMaterial(atlasFallback);
      const lavaMaterialIndex = this.blockMaterials.length;
      this.blockMaterials.push(lavaMat);
      this.materialIndexMap['lava'] = lavaMaterialIndex;

      if (typeof Tiles !== 'undefined') {
        if (Tiles.calmLava) {
          try { this.materialIndexMap[Tiles.calmLava.id] = lavaMaterialIndex; } catch (e) {}
        }
        if (Tiles.lava) {
          try { this.materialIndexMap[Tiles.lava.id] = lavaMaterialIndex; } catch (e) {}
        }
      }
      this._lavaMaterial = lavaMat;
    } catch (e) {
      console.warn('Failed to create/register lava material:', e);
    }
  }

  async init() {
    this.setupScene();
    this.setupControls();
    this.scene.background = new THREE.Color(0x3F76E4);
    try {
      const skyColor = new THREE.Color(0x7FCCFF);
      const SKY_RADIUS = 800;
      const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
      const skyMat = new THREE.MeshBasicMaterial({
        color: skyColor,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true
      });
      this._skyMesh = new THREE.Mesh(skyGeo, skyMat);
      this._skyMesh.frustumCulled = false;
      this._skyMesh.renderOrder = -1000;
      this.scene.add(this._skyMesh);
    } catch (e) {
      console.warn('Failed to create skydome:', e);
    }

    // Load water texture FIRST so animated water material can use it
    this._waterTex = await this.loadTexture("/water.png").catch(() => null);
    if (this._waterTex && this._waterTex.isTexture) {
      try {
        this._waterTex.wrapS = THREE.RepeatWrapping;
        this._waterTex.wrapT = THREE.RepeatWrapping;
        this._waterTex.magFilter = THREE.NearestFilter;
        this._waterTex.minFilter = THREE.NearestFilter;
        this._waterTex.generateMipmaps = false;
        this._waterTex.needsUpdate = true;
      } catch (e) { console.warn('Could not configure water texture sampling', e); }
    }

    // Now load atlas and particle engine
    const atlas = await this.loadTexture("/terrain.png");
    this.particleEngine = new ParticleEngine(atlas, this.scene);

    // 2. Create block materials (atlas-based)
    try {
      const { createBlockMaterials } = await import('./createBlockMaterials.js');
      const res = await createBlockMaterials(atlas);
      this.blockMaterials = res.blockMaterials;
      this.materialIndexMap = res.materialIndexMap;
    } catch (e) {
      console.warn('createBlockMaterials import or execution failed:', e);
      this.blockMaterials = [];
      this.materialIndexMap = {};
    }

    // 3. Create and register the animated water ShaderMaterial (use loaded water texture or atlas fallback)
    try {
      const waterTexForMat = this._waterTex || atlas;
      if (waterTexForMat && waterTexForMat.isTexture) {
        waterTexForMat.wrapS = THREE.RepeatWrapping;
        waterTexForMat.wrapT = THREE.RepeatWrapping;
        waterTexForMat.magFilter = THREE.NearestFilter;
        waterTexForMat.minFilter = THREE.NearestFilter;
        waterTexForMat.generateMipmaps = false;
        waterTexForMat.needsUpdate = true;
      }

      const waterMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: waterTexForMat },
          uOpacity: { value: 0.9 },
          uTime:    { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormal;
          void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          uniform sampler2D tDiffuse;
          uniform float uOpacity;
          uniform float uTime;
          varying vec2 vUv;
          varying vec3 vNormal;

          void main() {
            vec2 scrollUv = fract(vUv + vec2(uTime * 0.015, uTime * 0.01));
            float rippleX = sin((vUv.y * 16.0) + uTime * 1.2) * 0.0045;
            float rippleY = cos((vUv.x * 16.0) + uTime * 0.9) * 0.0045;
            vec2 warped = scrollUv + vec2(rippleX, rippleY);
            vec2 finalUv = fract(warped);

            vec4 texSample = texture2D(tDiffuse, finalUv);
            if (texSample.a < 0.01) discard;

            float topFactor = clamp(vNormal.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 deepBlue = vec3(0.01, 0.04, 0.45);
            vec3 mixed = mix(deepBlue, texSample.rgb, topFactor);

            vec3 finalColor = ((mixed - 0.5) * 1.12) + 0.5;
            finalColor = clamp(finalColor, 0.0, 1.0);

            gl_FragColor = vec4(finalColor, texSample.a * uOpacity);
          }
        `,
        transparent: true,
        // Match border water planes: do not write depth so opaque neighbors stay correct.
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending
      });

      const waterMaterialIndex = this.blockMaterials.length;
      this.blockMaterials.push(waterMat);
      this.materialIndexMap['water'] = waterMaterialIndex;

      if (typeof Tiles !== 'undefined' && Tiles.water) {
        try {
          this.materialIndexMap[Tiles.water.id] = waterMaterialIndex;
        } catch (e) { /* non-fatal */ }
      }
      if (typeof Tiles !== 'undefined' && Tiles.calmWater) {
        try {
          this.materialIndexMap[Tiles.calmWater.id] = waterMaterialIndex;
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) {
      console.warn('Failed to create/register animated water material:', e);
    }

    // 3b. Create and register the dedicated lava ShaderMaterial (lava.png-backed)
    await this.registerLavaMaterial(atlas);

    try {
      const rockTex = await this.loadTexture("/rock.png").catch(() => null);
      try {
        if (rockTex && rockTex.isTexture) {
          rockTex.wrapS = THREE.RepeatWrapping;
          rockTex.wrapT = THREE.RepeatWrapping;
          rockTex.magFilter = THREE.NearestFilter;
          rockTex.minFilter = THREE.NearestFilter;
          rockTex.generateMipmaps = false;
          rockTex.needsUpdate = true;
        }
      } catch (e) {
        console.warn('Could not configure rock texture sampling', e);
      }
      const rockTexForMat = rockTex || atlas;

      const makeRockMat = () => {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            tDiffuse: { value: rockTexForMat },
            uColor:   { value: new THREE.Vector3(1.0, 1.0, 1.0) },
            uTime:    { value: 0.0 }
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            precision mediump float;
            uniform sampler2D tDiffuse;
            uniform vec3 uColor;
            varying vec2 vUv;
            void main() {
              vec4 texSample = texture2D(tDiffuse, vUv);
              if (texSample.a < 0.01) discard;
              vec3 col = texSample.rgb * uColor;
              gl_FragColor = vec4(col, texSample.a);
            }
          `,
          transparent: false,
          depthWrite: true,
          depthTest: true,
          side: THREE.DoubleSide
        });
        mat.needsUpdate = true;
        return mat;
      };

      const rockPlaneMat = makeRockMat();
      this.blockMaterials.push(rockPlaneMat);
      this.materialIndexMap['rock_plane'] = this.blockMaterials.length - 1;
    } catch (e) {
      console.warn('Failed to create rock_plane material:', e);
    }

    const SUPERFLAT = false;
    this.world = new World(this.blockMaterials, this.materialIndexMap, SUPERFLAT);
    try {
      this.waterManager = new WaterManager(this.world);
    } catch (e) {
      this.waterManager = null;
      console.warn('Failed to create WaterManager', e);
    }

    if (typeof Tiles !== "undefined" && Object.keys(Tiles.byId).length === 0) {
      try { Tiles.init(); } catch (e) {}
    }

    try {
      const genResult = this.runLevelGen(this.world.width, this.world.height, this.world.depth, SUPERFLAT, this.worldSeed);
      this.world.blocks = genResult.blocks;
      this.world.lightDepths = genResult.lightDepths;

      try { if (this.waterManager) this.waterManager.initializeFromWorld(); } catch (e) { console.warn('waterManager.initializeFromWorld failed', e); }

      // Mark generated dirt so runtime exposure/growth logic can ignore worldgen-placed dirt.
      try { this.world.markGeneratedDirtFromBlocks(); } catch (e) { /* non-fatal */ }

      if (this.particleEngine) this.particleEngine.setWorld(this.world);

      this.worldInitialized = true;
      this.spawnInitialZombies();

      try { await this.createWorldBorderPlanes(); } catch (e) { console.warn('createWorldBorderPlanes call failed', e); }

      this.worldRevealStartTime = 0;
    } catch (err) {
      console.warn('LevelGen generation failed, falling back to in-thread generation:', err);
      await this.world.init();
      if (this.particleEngine) this.particleEngine.setWorld(this.world);
      this.worldInitialized = true;
      this.worldRevealStartTime = 0;
    }

    this.player = new Player(this.scene, this.camera, this.world);
    this.player.resetPosition();
    if (this.particleEngine) this.particleEngine.setPlayer(this.player);

    try {
      const handler = makeExposureHandler(this.world, (x, y, z) => {
        try { this.updateChunksAroundBlock(x, y, z); } catch (e) { console.warn('updateChunksAroundBlock failed', e); }
      });
      window.addEventListener('player:checkExposure', handler, false);

      window.addEventListener('player:convertGrass', (ev) => {
        try {
          const d = ev && ev.detail;
          if (d && typeof d.x === 'number' && typeof d.y === 'number' && typeof d.z === 'number') {
            const changed = this.convertGrassIfUnlit(d.x, d.y, d.z);
            if (changed) {
              try { this.updateChunksAroundBlock(d.x, d.y, d.z); } catch (e) { console.warn('updateChunksAroundBlock failed after convert', e); }
            }
          }
        } catch (err) {
          console.warn('player:convertGrass handler failed', err);
        }
      }, false);
    } catch (err) {
      console.warn('makeExposureHandler setup failed', err);
    }

    this.worldRevealStartTime = 0;

    this.renderer.setAnimationLoop(this.animate.bind(this));
    this.startFPSTimer();
  }

  /* runLevelGen — shared entry point used by both init() and regenerateWorld(). Wraps the
     ported LevelGen class, reporting progress through this.setNextPhase-style callback hooked
     up to whichever overlay/status UI is currently active. */
  runLevelGen(width, height, depth, superflat, seed) {
    const t0 = performance.now();
    const gen = new LevelGen((pct) => {
      // Progress hook: currently just logged; UI overlays use their own fixed-duration status
      // sequence (see regenerateWorld), so this is informational rather than driving the bar.
      if (pct % 25 === 0) console.log(`LevelGen progress: ${pct}%`);
    }, seed);
    const result = gen.generateLevel(width, height, depth, superflat);
    const t1 = performance.now();
    console.log(`LevelGen.generateLevel completed in ${(t1 - t0).toFixed(1)}ms (seed=${seed})`);
    return result;
  }

  setupScene() {
    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(0.5, 1, 0.25);
    dir.castShadow = false;
    this.scene.add(dir);
    window.addEventListener("resize", this.onWindowResize.bind(this), false);

    this.mobGroup = new THREE.Group();
    this.scene.add(this.mobGroup);

    this.createCrosshair();
  }

  async createWorldBorderPlanes() {
    if (!this.world) return;
    const w = this.world.width;
    const h = this.world.height;
    const waterY = Math.max(0, Math.min(this.world ? this.world.depth - 1 : 30, 30));
    const rockY  = waterY - 2;
    const extend = 2000;
    const rockTex = await this.loadTexture("./rock.png").catch(() => null);
    const makeWaterMat = () => {
      let sampleTex = null;
      try {
        const px = new Uint8Array([
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  30, 85, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 38, 93, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135, 61, 108, 255, 146,
  61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146, 38, 93, 255, 135,
  38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 61, 108, 255, 146,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  30, 85, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 38, 93, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 38, 93, 255, 135, 61, 108, 255, 146,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  30, 85, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146,
  61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135, 61, 108, 255, 146,
  38, 93, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 38, 93, 255, 135, 38, 93, 255, 135, 30, 85, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  61, 108, 255, 146, 61, 108, 255, 146, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 38, 93, 255, 135, 38, 93, 255, 135,
  38, 93, 255, 135, 38, 93, 255, 135, 61, 108, 255, 146, 61, 108, 255, 146,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 61, 108, 255, 146, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135,
  30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135, 30, 85, 255, 135
]);
        sampleTex = new THREE.DataTexture(px, 16, 16, THREE.RGBAFormat);
        sampleTex.magFilter = THREE.NearestFilter;
        sampleTex.minFilter = THREE.NearestFilter;
        sampleTex.generateMipmaps = false;
        sampleTex.wrapS = THREE.RepeatWrapping;
        sampleTex.wrapT = THREE.RepeatWrapping;
        sampleTex.needsUpdate = true;
      } catch (e) {
        console.warn('makeWaterMat: failed to create DataTexture, falling back to atlas', e);
        sampleTex = this._waterTex || null;
      }

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: sampleTex },
          uOpacity: { value: 1.0 },
          uTime:    { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormal;
          void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          uniform sampler2D tDiffuse;
          uniform float uOpacity;
          uniform float uTime;
          varying vec2 vUv;
          varying vec3 vNormal;

          void main() {
            vec2 scrollUv = fract(vUv + vec2(uTime * 0.015, uTime * 0.01));
            vec4 texSample = texture2D(tDiffuse, scrollUv);
            if (texSample.a < 0.01) discard;

            float topFactor = clamp(vNormal.y * 0.5 + 0.5, 0.0, 1.0);

            vec3 deepBlue = vec3(0.01, 0.04, 0.45);
            vec3 mixed = mix(deepBlue, texSample.rgb, topFactor);
            float contrast = 1.12;
            vec3 finalColor = ((mixed - 0.5) * contrast) + 0.5;
            finalColor = clamp(finalColor, 0.0, 1.0);

            gl_FragColor = vec4(finalColor, texSample.a * uOpacity);
          }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending
      });

      const ud = mat.userData || {};
      ud.clientOnly = true;
      try {
        Object.defineProperty(mat, 'userData', { value: ud, writable: true, configurable: true, enumerable: false });
      } catch (e) {
        mat.userData = ud;
      }
      mat.needsUpdate = true;
      return mat;
    };

    const makeRockMat = () => {
      const srcTex = (rockTex && rockTex.isTexture) ? rockTex : atlas;
      let rockTexForMat = srcTex;
      try {
        if (srcTex && srcTex.isTexture) {
          rockTexForMat = srcTex.clone();
          rockTexForMat.wrapS = THREE.RepeatWrapping;
          rockTexForMat.wrapT = THREE.RepeatWrapping;
          rockTexForMat.magFilter = THREE.NearestFilter;
          rockTexForMat.minFilter = THREE.NearestFilter;
          rockTexForMat.generateMipmaps = false;
          rockTexForMat.needsUpdate = true;
        }
      } catch (e) {
        console.warn('makeRockMat: could not configure cloned rock texture sampling', e);
        rockTexForMat = srcTex;
      }

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: rockTexForMat },
          uColor:   { value: new THREE.Vector3(1.0, 1.0, 1.0) },
          uTime:    { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          uniform sampler2D tDiffuse;
          uniform vec3 uColor;
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vec2 uv = vUv;
            vec4 texSample = texture2D(tDiffuse, uv);
            if (texSample.a < 0.01) discard;
            vec3 col = texSample.rgb * uColor;
            gl_FragColor = vec4(col, texSample.a);
          }
        `,
        transparent: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide
      });
      mat.needsUpdate = true;
      return mat;
    };

    const makePlane = (pw, ph, cx, cz, yPos, matFn) => {
      const geo = new THREE.PlaneGeometry(pw, ph, 1, 1);
      const uv = geo.attributes.uv;
      uv.array[0] = 0;  uv.array[1] = 0;
      uv.array[2] = pw; uv.array[3] = 0;
      uv.array[4] = 0;  uv.array[5] = ph;
      uv.array[6] = pw; uv.array[7] = ph;
      uv.needsUpdate = true;

      const mat = matFn();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;

      const posY = (typeof waterY !== "undefined" && yPos === waterY) ? (yPos - 0.1) : yPos;
      mesh.position.set(cx, posY, cz);

      // Ensure border water planes render after regular chunk geometry so blending and sorting
      // are consistent; use mesh.renderOrder (Object3D) not material.renderOrder.
      if (yPos === waterY) {
        mesh.renderOrder = 1000;
      } else {
        mesh.renderOrder = 0;
      }
      this.scene.add(mesh);

      if (yPos === waterY) {
        try {
          const arr = this._borderWaterMats || [];
          arr.push(mat);
          Object.defineProperty(this, '_borderWaterMats', { value: arr, writable: true, configurable: true, enumerable: false });
        } catch (e) {
          this._borderWaterMats = this._borderWaterMats || [];
          this._borderWaterMats.push(mat);
        }
      }
    };

    makePlane(extend,             h,      -extend / 2,      h / 2,           waterY, makeWaterMat);
    makePlane(extend,             h,       w + extend / 2,  h / 2,           waterY, makeWaterMat);
    makePlane(w + extend * 2, extend,     w / 2,           -extend / 2,      waterY, makeWaterMat);
    makePlane(w + extend * 2, extend,     w / 2,            h + extend / 2,  waterY, makeWaterMat);

    makePlane(extend,             h,      -extend / 2,      h / 2,           rockY, makeRockMat);
    makePlane(extend,             h,       w + extend / 2,  h / 2,           rockY, makeRockMat);
    makePlane(w + extend * 2, extend,     w / 2,           -extend / 2,      rockY, makeRockMat);
    makePlane(w + extend * 2, extend,     w / 2,            h + extend / 2,  rockY, makeRockMat);

    const makeVerticalPlane = (pw, ph, cx, cz, topY, rotY, matFn) => {
      const geo = new THREE.PlaneGeometry(pw, ph, 1, 1);
      const TILE_WORLD_SCALE = 1.0;
      const uRepeat = pw / TILE_WORLD_SCALE;
      const vRepeat = ph / TILE_WORLD_SCALE;
      const uv = geo.attributes.uv;
      uv.array[0] = 0.0;      uv.array[1] = 0.0;
      uv.array[2] = uRepeat; uv.array[3] = 0.0;
      uv.array[4] = 0.0;      uv.array[5] = vRepeat;
      uv.array[6] = uRepeat; uv.array[7] = vRepeat;
      uv.needsUpdate = true;
      try {
        const sampleTex = (rockTex && rockTex.isTexture) ? rockTex : null;
        if (sampleTex) {
          sampleTex.wrapS = THREE.RepeatWrapping;
          sampleTex.wrapT = THREE.RepeatWrapping;
          sampleTex.magFilter = THREE.NearestFilter;
          sampleTex.minFilter = THREE.NearestFilter;
          sampleTex.generateMipmaps = false;
          sampleTex.needsUpdate = true;
        }
      } catch (e) {
        console.warn('makeVerticalPlane: could not set rock texture sampling', e);
      }

      const mat = matFn();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = 0;
      mesh.rotation.y = rotY;
      mesh.position.set(cx, topY - ph / 2, cz);
      this.scene.add(mesh);
    };

    const wallLengthZ = this.world.height;
    const wallLengthX = this.world.width;

    makeVerticalPlane(wallLengthZ, rockY, 0, this.world.height / 2, rockY, Math.PI / 2, makeRockMat);
    makeVerticalPlane(wallLengthZ, rockY, w, this.world.height / 2, rockY, -Math.PI / 2, makeRockMat);
    makeVerticalPlane(wallLengthX, rockY, this.world.width / 2, 0, rockY, 0, makeRockMat);
    makeVerticalPlane(wallLengthX, rockY, this.world.width / 2, h, rockY, Math.PI, makeRockMat);

    try {
      if (this.world) {
        const bx = [];
        bx.push(new AABB(-extend, 0, 0, 0, rockY, this.world.height));
        bx.push(new AABB(this.world.width, 0, 0, this.world.width + extend, rockY, this.world.height));
        bx.push(new AABB(0, 0, -extend, this.world.width, rockY, 0));
        bx.push(new AABB(0, 0, this.world.height, this.world.width, rockY, this.world.height + extend));
        bx.push(new AABB(-extend, -extend, -extend, this.world.width + extend, 0, this.world.height + extend));
        bx.push(new AABB(-extend, rockY, -extend, this.world.width + extend, rockY + extend, this.world.height + extend));
        try {
          Object.defineProperty(this, '_clientBorderBoxes', { value: bx, writable: true, configurable: true, enumerable: false });
        } catch (e) {
          this._clientBorderBoxes = bx;
        }

        try {
          const WATER_ID = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
          if (WATER_ID !== null && this.world) {
            const y = waterY;
            for (let x = 0; x < this.world.width; x++) {
              if (this.world.getTile(x, y, 0) === 0) {
                this.world.setTile(x, y, 0, WATER_ID);
                try { this.world.updateChunksAroundBlock(x, y, 0); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.initializePos === 'function' && this.waterManager.initializePos(x, y, 0); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.onBlockUpdated === 'function' && this.waterManager.onBlockUpdated(x, y, 0); } catch (e) {}
              }
              if (this.world.getTile(x, y, this.world.height - 1) === 0) {
                this.world.setTile(x, y, this.world.height - 1, WATER_ID);
                try { this.world.updateChunksAroundBlock(x, y, this.world.height - 1); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.initializePos === 'function' && this.waterManager.initializePos(x, y, this.world.height - 1); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.onBlockUpdated === 'function' && this.waterManager.onBlockUpdated(x, y, this.world.height - 1); } catch (e) {}
              }
            }
            for (let z = 1; z < this.world.height - 1; z++) {
              if (this.world.getTile(0, y, z) === 0) {
                this.world.setTile(0, y, z, WATER_ID);
                try { this.world.updateChunksAroundBlock(0, y, z); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.initializePos === 'function' && this.waterManager.initializePos(0, y, z); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.onBlockUpdated === 'function' && this.waterManager.onBlockUpdated(0, y, z); } catch (e) {}
              }
              if (this.world.getTile(this.world.width - 1, y, z) === 0) {
                this.world.setTile(this.world.width - 1, y, z, WATER_ID);
                try { this.world.updateChunksAroundBlock(this.world.width - 1, y, z); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.initializePos === 'function' && this.waterManager.initializePos(this.world.width - 1, y, z); } catch (e) {}
                try { this.waterManager && typeof this.waterManager.onBlockUpdated === 'function' && this.waterManager.onBlockUpdated(this.world.width - 1, y, z); } catch (e) {}
              }
            }
          }
        } catch (e) {
          console.warn('Failed to populate world edge water blocks:', e);
        }
      }
    } catch (e) {
      console.warn('Failed to create world border boxes:', e);
    }
  }

  async regenerateWorld() {
    try {
      let overlay = document.getElementById('rd-gen-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'rd-gen-overlay';
        Object.assign(overlay.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.0)',
          zIndex: 999999,
          pointerEvents: 'auto',
          flexDirection: 'column',
        });

        const viewBox = document.createElement('div');
        viewBox.id = 'rd-gen-viewbox';
        Object.assign(viewBox.style, {
          width: '866px',
          height: '480px',
          position: 'relative',
          boxSizing: 'border-box',
          overflow: 'hidden',
          background: '#000',
          border: '1px solid rgba(0,0,0,0.2)',
          imageRendering: 'pixelated',
          zIndex: 1000000,
        });

        const bg = document.createElement('div');
        bg.id = 'rd-gen-bg';
        Object.assign(bg.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          width: '866px',
          height: '480px',
          backgroundImage: 'url(/dirt.png)',
          backgroundRepeat: 'repeat',
          backgroundSize: '64px 64px',
          imageRendering: 'pixelated',
          filter: 'brightness(0.45)',
          opacity: '1.0'
        });
        viewBox.appendChild(bg);

        const label = document.createElement('div');
        label.textContent = 'Generating Level';
        Object.assign(label.style, {
          fontFamily: 'monospace',
          color: '#ffffff',
          fontSize: '15px',
          fontWeight: '200',
          textShadow: '0.9px 1px 0 rgba(0,0,0,0.7), 1.9px 2px 0 rgba(0,0,0,0.5)',
          zIndex: 1000001,
          padding: '0',
          background: 'transparent',
          borderRadius: '0',
          pointerEvents: 'none',
          position: 'absolute',
          left: '50%',
          top: '48%',
          transform: 'translate(-50%, -50%)'
        });

        const statusContainer = document.createElement('div');
        statusContainer.id = 'rd-gen-status';
        Object.assign(statusContainer.style, {
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 1000001,
          width: '100%',
          textAlign: 'center'
        });

        const statusLine = document.createElement('div');
        statusLine.textContent = '';
        Object.assign(statusLine.style, {
          fontFamily: 'monospace',
          color: '#ffffff',
          fontSize: '13px',
          fontWeight: '200',
          textShadow: '1px 1px 0 rgba(0,0,0,0.7)',
          pointerEvents: 'none'
        });

        statusContainer.appendChild(statusLine);

        (async () => {
          try {
            const font = new FontFace('GameFace', `url('https://cdn.jsdelivr.net/gh/CaveGameDev/classicJS@refs/heads/main/a.ttf')`);
            await font.load();
            document.fonts.add(font);
            label.style.fontFamily = 'GameFace, monospace';
            statusLine.style.fontFamily = 'GameFace, monospace';
          } catch (err) {
            console.warn('Regenerate overlay font load failed:', err);
          }
        })();

        this._startGenStatusSequence = (overlayEl) => {
          try {
            if (!overlayEl) return;
            if (overlayEl._rd_statusRunning) {
              overlayEl._rd_statusRestartRequested = true;
              return;
            }
            overlayEl._rd_statusRunning = true;
            overlayEl._rd_statusRestartRequested = false;

            (async () => {
              try {
                const messages = ["Raising...", "Eroding...", "Soiling...", "Carving...", "Watering...", "Melting..."];
                await new Promise(r => setTimeout(r, 300));
                for (let i = 0; i < messages.length; i++) {
                  if (overlayEl._rd_statusRestartRequested) {
                    overlayEl._rd_statusRestartRequested = false;
                    i = 0;
                  }
                  statusLine.textContent = messages[i];
                  await new Promise(r => setTimeout(r, 500));
                }
              } catch (e) {
                console.warn('Status sequence failed', e);
              } finally {
                try { overlayEl._rd_statusRunning = false; overlayEl._rd_statusRestartRequested = false; } catch (e) {}
              }
            })();
          } catch (e) { console.warn('startGenStatusSequence failed', e); }
        };

        overlay.appendChild(viewBox);
        overlay.appendChild(label);
        overlay.appendChild(statusContainer);
        document.body.appendChild(overlay);

        try { this._startGenStatusSequence(overlay); } catch (e) {}

      } else {
        overlay.style.display = 'flex';
        try { overlay._rd_showStart = performance.now(); } catch (e) {}
        try {
          overlay._rd_statusRestartRequested = true;
          this._startGenStatusSequence(overlay);
        } catch (e) {}
      }

      try {
        if (this.world && this.world.loadedChunkMeshes) {
          for (const key of Array.from(this.world.loadedChunkMeshes.keys())) {
            const [cx, cz] = key.split('_').map(Number);
            this.world.unloadChunk(cx, cz, this.scene);
          }
        }
        if (this.mobGroup) {
          while (this.mobGroup.children.length) this.mobGroup.remove(this.mobGroup.children[0]);
        }
        if (this.particleEngine) this.particleEngine.dispose();
        this.worldInitialized = false;
        this.zombies = [];
        this._pendingGrassTimers.clear();
      } catch (e) {
        console.warn('Partial cleanup before regen failed', e);
      }

      const SUPERFLAT = false;
      this.world = new World(this.blockMaterials, this.materialIndexMap, SUPERFLAT);
      try {
        if (!this.waterManager) this.waterManager = new WaterManager(this.world);
        else this.waterManager.setWorld(this.world);
      } catch (e) {
        console.warn('Failed to init waterManager on regen:', e);
      }

      // New seed each regeneration so the world actually changes; uses the same JavaRandom-backed
      // LevelGen as init() via the shared runLevelGen() helper.
      this.worldSeed = Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF);
      const genResult = this.runLevelGen(this.world.width, this.world.height, this.world.depth, SUPERFLAT, this.worldSeed);
      this.world.blocks = genResult.blocks;
      this.world.lightDepths = genResult.lightDepths;

      try { if (this.waterManager) this.waterManager.initializeFromWorld(); } catch (e) { console.warn('waterManager.initializeFromWorld failed after regen', e); }

      // Mark generated dirt so runtime exposure/growth logic can ignore worldgen-placed dirt.
      try { this.world.markGeneratedDirtFromBlocks(); } catch (e) { /* non-fatal */ }

      this.world.exposedTimers = new Float32Array(this.world.width * this.world.height * this.world.depth);

      if (this.particleEngine) this.particleEngine.setWorld(this.world);

      if (!this.player) {
        this.player = new Player(this.scene, this.camera, this.world);
        this.player.resetPosition();
      } else {
        this.player.world = this.world;
        try { this.player.resetPosition(); } catch (e) { console.warn('Failed to reset player position after regen:', e); }
      }

      try {
        for (const key of Array.from(this.world.loadedChunkMeshes.keys())) {
          const [cx, cz] = key.split('_').map(Number);
          this.world.unloadChunk(cx, cz, this.scene);
        }
      } catch (e) {}

      const px = Math.floor(this.player.x), pz = Math.floor(this.player.z);
      const cx = Math.floor(px / this.world.chunkSizeX), cz = Math.floor(pz / this.world.chunkSizeZ);
      const chunksX = Math.ceil(this.world.width / this.world.chunkSizeX);
      const chunksZ = Math.ceil(this.world.height / this.world.chunkSizeZ);
      for (let dx = -this.renderDistance; dx <= this.renderDistance; dx++) {
        for (let dz = -this.renderDistance; dz <= this.renderDistance; dz++) {
          const rx = cx + dx, rz = cz + dz;
          if (rx >= 0 && rx < chunksX && rz >= 0 && rz < chunksZ) this.world.loadChunk(rx, rz, this.scene);
        }
      }

      try { await this.spawnInitialZombies(); } catch (e) {}

      this.worldInitialized = true;

      try {
        const start = overlay && overlay._rd_showStart ? overlay._rd_showStart : performance.now();
        const elapsed = performance.now() - start;
        const minMs = 3000;
        if (elapsed < minMs) {
          await new Promise((res) => setTimeout(res, Math.ceil(minMs - elapsed)));
        }
      } catch (e) {
        // fall through if timing fails
      }
      overlay.style.display = 'none';
    } catch (err) {
      console.error('regenerateWorld failed:', err);
      try {
        const overlay = document.getElementById('rd-gen-overlay');
        if (overlay) overlay.style.display = 'none';
      } catch(e){}
      alert('World regeneration failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  createCrosshair() {
    if (this.crosshairElement) return;
    const el = document.createElement("div");
    el.id = "rd-crosshair";
    Object.assign(el.style, {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: "26px",
      height: "26px",
      marginLeft: "-13px",
      marginTop: "-13px",
      pointerEvents: "none",
      zIndex: 9999,
      display: "block",
    });
    el.innerHTML = `<svg viewBox="0 0 26 26" width="26" height="26" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
      <rect x="11.5" y="4" width="2" height="18" rx="1" fill="rgba(255,255,255,0.95)" />
      <rect x="4" y="11.5" width="18" height="2" rx="1" fill="rgba(255,255,255,0.95)" />
    </svg>`;
    document.body.appendChild(el);
    this.crosshairElement = el;
  }

  setupControls() {
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 4;
    this.targetedBlock = null;
    document.addEventListener("mousedown", this.onMouseDown.bind(this));
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("keydown", (e) => {
      if (e.code === "Digit1") this.setSelectedBlock && this.setSelectedBlock("stone");
      else if (e.code === "Digit2") this.setSelectedBlock && this.setSelectedBlock("dirt");
      else if (e.code === "Digit3") this.setSelectedBlock && this.setSelectedBlock("cobble");
      else if (e.code === "Digit4") this.setSelectedBlock && this.setSelectedBlock("wood");
      else if (e.code === "Digit6") this.setSelectedBlock && this.setSelectedBlock("key6");
      else if (e.code === "KeyG") {
        if (this.player) {
          const px = Math.floor(this.player.x);
          const py = Math.floor(this.player.y);
          const pz = Math.floor(this.player.z);
          this.spawnZombie(px + 0.5, py + 3, pz + 0.5);
          console.log(`Spawned zombie at ${px + 0.5}, ${py + 3}, ${pz + 0.5}`);
        }
      }
      else if (e.code === "Digit9") {
        try { this.saveWorld && this.saveWorld(); } catch (err) { console.warn("Save failed:", err); }
      }
      else if (e.code === "Digit8") {
        try {
          if (!this._worldFileInput) {
            const fi = document.createElement("input");
            fi.type = "file";
            fi.accept = ".dat,application/octet-stream";
            fi.style.display = "none";
            fi.addEventListener("change", (ev) => {
              const f = ev.target.files && ev.target.files[0];
              if (f) this.loadWorldFile(f);
              fi.value = "";
            });
            document.body.appendChild(fi);
            this._worldFileInput = fi;
          }
          this._worldFileInput.click();
        } catch (err) { console.warn("Load picker failed:", err); }
      }
    });

    this.setSelectedBlock = (key) => {
      this.selectedBlockKey = key;
      switch (key) {
        case "stone": this.selectedBlockId = Tiles.stone ? Tiles.stone.id : 2; break;
        case "dirt": this.selectedBlockId = Tiles.dirt ? Tiles.dirt.id : 3; break;
        case "cobble": this.selectedBlockId = Tiles.cobble ? Tiles.cobble.id : (Tiles.stone ? Tiles.stone.id : 2); break;
        case "wood": this.selectedBlockId = Tiles.wood ? Tiles.wood.id : 5; break;
        case "key6": this.selectedBlockId = Tiles.key6 ? Tiles.key6.id : 7; break;
        default: this.selectedBlockId = Tiles.stone ? Tiles.stone.id : 2; break;
      }
      this.updateSelectedUI && this.updateSelectedUI();
      console.log("Selected block:", this.selectedBlockKey, this.selectedBlockId);
    };

    this.saveWorld = () => {
      try {
        if (!this.world) throw new Error("No world to save");
        const header = {
          magic: "RUBYDUNG1",
          width: this.world.width,
          height: this.world.height,
          depth: this.world.depth,
          time: Date.now()
        };
        const headerJson = JSON.stringify(header);
        const headerBytes = new TextEncoder().encode(headerJson + "\n");
        const blockBytes = this.world.blocks instanceof Uint8Array ? this.world.blocks : new Uint8Array(this.world.blocks);
        const blob = new Blob([headerBytes, blockBytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `level.dat`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        console.log("World saved:", header);
      } catch (err) {
        console.error("Failed to save world:", err);
        alert("Save failed: " + err.message);
      }
    };

    this.createWorldBlob = async () => {
      try {
        if (!this.world) throw new Error("No world to blob");
        const header = {
          magic: "RUBYDUNG1",
          width: this.world.width,
          height: this.world.height,
          depth: this.world.depth,
          time: Date.now()
        };
        const headerJson = JSON.stringify(header);
        const headerBytes = new TextEncoder().encode(headerJson + "\n");
        const blockBytes = this.world.blocks instanceof Uint8Array ? this.world.blocks : new Uint8Array(this.world.blocks);
        const blob = new Blob([headerBytes, blockBytes], { type: "application/octet-stream" });
        return blob;
      } catch (err) {
        console.error("createWorldBlob failed:", err);
        return null;
      }
    };

    this.loadWorldFile = async (file) => {
      let overlay = document.getElementById('rd-load-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'rd-load-overlay';
        Object.assign(overlay.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.0)',
          zIndex: 999999,
          pointerEvents: 'auto',
          flexDirection: 'column',
        });

        const viewBox = document.createElement('div');
        viewBox.id = 'rd-load-viewbox';
        Object.assign(viewBox.style, {
          width: '866px',
          height: '480px',
          position: 'relative',
          boxSizing: 'border-box',
          overflow: 'hidden',
          background: '#000',
          border: '1px solid rgba(0,0,0,0.2)',
          imageRendering: 'pixelated',
          zIndex: 1000000,
        });

        const bg = document.createElement('div');
        bg.id = 'rd-load-bg';
        Object.assign(bg.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          width: '866px',
          height: '480px',
          backgroundImage: 'url(/dirt.png)',
          backgroundRepeat: 'repeat',
          backgroundSize: '64px 64px',
          imageRendering: 'pixelated',
          filter: 'brightness(0.45)',
          opacity: '1.0'
        });
        viewBox.appendChild(bg);

        const label = document.createElement('div');
        label.textContent = 'Loading World';
        Object.assign(label.style, {
          fontFamily: 'monospace',
          color: '#ffffff',
          fontSize: '15px',
          fontWeight: '200',
          textShadow: '0.9px 1px 0 rgba(0,0,0,0.7), 1.9px 2px 0 rgba(0,0,0,0.5)',
          zIndex: 1000001,
          padding: '0',
          background: 'transparent',
          borderRadius: '0',
          pointerEvents: 'none',
          position: 'absolute',
          left: '50%',
          top: '48%',
          transform: 'translate(-50%, -50%)'
        });

        const statusContainerLoad = document.createElement('div');
        statusContainerLoad.id = 'rd-load-status';
        Object.assign(statusContainerLoad.style, {
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 1000001,
          width: '100%',
          textAlign: 'center'
        });

        const statusLineLoad = document.createElement('div');
        statusLineLoad.textContent = 'Reading...';
        Object.assign(statusLineLoad.style, {
          fontFamily: 'monospace',
          color: '#ffffff',
          fontSize: '13px',
          fontWeight: '200',
          textShadow: '1px 1px 0 rgba(0,0,0,0.7)',
          pointerEvents: 'none'
        });

        statusContainerLoad.appendChild(statusLineLoad);

        (async () => {
          try {
            const font = new FontFace('GameFace', `url('https://cdn.jsdelivr.net/gh/CaveGameDev/classicJS@refs/heads/main/a.ttf')`);
            await font.load();
            document.fonts.add(font);
            label.style.fontFamily = 'GameFace, monospace';
            statusLineLoad.style.fontFamily = 'GameFace, monospace';
          } catch (err) {
            console.warn('Load overlay font load failed:', err);
          }
        })();

        viewBox.appendChild(bg);
        overlay.appendChild(viewBox);
        overlay.appendChild(label);
        overlay.appendChild(statusContainerLoad);
        document.body.appendChild(overlay);
        try { overlay._rd_showStart = performance.now(); } catch (e) {}
      } else {
        overlay.style.display = 'flex';
        try { overlay._rd_showStart = performance.now(); } catch (e) {}
      }

      try {
        if (!this.world) throw new Error("No world present to load into");
        const ab = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let idx = bytes.indexOf(10);
        if (idx <= 0) throw new Error("Invalid save format");
        const headerBytes = bytes.subarray(0, idx);
        const headerJson = new TextDecoder().decode(headerBytes);
        const header = JSON.parse(headerJson);
        if (header.magic !== "RUBYDUNG1") throw new Error("Unrecognized save file");

        const expectedW = this.world.width, expectedH = this.world.height, expectedD = this.world.depth;
        if (header.width !== expectedW || header.height !== expectedH || header.depth !== expectedD) {
          throw new Error(`World size mismatch: file ${header.width}×${header.height}×${header.depth} vs engine ${expectedW}×${expectedH}×${expectedD}`);
        }

        const blockData = bytes.subarray(idx + 1);
        const expectedLen = expectedW * expectedH * expectedD;
        if (blockData.length < expectedLen) {
          throw new Error("Save file truncated");
        }

        this.world.blocks = new Uint8Array(blockData.slice(0, expectedLen));

        try { if (this.player) this.player.world = this.world; } catch (e) { console.warn('Failed to resync player.world after load:', e); }

        this.world.exposedTimers = new Float32Array(expectedLen);

        this.world.calcLightDepths(0, 0, this.world.width, this.world.height);
        for (const key of Array.from(this.world.loadedChunkMeshes.keys())) {
          const [cx, cz] = key.split("_").map(Number);
          this.world.unloadChunk(cx, cz, this.scene);
        }
        const px = Math.floor(this.player.x), pz = Math.floor(this.player.z);
        const cx = Math.floor(px / this.world.chunkSizeX), cz = Math.floor(pz / this.world.chunkSizeZ);
        const chunksX = Math.ceil(this.world.width / this.world.chunkSizeX);
        const chunksZ = Math.ceil(this.world.height / this.world.chunkSizeZ);
        for (let dx = -this.renderDistance; dx <= this.renderDistance; dx++) {
          for (let dz = -this.renderDistance; dz <= this.renderDistance; dz++) {
            const rx = cx + dx, rz = cz + dz;
            if (rx >= 0 && rx < chunksX && rz >= 0 && rz < chunksZ) this.world.loadChunk(rx, rz, this.scene);
          }
        }
        console.log("World loaded from file:", header);

        try {
          if (this.player) this.player.resetPosition();
        } catch (e) {
          console.warn('Failed to reset player position after load:', e);
        }

        try {
          const overlayEl = document.getElementById('rd-load-overlay');
          const start = overlayEl && overlayEl._rd_showStart ? overlayEl._rd_showStart : performance.now();
          const elapsed = performance.now() - start;
          const minMs = 3000;
          if (elapsed < minMs) {
            await new Promise((res) => setTimeout(res, Math.ceil(minMs - elapsed)));
          }
        } catch (e) { /* ignore timing errors */ }

        const ov = document.getElementById('rd-load-overlay');
        if (ov) ov.style.display = 'none';

      } catch (err) {
        console.error("Failed to load world:", err);
        try {
          const ov = document.getElementById('rd-load-overlay');
          if (ov) ov.style.display = 'none';
        } catch (e) {}
        alert("Load failed: " + err.message);
      }
    };

    this.openWorldPicker = () => {
      try {
        if (!this._worldFileInput) {
          const fi = document.createElement("input");
          fi.type = "file";
          fi.accept = ".dat,application/octet-stream";
          fi.style.display = "none";
          fi.addEventListener("change", (ev) => {
            const f = ev.target.files && ev.target.files[0];
            if (f) {
              try { this.loadWorldFile(f); } catch (e) { console.error("Load handler failed:", e); alert("Load failed: " + e.message); }
            }
            fi.value = "";
          });
          document.body.appendChild(fi);
          this._worldFileInput = fi;
        }
        this._worldFileInput.click();
      } catch (err) {
        console.warn("Load picker failed:", err);
        alert("Load failed: " + err.message);
      }
    };
  }

  updateBlockTargeting() {
    if (!this.worldInitialized || !this.player) return;
    const cam = this.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    let pos = cam.position.clone();
    let result = null;
    for (let t = 0; t < 4; t += 0.05) {
      const prev = pos.clone();
      pos.add(dir.clone().multiplyScalar(0.05));
      const ox = Math.floor(pos.x), oy = Math.floor(pos.y), oz = Math.floor(pos.z);
      if (this.world.getTile(ox, oy, oz) !== 0) {
        const center = new THREE.Vector3(ox + 0.5, oy + 0.5, oz + 0.5);
        const diff = prev.clone().sub(center);
        const ax = Math.abs(diff.x), ay = Math.abs(diff.y), az = Math.abs(diff.z);
        const face = ay > ax && ay > az ? (diff.y > 0 ? 0 : 1) : (ax > az ? (diff.x > 0 ? 4 : 5) : (diff.z > 0 ? 3 : 2));
        result = { x: ox, y: oy, z: oz, face, blockId: this.world.getTile(ox, oy, oz) };
        break;
      }
    }
    if (result) { this.targetedBlock = result; this.updateHighlightUniforms(this.targetedBlock); }
    else { this.targetedBlock = null; this.updateHighlightUniforms(null); }
  }

  updateHighlightUniforms(info) {
    try {
      if (!this.highlightFaceMesh) {
        const planeGeo = new THREE.PlaneGeometry(1.0, 1.0);
        const planeMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.32,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false
        });
        this.highlightFaceMesh = new THREE.Mesh(planeGeo, planeMat);
        this.highlightFaceMesh.renderOrder = 10001;
        this.highlightFaceMesh.visible = false;
        if (this.scene) this.scene.add(this.highlightFaceMesh);
      }
    } catch (e) {
      console.warn('Could not create highlight face mesh', e);
    }

    this.blockMaterials.forEach((m) => {
      if (!m || !m.uniforms || typeof m.uniforms !== "object") return;

      if (info) {
        if (m.uniforms.uHighlightBlock && m.uniforms.uHighlightBlock.value && typeof m.uniforms.uHighlightBlock.value.set === "function") {
          m.uniforms.uHighlightBlock.value.set(info.x, info.y, info.z);
        }
        if (m.uniforms.uHighlightEnabled && typeof m.uniforms.uHighlightEnabled === "object") {
          m.uniforms.uHighlightEnabled.value = 1;
        }

        if (m.uniforms.uHighlightTol) {
          if (typeof info.blockId === "number" && Tiles.key6 && info.blockId === Tiles.key6.id) {
            m.uniforms.uHighlightTol.value = 0.48;
          } else {
            m.uniforms.uHighlightTol.value = 0.501;
          }
        }

        let forceXFace = false;
        if (typeof info.blockId === "number") {
          const tile = Tiles.byId ? Tiles.byId[info.blockId] : null;
          if (tile && tile.sideTextureKey === "cobble") forceXFace = true;
          else if (Tiles.cobble && info.blockId === Tiles.cobble.id) forceXFace = true;
        }

        if (m.uniforms.uHighlightFace) {
          m.uniforms.uHighlightFace.value = (typeof info.face === "number") ? info.face : 0;
        }
      } else {
        if (m.uniforms.uHighlightEnabled) m.uniforms.uHighlightEnabled.value = 0;
      }
    });

    try {
      if (this.highlightFaceMesh) {
        if (info) {
          const hx = info.x + 0.5;
          const hy = info.y + 0.5;
          const hz = info.z + 0.5;

          this.highlightFaceMesh.visible = true;
          this.highlightFaceMesh.scale.set(0.96, 0.96, 1.0);
          this.highlightFaceMesh.rotation.set(0, 0, 0);

          const face = (typeof info.face === "number") ? info.face : 0;

          switch (face) {
            case 0:
              this.highlightFaceMesh.position.set(hx, info.y + 1 + 0.001, hz);
              this.highlightFaceMesh.rotation.set(-Math.PI / 2, 0, 0);
              break;
            case 1:
              this.highlightFaceMesh.position.set(hx, info.y - 0.001, hz);
              this.highlightFaceMesh.rotation.set(Math.PI / 2, 0, 0);
              break;
            case 2:
              this.highlightFaceMesh.position.set(hx, hy, info.z - 0.001);
              this.highlightFaceMesh.rotation.set(0, Math.PI, 0);
              break;
            case 3:
              this.highlightFaceMesh.position.set(hx, hy, info.z + 1 + 0.001);
              this.highlightFaceMesh.rotation.set(0, 0, 0);
              break;
            case 4:
              this.highlightFaceMesh.position.set(info.x + 1 + 0.001, hy, hz);
              this.highlightFaceMesh.rotation.set(0, -Math.PI / 2, 0);
              break;
            case 5:
              this.highlightFaceMesh.position.set(info.x - 0.001, hy, hz);
              this.highlightFaceMesh.rotation.set(0, Math.PI / 2, 0);
              break;
            default:
              this.highlightFaceMesh.position.set(hx, hy, hz);
              this.highlightFaceMesh.rotation.set(0, 0, 0);
              break;
          }
        } else {
          this.highlightFaceMesh.visible = false;
        }
      }
    } catch (e) {
      console.warn('updateHighlightUniforms: highlightFaceMesh update failed', e);
    }
  }

  onMouseDown(e) {
    if (!this.targetedBlock || !document.pointerLockElement) return;

    const leftIsBreak = !this.invertMouseButtons;
    if (e.button === 0) {
      if (leftIsBreak) this.breakBlock(); else this.placeBlock();
    } else if (e.button === 2) {
      if (leftIsBreak) this.placeBlock(); else this.breakBlock();
    }
  }

  breakBlock() {
    if (!this.targetedBlock) return;
    const { x, y, z } = this.targetedBlock;

    if (typeof y === "number" && y === 0) {
      console.log("Cannot break bottom rock layer (y=0)");
      return;
    }

    const id = this.world.getTile(x, y, z);
    if (id !== 0) {
      this.world.setTile(x, y, z, 0);
      try {
        if (this.particleEngine) {
          this.particleEngine.spawnAt(x, y, z, id, 12);
        }
      } catch (err) { console.warn("Particle spawn failed:", err); }

      this.updateChunksAroundBlock(x, y, z);

      try {
        if (this.world) {
          const checks = [
            { x: x, y: y - 1, z: z },
            { x: x, y: y, z: z },
            { x: x - 1, y: y - 1, z: z },
            { x: x + 1, y: y - 1, z: z },
            { x: x, y: y - 1, z: z - 1 },
            { x: x, y: y - 1, z: z + 1 }
          ];
          const DIRT_ID = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
          for (const c of checks) {
            if (c.y >= 0 && c.y < this.world.depth) {
              try {
                const id = this.world.getTile(c.x, c.y, c.z);
                if (id === DIRT_ID) {
                  let blockedAbove = false;
                  for (let ay = c.y + 1; ay < this.world.depth; ay++) {
                    if (this.world.getTile(c.x, ay, c.z) !== 0) { blockedAbove = true; break; }
                  }
                  if (!blockedAbove) {
                    const idx = c.x + c.y * this.world.width + c.z * (this.world.width * this.world.depth);
                    this.world.exposedTimers[idx] = FIXED_DT;
                    this.updateChunksAroundBlock(c.x, c.y, c.z);
                  }
                }
              } catch (e) {
                console.warn("Exposure candidate check failed for", c, e);
              }
            }
          }
        }
      } catch (err) { console.warn("Exposure check failed:", err); }

      console.log(`Broke ${this.getBlockTypeName(id)} block at ${x}, ${y}, ${z}`);
    }
  }

  placeBlock() {
    if (!this.targetedBlock) return;
    const { x, y, z, face } = this.targetedBlock;
    let nx = x, ny = y, nz = z;
    switch (face) {
      case 0: ny = y + 1; break;
      case 1: ny = y - 1; break;
      case 2: nz = z - 1; break;
      case 3: nz = z + 1; break;
      case 4: nx = x + 1; break;
      case 5: nx = x - 1; break;
    }
    if (nx < 0 || nx >= this.world.width || ny < 0 || ny >= this.world.depth || nz < 0 || nz >= this.world.height) {
      console.log("Cannot place block: out of bounds"); return;
    }

    const id = this.selectedBlockId || (Tiles.stone ? Tiles.stone.id : 2);

    if (id === (Tiles.key6 ? Tiles.key6.id : 7)) {
      if (this.world.getTile(nx, ny, nz) === 0) {
        this.world.setTile(nx, ny, nz, id);
        this.updateChunksAroundBlock(nx, ny, nz);
        console.log(`Placed key6 block at ${nx}, ${ny}, ${nz}`);
      } else {
        console.log("Cannot place key6: center position occupied");
      }
      return;
    }

    if (this.world.getTile(nx, ny, nz) !== 0) { console.log("Cannot place block: position occupied"); return; }
    this.world.setTile(nx, ny, nz, id);

    try {
      if (this.world && typeof this.world.calcLightDepths === 'function') {
        this.world.calcLightDepths(Math.max(0, nx), Math.max(0, nz), 1, 1);
      }
    } catch (e) {
      console.warn('calcLightDepths update after place failed:', e);
    }

    this.updateChunksAroundBlock(nx, ny, nz);

    try {
      if (this.world) {
        const belowY = ny - 1;
        const GRASS_ID = (Tiles.grass_top && Tiles.grass_top.id) ? Tiles.grass_top.id : 1;
        const DIRT_ID = (Tiles.dirt && Tiles.dirt.id) ? Tiles.dirt.id : 3;
        if (belowY >= 0) {
          const belowIdNow = this.world.getTile(nx, belowY, nz);
          if (belowIdNow === GRASS_ID) {
            const key = `${nx}_${belowY}_${nz}`;
            const ticks = 80 + Math.floor(Math.random() * 30);
            this._pendingGrassTimers.set(key, ticks);
            this.updateChunksAroundBlock(nx, belowY, nz);
          }

          const changed = this.world.checkExposureAt(nx, belowY, nz);
          if (changed) this.updateChunksAroundBlock(nx, belowY, nz);
        }

        const neighbors = [
          { x: nx - 1, y: ny - 1, z: nz },
          { x: nx + 1, y: ny - 1, z: nz },
          { x: nx, y: ny - 1, z: nz - 1 },
          { x: nx, y: ny - 1, z: nz + 1 }
        ];
        for (const n of neighbors) {
          if (n.y >= 0 && n.y < this.world.depth) {
            const ch = this.world.checkExposureAt(n.x, n.y, n.z);
            if (ch) this.updateChunksAroundBlock(n.x, n.y, n.z);
          }
        }
      }
    } catch (err) { console.warn("Exposure check failed:", err); }

    console.log(`Placed ${this.getBlockTypeName(id)} block at ${nx}, ${ny}, ${nz} on face ${face}`);
  }

  getBlockTypeName(id) {
    switch (id) {
      case 0: return "air";
      case 1: return "stone";
      case 2: return "grass";
      case 3: return "dirt";
      case 5: return "wood";
      case 6: return "cobble";
      case 7: return "key6";
      default:
        if (id === (Tiles.stone ? Tiles.stone.id : 2)) return (this.selectedBlockKey === "cobble") ? "cobble" : "stone";
        if (Tiles.calmLava && id === Tiles.calmLava.id) return "lava";
        if (Tiles.lava && id === Tiles.lava.id) return "lava";
        return "unknown";
    }
  }

  updateChunksAroundBlock(x, y, z) {
    const cx = Math.floor(x / this.world.chunkSizeX);
    const cz = Math.floor(z / this.world.chunkSizeZ);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const ix = cx + dx, iz = cz + dz, key = `${ix}_${iz}`;
      if (this.world.loadedChunkMeshes.has(key)) { this.world.unloadChunk(ix, iz, this.scene); this.world.loadChunk(ix, iz, this.scene); }
    }

    this.world.calcLightDepths(Math.max(0, x - 1), Math.max(0, z - 1), 3, 3);
  }



  convertGrassIfUnlit(x, y, z) {
    try {
      if (!this.world) return false;
      const GRASS_ID = (typeof Tiles !== "undefined" && Tiles.grass_top) ? Tiles.grass_top.id : 1;
      const DIRT_ID  = (typeof Tiles !== "undefined" && Tiles.dirt) ? Tiles.dirt.id : 3;
      if (x < 0 || x >= this.world.width || y < 0 || y >= this.world.depth || z < 0 || z >= this.world.height) return false;
      const id = this.world.getTile(x, y, z);
      if (id !== GRASS_ID) return false;
      const maxCheck = 10;
      let covered = false;
      for (let oy = y + 1; oy <= Math.min(this.world.depth - 1, y + maxCheck); oy++) {
        const aboveId = this.world.getTile(x, oy, z);
        if (aboveId !== 0) { covered = true; break; }
      }

      if (covered) {
        this.world.setTile(x, y, z, DIRT_ID);
        const idx = x + y * this.world.width + z * (this.world.width * this.world.depth);
        if (this.world.exposedTimers && this.world.exposedTimers.length > idx) this.world.exposedTimers[idx] = 0;
        this.updateChunksAroundBlock(x, y, z);
        return true;
      }

      return false;
    } catch (e) {
      console.warn('convertGrassIfUnlit failed', e);
      return false;
    }
  }

  onWindowResize() {
    const useFullWindowCanvas = !!window.__FS_FULLSIZE;
    if (useFullWindowCanvas) {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      const canvasEl = this.renderer.domElement;
      if (canvasEl) {
        canvasEl.style.width = '100%';
        canvasEl.style.height = '100%';
      }
    } else {
      this.camera.aspect = 640 / 480;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(640, 480);
    }
  }

  startFPSTimer() {
    const overlay = document.getElementById('versionFps');
    const VERSION = 'O.O.13a';
    const setOverlayLines = (line1, line2) => {
      try {
        if (!overlay) return;
        overlay.innerHTML = `
          <div style="position:relative; line-height:1; font-size:14px; font-weight:400; white-space:nowrap;">
            <div style="position:relative; color:#ffffff; pointer-events:none; font-family:inherit; white-space:nowrap; text-shadow: 2px 2px 0 rgba(0,0,0,0.80);">
              ${line1}
            </div>
          </div>
          <div style="position:relative; line-height:1; font-size:14px; font-weight:400; white-space:nowrap; margin-top:0px;">
            <div style="position:relative; color:#ffffff; pointer-events:none; font-family:inherit; white-space:nowrap; text-shadow: 2px 2px 0 rgba(0,0,0,0.80);">
              ${line2}
            </div>
          </div>
        `;
      } catch (e) { }
    };

    (async () => {
      try {
        const font = new FontFace('GameFace', `url('https://cdn.jsdelivr.net/gh/CaveGameDev/classicJS@refs/heads/main/a.ttf')`);
        await font.load();
        document.fonts.add(font);
        if (overlay) overlay.style.fontFamily = 'GameFace, monospace';
      } catch (e) {
        console.warn('GameFace font load failed:', e);
        if (overlay) overlay.style.fontFamily = 'monospace';
      }
    })();

    setOverlayLines(VERSION, 'initializing...');

    const INTERVAL_SECONDS = 5;
    setInterval(() => {
      try {
        const frames = this.frameCount || 0;
        const fps = Math.max(0, Math.round(frames / INTERVAL_SECONDS));
        const updates = this.currentLoadedChunkCount || 0;
        // nudged text-shadow slightly left in CSS template used by setOverlayLines innerHTML
        setOverlayLines(VERSION, `${fps} fps · ${updates} chunk updates`);
        this.frameCount = 0;
      } catch (e) {
        console.warn('FPS overlay update failed', e);
      }
    }, INTERVAL_SECONDS * 1000);
  }

  /* Check if a specific chunk contains any water blocks */
  chunkContainsWater(cx, cz, waterIds) {
    if (!this.world || !this.world.blocks || waterIds.size === 0) return false;
    
    const startX = cx * this.world.chunkSizeX;
    const startZ = cz * this.world.chunkSizeZ;
    const endX = Math.min(startX + this.world.chunkSizeX, this.world.width);
    const endZ = Math.min(startZ + this.world.chunkSizeZ, this.world.height);
    
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        for (let y = 0; y < this.world.depth; y++) {
          const idx = x + y * this.world.width + z * (this.world.width * this.world.depth);
          if (waterIds.has(this.world.blocks[idx])) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /* updateWaterChunkCulling — no-op stub kept for call-site compatibility.
     Water chunks now have frustumCulled=false set permanently at loadChunk() time, so
     no per-frame distance check is needed. Non-water chunks are handled by Three.js
     default frustum culling (frustumCulled=true, set at loadChunk). The old distance-
     radius approach caused water to "fall apart" when looking from an angle because
     Three.js frustum-culls by bounding sphere, which exits the frustum even when water
     quads are clearly visible. Always rendering water chunks is negligible perf cost.
  */
  updateWaterChunkCulling() {
    // intentionally empty — frustumCulled is set correctly at loadChunk time
  }

  animate() {
    const now = performance.now();

    try {
      if (!this._lastDebugLog) this._lastDebugLog = 0;
      if (now - this._lastDebugLog >= 1000) {
        this._lastDebugLog = now;
        if (this.player) {
          try {
            console.log(`DEBUG XYZ: x=${this.player.x.toFixed(3)} y=${this.player.y.toFixed(3)} z=${this.player.z.toFixed(3)}`);
          } catch (e) {
            console.log('DEBUG XYZ: player position unavailable', e);
          }
        } else {
          console.log('DEBUG XYZ: player not initialized');
        }
      }
    } catch (e) {
      console.warn('Debug XYZ logging failed', e);
    }
    try { if (this._skyMesh && this.camera && this.camera.position) this._skyMesh.position.copy(this.camera.position); } catch (e) { }
    this.frameCount++;

    let frameDelta = Math.max(0, (now - (this.lastTime || now)) / 1000);
    const MAX_STEP = 0.25;
    if (frameDelta > MAX_STEP) frameDelta = MAX_STEP;

    if (frameDelta > 0) {
      const instantFps = 1 / frameDelta;
      this.fpsSmoothed = (typeof this.fpsSmoothed === "number") ? (this.fpsSmoothed * 0.9 + instantFps * 0.1) : instantFps;
    }

    this.lowPerfUpdateCounter++;
    if (this.lowPerfUpdateCounter >= 30) {
      this.lowPerfUpdateCounter = 0;
      if (this.player) this.player.updateLowPerfStatus(this.fpsSmoothed);
    }

    this.accumulator += frameDelta;
    while (this.accumulator >= FIXED_DT) {
      if (this.player) {
        try { this.player.tick(FIXED_DT); } catch (err) { console.warn("Player tick error:", err); }
      }

      for (let i = this.zombies.length - 1; i >= 0; i--) {
        const zombie = this.zombies[i];
        try {
          zombie.tick(FIXED_DT);
          if (zombie.removed) {
            zombie.dispose();
            this.zombies.splice(i, 1);
          }
        } catch (err) { console.warn("Zombie tick error:", err); }
      }

      if (this._pendingGrassTimers && this._pendingGrassTimers.size > 0) {
        for (const [key, ticks] of Array.from(this._pendingGrassTimers.entries())) {
          const remaining = ticks - 1;
          if (remaining <= 0) {
            this._pendingGrassTimers.delete(key);
            const parts = key.split('_').map(Number);
            if (parts.length === 3) {
              try {
                const [gx, gy, gz] = parts;
                const converted = this.convertGrassIfUnlit(gx, gy, gz);
                if (converted) this.updateChunksAroundBlock(gx, gy, gz);
              } catch (e) {
                console.warn('Pending grass convert failed for', key, e);
              }
            }
          } else {
            this._pendingGrassTimers.set(key, remaining);
          }
        }
      }

      if (this.world && typeof this.world.processExposure === "function") {
        try {
          const changed = this.world.processExposure(FIXED_DT);
          for (const c of changed) this.updateChunksAroundBlock(c.x, c.y, c.z);
        } catch (err) { console.warn("Exposure processing failed:", err); }
      }



      this.accumulator -= FIXED_DT;
    }

    if (this.player) {
      this.updateBlockTargeting();
      this.blockMaterials.forEach((m) => {
        if (!m || !m.uniforms) return;
        if (m.uniforms.uCameraPosition && m.uniforms.uCameraPosition.value && typeof m.uniforms.uCameraPosition.value.copy === 'function') {
          m.uniforms.uCameraPosition.value.copy(this.camera.position);
        }
        const isWaterMat = (this.materialIndexMap && typeof this.materialIndexMap['water'] !== 'undefined' && m === this.blockMaterials[this.materialIndexMap['water']]);
        const isLavaMat  = (this.materialIndexMap && typeof this.materialIndexMap['lava'] !== 'undefined' && m === this.blockMaterials[this.materialIndexMap['lava']]);
        if (m.uniforms.uTime && !isWaterMat && !isLavaMat) m.uniforms.uTime.value = now / 1000;
      });

      // Lava material's uTime is driven on its own slower cadence (handled inside its shader via
      // the same uTime uniform, but updated every frame regardless of the isWaterMat/isLavaMat
      // skip above) so its glow animates independently of other materials' uTime usage.
      if (this._lavaMaterial && this._lavaMaterial.uniforms && this._lavaMaterial.uniforms.uTime) {
        this._lavaMaterial.uniforms.uTime.value = now / 1000;
      }

      if (this.worldInitialized) {
        const px = Math.floor(this.player.x), pz = Math.floor(this.player.z);
        const cx = Math.floor(px / this.world.chunkSizeX), cz = Math.floor(pz / this.world.chunkSizeZ);
        const needed = new Set();
        const chunksX = Math.ceil(this.world.width / this.world.chunkSizeX);
        const chunksZ = Math.ceil(this.world.height / this.world.chunkSizeZ);
        for (let dx = -this.renderDistance; dx <= this.renderDistance; dx++)
          for (let dz = -this.renderDistance; dz <= this.renderDistance; dz++) {
            const rx = cx + dx, rz = cz + dz;
            if (rx >= 0 && rx < chunksX && rz >= 0 && rz < chunksZ) needed.add(`${rx}_${rz}`);
          }
        for (const key of Array.from(this.world.loadedChunkMeshes.keys())) if (!needed.has(key)) {
          const [ex, ez] = key.split("_").map(Number); 
          this.world.unloadChunk(ex, ez, this.scene);
          // Clear water cache entry when chunk is unloaded
          this._waterChunkCache.delete(key);
        }
        for (const key of needed) if (!this.world.loadedChunkMeshes.has(key)) {
          const [ex, ez] = key.split("_").map(Number); 
          this.world.loadChunk(ex, ez, this.scene);
        }
        this.currentLoadedChunkCount = this.world.loadedChunkMeshes.size;
        
        // Update distance-aware water culling every frame
        this.updateWaterChunkCulling();
      }
    }

    if (this.particleEngine) {
      try { this.particleEngine.tick(frameDelta); } catch (err) { console.warn("Particle tick error:", err); }
    }

    if (this.worldInitialized) {
      const revealTotal = Math.min(2000, this.worldRevealDuration || 2000);
      const STUTTER_STEPS = 6;
      let revealFlag = 0, specialFinished = 1, maxVisibleY = this.world.depth, layerProgress = 1;
      if (this.worldRevealStartTime > 0) {
        const elapsed = now - this.worldRevealStartTime;
        if (elapsed < revealTotal) {
          revealFlag = 1; specialFinished = 0;
          const t = elapsed / revealTotal;
          maxVisibleY = Math.min(this.world.depth, Math.floor(t * this.world.depth));
          let frac = (t * this.world.depth) - maxVisibleY;
          frac = Math.max(0, Math.min(1, frac));
          layerProgress = Math.floor(frac * STUTTER_STEPS) / Math.max(1, STUTTER_STEPS);
        } else {
          this.worldRevealStartTime = 0;
          revealFlag = 0; specialFinished = 1;
          maxVisibleY = this.world.depth; layerProgress = 1;
        }
      }
      this.blockMaterials.forEach((m) => {
        if (!m || !m.uniforms) return;
        if (m.uniforms.uMaxVisibleY) m.uniforms.uMaxVisibleY.value = maxVisibleY;
        if (m.uniforms.uCurrentLayerXProgress) m.uniforms.uCurrentLayerXProgress.value = layerProgress;
        if (m.uniforms.uWorldWidth) m.uniforms.uWorldWidth.value = this.world.width;
        if (m.uniforms.uIsWorldRevealing) m.uniforms.uIsWorldRevealing.value = revealFlag;
        if (m.uniforms.uSpecialRevealFinished) m.uniforms.uSpecialRevealFinished.value = specialFinished;
      });
    }

    const renderAlpha = this.accumulator / FIXED_DT;
    const renderTime = now / 1000;
    for (const zombie of this.zombies) {
      try { zombie.render(renderAlpha, renderTime); } catch (err) { console.warn("Zombie render error:", err); }
    }

    try {
      if (this.highlightFaceMesh && this.highlightFaceMesh.visible && this.highlightFaceMesh.material && this.highlightFaceMesh.material.transparent) {
        const base = 0.32;
        const amp = 0.12;
        this.highlightFaceMesh.material.opacity = base + Math.sin(now * 0.0072) * amp;
        this.highlightFaceMesh.scale.set(1.0, 1.0, 1.0);
        this.highlightFaceMesh.material.needsUpdate = true;
      }
    } catch (e) {}

    // --- Underwater tint: if player's feet are inside water, tint the screen with #3F76E4 ---
    try {
      let inWater = false;
      if (this.player && this.world) {
        const footY = Math.floor(this.player.y - 1.62);
        const bx = Math.floor(this.player.x), bz = Math.floor(this.player.z);
        const WATER_ID = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
        const CALM_WATER_ID = (typeof Tiles !== "undefined" && Tiles.calmWater) ? Tiles.calmWater.id : null;
        if (WATER_ID !== null || CALM_WATER_ID !== null) {
          const id = this.world.getTile(bx, footY, bz);
          inWater = (WATER_ID !== null && id === WATER_ID) || (CALM_WATER_ID !== null && id === CALM_WATER_ID);
        }
      }

      if (inWater && !this._isUnderwaterTintActive) {
        // activate tint
        this.renderer.setClearColor(new THREE.Color(0x3F76E4));
        this._isUnderwaterTintActive = true;
      } else if (!inWater && this._isUnderwaterTintActive) {
        // restore previous clear color
        if (this._savedClearColor) this.renderer.setClearColor(this._savedClearColor);
        this._isUnderwaterTintActive = false;
      }
    } catch (e) {
      // non-fatal - don't interrupt rendering
      console.warn('Underwater tint check failed', e);
    }

    this.renderer.render(this.scene, this.camera);
    this.lastTime = now;
  }
}

/* instantiate globally so existing code and UI wiring continue to use window.rubyDung */
window.var1 = new RubyDung();
window.rubyDung = window.var1;

export { RubyDung, LevelGen, Synth, ImprovedNoise, PerlinNoise, Distort, JavaRandom };