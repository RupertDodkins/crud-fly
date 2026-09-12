import * as T from 'three';
import type { FlyPose } from './fly-rig';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Apache-2.0 FlyBody geometry; provenance and license are beside the converted asset.
let source: Promise<T.Group> | undefined;
export async function loadFlybody(bodyColor = 0xae772d): Promise<{ group: T.Group; animate(pose: FlyPose): void }> {
  source ??= new GLTFLoader().loadAsync(new URL('./assets/flybody.glb', import.meta.url).href).then(gltf => gltf.scene);
  const model = (await source).clone(true);
  const oriented = new T.Group();
  oriented.add(model);
  oriented.quaternion.setFromRotationMatrix(new T.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1));
  oriented.updateMatrixWorld(true);
  const bounds = new T.Box3().setFromObject(oriented);
  const scale = 1.9 / (bounds.max.z - bounds.min.z);
  const group = new T.Group();
  group.add(oriented);
  group.scale.setScalar(scale);
  // The source is in centimetres. Normalise it to the presentation rig's source units.
  group.position.set(0, 0.058 - bounds.min.y * scale, -bounds.min.z * scale);
  const legs = [...Array(3)].flatMap((_, i) => ['left', 'right'].map(side => {
    const names = ['coxa', 'femur', 'tibia'];
    const joints = names.map(name => {
      const joint = model.getObjectByName(`${name}_T${i + 1}_${side}`);
      if (!joint) throw new Error(`FlyBody has no ${name} joint for leg ${i + 1} ${side}`);
      return { joint, rest: joint.quaternion.clone() };
    });
    const foot = model.getObjectByName(`claw_T${i + 1}_${side}`);
    if (!foot) throw new Error(`FlyBody has no foot for leg ${i + 1} ${side}`);
    const restFoot = model.worldToLocal(foot.getWorldPosition(new T.Vector3()));
    return { joints, foot, restFoot, front: i === 0, side: side === 'left' ? 1 : -1,
      phase: (i % 2 + (side === 'left' ? 0 : 1)) * Math.PI };
  }));
  const wings = ['left', 'right'].map(side => {
    const joint = model.getObjectByName(`wing_${side}`)!;
    return { joint, rest: joint.quaternion.clone(), side: side === 'left' ? 1 : -1 };
  });
  model.traverse(node => {
    if (node instanceof T.Mesh) {
      node.geometry.computeVertexNormals();
      node.castShadow = true; node.receiveShadow = true;
      if (node.material instanceof T.MeshStandardMaterial) {
        node.material = node.material.clone();
        const c = node.material.color;
        if (c.r > c.g && c.g > c.b && c.g > 0.04) node.material.color.setHex(bodyColor);
      }
    }
  });
  const rotation = new T.Quaternion();
  return {
    group,
    animate({ phase, phaseT, t, carrying = false }) {
      const walking = phase === 'approach';
      const grip = phase === 'strike' ? Math.max(0, 1 - phaseT / 0.1) : carrying ? 1 : 0;
      for (const leg of legs) {
        for (const { joint, rest } of leg.joints) joint.quaternion.copy(rest);
        model.updateWorldMatrix(true, true);
        const cycle = phaseT * 32 + leg.phase;
        const envelope = walking ? Math.min(1, phaseT / 0.1) : 0;
        const target = leg.restFoot.clone();
        target.x += Math.sin(cycle) * 0.018 * envelope;
        target.z += Math.max(0, Math.cos(cycle)) * 0.012 * envelope;
        if (leg.front && grip > 0) target.lerp(new T.Vector3(0.2, leg.side * 0.032, -0.055), grip);
        model.localToWorld(target);
        // Fit the articulated leg to its planted foot or grasp target.
        for (let iteration = 0; iteration < 4; iteration++) {
          for (const { joint } of [...leg.joints].reverse()) {
            const origin = joint.getWorldPosition(new T.Vector3());
            const toe = leg.foot.getWorldPosition(new T.Vector3()).sub(origin).normalize();
            const desired = target.clone().sub(origin).normalize();
            const parent = joint.parent!.getWorldQuaternion(new T.Quaternion());
            rotation.setFromUnitVectors(toe, desired);
            const local = parent.clone().invert().multiply(rotation).multiply(parent);
            joint.quaternion.premultiply(local);
            joint.updateWorldMatrix(false, true);
          }
        }
      }
      for (const wing of wings) {
        rotation.setFromAxisAngle(new T.Vector3(0, 1, 0), wing.side * Math.sin(t * 70) * 0.12);
        wing.joint.quaternion.copy(wing.rest).multiply(rotation);
      }
    },
  };
}
