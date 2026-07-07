/* Local-only study port of Ando's Sora sky background. Do not ship. */
(function () {
  'use strict';

  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') return;

  var frame = document.querySelector('.hero-sky-frame.programmatic-sky');
  var canvas = frame ? frame.querySelector('.programmatic-sky__canvas') : null;
  var occluder = frame ? frame.querySelector('.hero-sky-window') : null;
  if (!frame || !canvas) return;

  var style = document.createElement('style');
  style.textContent = [
    '.ando-sky-study{background:#9fc2e6;}',
    '.ando-sky-study .programmatic-sky__canvas{display:block;z-index:1;opacity:0;transition:opacity .7s ease-out;}',
    '.ando-sky-study.is-ando-sky-ready .programmatic-sky__canvas{opacity:1;}',
    '.ando-sky-study .programmatic-sky__fallback,',
    '.ando-sky-study .programmatic-sky__haze,',
    '.ando-sky-study .programmatic-sky__grain{display:none;}'
  ].join('\n');
  document.head.appendChild(style);
  frame.classList.add('ando-sky-study');

  var params = {
    sunX: 1,
    sunY: 1,
    glow: 1,
    warm: 0.12,
    coverage: 0.45,
    soft: 0.65,
    scale: 2.2,
    billow: 0,
    cirrus: 0.92,
    drift: 0.79,
    haze: 0,
    ev: -0.18,
    bloom: 1,
    grain: 0.01,
    vig: 0
  };
  var camera = {
    type: 0,
    defocus: 0.31,
    edge: 0,
    highlights: 1
  };
  var seed = 1247;

  var vertexShader = '#version 300 es\n' +
    'layout(location = 0) in vec2 position;\n' +
    'void main(){ gl_Position = vec4(position, 0.0, 1.0); }\n';

  var fragmentHeader = '#version 300 es\n' +
    'precision highp float;\n' +
    'out vec4 fragColor;\n';

  var noiseSource = [
    '#define TAU 6.28318530718',
    'float hash21(vec2 p){',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash21(i),              hash21(i + vec2(1, 0)), u.x),',
    '             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);',
    '}',
    'float fbm2(vec2 p){ return vnoise(p) * 0.62 + vnoise(p * 2.13 + 7.7) * 0.38; }',
    'mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }'
  ].join('\n') + '\n';

  var soraShader = fragmentHeader + noiseSource + [
    'uniform vec2  u_res;',
    'uniform float u_time;',
    'uniform float u_seed;',
    'uniform vec2  u_sunPos;',
    'uniform float u_glow;',
    'uniform float u_warm;',
    'uniform float u_coverage;',
    'uniform float u_soft;',
    'uniform float u_scale;',
    'uniform float u_billow;',
    'uniform float u_cirrus;',
    'uniform float u_haze;',
    '',
    'float fbmN(vec2 p, int oct){',
    '  float a = 0.5, s = 0.0, n = 0.0;',
    '  for(int i = 0; i < 5; i++){',
    '    if(i >= oct) break;',
    '    s += a * vnoise(p);',
    '    n += a; a *= 0.52; p = p * 2.07 + 13.7;',
    '  }',
    '  return s / n;',
    '}',
    '',
    'float cloudField(vec2 q, int oct){',
    '  vec2 p = q + vec2(u_time * 0.045, u_time * 0.006);',
    '  if(u_billow > 0.001){',
    '    vec2 w = vec2(fbm2(q * 0.55 + u_time * 0.020 + u_seed),',
    '                  fbm2(q * 0.55 + 9.1 - u_time * 0.016));',
    '    p += (w - 0.5) * (2.6 * u_billow);',
    '  }',
    '  return fbmN(p, oct);',
    '}',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  float aspect = u_res.x / u_res.y;',
    '  vec2 pa = vec2(uv.x * aspect, uv.y);',
    '  vec2 sa = vec2(u_sunPos.x * aspect, u_sunPos.y);',
    '',
    '  float w = u_warm;',
    '  vec3 zen  = mix(vec3(0.150, 0.355, 0.795), vec3(0.34, 0.36, 0.62), w * 0.8);',
    '  vec3 hor  = mix(vec3(0.60, 0.74, 0.94),    vec3(0.95, 0.74, 0.58), w);',
    '  vec3 sunC = mix(vec3(1.00, 0.97, 0.90),    vec3(1.00, 0.66, 0.34), w);',
    '',
    '  float hz = pow(1.0 - uv.y, 1.6);',
    '  vec3 sky = mix(zen, hor, clamp(hz + u_haze * (1.0 - uv.y) * 0.7, 0.0, 1.0)) * 1.12;',
    '',
    '  float sd = distance(pa, sa);',
    '  float halo = exp(-sd * sd * 11.0) * 0.55 + exp(-sd * 2.6) * 0.16;',
    '  sky += sunC * halo * (u_glow * 1.15);',
    '',
    '  vec2 q = pa * (2.1 * u_scale) + vec2(u_seed * 0.37, u_seed * 0.61);',
    '  float d = mix(0.5, cloudField(q, 5), 1.22);',
    '  float thr  = mix(0.66, 0.38, u_coverage);',
    '  float band = 0.07 + 0.20 * u_soft;',
    '  float c = smoothstep(thr, thr + band, d);',
    '',
    '  vec2 toSun = normalize(sa - pa + 1e-4);',
    '  float dLit = cloudField(q + toSun * 0.11, 3);',
    '  float rim  = clamp((d - dLit) * 9.0, -1.0, 1.0);',
    '',
    '  float dense = smoothstep(thr + band * 0.6, thr + band * 1.9, d);',
    '  vec3 litC    = sunC * (1.18 + 0.55 * u_glow * exp(-sd * 1.4));',
    '  vec3 shadeC  = mix(vec3(0.66, 0.72, 0.85), vec3(0.72, 0.64, 0.68), w) * 0.96;',
    '  vec3 cloudC  = mix(litC, shadeC, clamp(dense * 0.85 - rim * 0.45, 0.0, 1.0));',
    '  cloudC = mix(cloudC, litC * 1.06, clamp(rim, 0.0, 1.0) * (1.0 - dense * 0.55));',
    '',
    '  float veil = smoothstep(thr - 0.13, thr, d) * (1.0 - c);',
    '  sky = mix(sky, mix(sky, litC, 0.45), veil * 0.28);',
    '',
    '  vec3 col = mix(sky, cloudC, c * 0.96);',
    '',
    '  if(u_cirrus > 0.005){',
    '    vec2 cq = rot2(-0.18) * (pa * vec2(1.3, 4.2) * u_scale) + vec2(u_time * 0.10, u_seed);',
    '    float ci = fbmN(cq, 5);',
    '    float wisp = smoothstep(0.56, 0.78, ci) * u_cirrus;',
    '    col = mix(col, mix(sunC, vec3(1.0), 0.5) * 1.05, wisp * 0.42 * (1.0 - c));',
    '  }',
    '',
    '  col *= 1.0 - 0.10 * pow(uv.y, 2.0) * (1.0 - u_warm * 0.5);',
    '',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var defocusShader = fragmentHeader + noiseSource + [
    'uniform sampler2D u_tex;',
    'uniform vec2  u_res;',
    'uniform float u_amount;',
    'uniform float u_edge;',
    'uniform float u_hi;',
    'uniform float u_type;',
    'uniform int   u_taps;',
    '',
    'float iris(float a){',
    '  return cos(0.5235988) / cos(mod(a, 1.0471976) - 0.5235988);',
    '}',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  if(u_amount < 1e-5){ fragColor = texture(u_tex, uv); return; }',
    '',
    '  float aspect = u_res.x / u_res.y;',
    '  vec2  c   = (uv - 0.5) * vec2(aspect, 1.0);',
    '  float rad = length(c) / (0.5 * sqrt(aspect * aspect + 1.0));',
    '  float R   = u_amount * mix(1.0, smoothstep(0.12, 0.95, rad), u_edge);',
    '  if(R < 1e-5){ fragColor = texture(u_tex, uv); return; }',
    '',
    '  float phi0 = hash21(gl_FragCoord.xy) * TAU;',
    '  int  type = int(u_type);',
    '  vec3 acc = vec3(0.0); float wsum = 0.0;',
    '  float fN = float(u_taps);',
    '  for(int i = 0; i < 16; i++){',
    '    if(i >= u_taps) break;',
    '    float fi = float(i);',
    '    float r  = sqrt((fi + 0.5) / fN);',
    '    float a  = fi * 2.39996323 + phi0;',
    '    if(type == 1) r *= iris(a);',
    '    vec2 off = r * vec2(cos(a), sin(a));',
    '    if(type == 2) off.x *= 0.52;',
    '    vec3 s = texture(u_tex, uv + off * R * vec2(1.0 / aspect, 1.0)).rgb;',
    '    float w = 1.0 + u_hi * 5.0 * max(dot(s, vec3(0.2126, 0.7152, 0.0722)) - 0.85, 0.0);',
    '    acc += s * w; wsum += w;',
    '  }',
    '  fragColor = vec4(acc / wsum, 1.0);',
    '}'
  ].join('\n');

  var brightShader = fragmentHeader + [
    'uniform sampler2D u_tex; uniform vec2 u_px;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy * u_px;',
    '  vec3 c = texture(u_tex, uv).rgb;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  float w = max(l - 1.02, 0.0) / max(l, 1e-4);',
    '  fragColor = vec4(c * w, 1.0);',
    '}'
  ].join('\n');

  var downShader = fragmentHeader + [
    'uniform sampler2D u_tex; uniform vec2 u_px;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy * u_px * 2.0;',
    '  vec3 c = texture(u_tex, uv).rgb * 4.0;',
    '  c += texture(u_tex, uv + vec2( u_px.x,  u_px.y)).rgb;',
    '  c += texture(u_tex, uv + vec2(-u_px.x,  u_px.y)).rgb;',
    '  c += texture(u_tex, uv + vec2( u_px.x, -u_px.y)).rgb;',
    '  c += texture(u_tex, uv + vec2(-u_px.x, -u_px.y)).rgb;',
    '  fragColor = vec4(c / 8.0, 1.0);',
    '}'
  ].join('\n');

  var upShader = fragmentHeader + [
    'uniform sampler2D u_low;',
    'uniform sampler2D u_same;',
    'uniform vec2 u_px;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy * u_px;',
    '  vec2 o = u_px * 1.6;',
    '  vec3 c  = texture(u_low, uv + vec2(-o.x * 2.0, 0.0)).rgb;',
    '  c += texture(u_low, uv + vec2( o.x * 2.0, 0.0)).rgb;',
    '  c += texture(u_low, uv + vec2(0.0, -o.y * 2.0)).rgb;',
    '  c += texture(u_low, uv + vec2(0.0,  o.y * 2.0)).rgb;',
    '  c += texture(u_low, uv + vec2(-o.x,  o.y)).rgb * 2.0;',
    '  c += texture(u_low, uv + vec2( o.x,  o.y)).rgb * 2.0;',
    '  c += texture(u_low, uv + vec2(-o.x, -o.y)).rgb * 2.0;',
    '  c += texture(u_low, uv + vec2( o.x, -o.y)).rgb * 2.0;',
    '  fragColor = vec4(c / 12.0 + texture(u_same, uv).rgb, 1.0);',
    '}'
  ].join('\n');

  var finalShader = fragmentHeader + noiseSource + [
    'uniform sampler2D u_scene;',
    'uniform sampler2D u_bloom;',
    'uniform vec2  u_res;',
    'uniform float u_bloomAmt;',
    'uniform float u_ev;',
    'uniform float u_vig;',
    'uniform float u_grain;',
    'uniform float u_gtime;',
    '',
    'vec3 aces(vec3 x){',
    '  x *= 0.72;',
    '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
    '}',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  vec3 hdr = texture(u_scene, uv).rgb;',
    '  hdr += texture(u_bloom, uv).rgb * (u_bloomAmt * 0.55);',
    '  hdr *= exp2(u_ev);',
    '',
    '  vec3 col = aces(hdr);',
    '',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col += smoothstep(0.55, 1.0, lum) * vec3(0.014, 0.005, -0.009);',
    '  col += (1.0 - smoothstep(0.0, 0.42, lum)) * vec3(-0.006, 0.002, 0.013);',
    '  col = mix(vec3(lum), col, 1.045);',
    '',
    '  vec2 c = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;',
    '  float vig = pow(max(cos(length(c) * 0.86), 0.0), 3.0);',
    '  col *= mix(1.0, vig, u_vig);',
    '',
    '  float g = hash21(gl_FragCoord.xy + fract(floor(u_gtime * 24.0) * 0.6180339) * 311.7) - 0.5;',
    '  col += g * u_grain * (0.35 + 0.65 * (1.0 - lum));',
    '  col += (hash21(gl_FragCoord.xy * 1.37 + 91.3) - 0.5) / 255.0;',
    '',
    '  col = pow(max(col, 0.0), vec3(1.0 / 2.2));',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compileShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('ando sky shader compile failed: ' + log);
    }
    return shader;
  }

  function createProgram(gl, fragmentSource, names) {
    var vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShader);
    var fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('ando sky program link failed: ' + log);
    }
    var uniforms = {};
    names.forEach(function (name) {
      uniforms[name] = gl.getUniformLocation(program, name);
    });
    return { id: program, u: uniforms };
  }

  function createRenderer(node) {
    var gl = node.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
    if (!gl) return null;

    gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');

    var programs = null;
    var vao = null;
    var buffer = null;
    var targets = null;
    var width = 0;
    var height = 0;
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var downgraded = false;
    var occlusion = null;
    var skyTime = 40;
    var grainTime = 0;
    var running = false;
    var active = true;
    var visible = !document.hidden;
    var intersecting = !('IntersectionObserver' in window);
    var raf = 0;
    var lastTick = 0;
    var slowFrames = 0;
    var ready = false;

    function initPrograms() {
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      programs = {
        sora: createProgram(gl, soraShader, ['u_res', 'u_time', 'u_seed', 'u_sunPos', 'u_glow', 'u_warm', 'u_coverage', 'u_soft', 'u_scale', 'u_billow', 'u_cirrus', 'u_haze']),
        defocus: createProgram(gl, defocusShader, ['u_tex', 'u_res', 'u_amount', 'u_edge', 'u_hi', 'u_type', 'u_taps']),
        bright: createProgram(gl, brightShader, ['u_tex', 'u_px']),
        down: createProgram(gl, downShader, ['u_tex', 'u_px']),
        up: createProgram(gl, upShader, ['u_low', 'u_same', 'u_px']),
        final: createProgram(gl, finalShader, ['u_scene', 'u_bloom', 'u_res', 'u_bloomAmt', 'u_ev', 'u_vig', 'u_grain', 'u_gtime'])
      };
    }

    function createTarget(w, h) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex: tex, fbo: fbo, w: w, h: h };
    }

    function disposeTargets() {
      if (!targets) return;
      [targets.scene, targets.lens].concat(targets.bloomA, targets.bloomB).forEach(function (target) {
        gl.deleteTexture(target.tex);
        gl.deleteFramebuffer(target.fbo);
      });
      targets = null;
    }

    function allocateTargets(w, h) {
      disposeTargets();
      var halfW = Math.max(1, w >> 1);
      var halfH = Math.max(1, h >> 1);
      var bloomA = [];
      var bloomB = [];
      for (var i = 0; i < 3; i += 1) {
        var bw = Math.max(1, w >> (i + 1));
        var bh = Math.max(1, h >> (i + 1));
        bloomA.push(createTarget(bw, bh));
        if (i < 2) bloomB.push(createTarget(bw, bh));
      }
      targets = {
        scene: createTarget(halfW, halfH),
        lens: createTarget(halfW, halfH),
        bloomA: bloomA,
        bloomB: bloomB
      };
    }

    function setStaticUniforms() {
      if (!programs || !targets) return;
      var p = programs.sora;
      gl.useProgram(p.id);
      gl.uniform2f(p.u.u_res, targets.scene.w, targets.scene.h);
      gl.uniform1f(p.u.u_seed, seed);
      gl.uniform2f(p.u.u_sunPos, params.sunX, params.sunY);
      gl.uniform1f(p.u.u_glow, params.glow);
      gl.uniform1f(p.u.u_warm, params.warm);
      gl.uniform1f(p.u.u_coverage, params.coverage);
      gl.uniform1f(p.u.u_soft, params.soft);
      gl.uniform1f(p.u.u_scale, params.scale);
      gl.uniform1f(p.u.u_billow, params.billow);
      gl.uniform1f(p.u.u_cirrus, params.cirrus);
      gl.uniform1f(p.u.u_haze, params.haze);

      p = programs.defocus;
      gl.useProgram(p.id);
      gl.uniform2f(p.u.u_res, targets.lens.w, targets.lens.h);
      gl.uniform1f(p.u.u_amount, 0.028 * camera.defocus);
      gl.uniform1f(p.u.u_edge, camera.edge);
      gl.uniform1f(p.u.u_hi, camera.highlights);
      gl.uniform1f(p.u.u_type, camera.type);
      gl.uniform1i(p.u.u_taps, 8);

      p = programs.final;
      gl.useProgram(p.id);
      gl.uniform2f(p.u.u_res, width, height);
      gl.uniform1f(p.u.u_bloomAmt, params.bloom);
      gl.uniform1f(p.u.u_ev, params.ev);
      gl.uniform1f(p.u.u_vig, params.vig);
      gl.uniform1f(p.u.u_grain, params.grain);
    }

    function resize() {
      var cssW = node.clientWidth || node.width || window.innerWidth;
      var cssH = node.clientHeight || node.height || window.innerHeight;
      var nextW = Math.max(1, Math.round(cssW * dpr));
      var nextH = Math.max(1, Math.round(cssH * dpr));
      if (nextW === width && nextH === height && targets) return false;
      width = nextW;
      height = nextH;
      node.width = width;
      node.height = height;
      allocateTargets(width, height);
      setStaticUniforms();
      return true;
    }

    function useTarget(program, target) {
      gl.useProgram(program.id);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : width, target ? target.h : height);
    }

    function bindTexture(unit, tex, uniform) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uniform, unit);
    }

    function draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function occlusionRects(w, h, box, pad) {
      var left = Math.min(w, Math.ceil(box.x0 * w) + pad);
      var right = Math.max(0, Math.floor(box.x1 * w) - pad);
      var bottom = Math.min(h, Math.ceil((1 - box.y1) * h) + pad);
      var top = Math.max(0, Math.floor((1 - box.y0) * h) - pad);
      if (right <= left || top <= bottom) return null;
      var rects = [];
      if (bottom > 0) rects.push([0, 0, w, bottom]);
      if (top < h) rects.push([0, top, w, h - top]);
      if (left > 0) rects.push([0, bottom, left, top - bottom]);
      if (right < w) rects.push([right, bottom, w - right, top - bottom]);
      return rects;
    }

    function drawWithOcclusion(rects) {
      if (!rects) {
        draw();
        return;
      }
      gl.clearColor(0.5, 0.62, 0.9, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      rects.forEach(function (rect) {
        gl.scissor(rect[0], rect[1], rect[2], rect[3]);
        draw();
      });
      gl.disable(gl.SCISSOR_TEST);
    }

    function render() {
      if (!targets || !programs) return;
      gl.bindVertexArray(vao);
      var pad = occlusion ? Math.ceil(0.028 * camera.defocus * targets.scene.h + 10 * dpr * (targets.scene.h / height) + 2) : 0;
      var rects = occlusion ? occlusionRects(targets.scene.w, targets.scene.h, occlusion, pad) : null;

      var p = programs.sora;
      useTarget(p, targets.scene);
      gl.uniform1f(p.u.u_time, skyTime);
      drawWithOcclusion(rects);

      var scene = targets.scene;
      if (camera.defocus > 0.001) {
        p = programs.defocus;
        useTarget(p, targets.lens);
        bindTexture(0, scene.tex, p.u.u_tex);
        drawWithOcclusion(rects);
        scene = targets.lens;
      }

      p = programs.bright;
      useTarget(p, targets.bloomA[0]);
      bindTexture(0, scene.tex, p.u.u_tex);
      gl.uniform2f(p.u.u_px, 1 / targets.bloomA[0].w, 1 / targets.bloomA[0].h);
      draw();

      for (var i = 1; i < 3; i += 1) {
        p = programs.down;
        useTarget(p, targets.bloomA[i]);
        bindTexture(0, targets.bloomA[i - 1].tex, p.u.u_tex);
        gl.uniform2f(p.u.u_px, 1 / targets.bloomA[i - 1].w, 1 / targets.bloomA[i - 1].h);
        draw();
      }

      var low = targets.bloomA[2];
      for (var j = 1; j >= 0; j -= 1) {
        p = programs.up;
        useTarget(p, targets.bloomB[j]);
        bindTexture(0, low.tex, p.u.u_low);
        bindTexture(1, targets.bloomA[j].tex, p.u.u_same);
        gl.uniform2f(p.u.u_px, 1 / targets.bloomB[j].w, 1 / targets.bloomB[j].h);
        draw();
        low = targets.bloomB[j];
      }

      p = programs.final;
      useTarget(p, null);
      bindTexture(0, scene.tex, p.u.u_scene);
      bindTexture(1, targets.bloomB[0].tex, p.u.u_bloom);
      gl.uniform1f(p.u.u_gtime, grainTime);
      draw();

      if (!ready) {
        ready = true;
        frame.classList.add('is-ando-sky-ready');
      }
    }

    function tick(now) {
      if (!running) return;
      raf = window.requestAnimationFrame(tick);
      var elapsed = now - lastTick;
      if (elapsed < 49) return;
      lastTick = now;
      var dt = Math.min(elapsed / 1000, 0.05);
      skyTime += dt * (params.drift || 0.5);
      grainTime += dt;
      render();
      if (!downgraded && dpr > 1) {
        if (elapsed > 75) {
          slowFrames += 1;
          if (slowFrames >= 30) {
            downgraded = true;
            dpr = 1;
            if (resize()) render();
          }
        } else {
          slowFrames = 0;
        }
      }
    }

    function start() {
      if (running || !active || !visible || !intersecting || !targets) return;
      running = true;
      lastTick = performance.now() - 50;
      raf = window.requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function syncRunning() {
      if (active && visible && intersecting) start();
      else stop();
    }

    function setOcclusion(box) {
      if (box) {
        var x0 = Math.max(0, Math.min(1, box.x0));
        var y0 = Math.max(0, Math.min(1, box.y0));
        var x1 = Math.max(0, Math.min(1, box.x1));
        var y1 = Math.max(0, Math.min(1, box.y1));
        occlusion = x1 > x0 && y1 > y0 ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
      } else {
        occlusion = null;
      }
      if (!running && targets && programs) render();
    }

    var observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      intersecting = entries[entries.length - 1].isIntersecting;
      syncRunning();
    }, { threshold: 0 }) : null;
    if (observer) observer.observe(node);

    function onVisibilityChange() {
      visible = !document.hidden;
      syncRunning();
    }

    function onResize() {
      if (resize()) render();
      updateOcclusion();
    }

    function onContextLost(event) {
      event.preventDefault();
      stop();
    }

    function onContextRestored() {
      programs = null;
      targets = null;
      width = 0;
      height = 0;
      downgraded = false;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      initPrograms();
      resize();
      render();
      syncRunning();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('resize', onResize);
    node.addEventListener('webglcontextlost', onContextLost, false);
    node.addEventListener('webglcontextrestored', onContextRestored, false);

    function disposePrograms() {
      if (!programs) return;
      Object.keys(programs).forEach(function (key) {
        gl.deleteProgram(programs[key].id);
      });
      programs = null;
    }

    function dispose() {
      stop();
      if (observer) observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
      node.removeEventListener('webglcontextlost', onContextLost);
      node.removeEventListener('webglcontextrestored', onContextRestored);
      disposeTargets();
      disposePrograms();
      if (buffer) gl.deleteBuffer(buffer);
      if (vao) gl.deleteVertexArray(vao);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    try {
      initPrograms();
      resize();
      render();
      start();
    } catch (error) {
      console.warn('[ando-sky-study] failed to initialize', error);
      dispose();
      return null;
    }

    return {
      setOcclusion: setOcclusion,
      renderOnce: render,
      dispose: dispose
    };
  }

  var renderer = createRenderer(canvas);
  if (!renderer) return;

  function updateOcclusion() {
    if (!occluder) {
      renderer.setOcclusion(null);
      return;
    }
    var frameRect = canvas.getBoundingClientRect();
    if (!frameRect.width || !frameRect.height) return;
    var winRect = occluder.getBoundingClientRect();
    renderer.setOcclusion({
      x0: (winRect.left - frameRect.left) / frameRect.width,
      y0: (winRect.top - frameRect.top) / frameRect.height,
      x1: (winRect.right - frameRect.left) / frameRect.width,
      y1: (winRect.bottom - frameRect.top) / frameRect.height
    });
  }

  var resizeObserver = null;
  if ('ResizeObserver' in window && occluder) {
    resizeObserver = new ResizeObserver(updateOcclusion);
    resizeObserver.observe(canvas);
    resizeObserver.observe(occluder);
  }
  updateOcclusion();
  window.addEventListener('scroll', updateOcclusion, { passive: true });
  window.addEventListener('resize', updateOcclusion, { passive: true });
  window.__miaAndoSkyStudy = {
    renderer: renderer,
    dispose: function () {
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('scroll', updateOcclusion);
      window.removeEventListener('resize', updateOcclusion);
      renderer.dispose();
      frame.classList.remove('ando-sky-study', 'is-ando-sky-ready');
    }
  };
})();
