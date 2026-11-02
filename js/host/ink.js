// ink.js: hand-drawn post-process over the papercraft scene.
//
// Pass 1 renders the scene's colour plus a depth texture.
// Pass 2 renders view-space normals (scene.overrideMaterial).
// Pass 3 composites: wobbly ink outlines from depth and normal discontinuities,
// pencil crosshatching in the darker tones, and a paper-grain wash.
// The line wobble "boils" at 6 fps, like a hand-drawn animation re-traced every frame.
//
// Objects on layer 1 (glass, particles, shadows, decals) are drawn in colour only
// and skipped by the normal pass, so they don't get outlines.

import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 res;
uniform float time;
uniform float near;
uniform float far;
uniform float px;        // line width in device pixels
uniform float hatchAmt;
uniform float boil;      // 0 when reduced motion is on
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * near * far / (far + near - z * (far - near));
}
float depthAt(vec2 uv) { return lin(texture2D(tDepth, uv).x); }
vec3 normalAt(vec2 uv) { return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }

void main() {
  float t = floor(time * 6.0) / 6.0 * boil;
  vec2 fc = gl_FragCoord.xy;

  // Wobble the sampling position so outlines look traced by hand.
  vec2 jit = vec2(noise(fc / (38.0 * px) + t * 7.1), noise(fc / (38.0 * px) - t * 5.3 + 17.0)) - 0.5;
  vec2 uv = vUv + jit * (1.8 * px) / res;
  vec2 o = vec2(px) / res;

  float d0 = depthAt(uv);
  float dl = depthAt(uv - vec2(o.x, 0.0)), dr = depthAt(uv + vec2(o.x, 0.0));
  float du = depthAt(uv + vec2(0.0, o.y)), dd = depthAt(uv - vec2(0.0, o.y));
  float dEdge = (abs(dl + dr - 2.0 * d0) + abs(du + dd - 2.0 * d0)) / max(d0, 0.001);

  vec3 n0 = normalAt(uv);
  float nEdge = (1.0 - dot(n0, normalAt(uv - vec2(o.x, 0.0)))) + (1.0 - dot(n0, normalAt(uv + vec2(o.x, 0.0))))
              + (1.0 - dot(n0, normalAt(uv + vec2(0.0, o.y)))) + (1.0 - dot(n0, normalAt(uv - vec2(0.0, o.y))));

  float edge = max(smoothstep(0.035, 0.09, dEdge), smoothstep(0.35, 0.9, nEdge));
  // Pen pressure: lines thin out and break up a little along their length.
  edge *= 0.65 + 0.5 * noise(fc / (7.0 * px) + t * 3.0);
  // Fade far-away linework so the background doesn't turn into scribble.
  edge *= 1.0 - smoothstep(60.0, 140.0, d0) * 0.7;

  vec3 col = texture2D(tColor, vUv).rgb;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));

  // Pencil crosshatch in the darker tones, drawn in screen space.
  vec2 sp = fc / px + (vec2(noise(fc / (26.0 * px) + t), noise(fc / (26.0 * px) - t + 9.0)) - 0.5) * 5.0;
  float l1 = smoothstep(0.62, 0.95, sin((sp.x + sp.y) * 0.85) * 0.5 + 0.5);
  float l2 = smoothstep(0.62, 0.95, sin((sp.x - sp.y) * 0.85) * 0.5 + 0.5);
  float hatch = l1 * smoothstep(0.5, 0.25, lum) + l2 * smoothstep(0.3, 0.1, lum);
  hatch *= 0.55 + 0.45 * noise(fc / (14.0 * px));
  hatch *= hatchAmt;

  // Paper grain and warm wash
  float grain = noise(fc * 0.7) * 0.4 + noise(fc * 0.11) * 0.35 + noise(fc * 0.025) * 0.25;
  float fibre = smoothstep(0.82, 1.0, noise(vec2(fc.x * 0.04, fc.y * 0.6)));
  vec3 paper = vec3(0.965, 0.935, 0.865) * (0.92 + 0.1 * grain) - fibre * 0.025;
  col = mix(col, col * paper * 1.04, 0.75);

  vec3 ink = vec3(0.17, 0.14, 0.09);
  col = mix(col, ink, hatch * 0.3);
  col = mix(col, ink, clamp(edge, 0.0, 1.0) * 0.92);

  // Soft vignette like a page under a desk lamp
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.45;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createInk(renderer) {
  const size = new THREE.Vector2();
  const depthTex = new THREE.DepthTexture(1, 1);
  depthTex.type = THREE.UnsignedIntType;
  const rtColor = new THREE.WebGLRenderTarget(1, 1, { depthTexture: depthTex, depthBuffer: true });
  const rtNormal = new THREE.WebGLRenderTarget(1, 1);
  const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      tColor: { value: rtColor.texture }, tNormal: { value: rtNormal.texture }, tDepth: { value: depthTex },
      res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, near: { value: 0.1 }, far: { value: 300 },
      px: { value: 1 }, hatchAmt: { value: 1 }, boil: { value: 1 },
    },
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // The normal pass (used only to find edges) can run at a fraction of the
  // screen resolution on slower devices; the outlines get a touch softer.
  let normalScale = 1;
  function resize() {
    renderer.getDrawingBufferSize(size);
    rtColor.setSize(size.x, size.y);
    rtNormal.setSize(Math.max(1, Math.round(size.x * normalScale)), Math.max(1, Math.round(size.y * normalScale)));
    mat.uniforms.res.value.copy(size);
    mat.uniforms.px.value = Math.max(1, renderer.getPixelRatio() * 1.15);
  }

  function render(scene, camera, time, reduceMotion) {
    const u = mat.uniforms;
    u.time.value = time; u.near.value = camera.near; u.far.value = camera.far;
    u.boil.value = reduceMotion ? 0 : 1;

    renderer.setRenderTarget(rtColor);
    renderer.render(scene, camera);

    const bg = scene.background, fog = scene.fog;
    scene.background = null; scene.fog = null;
    scene.overrideMaterial = normalMat;
    camera.layers.disable(1);
    renderer.setRenderTarget(rtNormal);
    renderer.setClearColor(0x8080ff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.enable(1);
    scene.overrideMaterial = null;
    scene.background = bg; scene.fog = fog;

    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  }

  function setNormalScale(s) { normalScale = s; resize(); }

  return { resize, render, setNormalScale };
}
