// 空の上に重ねる半球: 雲の層、星、地平線の霞。空（three の Sky）の後、地形より奥に描く。
// 雲は高さ 2000m の平面に描いた模様で、世界座標に固定して風で流す。表示だけなので GPU ごとの差は気にしない。

import * as THREE from "three";

const vertex = /* glsl */ `
varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const fragment = /* glsl */ `
varying vec3 vDir;
uniform vec2 uCamXZ;      // カメラの世界座標（km 単位で丸めた後の余り、m）
uniform vec2 uWind;       // 風で流れた量（m）
uniform float uCover;     // 雲の量 0〜1
uniform float uVeil;      // 霧で空全体が白くなる量 0〜1
uniform float uNight;     // 夜 0〜1
uniform vec3 uSunDir;
uniform vec3 uLit;        // 日の当たる雲の色
uniform vec3 uShade;      // 雲の影の色
uniform vec3 uFog;        // 霞の色（地形の霧と同じ）
uniform float uHorizon;   // 地平線の霞の強さ
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

float h12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float h13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = h12( i ), b = h12( i + vec2( 1.0, 0.0 ) ), c = h12( i + vec2( 0.0, 1.0 ) ), d = h12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float fbm( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < OCTAVES; i++ ) {
    s += a * vnoise( p );
    p = mat2( 1.6, 1.2, -1.2, 1.6 ) * p + vec2( 3.1, 1.7 );
    a *= 0.5;
  }
  return s;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize( vDir );
  float up = d.y;
  vec3 col = vec3( 0.0 );
  float alpha = 0.0;

  // 星（夜で、雲のない所）
  if ( uNight > 0.01 && up > 0.0 ) {
    vec3 sp = d * 260.0;
    vec3 cell = floor( sp );
    float r = h13( cell );
    if ( r > 0.985 ) {
      vec3 c = cell + vec3( h13( cell + 1.7 ), h13( cell + 5.3 ), h13( cell + 9.1 ) );
      float k = 1.0 - smoothstep( 0.0, 0.32, length( sp - c ) );
      float b = k * ( r - 0.985 ) / 0.015 * uNight * smoothstep( 0.0, 0.25, up );
      col += vec3( 0.85, 0.9, 1.0 ) * b * 1.6;
      alpha += b;
    }
  }

  // 雲の層（高さ 2000m の平面）
  if ( up > 0.015 && uCover > 0.01 ) {
    float t = min( 2000.0 / up, 60000.0 );
    vec2 p = ( uCamXZ + d.xz * t + uWind ) / 2600.0;
    float n = fbm( p );
    // 雲の量が多いほど低い値でも雲になる
    float th = mix( 0.78, 0.2, uCover );
    float dens = smoothstep( th, th + 0.22, n );
    // 一面の曇りは薄い所も埋める
    dens = max( dens, smoothstep( 0.72, 1.0, uCover ) * smoothstep( 0.15, 0.55, n + 0.25 ) );
    // 遠くの雲は薄く（模様が細かくなりすぎるので）
    dens *= smoothstep( 0.015, 0.12, up );
    float thick = smoothstep( th, th + 0.5, n );
    float sunSide = max( dot( d, uSunDir ), 0.0 );
    vec3 c = mix( uLit, uShade, clamp( thick * ( 0.25 + 0.5 * uCover ) + uCover * 0.3, 0.0, 1.0 ) );
    c += uLit * pow( sunSide, 12.0 ) * 0.35 * ( 1.0 - thick );
    // 遠くの雲ほど霞の色へ
    c = mix( c, uFog, smoothstep( 0.35, 0.02, up ) * 0.6 );
    col = c * dens + col * ( 1.0 - dens );
    alpha = dens + alpha * ( 1.0 - dens );
  }

  // 地平線の霞（地形の霧の色につなぐ）と、霧で白くなる空
  float hz = max( uHorizon * ( 1.0 - smoothstep( -0.02, 0.10 + 0.25 * uCover + 0.4 * uVeil, up ) ), uVeil * ( 1.0 - 0.35 * smoothstep( 0.2, 1.0, up ) * ( 1.0 - uVeil ) ) );
  if ( up < -0.02 ) hz = 1.0;

  // 雲と星の色を色調の変換に通してから、地形の霧と同じ所（変換の後）で霞の色を重ねる
  gl_FragColor = vec4( alpha > 0.0001 ? col / alpha : col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec3 fogC = uFog;
  #ifdef USE_FOG
    fogC = fogColor;
  #endif
  float a = 1.0 - ( 1.0 - hz ) * ( 1.0 - alpha );
  gl_FragColor = vec4( a > 0.0001 ? ( fogC * hz + gl_FragColor.rgb * alpha * ( 1.0 - hz ) ) / a : fogC, a );
}`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      defines: { OCTAVES: 5 },
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uCamXZ: { value: new THREE.Vector2() },
        uWind: { value: new THREE.Vector2() },
        uCover: { value: 0.3 },
        uVeil: { value: 0 },
        uNight: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uLit: { value: new THREE.Color(1, 1, 1) },
        uShade: { value: new THREE.Color(0.5, 0.5, 0.5) },
        uFog: { value: new THREE.Color(0.7, 0.8, 0.9) },
        uHorizon: { value: 0.6 },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      // 霧の色は three の霧の値を使う（地形と同じ色になるように）
      fog: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.name = "sky-dome";
    this.mesh.frustumCulled = false;
    // 不透明な物の後、ほかの半透明の物の前
    this.mesh.renderOrder = -1;
  }

  setQuality(light: boolean) {
    const o = light ? 3 : 5;
    if (this.material.defines.OCTAVES !== o) {
      this.material.defines.OCTAVES = o;
      this.material.needsUpdate = true;
    }
  }
}
