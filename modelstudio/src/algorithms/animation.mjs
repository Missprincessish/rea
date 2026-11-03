// Procedural animation clips authored against a skeleton's bone names.
// Clips are stored as keyframes on bone rotations (quaternion) and root motion.
import { poseSkeleton, quatEuler, skeletonBones, worldPositionsOf } from '../core/rigging.mjs';
import { fail } from '../core/util.mjs';

const CLIPS = {
  idle: {
    label: 'Idle breathing',
    duration: 2.4,
    loop: true,
    tracks: (bones) => [
      track(bones, 'spine', [[0, [0, 0, 0]], [1.2, [1.5, 0, 0.5]], [2.4, [0, 0, 0]]]),
      track(bones, 'chest', [[0, [0, 0, 0]], [1.2, [-1, 0, 0]], [2.4, [0, 0, 0]]]),
      track(bones, 'head', [[0, [0, 0, 0]], [0.9, [0, 4, 0]], [1.8, [0, -3, 0]], [2.4, [0, 0, 0]]]),
      track(bones, 'upper_arm.L', [[0, [0, 0, -6]], [1.2, [2, 0, -8]], [2.4, [0, 0, -6]]]),
      track(bones, 'upper_arm.R', [[0, [0, 0, 6]], [1.2, [2, 0, 8]], [2.4, [0, 0, 6]]]),
    ],
  },
  walk: {
    label: 'Walk cycle',
    duration: 1.2,
    loop: true,
    tracks: (bones) => [
      track(bones, 'thigh.L', [[0, [26, 0, 0]], [0.3, [0, 0, 0]], [0.6, [-24, 0, 0]], [0.9, [0, 0, 0]], [1.2, [26, 0, 0]]]),
      track(bones, 'shin.L', [[0, [-8, 0, 0]], [0.3, [-22, 0, 0]], [0.6, [-4, 0, 0]], [0.9, [-30, 0, 0]], [1.2, [-8, 0, 0]]]),
      track(bones, 'thigh.R', [[0, [-24, 0, 0]], [0.3, [0, 0, 0]], [0.6, [26, 0, 0]], [0.9, [0, 0, 0]], [1.2, [-24, 0, 0]]]),
      track(bones, 'shin.R', [[0, [-4, 0, 0]], [0.3, [-30, 0, 0]], [0.6, [-8, 0, 0]], [0.9, [-22, 0, 0]], [1.2, [-4, 0, 0]]]),
      track(bones, 'upper_arm.L', [[0, [-18, 0, -5]], [0.6, [18, 0, -5]], [1.2, [-18, 0, -5]]]),
      track(bones, 'upper_arm.R', [[0, [18, 0, 5]], [0.6, [-18, 0, 5]], [1.2, [18, 0, 5]]]),
      track(bones, 'spine', [[0, [2, 3, 0]], [0.6, [2, -3, 0]], [1.2, [2, 3, 0]]]),
      trackPosition(bones, 'hips', [[0, [0, 0, 0]], [0.3, [0, 0.02, 0]], [0.6, [0, 0, 0]], [0.9, [0, 0.02, 0]], [1.2, [0, 0, 0]]]),
    ],
  },
  run: {
    label: 'Run cycle',
    duration: 0.8,
    loop: true,
    tracks: (bones) => [
      track(bones, 'thigh.L', [[0, [44, 0, 0]], [0.2, [-10, 0, 0]], [0.4, [-36, 0, 0]], [0.6, [10, 0, 0]], [0.8, [44, 0, 0]]]),
      track(bones, 'shin.L', [[0, [-16, 0, 0]], [0.2, [-46, 0, 0]], [0.4, [-10, 0, 0]], [0.6, [-60, 0, 0]], [0.8, [-16, 0, 0]]]),
      track(bones, 'thigh.R', [[0, [-36, 0, 0]], [0.2, [10, 0, 0]], [0.4, [44, 0, 0]], [0.6, [-10, 0, 0]], [0.8, [-36, 0, 0]]]),
      track(bones, 'shin.R', [[0, [-10, 0, 0]], [0.2, [-60, 0, 0]], [0.4, [-16, 0, 0]], [0.6, [-46, 0, 0]], [0.8, [-10, 0, 0]]]),
      track(bones, 'upper_arm.L', [[0, [-46, 0, -8]], [0.4, [46, 0, -8]], [0.8, [-46, 0, -8]]]),
      track(bones, 'upper_arm.R', [[0, [46, 0, 8]], [0.4, [-46, 0, 8]], [0.8, [46, 0, 8]]]),
      track(bones, 'forearm.L', [[0, [-60, 0, 0]], [0.4, [-30, 0, 0]], [0.8, [-60, 0, 0]]]),
      track(bones, 'forearm.R', [[0, [-30, 0, 0]], [0.4, [-60, 0, 0]], [0.8, [-30, 0, 0]]]),
      track(bones, 'spine', [[0, [8, 0, 0]]]),
    ],
  },
  wave: {
    label: 'Wave hello',
    duration: 1.6,
    loop: false,
    tracks: (bones) => [
      track(bones, 'upper_arm.R', [[0, [0, 0, 8]], [0.4, [-10, 0, 62]], [1.2, [-10, 0, 62]], [1.6, [0, 0, 8]]]),
      track(bones, 'forearm.R', [[0, [0, 0, 0]], [0.4, [-20, 0, 40]], [0.7, [-20, 0, 10]], [1.0, [-20, 0, 40]], [1.3, [-20, 0, 10]], [1.6, [0, 0, 0]]]),
      track(bones, 'head', [[0, [0, 0, 0]], [0.6, [4, 0, 6]], [1.6, [0, 0, 0]]]),
    ],
  },
  punch: {
    label: 'Punch',
    duration: 0.7,
    loop: false,
    tracks: (bones) => [
      track(bones, 'upper_arm.R', [[0, [0, 0, 6]], [0.25, [-10, 0, -8]], [0.4, [-88, 0, 4]], [0.7, [0, 0, 6]]]),
      track(bones, 'forearm.R', [[0, [-20, 0, 0]], [0.25, [-90, 0, 0]], [0.4, [-4, 0, 0]], [0.7, [-20, 0, 0]]]),
      track(bones, 'spine', [[0, [0, 0, 0]], [0.4, [0, -18, 0]], [0.7, [0, 0, 0]]]),
      track(bones, 'hips', [[0, [0, 0, 0]], [0.4, [0, -8, 0]], [0.7, [0, 0, 0]]]),
    ],
  },
  jump: {
    label: 'Jump',
    duration: 1.4,
    loop: false,
    tracks: (bones) => [
      track(bones, 'thigh.L', [[0, [0, 0, 0]], [0.25, [40, 0, 0]], [0.5, [-10, 0, 0]], [0.8, [50, 0, 0]], [1.4, [0, 0, 0]]]),
      track(bones, 'shin.L', [[0, [0, 0, 0]], [0.25, [-50, 0, 0]], [0.5, [0, 0, 0]], [0.8, [-60, 0, 0]], [1.4, [0, 0, 0]]]),
      track(bones, 'thigh.R', [[0, [0, 0, 0]], [0.25, [40, 0, 0]], [0.5, [-10, 0, 0]], [0.8, [50, 0, 0]], [1.4, [0, 0, 0]]]),
      track(bones, 'shin.R', [[0, [0, 0, 0]], [0.25, [-50, 0, 0]], [0.5, [0, 0, 0]], [0.8, [-60, 0, 0]], [1.4, [0, 0, 0]]]),
      track(bones, 'upper_arm.L', [[0, [0, 0, 0]], [0.25, [30, 0, 0]], [0.5, [-120, 0, 0]], [1.4, [0, 0, 0]]]),
      track(bones, 'upper_arm.R', [[0, [0, 0, 0]], [0.25, [30, 0, 0]], [0.5, [-120, 0, 0]], [1.4, [0, 0, 0]]]),
      trackPosition(bones, 'hips', [[0, [0, 0, 0]], [0.3, [0, -0.08, 0]], [0.6, [0, 0.32, 0]], [0.9, [0, 0.05, 0]], [1.4, [0, 0, 0]]]),
    ],
  },
  spin: {
    label: 'Turntable spin',
    duration: 3,
    loop: true,
    tracks: (bones) => [
      trackPosition(bones, 'hips', [[0, [0, 0, 0]], [3, [0, 0, 0]]]),
    ],
    rootRotation: (t) => {
      const q = quatEuler([0, (t / 3) * 360, 0]);
      return q;
    },
  },
};

function track(bones, boneName, keys) {
  const bone = bones.find((b) => b.name === boneName) ?? bones.find((b) => b.id === boneName);
  if (!bone) return null;
  return {
    bone: bone.name,
    jointId: bone.id,
    path: 'rotation',
    keys: keys.map(([time, degrees]) => ({ time, value: quatEuler(degrees) })),
  };
}

function trackPosition(bones, boneName, keys) {
  const bone = bones.find((b) => b.name === boneName) ?? bones.find((b) => b.id === boneName);
  if (!bone) return null;
  return {
    bone: bone.name,
    jointId: bone.id,
    path: 'translation',
    keys: keys.map(([time, value]) => ({ time, value })),
  };
}

export function listClips() {
  return Object.entries(CLIPS).map(([id, clip]) => ({ id, label: clip.label, duration: clip.duration, loop: clip.loop }));
}

export function buildClip(skeleton, clipId) {
  const clip = CLIPS[clipId];
  if (!clip) fail('unknown_clip', `Unknown animation clip "${clipId}"`, { details: { available: Object.keys(CLIPS) } });
  const bones = skeletonBones(skeleton);
  const tracks = clip.tracks(bones).filter(Boolean);
  return {
    name: clipId,
    label: clip.label,
    duration: clip.duration,
    loop: clip.loop,
    tracks,
    channels: tracks.length,
  };
}

/** Sample a clip at a time, returning bone names -> rotation quaternions. */
export function sampleClip(animation, time) {
  const t = Math.max(0, Math.min(animation.duration, time));
  const result = {};
  for (const track of animation.tracks) {
    const keys = track.keys;
    if (keys.length === 0) continue;
    let a = keys[0];
    let b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (t >= keys[i].time && t <= keys[i + 1].time) {
        a = keys[i];
        b = keys[i + 1];
        break;
      }
    }
    const span = b.time - a.time;
    const alpha = span > 1e-6 ? (t - a.time) / span : 0;
    if (track.path === 'rotation') {
      result[track.bone] = slerp(a.value, b.value, alpha);
    } else {
      result[track.bone] = a.value.map((v, i) => v + (b.value[i] - v) * alpha);
    }
  }
  return result;
}

function slerp(a, b, alpha) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) {
    bb = b.map((v) => -v);
    dot = -dot;
  }
  if (dot > 0.9995) return a.map((v, i) => v + (bb[i] - v) * alpha);
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const w1 = Math.sin((1 - alpha) * theta) / sin;
  const w2 = Math.sin(alpha * theta) / sin;
  return a.map((v, i) => v * w1 + bb[i] * w2);
}

/** Convert a clip into glTF animation channels ready for export. */
export function clipToGltfChannels(animation, boneNodeIds) {
  return animation.tracks
    .filter((t) => boneNodeIds[t.jointId])
    .map((t) => ({
      nodeId: boneNodeIds[t.jointId],
      path: t.path,
      times: t.keys.map((k) => k.time),
      values: t.keys.map((k) => k.value),
    }));
}

export function applyClipPose(skeleton, animation, time) {
  const rotations = {};
  for (const track of animation.tracks) {
    if (track.path !== 'rotation') continue;
    const sampled = sampleClip({ ...animation, tracks: [track] }, time);
    if (sampled[track.bone]) skeleton.nodes[track.jointId].rotation = sampled[track.bone];
  }
  return rotations;
}

export { poseSkeleton, worldPositionsOf };
