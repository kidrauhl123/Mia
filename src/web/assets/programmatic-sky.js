(function () {
  'use strict';

  var VERTEX_SHADER = '#version 300 es\n' +
    'layout(location = 0) in vec2 a_position;\n' +
    'void main(){gl_Position=vec4(a_position,0.0,1.0);}';

  var FRAGMENT_SHADER = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform vec2 u_resolution;\n' +
    'uniform float u_time;\n' +
    'uniform float u_seed;\n' +
    'uniform float u_warmth;\n' +
    'uniform float u_clouds;\n' +
    'uniform float u_softness;\n' +
    'uniform float u_drift;\n' +
    'uniform float u_grain;\n' +
    'uniform vec2 u_wind;\n' +
    'out vec4 out_color;\n' +
    'mat2 rotate2d(float angle){float s=sin(angle);float c=cos(angle);return mat2(c,-s,s,c);}\n' +
    'float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(0.1271,0.3117,0.7473));p3+=dot(p3,p3.yzx+19.19);return fract((p3.x+p3.y)*p3.z);}\n' +
    'float valueNoise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);float a=hash12(i);float b=hash12(i+vec2(1.0,0.0));float c=hash12(i+vec2(0.0,1.0));float d=hash12(i+vec2(1.0,1.0));return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}\n' +
    'float fbm(vec2 p){float total=0.0;float amp=0.52;float norm=0.0;mat2 r=rotate2d(0.54);for(int i=0;i<5;i++){total+=valueNoise(p)*amp;norm+=amp;p=r*p*2.04+vec2(5.37,9.19);amp*=0.54;}return total/norm;}\n' +
    'float smokeBlob(vec2 p,vec2 center,vec2 size,float seed,float t,float span){center+=vec2(sin(t*0.018+seed)*0.035,sin(t*0.014+seed*1.9)*0.02);center.x+=round((p.x-center.x)/span)*span;vec2 q=(p-center)/size;vec2 warp=vec2(fbm(q*1.15+vec2(seed,t*0.018)),fbm(q*1.1+vec2(7.0-t*0.014,seed*0.47)));q+=(warp-0.5)*0.62;vec2 q0=q*vec2(0.9,1.08);vec2 q1=(q+vec2(0.78,-0.12))*vec2(1.18,1.0);vec2 q2=(q+vec2(-0.64,0.14))*vec2(1.05,1.16);vec2 q3=(q+vec2(0.06,0.48))*vec2(0.92,1.42);float shape=exp(-dot(q0,q0)*1.05);shape+=exp(-dot(q1,q1)*1.34)*0.58;shape+=exp(-dot(q2,q2)*1.28)*0.62;shape+=exp(-dot(q3,q3)*1.55)*0.36;float broad=fbm(q*vec2(2.6,2.0)+vec2(seed*0.3,t*0.018));float medium=fbm(q*vec2(6.0,4.7)+vec2(-t*0.028,seed));float fine=fbm(q*vec2(15.0,11.0)+vec2(seed*2.1,t*0.045));float erosion=medium*0.2+fine*0.08;return max(shape*(0.54+broad*0.68)-erosion,0.0);}\n' +
    'float smokyCloudscape(vec2 p,float aspect,float t){vec2 crossWind=vec2(-u_wind.y,u_wind.x);vec2 wind=u_wind*t*0.11+crossWind*sin(t*0.08)*0.035;vec2 nearWind=u_wind*t*0.17+crossWind*sin(t*0.1+1.4)*0.045;vec2 far=p-wind;vec2 near=p-nearWind;float span=aspect+1.35;float volume=0.0;volume+=smokeBlob(near,vec2(aspect*0.36,-0.05),vec2(0.82,0.34),1.7,t,span)*1.2;volume+=smokeBlob(far,vec2(aspect*0.88,0.18),vec2(0.56,0.27),5.1,t,span)*0.92;volume+=smokeBlob(near,vec2(aspect*-0.08,0.48),vec2(0.46,0.3),9.4,t,span)*0.9;volume+=smokeBlob(far,vec2(aspect*0.68,1.04),vec2(0.48,0.22),13.6,t,span)*0.76;volume+=smokeBlob(near,vec2(aspect*1.08,0.64),vec2(0.44,0.26),17.2,t,span)*0.78;volume+=smokeBlob(far,vec2(aspect*0.18,0.9),vec2(0.38,0.18),22.8,t,span)*0.5;volume+=smokeBlob(near,vec2(aspect*0.58,0.52),vec2(0.62,0.26),28.4,t,span)*0.72;volume+=smokeBlob(far,vec2(aspect*0.08,0.2),vec2(0.5,0.24),33.1,t,span)*0.58;return clamp(volume,0.0,2.35);}\n' +
    'void main(){vec2 uv=gl_FragCoord.xy/u_resolution;float aspect=u_resolution.x/u_resolution.y;vec2 p=vec2(uv.x*aspect,uv.y);float time=u_time;float lowerSky=pow(1.0-uv.y,1.42);vec3 highBlue=mix(vec3(0.25,0.54,0.82),vec3(0.6,0.43,0.72),u_warmth);vec3 lowBlue=mix(vec3(0.68,0.85,0.98),vec3(1.0,0.75,0.52),u_warmth);vec3 sky=mix(highBlue,lowBlue,lowerSky);vec2 sun=vec2(aspect*0.88,0.84);float sunDistance=distance(p,sun);vec3 sunColor=mix(vec3(1.0,0.97,0.88),vec3(1.0,0.72,0.43),u_warmth);sky+=sunColor*exp(-sunDistance*sunDistance*9.0)*0.22;sky+=sunColor*exp(-sunDistance*3.2)*0.04;vec3 toneWash=mix(vec3(0.36,0.68,1.0),vec3(1.0,0.55,0.28),u_warmth);float toneStrength=mix(0.22,0.42,u_warmth)*(0.56+lowerSky*0.44);sky=mix(sky,toneWash,toneStrength);float cloudSlider=smoothstep(0.12,1.0,u_clouds);vec2 cloudCoord=vec2(p.x,uv.y);vec2 crossWind=vec2(-u_wind.y,u_wind.x);float volume=smokyCloudscape(p,aspect,time);vec2 macroP=cloudCoord-u_wind*time*0.1+crossWind*sin(time*0.06)*0.05;vec2 detailP=cloudCoord-u_wind*time*0.28+crossWind*sin(time*0.12)*0.12;vec2 microP=cloudCoord-u_wind*time*0.52+crossWind*sin(time*0.16)*0.24;float macro=fbm(macroP*vec2(1.12,0.9)+vec2(time*0.025,u_seed*0.2));float detail=fbm(detailP*vec2(5.4,4.2)+vec2(-time*0.055,u_seed*0.61));float micro=fbm(microP*vec2(14.0,10.0)+vec2(time*0.08,u_seed*1.4));float storm=smoothstep(0.68,1.0,cloudSlider);float density=volume*(0.82+macro*0.56)+detail*0.2-micro*0.08;density*=mix(0.98,1.42,cloudSlider);density+=storm*volume*0.28;float threshold=mix(0.78,0.22,cloudSlider);float softness=max(u_softness,0.1);float mist=smoothstep(threshold-0.22*softness,threshold+0.34*softness,density);float cloudGate=smoothstep(threshold,threshold+0.34*softness,density);float core=smoothstep(threshold+0.22*softness,threshold+0.78*softness,density+detail*0.16);float edgeMask=max(max(smoothstep(0.98,0.55,uv.y),smoothstep(0.74,1.0,uv.y)),max(smoothstep(0.12,0.0,uv.x),smoothstep(0.88,1.0,uv.x)));float edgeMist=edgeMask*(0.05+cloudSlider*0.13)*smoothstep(0.26,0.78,macro+detail*0.35);float cloudAlpha=clamp(mist*mix(0.16,0.3,cloudSlider)+cloudGate*mix(0.32,0.62,cloudSlider)+core*mix(0.12,0.24,cloudSlider)+edgeMist,0.0,0.82);float cloudWarmth=u_warmth*0.16;vec3 cloudShade=mix(vec3(0.56,0.64,0.7),vec3(0.72,0.68,0.72),cloudWarmth);vec3 cloudLit=mix(vec3(0.98,0.99,1.0),sunColor*1.05,0.08+0.08*cloudWarmth);vec3 cloudColor=mix(cloudShade,cloudLit,clamp(core*0.92+macro*0.38,0.0,1.0));cloudColor+=vec3(1.0,0.98,0.93)*core*0.12;cloudColor=mix(cloudColor,cloudShade*0.92,detail*mist*0.2);sky=mix(sky,cloudColor,cloudAlpha);sky=mix(sky,vec3(0.95,0.97,0.98),edgeMist*0.28);vec2 center=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;float vignette=pow(max(cos(length(center)*0.86),0.0),2.6);sky*=mix(0.94,1.0,vignette);float sparkle=hash12(gl_FragCoord.xy+floor(u_time*18.0)*37.0)-0.5;sky+=sparkle*u_grain;sky=pow(max(sky,vec3(0.0)),vec3(1.0/2.2));out_color=vec4(sky,1.0);}';

  function compileShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(error || 'shader compile failed');
    }
    return shader;
  }

  function createProgram(gl) {
    var vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    var fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    var program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(error || 'program link failed');
    }
    return program;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function flowToSpeed(flow) {
    var normalized = clamp((flow - 0.12) / 2.88, 0, 1);
    return 0.08 + normalized * normalized * 18;
  }

  function readNumber(node, key, fallback) {
    var value = Number.parseFloat(node.getAttribute(key));
    return Number.isFinite(value) ? value : fallback;
  }

  function initSky(root) {
    var canvas = root.querySelector('.programmatic-sky__canvas');
    if (!canvas) return;
    var gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false
    });
    if (!gl) {
      canvas.style.opacity = '0';
      return;
    }

    var settings = {
      warmth: readNumber(root, 'data-sky-warmth', 0.7),
      clouds: readNumber(root, 'data-sky-clouds', 0.23),
      softness: readNumber(root, 'data-sky-softness', 0.82),
      drift: readNumber(root, 'data-sky-drift', 0.4),
      grain: readNumber(root, 'data-sky-grain', 0.01),
      wind: [1, 0]
    };
    var windRaw = root.getAttribute('data-sky-wind');
    if (windRaw) {
      var parts = windRaw.split(',').map(function (part) { return Number.parseFloat(part.trim()); });
      if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) settings.wind = parts;
    }

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var program;
    try {
      program = createProgram(gl);
    } catch (error) {
      console.warn('Programmatic sky shader failed', error);
      canvas.style.opacity = '0';
      return;
    }

    var uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      time: gl.getUniformLocation(program, 'u_time'),
      seed: gl.getUniformLocation(program, 'u_seed'),
      warmth: gl.getUniformLocation(program, 'u_warmth'),
      clouds: gl.getUniformLocation(program, 'u_clouds'),
      softness: gl.getUniformLocation(program, 'u_softness'),
      drift: gl.getUniformLocation(program, 'u_drift'),
      grain: gl.getUniformLocation(program, 'u_grain'),
      wind: gl.getUniformLocation(program, 'u_wind')
    };
    var vao = gl.createVertexArray();
    var buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    var raf = 0;
    var visible = true;
    var disposed = false;
    var lastFrame = 0;
    var previousTime = 0;
    var cloudTime = 0;
    var width = 0;
    var height = 0;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function draw(now) {
      if (disposed) return;
      if (!visible && !reduceMotion) {
        raf = 0;
        return;
      }
      if (!reduceMotion && now - lastFrame < 33) {
        raf = window.requestAnimationFrame(draw);
        return;
      }
      lastFrame = now;
      var seconds = now * 0.001;
      if (!previousTime) previousTime = seconds;
      var delta = Math.min(0.08, Math.max(0, seconds - previousTime));
      previousTime = seconds;
      if (!reduceMotion) cloudTime += delta * flowToSpeed(settings.drift);
      resize();
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform2f(uniforms.resolution, width, height);
      gl.uniform1f(uniforms.time, reduceMotion ? 0 : cloudTime);
      gl.uniform1f(uniforms.seed, 12.47);
      gl.uniform1f(uniforms.warmth, settings.warmth);
      gl.uniform1f(uniforms.clouds, settings.clouds);
      gl.uniform1f(uniforms.softness, settings.softness);
      gl.uniform1f(uniforms.drift, settings.drift);
      gl.uniform1f(uniforms.grain, settings.grain);
      gl.uniform2f(uniforms.wind, settings.wind[0], settings.wind[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduceMotion) raf = window.requestAnimationFrame(draw);
    }

    var observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1] ? entries[entries.length - 1].isIntersecting : true;
      if (visible && !raf && !reduceMotion) raf = window.requestAnimationFrame(draw);
    }) : null;
    if (observer) observer.observe(canvas);

    var resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(function () {
      draw(performance.now());
    }) : null;
    if (resizeObserver) resizeObserver.observe(canvas);
    window.addEventListener('resize', resize);
    draw(performance.now());
  }

  function initAll() {
    Array.prototype.slice.call(document.querySelectorAll('[data-programmatic-sky]')).forEach(initSky);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once: true });
  } else {
    initAll();
  }
})();
