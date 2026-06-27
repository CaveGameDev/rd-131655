import * as THREE from "three";

export class Zombie {
  constructor(group, world, texture, x, y, z) {
    this.group = group;
    this.world = world;

    this.pos = new THREE.Vector3(x, y, z);
    this.prev = this.pos.clone();

    this.vel = new THREE.Vector3();
    this.rotation = Math.random() * Math.PI * 2;
    this.targetRotation = this.rotation;

    this.walkTime = 0;
    this.onGround = false;
    this.walkSpeed = 0.05;

    // -------------------------
    // TEXTURE (64x32 SKIN)
    // -------------------------
    this.texture = texture;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texture
    });

    this.mesh = new THREE.Group();
    this.group.add(this.mesh);

    this.buildModel(mat);
  }

  // =========================================================
  // PATCHED UV HELPER
  // =========================================================
  setFaceUV(geo, face, x1, y1, x2, y2, isHead = false) {
    const uv = geo.attributes.uv.array;

    // Dynamically support both 64x32 (classic) and 64x64 (modern) textures
    const texWidth = 64;
    const texHeight = (this.texture.image && this.texture.image.height) ? this.texture.image.height : 64;

    const u1 = x1 / texWidth;
    const v1 = y1 / texHeight;
    const u2 = x2 / texWidth;
    const v2 = y2 / texHeight;

    let f;

    if (isHead && (face === 2 || face === 3)) {
      // Top and Bottom caps
      f = [
        u1, v2, // Top Left
        u2, v2, // Top Right
        u1, v1, // Bottom Left
        u2, v1  // Bottom Right
      ];
    } else {
      // Standard Sides
      f = [
        u2, v1, // Top Left
        u1, v1, // Top Right
        u2, v2, // Bottom Left  <-- FIXED: Matches top edge orientation
        u1, v2  // Bottom Right <-- FIXED: Matches top edge orientation
      ];
    }

    for (let i = 0; i < 8; i++) {
      uv[face * 8 + i] = f[i];
    }
    
    geo.attributes.uv.needsUpdate = true;
  }

  // =========================================================
  // HEAD
  // =========================================================
  createHead(mat) {
    const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);

    this.setFaceUV(g, 2, 8, 0, 16, 8, true);    // Top
    this.setFaceUV(g, 3, 16, 0, 24, 8, true);   // Bottom
    this.setFaceUV(g, 0, 0, 8, 8, 16, true);    // Right
    this.setFaceUV(g, 4, 8, 8, 16, 16, true);   // Front (Face)
    this.setFaceUV(g, 1, 16, 8, 24, 16, true);  // Left
    this.setFaceUV(g, 5, 24, 8, 32, 16, true);  // Back

    return new THREE.Mesh(g, mat);
  }

  // =========================================================
  // BODY
  // =========================================================
  createBody(mat) {
    const g = new THREE.BoxGeometry(0.5, 0.75, 0.25);

    this.setFaceUV(g, 2, 20, 16, 28, 20); // Top
    this.setFaceUV(g, 3, 28, 16, 36, 20); // Bottom
    this.setFaceUV(g, 0, 16, 20, 20, 32); // Right
    this.setFaceUV(g, 4, 20, 20, 28, 32); // Front
    this.setFaceUV(g, 1, 28, 20, 32, 32); // Left
    this.setFaceUV(g, 5, 32, 20, 40, 32); // Back

    return new THREE.Mesh(g, mat);
  }

  // =========================================================
  // LEGS
  // =========================================================
  createLeg(mat) {
    const g = new THREE.BoxGeometry(0.25, 0.75, 0.25);

    this.setFaceUV(g, 2, 4, 16, 8, 20);   // Top
    this.setFaceUV(g, 3, 8, 16, 12, 20);  // Bottom
    this.setFaceUV(g, 0, 0, 20, 4, 32);   // Right
    this.setFaceUV(g, 4, 4, 20, 8, 32);   // Front
    this.setFaceUV(g, 1, 8, 20, 12, 32);  // Left
    this.setFaceUV(g, 5, 12, 20, 16, 32); // Back

    return new THREE.Mesh(g, mat);
  }

  // =========================================================
  // ARMS
  // =========================================================
  createArm(mat) {
    const g = new THREE.BoxGeometry(0.25, 0.75, 0.25);

    this.setFaceUV(g, 2, 44, 16, 48, 20); // Top
    this.setFaceUV(g, 3, 48, 16, 52, 20); // Bottom
    this.setFaceUV(g, 0, 40, 20, 44, 32); // Right
    this.setFaceUV(g, 4, 44, 20, 48, 32); // Front
    this.setFaceUV(g, 1, 48, 20, 52, 32); // Left
    this.setFaceUV(g, 5, 52, 20, 56, 32); // Back

    return new THREE.Mesh(g, mat);
  }

// =========================================================
  // BUILD MODEL
  // =========================================================
  buildModel(mat) {
    this.headPivot = new THREE.Group();
    this.head = this.createHead(mat);
    this.head.position.y = 0.25; 
    this.headPivot.add(this.head);

    this.body = this.createBody(mat);

    this.armLPivot = new THREE.Group();
    this.armRPivot = new THREE.Group();

    this.armL = this.createArm(mat);
    this.armR = this.createArm(mat);

    this.armL.position.y = -0.375;
    this.armR.position.y = -0.375;

    this.armLPivot.add(this.armL);
    this.armRPivot.add(this.armR);

    this.legLPivot = new THREE.Group();
    this.legRPivot = new THREE.Group();

    this.legL = this.createLeg(mat);
    this.legR = this.createLeg(mat);

    this.legL.position.y = -0.375;
    this.legR.position.y = -0.375;

    this.legLPivot.add(this.legL);
    this.legRPivot.add(this.legR);

    // ==========================================
    // FIXED POSITIONS: Closing the Gaps
    // ==========================================

    // 1. HEAD PIVOT: Dropped from 1.0 to 0.75 to rest exactly on the torso's shoulders
    this.headPivot.position.set(0, 0.75, 0);

    // 2. BODY: Dropped from 0.5 to 0.375. Since it's 0.75 units tall, 
    // a center of 0.375 puts the bottom edge precisely at Y=0 (touching the legs).
    this.body.position.set(0, 0.375, 0);

    // 3. ARM PIVOTS: Pulled X inward from +/- 0.375 to +/- 0.3125. 
    // If your texture/geometry uses 3-pixel wide "Alex" arms, this snaps them perfectly flush. 
    // If they are 4-pixels wide, it overlaps them slightly so there is zero chance of a gap.
    this.armLPivot.position.set(-0.3125, 0.75, 0);
    this.armRPivot.position.set(0.3125, 0.75, 0);

    // Legs remain anchored at 0 so they don't clip through the floor
    this.legLPivot.position.set(-0.125, 0, 0);
    this.legRPivot.position.set(0.125, 0, 0);

    this.mesh.add(
      this.body,
      this.headPivot,
      this.armLPivot,
      this.armRPivot,
      this.legLPivot,
      this.legRPivot
    );

    this.mesh.position.y -= 0.6;
  }

  // =========================================================
  // MOVEMENT & TICK
  // =========================================================
// =========================================================
  // MOVEMENT & TICK (Animation Independent of Ground)
  // =========================================================
  tick(dt) {
    this.prev.copy(this.pos);

    if (Math.random() < 0.02) {
      this.targetRotation = Math.random() * Math.PI * 2;
    }

    let diff = this.targetRotation - this.rotation;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    this.rotation += diff * 0.08;

    this.vel.x = Math.sin(this.rotation) * this.walkSpeed;
    this.vel.z = Math.cos(this.rotation) * this.walkSpeed;

    this.vel.y -= 0.012; // Gravity

    this.move(dt);

    // FIXED: Walk time increments every tick so animations run independently of ground state
    this.walkTime += dt;
  }

move(dt) {
    let dx = this.vel.x * dt * 60;
    let dy = this.vel.y * dt * 60;
    let dz = this.vel.z * dt * 60;

    const origDx = dx;
    const origDy = dy;
    const origDz = dz;

    if (this.world) {
      // 1. DEFINE ZOMBIE BOUNDING BOX (Width: 0.4, Height: 1.8)
      let zombie = {
        minX: this.pos.x - 0.2, maxX: this.pos.x + 0.2,
        minY: this.pos.y - 0.9, maxY: this.pos.y + 0.9,
        minZ: this.pos.z - 0.2, maxZ: this.pos.z + 0.2
      };

      // 2. GATHER SURROUNDING SOLID BLOCK BOXES
      const boxes = [];
      const x0 = Math.floor(Math.min(zombie.minX, zombie.minX + dx)) - 1;
      const x1 = Math.floor(Math.max(zombie.maxX, zombie.maxX + dx)) + 1;
      const y0 = Math.floor(Math.min(zombie.minY, zombie.minY + dy)) - 1;
      const y1 = Math.floor(Math.max(zombie.maxY, zombie.maxY + dy)) + 1;
      const z0 = Math.floor(Math.min(zombie.minZ, zombie.minZ + dz)) - 1;
      const z1 = Math.floor(Math.max(zombie.maxZ, zombie.maxZ + dz)) + 1;

      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            if (this.world.getTile(x, y, z) !== 0) {
              boxes.push({
                minX: x, maxX: x + 1,
                minY: y, maxY: y + 1,
                minZ: z, maxZ: z + 1
              });
            }
          }
        }
      }

      // 3. CLIP Y MOVEMENT (Floor / Ceiling Collisions)
      for (const b of boxes) {
        if (b.maxX > zombie.minX && b.minX < zombie.maxX && b.maxZ > zombie.minZ && b.minZ < zombie.maxZ) {
          if (dy > 0 && b.minY >= zombie.maxY) {
            let max = b.minY - zombie.maxY;
            if (max < dy) dy = max;
          }
          if (dy < 0 && b.maxY <= zombie.minY) {
            let min = b.maxY - zombie.minY;
            if (min > dy) dy = min;
          }
        }
      }
      zombie.minY += dy;
      zombie.maxY += dy;

      // 4. CLIP X MOVEMENT (Wall Collisions)
      for (const b of boxes) {
        if (b.maxY > zombie.minY && b.minY < zombie.maxY && b.maxZ > zombie.minZ && b.minZ < zombie.maxZ) {
          if (dx > 0 && b.minX >= zombie.maxX) {
            let max = b.minX - zombie.maxX;
            if (max < dx) dx = max;
          }
          if (dx < 0 && b.maxX <= zombie.minX) {
            let min = b.maxX - zombie.minX;
            if (min > dx) dx = min;
          }
        }
      }
      zombie.minX += dx;
      zombie.maxX += dx;

      // 5. CLIP Z MOVEMENT (Wall Collisions)
      for (const b of boxes) {
        if (b.maxX > zombie.minX && b.minX < zombie.maxX && b.maxY > zombie.minY && b.minY < zombie.maxY) {
          if (dz > 0 && b.minZ >= zombie.maxZ) {
            let max = b.minZ - zombie.maxZ;
            if (max < dz) dz = max;
          }
          if (dz < 0 && b.maxZ <= zombie.minZ) {
            let min = b.maxZ - zombie.minZ;
            if (min > dz) dz = min;
          }
        }
      }

      // 6. UPDATE POSITIONS TO CRITICAL ACCURATE POINTS
      this.pos.x += dx;
      this.pos.y += dy;
      this.pos.z += dz;

      // Determine ground state completely based on Y vector reduction
      if (origDy < 0 && dy !== origDy) {
        this.onGround = true;
        this.vel.y = 0;
      } else {
        this.onGround = false;
      }

      // If either horizontal displacement was stopped by a wall face, trigger a panic jump
      const hitWall = (dx !== origDx) || (dz !== origDz);
      if (hitWall) {
        if (dx !== origDx) this.vel.x = 0;
        if (dz !== origDz) this.vel.z = 0;
        
        if (this.onGround) {
          this.vel.y = 0.18;
          this.onGround = false;
        }
      }
    } else {
      // Fallback out of bounds
      this.pos.x += dx;
      this.pos.y += dy;
      this.pos.z += dz;
    }

    // 7. HYPER JUMP COINFLIP (35% chance on ground per tick)
    if (this.onGround && (Math.abs(this.vel.x) > 0.001 || Math.abs(this.vel.z) > 0.001)) {
      if (Math.random() < 0.35) {
        this.vel.y = 0.18;
        this.onGround = false;
      }
    }
  }

  findGround(x, y, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);

    for (let yy = Math.floor(y) + 2; yy >= 0; yy--) {
      if (this.world.getTile(bx, yy, bz) !== 0) {
        return yy + 1;
      }
    }
    return null;
  }

  // =========================================================
  // ANIMATION
  // =========================================================
  animate() {
    const t = this.walkTime * 10;

    this.headPivot.rotation.y = Math.sin(t * 0.83) * 1.0;
    this.headPivot.rotation.x = Math.sin(t) * 0.8;

    this.armLPivot.rotation.x = Math.sin(t * 0.6662 + Math.PI) * 2.0;
    this.armLPivot.rotation.z = -((Math.sin(t * 0.2312) + 1.0) * 1.0);

    this.armRPivot.rotation.x = Math.sin(t * 0.6662) * 2.0;
    this.armRPivot.rotation.z = -((Math.sin(t * -0.2812) - 1.0) * 1.0);

    this.legLPivot.rotation.x = Math.sin(t * 0.6662) * 1.4;
    this.legRPivot.rotation.x = Math.sin(t * 0.6662 + Math.PI) * 1.4;
  }

  // =========================================================
  // RENDER
  // =========================================================
  render(alpha) {
    this.mesh.position.lerpVectors(this.prev, this.pos, alpha);
    this.mesh.rotation.y = this.rotation;

    this.animate();
  }
}