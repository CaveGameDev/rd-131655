import { Tiles } from "/Tile.js";

/**
 * WaterManager - lightweight liquid simulation for the engine.
 *
 * Behavior:
 * - Recognizes a configured Tiles.water.id; if none present, becomes a no-op.
 * - Keeps two internal sets: flowing (checks and spreads each tick) and calm (idle until touched).
 * - initializeFromWorld() scans the world and classifies water blocks as flowing if they have air below or to any side.
 * - tick() advances the simulation: flowing water attempts to fall (prefer down) else spreads to a single horizontal neighbor per tick.
 * - When water spreads into an air cell it becomes flowing; when a flowing cell can no longer spread it becomes calm.
 *
 * This module exports a default WaterManager class.
 */
export default class WaterManager {
  constructor(world = null) {
    this.world = world;
    // sets of "x_y_z" strings
    this.flowing = new Set();
    this.calm = new Set();
    // basic per-tick cap to avoid pathological spreads (lowered to reduce tick spikes)
    this._maxSpreadsPerTick = 1024;
  }

  setWorld(world) {
    this.world = world;
    this.initializeFromWorld();
  }

  initializeFromWorld() {
    // reset state
    this.flowing.clear();
    this.calm.clear();

    if (!this.world) return;

    // determine water id
    const waterId = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
    if (waterId == null) return;

    const w = this.world.width, h = this.world.height, d = this.world.depth;
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < h; z++) {
        for (let y = 0; y < d; y++) {
          const id = this.world.getTile(x, y, z);
          if (id === waterId) {
            const key = this._key(x, y, z);
            if (this._shouldBeFlowing(x, y, z)) this.flowing.add(key);
            else this.calm.add(key);
          }
        }
      }
    }
  }

  // tiny helper
  _key(x, y, z) { return `${x}_${y}_${z}`; }
  _parseKey(key) { const p = key.split('_').map(Number); return { x: p[0], y: p[1], z: p[2] }; }

  _isAir(x, y, z) {
    if (!this.world) return false;
    return this.world.getTile(x, y, z) === 0;
  }

  _shouldBeFlowing(x, y, z) {
    // Flowing only if anything below is air or any horizontal neighbor at the same Y is air.
    // Explicitly forbid upward checks so water never "flows" into y+1.
    if (y - 1 >= 0 && this._isAir(x, y - 1, z)) return true;
    const sides = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const s of sides) {
      const nx = x + s[0], nz = z + s[1];
      // Allow neighbor checks across chunk boundaries; world.getTile/_isAir will handle out-of-range safely.
      if (this._isAir(nx, y, nz)) return true;
    }
    return false;
  }

  initializePos(x, y, z) {
    if (!this.world) return;
    const waterId = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
    if (waterId == null) return;

    const id = this.world.getTile(x, y, z);
    const key = this._key(x, y, z);
    this.flowing.delete(key);
    this.calm.delete(key);
    if (id === waterId) {
      if (this._shouldBeFlowing(x, y, z)) this.flowing.add(key);
      else this.calm.add(key);
    }
  }

  // Public: called by engine each liquid tick
  tick() {
    if (!this.world) return;
    const waterId = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
    if (waterId == null) return;

    // gather current flowing positions (shallow copy)
    const flowingNow = Array.from(this.flowing);
    if (flowingNow.length === 0) return;

    // bound the number of spreads processed this tick
    let spreadsProcessed = 0;
    const newFlowing = new Set();
    const toCalm = [];

    for (const key of flowingNow) {
      if (spreadsProcessed > this._maxSpreadsPerTick) break;
      const { x, y, z } = this._parseKey(key);

      // If the block is no longer water, remove from flowing state
      if (this.world.getTile(x, y, z) !== waterId) {
        this.flowing.delete(key);
        continue;
      }

      // 1) Prefer to fall down (gravity). NEVER try to create water above (y+1).
      if (y - 1 >= 0 && this._isAir(x, y - 1, z)) {
        // move water down one block
        this.world.setTile(x, y - 1, z, waterId);
        this.world.setTile(x, y, z, 0);
        const downKey = this._key(x, y - 1, z);
        newFlowing.add(downKey);
        this._touchNeighbors(x, y - 1, z);
        spreadsProcessed++;
        this.flowing.delete(key);
        continue;
      }

      // 2) Otherwise attempt a single horizontal spread (same Y). Do NOT attempt upward spreads.
      // Check neighbors in deterministic order but allow crossing chunk boundaries; world getters/setters handle OOB.
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      let spreadDone = false;
      for (const s of dirs) {
        if (spreadsProcessed > this._maxSpreadsPerTick) break;
        const nx = x + s[0], nz = z + s[1], ny = y; // explicit same-level spread
        // Only spread into air at the same Y level; rely on _isAir to safely handle out-of-range coords.
        if (this._isAir(nx, ny, nz)) {
          this.world.setTile(nx, ny, nz, waterId);
          const nk = this._key(nx, ny, nz);
          newFlowing.add(nk);
          this._touchNeighbors(nx, ny, nz);
          spreadsProcessed++;
          spreadDone = true;
          break; // only one lateral spread per source this tick
        }
      }

      if (!spreadDone) {
        // No downward nor lateral progress -> mark calm
        toCalm.push(key);
        this.flowing.delete(key);
      }
    }

    // Add newly flowing blocks and ensure they aren't calm
    for (const k of newFlowing) {
      this.flowing.add(k);
      this.calm.delete(k);
    }

    // Move those marked to calm set
    for (const k of toCalm) {
      // only calm if still water
      const { x, y, z } = this._parseKey(k);
      if (this.world.getTile(x, y, z) === waterId) {
        // re-evaluate; it might still be flowing next tick if something changes
        if (this._shouldBeFlowing(x, y, z)) {
          this.flowing.add(k);
        } else {
          this.calm.add(k);
        }
      }
    }
  }

  // Called when a nearby block changed so water can re-awaken calm cells
  onBlockUpdated(x, y, z) {
    // check neighbors for calm water that should become flowing
    const candidates = [
      [x, y, z],
      [x+1, y, z],[x-1,y,z],[x,y,z+1],[x,y,z-1],
      [x, y+1, z], [x, y-1, z]
    ];
    for (const c of candidates) {
      const cx = c[0], cy = c[1], cz = c[2];
      if (cx < 0 || cy < 0 || cz < 0) continue;
      if (!this.world) continue;
      const waterId = (typeof Tiles !== "undefined" && Tiles.water) ? Tiles.water.id : null;
      if (waterId == null) return;
      if (cx >= this.world.width || cz >= this.world.height || cy >= this.world.depth) continue;
      if (this.world.getTile(cx, cy, cz) === waterId) {
        const k = this._key(cx, cy, cz);
        if (this._shouldBeFlowing(cx, cy, cz)) {
          this.calm.delete(k);
          this.flowing.add(k);
        }
      }
    }
  }

  // mark neighbor positions so next tick re-eval occurs (used internally)
  _touchNeighbors(x, y, z) {
    // Notify world/world-chunk updater so meshes can refresh.
    // A single water block change can affect brightness for every block beneath it in the same column,
    // so updateChunksAroundBlock must be invoked for the full column (all Y levels) for each neighbor cell.
    try {
      if (this.world && typeof this.world.updateChunksAroundBlock === "function") {
        // Expand to the 3x3 neighborhood in X/Z, and for each, refresh every Y in the world depth.
        const depth = (typeof this.world.depth === "number") ? this.world.depth : 0;
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const nx = x + ox;
            const nz = z + oz;
            for (let yy = 0; yy < depth; yy++) {
              try {
                this.world.updateChunksAroundBlock(nx, yy, nz);
              } catch (inner) {
                // ignore per-call failures but continue updating others
              }
            }
          }
        }
      }
    } catch (e) {
      // non-fatal
    }
  }
}