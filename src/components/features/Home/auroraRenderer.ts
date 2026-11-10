// 光の裾と上へ溶ける細い筋を、奥行きの異なる4枚のカーテンとして描く。
// テクスチャ・乱数の再生成・音声APIは使わず、時間と共有メーターの強さだけを受け取る。
const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
const FRAGMENT = `
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float energy;
uniform vec3 green;
uniform vec3 teal;
uniform vec3 rose;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) {
    float i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), f);
}
void main() {
    vec2 uv = gl_FragCoord.xy / resolution;
    vec3 light = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        float layer = float(i);
        float t = time * (0.23 + layer * 0.037);
        float x = uv.x * (6.5 + layer * 1.2) + layer * 7.3;
        // 大きな流れに細かいひだを重ね、裾・光の筋・色が同じ面として動く。
        float fold = x + 0.7 * sin(x * 1.3 - t) + 0.24 * sin(x * 3.7 + t * 1.4);
        float hem = 0.22 + layer * 0.065 + 0.12 * sin(x * 0.8 + t)
            + 0.055 * sin(fold * 2.2 - t * 0.6);
        float above = uv.y - hem;
        float bent = fold + above * 0.22 * sin(x * 0.7 + t + above * 3.0);
        float rays = pow(noise(bent * 38.0 - t * 1.8), 2.0);
        float silk = 0.38 + 0.62 * noise(fold * 9.0 + t * 0.4);
        float reach = 0.16 + 0.13 * silk + energy * 0.1;
        float body = exp(-max(above, 0.0) / reach) * smoothstep(-0.025, 0.025, above);
        float edge = exp(-abs(above) * 90.0) * (0.55 + 0.45 * silk);
        float threads = (0.15 + 0.85 * rays) * body;
        float crown = smoothstep(0.12, 0.5, above);
        vec3 color = mix(green, teal, smoothstep(0.02, 0.3, above));
        color = mix(color, rose, crown * 0.65);
        float depth = (0.5 + layer * 0.14) * (0.7 + energy * 0.6);
        light += color * (threads * 0.65 + edge * 0.38) * depth;
    }
    float vignette = smoothstep(0.0, 0.14, uv.x) * smoothstep(0.0, 0.14, 1.0 - uv.x)
        * smoothstep(0.0, 0.12, uv.y) * smoothstep(0.0, 0.2, 1.0 - uv.y);
    light = (1.0 - exp(-light * 1.6)) * vignette;
    // 透過合成でテーマの面色を残す。中央の文字の背面は既存のサーフェスが守る。
    gl_FragColor = vec4(light, clamp(max(light.r, max(light.g, light.b)) * 1.3, 0.0, 0.88));
}
`;

export function createAuroraRenderer(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const dispose = () => {
        shaders.forEach(shader => gl.deleteShader(shader));
        gl.deleteBuffer(buffer); gl.deleteProgram(program);
    };
    if (!program || !buffer) { dispose(); return null; }
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type);
        if (!shader) { dispose(); return null; }
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { dispose(); return null; }
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, 'resolution');
    const time = gl.getUniformLocation(program, 'time');
    const energy = gl.getUniformLocation(program, 'energy');
    const palette = ['green', 'teal', 'rose'].map(name => ({ name, location: gl.getUniformLocation(program, name) }));
    return {
        refreshPalette() {
            const css = getComputedStyle(canvas);
            for (const { name, location } of palette) {
                const [hue, saturation, lightness] = css.getPropertyValue(`--aurora-${name}`).trim().split(/\s+/).map(parseFloat);
                const h = hue / 30, s = saturation / 100, l = lightness / 100;
                const a = s * Math.min(l, 1 - l);
                const channel = (n: number) => { const k = (n + h) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
                gl.uniform3f(location, channel(0), channel(8), channel(4));
            }
        },
        draw(seconds: number, strength: number) {
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.uniform2f(resolution, canvas.width, canvas.height);
            gl.uniform1f(time, seconds); gl.uniform1f(energy, strength);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
        dispose,
    };
}
