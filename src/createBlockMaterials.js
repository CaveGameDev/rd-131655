import * as THREE from "three";

/**
 * Create block shader materials for the engine.
 * Returns { blockMaterials, materialIndexMap }.
 */
export async function createBlockMaterials(atlas) {
  const tileSize = 1.0 / 16.0;
  const topRowOffsetY = 1.0 - tileSize;
  const pixelSize = 1.0 / 256.0;

  const tileKeys = ["grass_top", "stone", "dirt", "grass_side", "wood", "cobble", "key6"];
  const textures = {};
  for (let i = 0; i < tileKeys.length; i++) textures[tileKeys[i]] = atlas;

  let matIndex = 0;
  const blockMaterials = [];
  const materialIndexMap = {};

  for (const key of tileKeys) {
    let uOffset;
    const uScale = new THREE.Vector2(tileSize, tileSize);

    if (key === "cobble") {
      const stoneCol = tileKeys.indexOf("stone") >= 0 ? tileKeys.indexOf("stone") : 1;
      const col = Math.max(0, stoneCol - 1);
      const vOffset = topRowOffsetY - pixelSize * 16;
      uOffset = new THREE.Vector2(col * tileSize, vOffset);
    } else if (key === "key6") {
      const rightmostCol = 15;
      uOffset = new THREE.Vector2(rightmostCol * tileSize, topRowOffsetY);
    } else {
      const col = tileKeys.indexOf(key);
      const vOffset = topRowOffsetY;
      uOffset = new THREE.Vector2(col * tileSize, vOffset);
    }

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: textures[key] },
        uTileOffset: { value: uOffset },
        uTileScale: { value: uScale },
        uSelectorTex: { value: new THREE.DataTexture(new Uint8Array([0,0,0,0]), 1, 1, THREE.RGBAFormat) },
        uMaxVisibleY: { value: 0 },
        uCurrentLayerXProgress: { value: 0 },
        uWorldWidth: { value: 1 },
        uCameraPosition: { value: new THREE.Vector3() },
        uMinDarknessDistance: { value: 2.5 },
        uMaxDarknessDistance: { value: 3000 },
        uIsWorldRevealing: { value: 0 },
        uSpecialRevealFinished: { value: 0 },
        uRevealMaxRadius: { value: 50.0 },
        uHighlightBlock: { value: new THREE.Vector3(-999, -999, -999) },
        uHighlightFace: { value: 0 },
        uHighlightYOffset: { value: 0.0 },
        uTopFaceNudge: { value: 0.0 },
        uHighlightTol: { value: 0.16 },
        uTime: { value: 0 },
        uHighlightEnabled: { value: 0 }
      },
      vertexShader: `attribute float isSunlit; attribute float isSideBoundaryFace; attribute float isBottomBoundaryFace; attribute float faceId; varying vec2 vUv; varying vec3 vColor; varying vec3 vWorldPosition; varying vec3 vWorldPositionForHighlight; varying float vIsSunlit; varying float vIsSideBoundaryFace; varying float vIsBottomBoundaryFace; varying float vFaceId; uniform float uTopFaceNudge; void main() { vUv = uv; vColor = color; vWorldPosition = position; vWorldPositionForHighlight = position + vec3(0.0, uTopFaceNudge, 0.0); vIsSunlit = isSunlit; vIsSideBoundaryFace = isSideBoundaryFace; vIsBottomBoundaryFace = isBottomBoundaryFace; vFaceId = faceId; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `precision mediump float; uniform sampler2D tDiffuse; uniform vec2 uTileOffset; uniform vec2 uTileScale; uniform float uHighlightEnabled; uniform vec3 uHighlightBlock; uniform float uHighlightFace; uniform float uHighlightTol; uniform float uHighlightYOffset; uniform float uTime; varying vec2 vUv; varying vec3 vColor; varying vec3 vWorldPosition; varying vec3 vWorldPositionForHighlight; varying float vIsSunlit; varying float vFaceId; float softEdge(float dist, float radius) { float f = smoothstep(radius, radius * 0.75, dist); return 1.0 - f; } void main() { vec2 tiledUV = fract(vUv); vec2 uv = tiledUV * uTileScale + uTileOffset; vec4 texSample = texture2D(tDiffuse, uv); if (texSample.a < 0.01) discard; float aoMul = 1.0; if (vFaceId < 0.5 || abs(vFaceId - 1.0) < 0.5) { aoMul = 1.0; } else if (abs(vFaceId - 2.0) < 0.5 || abs(vFaceId - 3.0) < 0.5) { aoMul = 0.8; } else { aoMul = 0.6; } float sunBoost = vIsSunlit > 0.5 ? 1.0 : 0.75; float lightFactor = clamp(aoMul * sunBoost, 0.4, 1.5); vec3 color = texSample.rgb * vColor * lightFactor; vec3 outColor = color; if (uHighlightEnabled > 0.5) { const float EPS = 0.001; vec3 blockCenter = uHighlightBlock + vec3(0.5, 0.5, 0.5); vec3 rel = vWorldPosition - blockCenter; if (abs(rel.x) <= (uHighlightTol + EPS) && abs(rel.y) <= (uHighlightTol + EPS) && abs(rel.z) <= (uHighlightTol + EPS)) { float faceInt = floor(vFaceId + 0.5); if (abs(uHighlightFace - faceInt) < 0.5) { float pulse = sin(uTime * 10.0) * 0.25 + 0.5; float edgeEffect = 1.0; if (faceInt > 1.5) { vec3 local = vWorldPositionForHighlight - uHighlightBlock; vec2 local2 = local.xz - vec2(0.5, 0.5); float dist = length(local2); edgeEffect = softEdge(dist, 0.55); } vec3 glow = vec3(1.0, 1.0, 1.0) * pulse * edgeEffect; outColor += glow * 0.6; } } } gl_FragColor = vec4(outColor, texSample.a); }`,
      vertexColors: true,
      side: THREE.DoubleSide
    });
    mat.transparent = true;
    if (key === "key6") {
      mat.alphaTest = 0.1;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
    }

    blockMaterials[matIndex] = mat;
    materialIndexMap[key] = matIndex;
    matIndex++;
  }

  // Create and append a water material (renders like a semi-transparent textured block)
  // Use the provided atlas as fallback; users may replace tDiffuse later with a dedicated water texture.
  try {
    const waterTex = atlas;
    if (waterTex && waterTex.isTexture) {
      waterTex.magFilter = THREE.NearestFilter;
      waterTex.minFilter = THREE.NearestFilter;
      waterTex.generateMipmaps = false;
      waterTex.needsUpdate = true;
    }
  } catch (e) {
    // continue with atlas reference even if texture tweaks fail
  }

  // Simple water shader: sample by world-position to keep texels consistent across chunk borders
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: atlas },
      uTileOffset: { value: new THREE.Vector2(0, topRowOffsetY) },
      uTileScale: { value: new THREE.Vector2(tileSize, tileSize) },
      uTime: { value: 0.0 },
      uOpacity: { value: 0.95 }
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        // provide world-space position so the fragment shader can compute stable UVs
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform sampler2D tDiffuse;
      uniform vec2 uTileOffset;
      uniform vec2 uTileScale;
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPosition;

      // small stable pseudo-ripple applied in world-space but kept tiny so texels remain intact
      float microRipple(vec2 p, float t) {
        // low-amplitude high-frequency noise-like ripple that won't shift whole texels
        return (sin((p.x + p.y) * 24.0 + t * 6.0) + cos((p.x - p.y) * 16.0 + t * 4.0)) * 0.0018;
      }

      void main() {
        // Compute UVs from world XZ so sampling is continuous across mesh/chunk boundaries.
        // This avoids using fract(vUv) which can introduce seams when tiles are placed by chunked geometry.
        vec2 worldXZ = vWorldPosition.xz;

        // Map world-space to atlas UV space. The uTileScale is expressed in atlas tile-space (tileSize).
        // Multiply world coordinates by 1.0 so each world unit aligns with one tile in the atlas mapping.
        // If your world-to-atlas scale differs, adjust multiplication factor accordingly.
        vec2 uvBase = worldXZ * uTileScale + uTileOffset;

        // Add an extremely subtle, world-space ripple (keeps per-pixel texel alignment).
        vec2 ripple = vec2(microRipple(worldXZ, uTime), microRipple(worldXZ.yx, uTime * 0.9));
        vec2 finalUv = uvBase + ripple;

        // Use direct sampling (no fract) so adjacent chunks sample exactly continuous coordinates.
        vec4 tex = texture2D(tDiffuse, finalUv);

        if (tex.a < 0.01) discard;

        // tint toward blue but preserve the exact sampled texel color (no additional modulation on alpha)
        vec3 deep = vec3(0.02, 0.06, 0.55);
        // approximate top-facing contribution (kept constant here so underlying top texels aren't visually changed)
        float upFactor = 0.8;
        vec3 col = mix(deep, tex.rgb, upFactor);

        // modest contrast but clamp to avoid altering low-level raw coloring too strongly
        col = ((col - 0.5) * 1.03) + 0.5;
        col = clamp(col, 0.0, 1.0);

        gl_FragColor = vec4(col, tex.a * uOpacity);
      }
    `,
    transparent: true,
    // Ensure water writes depth so it reliably occludes geometry behind it and avoids angle-dependent leaks.
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending
  });

  blockMaterials[matIndex] = waterMat;
  materialIndexMap['water'] = matIndex;
  matIndex++;

  return { blockMaterials, materialIndexMap };
}