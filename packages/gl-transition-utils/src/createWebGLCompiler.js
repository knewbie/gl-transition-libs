//@flow
import createShader from "gl-shader";
import createTexture from "gl-texture2d";
import now from "performance-now";
import ndarray from "ndarray";

type Color = [number, number, number, number];

function colorMatches(actual: Color, expected: Color): boolean {
  const dr = actual[0] - expected[0];
  const dg = actual[1] - expected[1];
  const db = actual[2] - expected[2];
  const da = actual[3] - expected[3];
  // we need to be fuzzy because implementation precision can differ
  return dr * dr + dg * dg + db * db + da * da < 10; // euclidian distance < sqrt(10)
}

type CompilerResult = {
  data: {
    compileTime: number,
    drawTime: number,
  },
  errors: Array<{
    type: string,
    message: string,
    code: string,
    id?: string,
    line?: number,
  }>,
};

const pickPositionsForSize = (w, h) => {
  const padX = Math.floor(w / 64);
  const padY = Math.floor(h / 64);
  return [
    [padX, padY],
    [w - 1 - padX, padY],
    [padX, h - 1 - padY],
    [w - 1 - padX, h - 1 - padY],
    [Math.floor(w / 2), Math.floor(h / 2)],
  ];
};
const expectedDraw1Picks = [
  [4, 4, 0, 255],
  [251, 4, 0, 255],
  [4, 251, 0, 255],
  [251, 251, 0, 255],
  [128, 128, 0, 255],
];
const expectedDraw2Picks = [
  [4, 4, 255, 255],
  [251, 4, 255, 255],
  [4, 251, 255, 255],
  [251, 251, 255, 255],
  [128, 128, 255, 255],
];

const debugColor = (c, lbl) => {
  const [r, g, b, a] = c;
  return `${lbl}:rgba(${[r, g, b, a].join(",")})`;
};

const debugPicks = (picks, tests) =>
  picks
    .map((c, i) => (!tests[i] ? debugColor(c, i) : ""))
    .filter(f => f)
    .join(" ");

const VERTEX_SHADER = `attribute vec2 _p;
varying vec2 _uv;
void main() {
gl_Position = vec4(_p,0.0,1.0);
_uv = vec2(0.5, 0.5) * (_p+vec2(1.0, 1.0));
}`;

export default (gl: WebGLRenderingContext) => {
  const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
  const pixels = new Uint8Array(w * h * 4);
  const pickPositions = pickPositionsForSize(w, h);

  function colorAt([x, y]) {
    const i = (x + y * w) * 4;
    const r = pixels[i + 0];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    return [r, g, b, a];
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -1, 4, 4, -1]), // see a-big-triangle
    gl.STATIC_DRAW
  );
  gl.viewport(0, 0, w, h);

  const genericTexture = createTexture(
    gl,
    ndarray(
      // prettier-ignore
      [ 0.1, 0.1, 0.1, 1.0,
        0.5, 0.5, 0.5, 1.0,
        0.5, 0.5, 0.5, 1.0,
        0.9, 0.9, 0.9, 1.0 ],
      [2, 2, 4]
    )
  );
  genericTexture.minFilter = gl.LINEAR;
  genericTexture.magFilter = gl.LINEAR;

  return ({ glsl, paramsTypes, defaultParams }): CompilerResult => {
    let data = {
      compileTime: 0,
      drawTime: 0,
    };
    const errors = [];
    let shader;
    try {
      const beforeCompilation = now();
      shader = createShader(
        gl,
        VERTEX_SHADER,
        `precision highp float;varying vec2 _uv;uniform float progress, ratio;vec4 getFromColor (vec2 uv) { return vec4(uv, 0.0, 1.0); } vec4 getToColor (vec2 uv) { return vec4(uv, 1.0, 1.0); } ${glsl}
  void main () {
    gl_FragColor = transition(_uv);
  }`
      );
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // this is just to force trigger a flush
      const afterCompilation = now();
      data.compileTime = afterCompilation - beforeCompilation;

      // We now will check the transition is correctly rendering the {from, to} images in progress={0, 1}
      // leaving all transition params to default zero value should not affect a transition to "work"

      shader.bind();
      shader.attributes._p.pointer();

      for (let key in shader.types.uniforms) {
        if (shader.types.uniforms[key] === "sampler2D") {
          shader.uniforms[key] = genericTexture.bind();
        } else {
          if (key in defaultParams) {
            shader.uniforms[key] = defaultParams[key];
          }
        }
      }

      for (let key in paramsTypes) {
        if (!(key in shader.uniforms)) {
          errors.push({
            code: "Transition_unused_uniforms",
            id: key,
            type: "warn",
            message: `The uniform '${key}' is defined but never used. use it or drop it.`,
          });
        }
      }

      shader.uniforms.ratio = w / h;

      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // this is just to force trigger a flush
      const beforeDraw1 = now();
      shader.uniforms.progress = 0;
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // we need to put this in the scope because impl like Chrome are lazy and this really trigger the work.
      const afterDraw1 = now();
      const draw1PixelsPicks = pickPositions.map(colorAt);

      const beforeDraw2 = now();
      shader.uniforms.progress = 1;
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const afterDraw2 = now();
      const draw2PixelsPicks = pickPositions.map(colorAt);

      const drawErrorMessages = [];
      const drawErrorDebug = [];

      const draw1Tests = draw1PixelsPicks.map((pick, i) =>
        colorMatches(pick, expectedDraw1Picks[i])
      );
      if (!draw1Tests.every(valid => valid)) {
        if (
          draw1PixelsPicks
            .map((pick, i) => colorMatches(pick, expectedDraw2Picks[i]))
            .every(valid => valid)
        ) {
          drawErrorMessages.push(
            "getFromColor(uv) MUST render when progress=0.0 but NOT getToColor(uv)"
          );
        } else {
          drawErrorMessages.push(
            "getFromColor(uv) MUST render when progress=0.0"
          );
          drawErrorDebug.push(debugPicks(draw1PixelsPicks, draw1Tests));
        }
      }

      const draw2Tests = draw2PixelsPicks.map((pick, i) =>
        colorMatches(pick, expectedDraw2Picks[i])
      );
      if (!draw2Tests.every(valid => valid)) {
        if (
          draw2PixelsPicks
            .map((pick, i) => colorMatches(pick, expectedDraw1Picks[i]))
            .every(valid => valid)
        ) {
          drawErrorMessages.push(
            "getToColor(uv) MUST render when progress=1.0 but NOT getFromColor(uv)"
          );
        } else {
          drawErrorMessages.push(
            "getToColor(uv) MUST render when progress=1.0"
          );
          drawErrorDebug.push(debugPicks(draw2PixelsPicks, draw2Tests));
        }
      }

      if (drawErrorMessages.length > 0) {
        errors.push({
          code: "Transition_draw_invalid",
          type: "error",
          message: "invalid transition: " +
            drawErrorMessages.join(", ") +
            (drawErrorDebug.length
              ? " – " + " DEBUG: " + drawErrorDebug.join(" ; ")
              : ""),
        });
      }

      const drawTime1 = afterDraw1 - beforeDraw1;
      const drawTime2 = afterDraw2 - beforeDraw2;
      // average of the 2 draws for even better precision
      data.drawTime = (drawTime1 + drawTime2) / 2;
    } catch (e) {
      let error;
      const lines = e.message.split("\n");
      for (let _i = 0, _len = lines.length; _i < _len; _i++) {
        const i = lines[_i];
        if (i.substr(0, 5) === "ERROR") {
          error = i;
        }
      }
      if (!error) {
        errors.push({
          line: 0,
          code: "WebGL_unknown_error",
          type: "error",
          message: "Unknown error: " + e.message,
        });
      } else {
        const details = error.split(":");
        if (details.length < 4) {
          errors.push({
            line: 0,
            code: "WebGL_error",
            type: "error",
            message: error,
          });
        } else {
          const lineStr = details[2];
          let line = parseInt(lineStr, 10);
          if (isNaN(line)) line = 0;
          const message = details.splice(3).join(":");
          errors.push({
            line,
            code: "WebGL_error",
            type: "error",
            message,
          });
        }
      }
    } finally {
      if (shader) shader.dispose();
    }
    return {
      data,
      errors,
    };
  };
};
