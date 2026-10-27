// Three.js r186: opt in live farm objects, never engine prototypes or templates.
const matrixWriters = new WeakMap();

export function markChangedRange(attribute, start, count) {
  if (!count) return;
  let end = start + count;
  // Keep edits that have not reached the GPU (hidden/cull-skipped objects).
  for (const range of attribute.updateRanges) {
    start = Math.min(start, range.start);
    end = Math.max(end, range.start + range.count);
  }
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}

export function flushInstanceMatrix(mesh) {
  const state = matrixWriters.get(mesh);
  if (!state || !state.control.enabled) {
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
  } else if (state.end > state.start) {
    markChangedRange(mesh.instanceMatrix, state.start, state.end - state.start);
  }
  if (state) { state.start = Infinity; state.end = 0; }
}

export function installSelectiveMatrix(mesh, control) {
  if (matrixWriters.has(mesh)) return;
  const original = mesh.setMatrixAt;
  const state = { control, start: Infinity, end: 0 };
  matrixWriters.set(mesh, state);
  mesh.setMatrixAt = function(index, matrix) {
    if (!control.enabled) return original.call(this, index, matrix);
    const array = this.instanceMatrix.array, offset = index * 16, values = matrix.elements;
    let changed = false;
    for (let i = 0; i < 16; i++) if (array[offset + i] !== Math.fround(values[i])) { changed = true; break; }
    if (!changed) return;
    original.call(this, index, matrix);
    state.start = Math.min(state.start, offset);
    state.end = Math.max(state.end, offset + 16);
  };
}

export function installTransformCache(root, control = { enabled: true }) {
  // Scene/Group inherit this exact method in r186. Custom update implementations,
  // cameras, bones and skinned meshes keep their original semantics.
  let proto = Object.getPrototypeOf(root);
  while (proto && !Object.hasOwn(proto, 'updateMatrixWorld')) proto = Object.getPrototypeOf(proto);
  const standard = proto.updateMatrixWorld;
  const seen = new WeakSet();
  function visit(node) {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.updateMatrixWorld === standard && node.updateMatrix === proto.updateMatrix &&
        !node.isCamera && !node.isBone && !node.isSkinnedMesh) {
      let valid = false, parent = null;
      const pose = new Float64Array(10);
      node.updateMatrixWorld = function(force) {
        const p = this.position, q = this.quaternion, s = this.scale;
        if (!control.enabled || !this.matrixAutoUpdate || !this.matrixWorldAutoUpdate || this.pivot != null) {
          valid = false;
          return standard.call(this, force);
        }
        const same = valid && pose[0] === p.x && pose[1] === p.y && pose[2] === p.z &&
          pose[3] === q.x && pose[4] === q.y && pose[5] === q.z && pose[6] === q.w &&
          pose[7] === s.x && pose[8] === s.y && pose[9] === s.z;
        if (parent !== this.parent) this.matrixWorldNeedsUpdate = true;
        parent = this.parent;
        if (!same) {
          pose[0]=p.x; pose[1]=p.y; pose[2]=p.z; pose[3]=q.x; pose[4]=q.y;
          pose[5]=q.z; pose[6]=q.w; pose[7]=s.x; pose[8]=s.y; pose[9]=s.z;
          valid = true;
          return standard.call(this, force);
        }
        this.matrixAutoUpdate = false;
        try { return standard.call(this, force); }
        finally { this.matrixAutoUpdate = true; }
      };
    }
    // Only these producers write their matrices through setMatrixAt and flush.
    if (node.isInstancedMesh && (node.parent?.name === 'map_life' || node.name === 'local_fireflies')) {
      installSelectiveMatrix(node, control);
    }
    node.addEventListener('childadded', event => visit(event.child));
    for (const child of node.children) visit(child);
  }
  visit(root);
  return { setEnabled(value) { control.enabled = !!value; }, control };
}

export function installFarmWorkCache(farm) {
  return installTransformCache(farm.scene);
}
