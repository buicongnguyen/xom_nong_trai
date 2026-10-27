export async function runCorrectness(T, opt, farm) {
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const Group = T.bc, Matrix4 = T.bi, Vector3 = T.bk;
  const make = () => {
    const root = new Group(), parent = new Group(), child = new Group(), other = new Group();
    root.add(parent, other); parent.add(child); child.position.set(1, 2, 3);
    return { root, parent, child, other };
  };
  const a = make(), b = make(), cache = opt.installTransformCache(b.root);
  const compare = label => {
    a.root.updateMatrixWorld(); b.root.updateMatrixWorld();
    for (const name of ['root', 'parent', 'child', 'other']) {
      check(a[name].matrixWorld.elements.every((v,i)=>Math.abs(v-b[name].matrixWorld.elements[i])<1e-12), label+' '+name);
      check(a[name].matrixAutoUpdate===b[name].matrixAutoUpdate, label+' auto flag');
    }
    passed.push(label);
  };
  compare('initial'); compare('unchanged');
  for (const f of [a,b]) { f.parent.position.set(4,5,6); f.parent.rotation.y=.73; f.child.rotation.z=.21; f.child.scale.setScalar(.55); }
  compare('moving-turning-animated-child-construction-scale');
  for (const f of [a,b]) { f.parent.visible=false; f.parent.position.x+=2; }
  compare('hidden-parent-moves');
  for (const f of [a,b]) { f.parent.visible=true; f.child.scale.setScalar(1); f.root.updateMatrixWorld(true); }
  compare('reveal-and-force');
  for (const f of [a,b]) { f.other.position.z=9; f.other.add(f.child); }
  compare('reparent');
  for (const f of [a,b]) { f.parent.position.y=12; f.parent.add(f.child); f.child.updateWorldMatrix(true,true); }
  compare('explicit-parent-first-world-update');
  for (const f of [a,b]) { f.child.position.x=7; f.child.updateMatrix(); }
  compare('explicit-local-update');
  for (const f of [a,b]) { f.parent.matrixAutoUpdate=false; f.parent.matrix.makeTranslation(8,9,10); f.parent.matrixWorldNeedsUpdate=true; }
  compare('manual-matrix');
  for (const f of [a,b]) f.parent.matrixAutoUpdate=true;
  compare('return-to-auto');
  for (const f of [a,b]) { f.parent.matrixWorldAutoUpdate=false; f.parent.matrixWorld.makeTranslation(6,7,8); }
  compare('manual-world-matrix');
  for (const f of [a,b]) f.parent.matrixWorldAutoUpdate=true;
  compare('return-world-to-auto');
  for (const f of [a,b]) f.child.pivot=new Vector3(1,0,1);
  compare('pivot-fallback');
  for (const f of [a,b]) { f.child.pivot=null; f.parent.remove(f.child); f.other.add(f.child); }
  compare('remove-reuse');
  cache.setEnabled(false); compare('disabled-control'); cache.setEnabled(true); compare('reenabled');
  const laterA=new Group(),laterB=new Group();a.child.add(laterA);b.child.add(laterB);
  laterA.position.y=laterB.position.y=3;compare('new-descendant');
  check(laterA.matrixWorld.equals(laterB.matrixWorld),'new descendant world');
  // Installed r186 raycasting must see the same parent-first updates.
  const Raycaster=Object.values(T).find(C=>typeof C==='function'&&C.prototype?.intersectObjects&&C.prototype?.setFromCamera);
  const ga=new T.be(2,2),gb=ga.clone(),ma=new T.bg(),mb=ma.clone();
  const meshA=new T.ba(ga,ma),meshB=new T.ba(gb,mb);a.root.add(meshA);b.root.add(meshB);
  meshA.position.z=meshB.position.z=2;a.root.updateMatrixWorld();b.root.updateMatrixWorld();
  const ray=new Raycaster(new Vector3(0,0,5),new Vector3(0,0,-1));
  const hitA=ray.intersectObject(meshA),hitB=ray.intersectObject(meshB);
  check(hitA.length>0&&hitA.length===hitB.length&&hitA[0].distance===hitB[0].distance,'ray picking');passed.push('ray-picking');
  ga.dispose();gb.dispose();ma.dispose();mb.dispose();
  const mesh=new T.bd(new T.be(),new T.bg(),4),control={enabled:true};opt.installSelectiveMatrix(mesh,control);
  const m=new Matrix4().makeRotationY(.17);mesh.setMatrixAt(0,m);opt.flushInstanceMatrix(mesh);
  mesh.instanceMatrix.clearUpdateRanges();const version=mesh.instanceMatrix.version;
  mesh.setMatrixAt(0,m);opt.flushInstanceMatrix(mesh);check(mesh.instanceMatrix.version===version,'Float32 stable write');
  m.setPosition(1,2,3);mesh.setMatrixAt(1,m);opt.flushInstanceMatrix(mesh);
  m.setPosition(4,5,6);mesh.setMatrixAt(3,m);opt.flushInstanceMatrix(mesh);
  check(mesh.instanceMatrix.updateRanges.length===1&&mesh.instanceMatrix.updateRanges[0].start===16&&mesh.instanceMatrix.updateRanges[0].count===48,'pending ranges union');
  mesh.count=2;mesh.setMatrixAt(0,m);opt.flushInstanceMatrix(mesh);check(mesh.instanceMatrix.updateRanges[0].start===0,'middle replacement');
  mesh.count=4;mesh.setMatrixAt(2,m);opt.flushInstanceMatrix(mesh);check(mesh.instanceMatrix.array[2*16+12]===4,'growth writes slot');
  passed.push('stable-float32-and-pending-hidden-ranges-shrink-growth-replacement');
  mesh.dispose();mesh.geometry.dispose();mesh.material.dispose();
  const fx=farm.fx3d,origin=new Vector3(farm.target.x,1,farm.target.z);
  fx.spawnWaterSplash(origin);fx.spawnPoof(origin,'dirt');fx.spawnSparkleBurst(origin,8,0xffff00,true);
  check(fx.hasActive(),'effects spawned');fx.update(16);check(fx.hasActive(),'effects animate');
  fx.update(2000);check(!fx.hasActive(),'effects expire');const free=fx.pool.free.length;
  check(free>0&&fx.pool.free.every(s=>!s.visible&&!s.parent),'expired sprites removed');
  fx.spawnWaterSplash(origin);check(fx.pool.free.length<free,'pool reused');fx.update(2000);
  check(!fx.hasActive()&&fx.pool.free.length===free,'pool recovered');passed.push('splash-poof-sparkle-expiry-pool-reuse');
  return passed;
}
