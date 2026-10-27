/**
 * GLSL for the WebGL stage. Everything is unlit: a fake key light by face normal, linear
 * fog to the page's own background, and a static grain matched to the page's grain.svg,
 * so the canvas sits in the page with no visible edge. Colours arrive as sRGB uniforms
 * and are written out untouched (no colour management), exactly as CSS would mix them.
 */

/** Shared by every material: the ground, the fog and the stage's dim. */
const COMMON = /* glsl */ `
uniform vec3 uBg;
uniform float uFogNear;
uniform float uFogFar;
uniform float uDim;
varying float vDepth;

// Linear fog by view depth, then the beat's dim on top: both recede into the ground.
float fogOf(float depth) {
  float f = clamp((depth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  float d = clamp(uDim * 1.6, 0.0, 1.0);
  return 1.0 - (1.0 - f) * (1.0 - d);
}
`;

/** Top faces 100%, fronts 70%, sides 45%: the only light there is. */
const KEY_LIGHT = /* glsl */ `
float keyLight(vec3 n, vec3 w) {
  vec3 a = abs(n);
  return a.x * w.x + a.z * w.z + a.y * (n.y > 0.0 ? w.y : w.x * 0.8);
}
`;

const VERT_HEAD = /* glsl */ `
varying float vDepth;
`;

/** Rails, the bead: solid boxes, faded towards the ground per group (a ladder, or the tower). */
export const SOLID_VERT = /* glsl */ `
${VERT_HEAD}
attribute float aGroup;
varying float vGroup;
varying vec3 vNormal;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  // Nothing on the stage is rotated, so object normals are world normals.
  vNormal = normal;
  vGroup = aGroup;
  gl_Position = projectionMatrix * mv;
}
`;

export const SOLID_FRAG = /* glsl */ `
${COMMON}
${KEY_LIGHT}
uniform vec3 uInk;
uniform float uGroupAlpha[3];
varying float vGroup;
varying vec3 vNormal;
void main() {
  float l = keyLight(normalize(vNormal), vec3(0.45, 1.0, 0.7));
  float a = uGroupAlpha[int(vGroup + 0.5)];
  vec3 c = mix(uBg, uInk, l * a);
  gl_FragColor = vec4(mix(c, uBg, fogOf(vDepth)), 1.0);
}
`;

/**
 * One quad per ladder; its rungs are antialiased stripes, one per block. Per-rung state
 * comes from uniforms: the pulled rung's empty slot, the release's void cascade in bands
 * outward from it, and the cancel's hollowing from the top down.
 */
export const RUNGS_VERT = /* glsl */ `
${VERT_HEAD}
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const RUNGS_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uInk;
uniform float uN;
uniform float uTone;
uniform float uAlpha;
uniform float uReleased;
uniform float uPer;
uniform float uBands[8];
uniform float uHollow;
varying vec2 vUv;

const float H = 0.15;      // half a rung's thickness, in pitches
const float VOID = 0.12;   // a rung that can never be valid
const float HOLLOW = 0.08; // a cancelled installment

void main() {
  float y = vUv.y * uN;
  float i = floor(y);
  // Rungs per pixel.
  float w = fwidth(y);
  float c = fract(y) - 0.5;
  float a = 1.0 - smoothstep(H - w, H + w, abs(c));
  // A hard stripe's harmonics alias into bands (moire) once a rung is under about four
  // pixels: give way to its fundamental, a sinusoid with the same mean, which can't alias
  // until two pixels a rung, then to the flat mean tone, which is what the eye sees anyway.
  float mean = 2.0 * H;
  float wave = mean + mean * cos(6.2831853 * c) * (1.0 - smoothstep(0.32, 0.5, w));
  a = mix(a, wave, smoothstep(0.17, 0.3, w));

  float tone = 1.0;
  if (uReleased >= 0.0) {
    float d = abs(i - uReleased);
    if (d < 0.5) {
      // The pulled rung's slot: it is drawn on its own.
      tone = 0.0;
    } else {
      int b = int(min(7.0, floor((d - 1.0) / uPer)));
      tone = mix(1.0, VOID, uBands[b]);
    }
  }
  // 0 at the top rung: the cancel empties a ladder from the top down.
  float fromTop = 1.0 - (i + 0.5) / uN;
  tone *= mix(1.0, HOLLOW, clamp((uHollow * 1.25 - fromTop) * 4.0, 0.0, 1.0));

  gl_FragColor = vec4(uInk, a * tone * uTone * uAlpha * (1.0 - fogOf(vDepth)));
}
`;

/**
 * The released rung: two half-bars that sit together as one rung, then part into the
 * transaction's two Ironwood actions. aSide is +1 for the top bar, -1 for the bottom.
 */
export const RUNG_VERT = /* glsl */ `
${VERT_HEAD}
attribute float aSide;
uniform float uSplit;
uniform vec3 uSize;
varying vec3 vNormal;
void main() {
  float bar = mix(0.5, 0.4, uSplit) * uSize.y;
  float off = mix(0.25, 0.633, uSplit) * uSize.y;
  vec3 p = vec3(position.x * uSize.x, position.y * bar + aSide * off, position.z * uSize.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  vNormal = normal;
  gl_Position = projectionMatrix * mv;
}
`;

export const RUNG_FRAG = /* glsl */ `
${COMMON}
${KEY_LIGHT}
uniform vec3 uAmber;
uniform vec3 uInk;
uniform float uLevel;
uniform float uPast;
uniform float uAlpha;
varying vec3 vNormal;
void main() {
  float l = keyLight(normalize(vNormal), vec3(0.72, 1.0, 0.92));
  // Once it is history the rung is ink: nothing past is amber.
  vec3 hue = mix(uAmber, uInk, uPast);
  float level = mix(uLevel, 0.9, uPast);
  vec3 c = mix(uBg, hue, l * level * uAlpha);
  gl_FragColor = vec4(mix(c, uBg, fogOf(vDepth)), 1.0);
}
`;

/** Sheath edges and other hairlines drawn as GL lines. */
export const LINE_VERT = /* glsl */ `
${VERT_HEAD}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const LINE_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uInk;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(uInk, uAlpha * (1.0 - fogOf(vDepth)));
}
`;

/** The tip line: a hairline drawn inside a taller quad, never thinner than a pixel. */
export const TIP_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uInk;
uniform float uAlpha;
uniform float uHeight;
uniform float uThickness;
varying vec2 vUv;
void main() {
  float d = abs(vUv.y - 0.5) * uHeight;
  float w = max(fwidth(d), 1e-5);
  float half_ = max(uThickness * 0.5, w * 0.5);
  float a = 1.0 - smoothstep(half_ - w * 0.5, half_ + w * 0.5, d);
  // Thinner than a pixel: keep its weight by coverage instead of width.
  a *= min(1.0, uThickness / w);
  gl_FragColor = vec4(uInk, a * uAlpha * (1.0 - fogOf(vDepth)));
}
`;

/**
 * The page's grain (public/grain.svg at --grain opacity), reproduced per CSS pixel so the
 * canvas matches the page around it: the same mean lift and about the same spread,
 * measured from screenshots of both themes. Static: it never asks for a frame.
 */
export const GRAIN_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const GRAIN_FRAG = /* glsl */ `
uniform float uGrain;
uniform float uPixelRatio;
// Device pixels at the canvas's bottom that are below the viewport, where the page's
// fixed grain doesn't reach either (a full-page capture shows them).
uniform float uBelow;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  if (gl_FragCoord.y < uBelow) discard;
  vec2 px = floor(gl_FragCoord.xy / uPixelRatio);
  // Three uniform samples: roughly normal, unit spread.
  float n = (hash(px) + hash(px + 71.3) + hash(px + 157.9) - 1.5) * 2.0;
  float a = 0.555 + 0.26 * n;
  float k = 0.393 + 0.15 * n;
  // Premultiplied: out = k * g + dst * (1 - a * g), as an SVG tile composited at opacity g.
  gl_FragColor = vec4(vec3(k * uGrain), a * uGrain);
}
`;
