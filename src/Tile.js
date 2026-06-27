class Tile {
  // added optional preventsCulling flag (when true, this tile prevents culling of faces of blocks it touches)
  constructor(id, sideKey, topKey, bottomKey, preventsCulling = false, isLiquid = false, isPartialHeight = false) {
    this.id = id;
    this.sideTextureKey = sideKey;
    this.topTextureKey = topKey;
    this.bottomTextureKey = bottomKey;
    this.preventsCulling = preventsCulling;
    this.isLiquid = isLiquid;
    this.isPartialHeight = isPartialHeight; // For calm water/lava - renders slightly lower
  }
  getTextureKey(face) {
    switch (face) {
      case 0: return this.topTextureKey;
      case 1: return this.bottomTextureKey;
      default: return this.sideTextureKey;
    }
  }
}

export const Tiles = {
  // IDs assigned sequentially; texture keys are descriptive names matching atlas tiles
  grass_top: new Tile(1, "grass_side", "grass_top", "dirt"),
  stone:     new Tile(2, "stone",     "stone",     "stone"),
  dirt:      new Tile(3, "dirt",      "dirt",      "dirt"),
  grass_side:new Tile(4, "grass_side","grass_top", "dirt"),
  wood:      new Tile(5, "wood",      "wood",      "wood"),
  cobble:    new Tile(6, "cobble",    "cobble",    "cobble", true),
  key6:      new Tile(7, "key6",      "key6",      "key6", true),
  
  // Water variants
  // Calm water - partial height (like the border planes), uses "water" texture
  calmWater: new Tile(8, "water", "water", "water", false, true, true),
  // Flowing water - full block height
  water:     new Tile(9, "water", "water", "water", false, true, false),
  
  // Lava variants (for consistency, since your code referenced calmLava)
  calmLava:  new Tile(10, "calmLava", "calmLava", "calmLava", false, true, true),
  lava:      new Tile(11, "lava", "lava", "lava", false, true, false),
  
  byId: {},
  init() {
    for (const v of Object.values(this)) if (v instanceof Tile) this.byId[v.id] = v;
  }
};
Tiles.init();

// compatibility aliases
Tiles.rock = Tiles.stone;
Tiles.grass = Tiles.grass_top;