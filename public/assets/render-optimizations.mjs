import { flushInstanceMatrix, markChangedRange } from './cpu-optimizations.mjs';
// Adapted from smooth-dense-scenes: instance repeated geometry with the same look.
// Keep the original firefly motion/flicker data; draw the glow quads together.
import { bd as InstancedMesh, bg as MeshBasicMaterial, be as PlaneGeometry, bi as Matrix4 } from './index-Gy4nOY45.js';

export function installFireflyBatch(farm) {
  const flies = farm.fireflies;
  let mesh = null, geometry = null, material = null, opacity = null;
  let enabled = true;
  const matrix = new Matrix4();
  const viewDepth = new Map();
  let ordered = [];

  function clear() {
    if (mesh) { flies.group.remove(mesh); mesh.dispose(); geometry.dispose(); material.dispose(); }
    mesh = geometry = material = opacity = null;
    viewDepth.clear(); ordered = [];
    for (const fly of flies.flies) if (fly.sprite.parent !== flies.group) flies.group.add(fly.sprite);
  }
  function rebuild() {
    clear();
    if (!flies.flies.length) return;
    const source = flies.flies[0].material;
    geometry = new PlaneGeometry(1, 1);
    material = new MeshBasicMaterial({ map: source.map, color: source.color, transparent: true,
      depthWrite: false, depthTest: source.depthTest, fog: source.fog, toneMapped: source.toneMapped });
    material.name = 'local_fireflies_instanced';
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float flyOpacity;\nvarying float vFlyOpacity;')
        .replace('#include <project_vertex>', `
          vFlyOpacity = flyOpacity;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 billboardScale = vec2(length(modelMatrix[0].xyz) * length(instanceMatrix[0].xyz),
                                     length(modelMatrix[1].xyz) * length(instanceMatrix[1].xyz));
          mvPosition.xy += position.xy * billboardScale;
          gl_Position = projectionMatrix * mvPosition;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFlyOpacity;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFlyOpacity;');
    };
    material.customProgramCacheKey = () => 'local-firefly-billboard-v1';
    mesh = new InstancedMesh(geometry, material, flies.flies.length);
    mesh.name = 'local_fireflies';
    mesh.frustumCulled = false; // Tiny swarm follows the camera; its points move each tick.
    mesh.raycast = () => {};
    opacity = new mesh.instanceMatrix.constructor(new Float32Array(flies.flies.length), 1);
    geometry.setAttribute('flyOpacity', opacity);
    ordered = [...flies.flies];
    flies.group.add(mesh);
    sync();
  }
  function sync() {
    if (!mesh) return;
    mesh.visible = enabled;
    for (const fly of flies.flies) {
      if (enabled && fly.sprite.parent === flies.group) flies.group.remove(fly.sprite);
      else if (!enabled && fly.sprite.parent !== flies.group) flies.group.add(fly.sprite);
    }
    if (!enabled || !flies.group.visible) return;
    // The game has a fixed orthographic viewing direction. Preserve back-to-front
    // ordering within the swarm, including each fly's separate opacity.
    matrix.multiplyMatrices(farm.camera.matrixWorldInverse, flies.group.matrixWorld);
    for (const fly of ordered) {
      const p = fly.sprite.position, m = matrix.elements;
      viewDepth.set(fly, m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]);
    }
    ordered.sort((a, b) => viewDepth.get(a) - viewDepth.get(b));
    let opacityStart = Infinity, opacityEnd = 0;
    ordered.forEach((fly, index) => {
      fly.sprite.updateMatrix();
      mesh.setMatrixAt(index, fly.sprite.matrix);
      const value = Math.fround(fly.material.opacity);
      if (opacity.array[index] !== value) {
        opacity.setX(index, value); opacityStart = Math.min(opacityStart, index); opacityEnd = index + 1;
      }
    });
    flushInstanceMatrix(mesh);
    if (!farm.localWorkCache?.control.enabled) { opacity.clearUpdateRanges(); opacity.needsUpdate = true; }
    else if (opacityEnd > opacityStart) markChangedRange(opacity, opacityStart, opacityEnd - opacityStart);
  }
  const originalRebuild = flies.rebuild, originalUpdate = flies.update, originalDispose = flies.dispose;
  flies.rebuild = function(...args) { clear(); originalRebuild.apply(this, args); rebuild(); };
  flies.update = function(...args) { originalUpdate.apply(this, args); sync(); };
  flies.dispose = function(...args) { clear(); originalDispose.apply(this, args); };
  rebuild();
  return { setEnabled(value) { enabled = !!value; sync(); }, sync, get mesh() { return mesh; } };
}

// EffectComposer owns two render targets. The original teardown freed only the
// supplied first target, leaking its clone and shader passes on quality changes.
export function disposeComposer(composer) {
  for (const pass of composer.passes) pass.dispose?.();
  composer.dispose();
}
