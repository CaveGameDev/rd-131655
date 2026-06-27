import * as THREE from "three";

/**
 * Represents a single cube part of a mob model.
 * Maps UV coordinates from char.png (64x64 texture atlas) to a box mesh.
 */
export class Cube {
  constructor(u, v) {
    this.u = u;
    this.v = v;
  }
  
  /**
   * Creates a BoxGeometry with proper UV mapping from the texture atlas.
   * 
   * Texture layout (char.png - 64x64):
   * - (0,0) to (64,64) contains all mob textures
   * - Head: u=0, v=0 (8x8 pixels at top-left)
   * - Body: u=16, v=16 (8x12 pixels)
   * - Arms: u=40, v=16 (4x12 pixels each)
   * - Legs: u=0, v=16 (4x12 pixels each)
   */
  createGeometry(w, h, d) {
    // Scale to world units (1 pixel = 1/16 block, scaled by 0.0625)
    const geometry = new THREE.BoxGeometry(w * 0.0625, h * 0.0625, d * 0.0625);
    
    // UV scale factors (texture is 64x64)
    const uScale = 1.0 / 64;
    const vScale = 1.0 / 64;
    
    // Get UV attribute
    const uvAttr = geometry.getAttribute('uv');
    
    // BoxGeometry face order: right(+X), left(-X), top(+Y), bottom(-Y), front(+Z), back(-Z)
    // Each face needs UV coordinates from the texture atlas
    
    // Right face (+X) - uses depth x height area
    this._setFaceUV(uvAttr, 0, this.u + d, this.v + d, d, h, uScale, vScale);
    
    // Left face (-X) - mirrored horizontally
    this._setFaceUV(uvAttr, 1, this.u + d + d + w, this.v + d, d, h, uScale, vScale);
    
    // Top face (+Y) - uses width x depth area
    this._setFaceUV(uvAttr, 2, this.u + d, this.v, w, d, uScale, vScale);
    
    // Bottom face (-Y)
    this._setFaceUV(uvAttr, 3, this.u + d + w, this.v, w, d, uScale, vScale);
    
    // Front face (+Z) - main face, uses width x height area
    this._setFaceUV(uvAttr, 4, this.u + d, this.v + d, w, h, uScale, vScale);
    
    // Back face (-Z) - mirrored horizontally
    this._setFaceUV(uvAttr, 5, this.u + d + w, this.v + d, w, h, uScale, vScale);
    
    uvAttr.needsUpdate = true;
    
    return geometry;
  }
  
  _setFaceUV(uvAttr, faceIndex, u, v, w, h, uScale, vScale) {
    const vertexIndex = faceIndex * 4;
    
    // Calculate UV coordinates
    const u0 = u * uScale;
    const u1 = (u + w) * uScale;
    const v0 = v * vScale;
    const v1 = (v + h) * vScale;
    
    // Set UVs for the 4 vertices of this face
    // BoxGeometry vertex order per face: bottom-left, top-left, top-right, bottom-right
    uvAttr.setXY(vertexIndex + 0, u0, v1); // bottom-left
    uvAttr.setXY(vertexIndex + 1, u0, v0); // top-left
    uvAttr.setXY(vertexIndex + 2, u1, v0); // top-right
    uvAttr.setXY(vertexIndex + 3, u1, v1); // bottom-right
  }
}