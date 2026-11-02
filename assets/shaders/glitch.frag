#version 300 es
// Capri's glitch over the whole screen, for a split second: her colors knocked out of register,
// slices of the picture torn sideways, scanlines and a red cast (Hyprland's screen_shader).
// No clock uniform (Hyprland would want damage tracking off for one): hyprland.js writes a few copies
// with a different SEED and flips through them, one per frame.
precision highp float;
#define SEED 0.0
#define AMOUNT 1.0
in vec2 v_texcoord;
uniform sampler2D tex;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
    vec2 uv = v_texcoord;
    float t = SEED; // which frame of her glitch this copy is

    // a few horizontal bands, torn sideways
    float band = floor(uv.y * 18.0);
    float tear = hash(band + t * 7.0);
    if (tear > 0.72) uv.x += (hash(band * 3.1 + t) - 0.5) * 0.08 * AMOUNT;

    // a thin strip jumping somewhere each frame
    float strip = hash(t * 1.7);
    if (abs(uv.y - strip) < 0.012) uv.x += 0.04 * AMOUNT;

    // her colors out of register: red one way, cyan the other
    float split = (0.006 + 0.01 * hash(t + 3.0)) * AMOUNT;
    float r = texture(tex, uv + vec2(split, 0.0)).r;
    vec4 mid = texture(tex, uv);
    float b = texture(tex, uv - vec2(split, 0.0)).b;
    vec3 col = vec3(r, mid.g, b);

    // scanlines and a red cast (#ff2152)
    col *= 0.88 + 0.12 * sin(v_texcoord.y * 900.0);
    col = mix(col, vec3(1.0, 0.13, 0.32), 0.10 * AMOUNT);

    fragColor = vec4(col, mid.a);
}
