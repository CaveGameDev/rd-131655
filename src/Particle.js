import * as THREE from "three";
import { AABB } from "/AABB.js";

const FIXED_TIMESTEP = 1.0 / 60.0;

const PARTICLE_VERTEX_SHADER = `
  attribute float isSunlit;
  attribute float isSideBoundaryFace;
  attribute float isBottomBoundaryFace;
  attribute float faceId;
  
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying float vIsSunlit;
  varying float vIsSideBoundaryFace;
  varying float vIsBottomBoundaryFace;
  varying float vFaceId;
  
  void main() {
    vUv = uv;
    vColor = color;
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vIsSunlit = isSunlit;
    vIsSideBoundaryFace = isSideBoundaryFace;
    vIsBottomBoundaryFace = isBottomBoundaryFace;
    vFaceId = faceId;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PARTICLE_FRAGMENT_SHADER = `
  precision mediump float;
  
  uniform sampler2D tDiffuse;
  uniform vec2 uTileOffset;
  uniform vec2 uTileScale;
  uniform float uOpacity;
  uniform float uLayer;
  
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vIsSunlit;
  
  void main() {
    vec2 tiledUV = fract(vUv);
    vec2 uv = tiledUV * uTileScale + uTileOffset;
    
    vec4 texSample = texture2D(tDiffuse, uv);
    if (texSample.a < 0.1) discard;
    
    bool lit = (vIsSunlit > 0.5);
    bool layerFlag = (uLayer > 0.5);
    if (!(lit != layerFlag)) discard;
    
    // vColor carries the world brightness baked in at spawn time; use it directly
    gl_FragColor = vec4(texSample.rgb * vColor, texSample.a * uOpacity);
  }
`;

export class Particle {
  constructor(atlasTexture, scene, world, x, y, z, vx, vy, vz, uvInfo, blockId, lifetime = 1.5, distanceOverride = null, brightness = 1.0) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlasTexture;
    this.blockId = blockId;

    this.pos = new THREE.Vector3(x, y, z);
    this.origin = this.pos.clone();
    this.prev = this.pos.clone();
    this.vel = new THREE.Vector3(vx, vy, vz);

    this.age = 0.0;
    const javaLifetime = Math.floor(4.0 / (Math.random() * 0.9 + 0.1));
    this.lifetime = javaLifetime / 60.0;
    this.removed = false;

    this.size = (Math.random() * 0.5 + 0.5) * 0.5;
    // increase base render size so particles start noticeably larger
    this.renderSize = 0.12 * this.size * 6.0;
    // apply modest extra scale to make on-screen particles bigger by default
    this.renderSize *= 1.0;

    this.maxDistance = (typeof distanceOverride === "number" && distanceOverride >= 0)
      ? distanceOverride
      : 4.0;

    this.gravity = -0.04;
    this.drag = 0.98;
    this.friction = 0.7;
    this.onGround = false;

    const halfBB = 0.1;
    this.bb = new AABB(x - halfBB, y - halfBB, z - halfBB, x + halfBB, y + halfBB, z + halfBB);

    // Pass down brightness so the vertex attribute 'isSunlit' reflects world lighting.
    const geometry = this._createPlaneGeometry(brightness);
    const material = this._createMaterial(uvInfo, brightness);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(this.pos);
    this.mesh.scale.set(this.renderSize, this.renderSize, this.renderSize);

    scene.add(this.mesh);
  }

  _createPlaneGeometry(brightness = 1.0) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const vertexCount = geometry.getAttribute('position').count; // 4 verts

    // Bake brightness into vertex color and simplify isSunlit to a neutral 1.0
    const clamped = Math.max(0.0, Math.min(1.0, Number(brightness) || 0.0));
    const isSunlit = new Float32Array(vertexCount).fill(1.0);

    const isSideBoundaryFace = new Float32Array(vertexCount).fill(0.0);
    const isBottomBoundaryFace = new Float32Array(vertexCount).fill(0.0);
    // faceId=2 (top face) — particles are treated as top-like by default, but shader no longer uses it
    const faceId = new Float32Array(vertexCount).fill(2.0);

    geometry.setAttribute('isSunlit', new THREE.BufferAttribute(isSunlit, 1));
    geometry.setAttribute('isSideBoundaryFace', new THREE.BufferAttribute(isSideBoundaryFace, 1));
    geometry.setAttribute('isBottomBoundaryFace', new THREE.BufferAttribute(isBottomBoundaryFace, 1));
    geometry.setAttribute('faceId', new THREE.BufferAttribute(faceId, 1));

    // Vertex colors carry the brightness multiplier for the shader
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3 + 0] = clamped;
      colors[i * 3 + 1] = clamped;
      colors[i * 3 + 2] = clamped;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return geometry;
  }

  _createMaterial(uvInfo, brightness) {
    const tileSize = uvInfo.scale;

    let baseU = uvInfo.u;
    let baseV = uvInfo.v;

    const grassTopU = 0 * tileSize;
    const grassSideU = 3 * tileSize;
    if (Math.abs(baseU - grassTopU) < 0.0001) {
      baseU = grassSideU;
    }

    // Use the UV info provided (already possibly subdivided by caller into quadrants).
    const uvOffset = new THREE.Vector2(baseU, baseV);
    const uvScale = new THREE.Vector2(tileSize, tileSize);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.atlas },
        uTileOffset: { value: uvOffset },
        uTileScale: { value: uvScale },
        uOpacity: { value: 1.0 },
        uLayer: { value: 0.0 } // default layer (can be toggled by caller)
      },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      vertexColors: true
    });

    if (this.atlas) {
      this.atlas.magFilter = THREE.NearestFilter;
      // Disable mipmaps and use nearest minification to remove mipmap sampling entirely.
      this.atlas.minFilter = THREE.NearestFilter;
      this.atlas.generateMipmaps = false;
    }

    return material;
  }

  fixedTick() {
    this.age += FIXED_TIMESTEP;

    if (this.age >= this.lifetime) {
      this.removed = true;
      return;
    }

    this.prev.copy(this.pos);
    const wasOnGround = this.onGround;
    this.onGround = false;

    this.vel.y += this.gravity;
    this.vel.x *= this.drag;
    this.vel.y *= this.drag;
    this.vel.z *= this.drag;

    const moveX = this.vel.x;
    const moveY = this.vel.y;
    const moveZ = this.vel.z;

    this._updateAABB();

    if (this.world && this.world.getCubes) {
      const expanded = this.bb.expand(moveX, moveY, moveZ);
      const cubes = this.world.getCubes(expanded);

      let clippedY = moveY;
      for (const cube of cubes) clippedY = cube.clipYCollide(this.bb, clippedY);
      this.bb.move(0, clippedY, 0);
      this.pos.y += clippedY;
      if (clippedY !== moveY) {
        if (moveY < 0) {
          this.onGround = true;
          this.vel.y = 0;
          this.vel.x *= this.friction;
          this.vel.z *= this.friction;
        } else {
          this.vel.y = 0;
        }
      }

      this._updateAABB();
      let clippedX = moveX;
      for (const cube of cubes) clippedX = cube.clipXCollide(this.bb, clippedX);
      this.bb.move(clippedX, 0, 0);
      this.pos.x += clippedX;
      if (clippedX !== moveX) this.vel.x = 0;

      this._updateAABB();
      let clippedZ = moveZ;
      for (const cube of cubes) clippedZ = cube.clipZCollide(this.bb, clippedZ);
      this.bb.move(0, 0, clippedZ);
      this.pos.z += clippedZ;
      if (clippedZ !== moveZ) this.vel.z = 0;

      this._updateAABB();
    } else {
      this.pos.x += moveX;
      this.pos.y += moveY;
      this.pos.z += moveZ;

      if (this.pos.y < 0.01) {
        this.pos.y = 0.01;
        this.vel.y = 0;
        this.vel.x *= this.friction;
        this.vel.z *= this.friction;
        this.onGround = true;
      }
    }
  }

  render(alpha, playerOrCamera) {
    if (!this.mesh) return;

    const renderPos = new THREE.Vector3().lerpVectors(this.prev, this.pos, alpha);
    this.mesh.position.copy(renderPos);

    // Billboard: always face the camera.
    // Accept either a direct THREE.Camera or an object with a .camera property.
    let cam = null;
    if (playerOrCamera) {
      // Three Camera objects often have .isCamera === true
      if (playerOrCamera.isCamera) cam = playerOrCamera;
      else if (playerOrCamera.camera && playerOrCamera.camera.isCamera) cam = playerOrCamera.camera;
    }

    if (cam) {
      // copy quaternion for stable billboard facing
      this.mesh.quaternion.copy(cam.quaternion);
    }
  }

  _updateAABB() {
    const halfBB = 0.1;
    this.bb.minX = this.pos.x - halfBB;
    this.bb.minY = this.pos.y - halfBB;
    this.bb.minZ = this.pos.z - halfBB;
    this.bb.maxX = this.pos.x + halfBB;
    this.bb.maxY = this.pos.y + halfBB;
    this.bb.maxZ = this.pos.z + halfBB;
  }

  dispose() {
    if (this.mesh) {
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      if (this.mesh.material) this.mesh.material.dispose();
      if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
      this.mesh = null;
    }
  }
}