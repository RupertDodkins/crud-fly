import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Apache-2.0 FlyBody geometry; provenance and license are beside the converted asset.
let source: Promise<T.Group> | undefined;
export async function loadFlybody(): Promise<{ group: T.Group; animate(walking: boolean, phaseT: number, t: number): void }> {
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
    const joint = model.getObjectByName(`coxa_T${i + 1}_${side}`)!;
    return { joint, rest: joint.quaternion.clone(), phase: (i % 2 + (side === 'left' ? 0 : 1)) * Math.PI };
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
        if (c.r > c.g && c.g > c.b && c.g > 0.04) node.material.color.setHex(0xae772d);
      }
    }
  });
  const rotation = new T.Quaternion();
  return {
    group,
    animate(walking, phaseT, t) {
      for (const leg of legs) {
        rotation.setFromAxisAngle(new T.Vector3(1, 0, 0), walking ? Math.sin(phaseT * 25 + leg.phase) * 0.14 * Math.min(1, phaseT / 0.1) : 0);
        leg.joint.quaternion.copy(leg.rest).multiply(rotation);
      }
      for (const wing of wings) {
        rotation.setFromAxisAngle(new T.Vector3(0, 1, 0), wing.side * Math.sin(t * 70) * 0.12);
        wing.joint.quaternion.copy(wing.rest).multiply(rotation);
      }
    },
  };
}
