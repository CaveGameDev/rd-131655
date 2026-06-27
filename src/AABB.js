export class AABB {
  constructor(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }
  expand(x, y, z) {
    let s = this.minX, n = this.minY, o = this.minZ, a = this.maxX, r = this.maxY, h = this.maxZ;
    if (x < 0) s += x; else a += x;
    if (y < 0) n += y; else r += y;
    if (z < 0) o += z; else h += z;
    return new AABB(s, n, o, a, r, h);
  }
  move(x, y, z) {
    this.minX += x; this.minY += y; this.minZ += z;
    this.maxX += x; this.maxY += y; this.maxZ += z;
  }
  clipXCollide(other, dx) {
    if (other.maxY <= this.minY || other.minY >= this.maxY || other.maxZ <= this.minZ || other.minZ >= this.maxZ) return dx;
    if (dx > 0 && other.maxX <= this.minX) {
      const i = this.minX - other.maxX;
      if (i < dx) dx = i;
    }
    if (dx < 0 && other.minX >= this.maxX) {
      const i = this.maxX - other.minX;
      if (i > dx) dx = i;
    }
    return dx;
  }
  clipYCollide(other, dy) {
    if (other.maxX <= this.minX || other.minX >= this.maxX || other.maxZ <= this.minZ || other.minZ >= this.maxZ) return dy;
    if (dy > 0 && other.maxY <= this.minY) {
      const i = this.minY - other.maxY;
      if (i < dy) dy = i;
    }
    if (dy < 0 && other.minY >= this.maxY) {
      const i = this.maxY - other.minY;
      if (i > dy) dy = i;
    }
    return dy;
  }
  clipZCollide(other, dz) {
    if (other.maxX <= this.minX || other.minX >= this.maxX || other.maxY <= this.minY || other.minY >= this.maxY) return dz;
    if (dz > 0 && other.maxZ <= this.minZ) {
      const i = this.minZ - other.maxZ;
      if (i < dz) dz = i;
    }
    if (dz < 0 && other.minZ >= this.maxZ) {
      const i = this.maxZ - other.minZ;
      if (i > dz) dz = i;
    }
    return dz;
  }
  intersects(other) {
    return other.maxX > this.minX && other.minX < this.maxX &&
           other.maxY > this.minY && other.minY < this.maxY &&
           other.maxZ > this.minZ && other.minZ < this.maxZ;
  }
}