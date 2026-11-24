import { state } from './state.js';
import { takeDirtyRects, terrainVersion, cellView, mapWidth, mapHeight, mapSizeVersion, fogEnabled, fogVersion, fogLayers, isCellVisible } from './simBridge.js';
import { isTyping } from './typing.js';
import { BuildingLayer } from './buildingLayer.js';
import { factionHexColors, factionRGB, BUILDING_RADIUS, SILO_RANGE, MISSILE_BLAST_RADIUS, ANTIAIR_RADIUS, MAX_FACTIONS, BUILDING_LINKS, LINK_RADIUS, RADAR_RANGE_MULT } from './constants.js';

// Per-faction shader arrays: index 0 = neutral, 1..MAX_FACTIONS = players.
const FACTION_SLOTS = MAX_FACTIONS + 1;


// Compact troop count formatting where "k" = thousand and "kk" = million.
//   <1000        -> as-is            (100, 200, 999)
//   1000..9999   -> one decimal + k  (1.1k, 2.2k, 9.9k)
//   10000..999999-> integer + k      (10k, 12k, 99k, 100k)
//   >=1_000_000  -> one decimal + kk (1.1kk, 1.2kk), integer kk past 10 million
// Decimals are floored (never rounded up) so 9999 reads "9.9k", not "10.0k".
function formatTroops(n) {
    n = Math.max(0, Math.floor(n));
    if (n < 1000) return String(n);
    const units = ['k', 'kk', 'kkk'];
    let v = n;
    let u = -1;
    while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
    if (v < 10) {
        // One decimal place, floored: floor(v * 10) / 10.
        return (Math.floor(v * 10) / 10).toFixed(1) + units[u];
    }
    return Math.floor(v) + units[u];
}
window.formatAbbreviation = formatTroops;

// Label font size scales with a faction's territory size (owned cells), using
// the territory's linear extent (~sqrt of area) so a region twice as wide gets
// a roughly twice-as-big label. Clamped to a readable [MIN, MAX] range.
const LABEL_MIN_PX = 11;
const LABEL_MAX_PX = 34;
function territoryLabelSize(cells) {
    const extent = Math.sqrt(Math.max(0, cells));
    // extent ~30 (~900 cells) hits the floor; ~400 (~160k cells) hits the cap.
    const t = (extent - 30) / (400 - 30);
    return LABEL_MIN_PX + (LABEL_MAX_PX - LABEL_MIN_PX) * Math.min(1, Math.max(0, t));
}



// ── Terrain bake ────────────────────────────────────────────────────────────
// The terrain never changes during a match, so its look — colour, relief
// shading, coast — is painted ONCE per map into an RGBA texture (one texel per
// cell, sampled with linear filtering) instead of being recomputed for every
// pixel every frame. The main shader then reads one texel per pixel.
const TERRAIN_BAKE_FS = `#version 300 es
            precision highp float;
            precision highp usampler2D;
            uniform usampler2D u_cell_tex;
            uniform vec2 u_map_size;
            out vec4 outColor;
            // ── Terrain look ─────────────────────────────────────────────
            // Terrain codes (bits 7-10, see TERRAIN in mapGen.js): 0 plains,
            // 1 highlands, 2 mountains, 3 water, 4 forest, 5 river (ford),
            // 6 gold deposit, 7 ruins.
            float hash12(vec2 p) {
                vec3 p3 = fract(vec3(p.xyx) * 0.1031);
                p3 += dot(p3, p3.yzx + 33.33);
                return fract((p3.x + p3.y) * p3.z);
            }
            float vnoise(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
                           mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
            }
            uint terrainAt(ivec2 tc) {
                return (texelFetch(u_cell_tex, clamp(tc, ivec2(0), ivec2(u_map_size) - 1), 0).r >> 7u) & 15u;
            }
            // Height of a terrain type, for the relief shading.
            float typeHeight(uint t) {
                if (t == 3u) return 0.0;   // water
                if (t == 5u) return 0.12;  // river
                if (t == 2u) return 1.0;   // mountains
                if (t == 1u) return 0.55;  // highlands
                if (t == 4u) return 0.34;  // forest canopy
                if (t == 7u) return 0.32;  // ruins
                return 0.25;               // plains, gold
            }
            // Ruggedness of a terrain type (noise amplitude).
            float typeRough(uint t) {
                if (t == 2u) return 0.55;
                if (t == 1u) return 0.25;
                if (t == 4u) return 0.18;
                return 0.04;
            }
            float heightAt(ivec2 tc, vec2 w) {
                uint t = terrainAt(tc);
                return typeHeight(t) + typeRough(t) * vnoise(w * 0.15);
            }
            // Base colour of a terrain type at world position w (cell units).
            vec3 terrainColor(uint t, vec2 w) {
                float n = vnoise(w * 0.09);
                float fine = hash12(floor(w));
                if (t == 3u) {
                    // Sea: deeper away from the coast (set by the caller), subtle swell.
                    return mix(vec3(0.20, 0.42, 0.62), vec3(0.24, 0.48, 0.68), n);
                }
                if (t == 0u) return mix(vec3(0.78, 0.85, 0.62), vec3(0.72, 0.81, 0.55), n) * (0.97 + 0.04 * fine);
                if (t == 1u) return mix(vec3(0.83, 0.76, 0.56), vec3(0.76, 0.68, 0.48), n) * (0.97 + 0.04 * fine);
                if (t == 2u) {
                    vec3 rock = mix(vec3(0.60, 0.57, 0.53), vec3(0.50, 0.48, 0.46), n);
                    // Snow on the higher crests.
                    float snow = smoothstep(0.80, 0.90, vnoise(w * 0.035) * 0.7 + n * 0.35);
                    return mix(rock, vec3(0.90, 0.91, 0.93), snow * 0.85) * (0.96 + 0.06 * fine);
                }
                if (t == 4u) {
                    // Forest: dark green with tree-crown speckle.
                    float crown = step(0.55, hash12(floor(w * 0.5)));
                    return mix(vec3(0.36, 0.55, 0.30), vec3(0.28, 0.45, 0.24), crown) * (0.95 + 0.08 * n);
                }
                if (t == 5u) return mix(vec3(0.42, 0.66, 0.82), vec3(0.50, 0.73, 0.86), n);
                if (t == 6u) {
                    // Gold deposit: warm ochre with glints.
                    float glint = step(0.93, fine);
                    return mix(mix(vec3(0.86, 0.72, 0.36), vec3(0.93, 0.80, 0.42), n), vec3(1.0, 0.95, 0.70), glint);
                }
                if (t == 7u) {
                    // Ruins: stone blocks on dry ground.
                    vec2 b = fract(w * 0.25);
                    float block = step(0.18, b.x) * step(0.18, b.y) * step(0.45, hash12(floor(w * 0.25)));
                    return mix(vec3(0.69, 0.62, 0.52), vec3(0.52, 0.47, 0.42), block);
                }
                return vec3(1.0, 1.0, 0.0); // debug: unknown terrain
            }
            // Hill shading and coast: light from the north-west on a height
            // field made of the terrain types plus noise.
            float reliefShade(ivec2 tc, vec2 w) {
                float h0 = heightAt(tc, w);
                float hr = heightAt(tc + ivec2(2, 0), w + vec2(2.0, 0.0));
                float hd = heightAt(tc + ivec2(0, 2), w + vec2(0.0, 2.0));
                vec3 n = normalize(vec3(h0 - hr, h0 - hd, 0.28));
                float lit = dot(n, normalize(vec3(-0.6, -0.7, 0.6)));
                return clamp(0.62 + 0.48 * lit, 0.70, 1.12);
            }
            // 0 = open sea, 1 = right at the coast (shallow, lighter water).
            float shallowness(ivec2 tc) {
                float s = 0.0;
                for (int k = 1; k <= 2; k++) {
                    int r = k * 4;
                    if (terrainAt(tc + ivec2( r, 0)) != 3u || terrainAt(tc + ivec2(-r, 0)) != 3u ||
                        terrainAt(tc + ivec2(0,  r)) != 3u || terrainAt(tc + ivec2(0, -r)) != 3u) {
                        s = max(s, 1.0 - float(k - 1) * 0.5);
                    }
                }
                return s;
            }


            void main() {
                ivec2 tc = ivec2(gl_FragCoord.xy);
                vec2 w = vec2(tc) + 0.5;
                uint t = terrainAt(tc);
                vec3 c = terrainColor(t, w);
                if (t == 3u) {
                    float sh = shallowness(tc);
                    c = mix(c, vec3(0.47, 0.74, 0.86), 0.65 * sh);
                    if (terrainAt(tc + ivec2(1, 0)) != 3u || terrainAt(tc + ivec2(-1, 0)) != 3u ||
                        terrainAt(tc + ivec2(0, 1)) != 3u || terrainAt(tc + ivec2(0, -1)) != 3u) {
                        c = mix(c, vec3(0.92, 0.96, 0.98), 0.45); // surf line
                    }
                } else {
                    c *= reliefShade(tc, w);
                }
                outColor = vec4(c, 1.0);
            }
`;

export class WebGLRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        // The map's size in cells (the room's — see simBridge.setMapSize);
        // the textures are (re)allocated when it changes.
        this.mapW = mapWidth();
        this.mapH = mapHeight();
        this.mapSizeVer = mapSizeVersion();
        // Per-frame upload accounting (read by scripts/bench-render.mjs via ?debug).
        this.stats = { frames: 0, uploads: 0, uploadedBytes: 0, uploadMs: 0 };
        this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!this.gl) throw new Error("WebGL2 not supported");

        this.camera = { x: 0, y: 0, zoom: 1.0 };
        // Camera keys held down, by PHYSICAL key (KeyboardEvent.code), so the
        // W/A/S/D positions work on any layout (AZERTY types Z/Q there).
        this.keys = { up: false, down: false, left: false, right: false };

        // The packed cells (u16/cell: owner + terrain + defense + building)
        // live in simBridge; this is their GPU copy.
        this.cellTexture = null;

        // Per-faction troop density ratio (troops-per-cell / DIFFICULTY_CAP, 0..1),
        // indexed by owner id 0..MAX_FACTIONS. Combined with terrain cost in the
        // shader to produce per-cell opacity. Updated on every sim-stats message.
        this.playerOpacity = new Float32Array(FACTION_SLOTS).fill(1.0);

        this.initShaders();
        this.initBuffers();
        this.initTextures();
        this.setupControls();

        // Handle resizing
        window.addEventListener('resize', () => this.resize());
        this.resize();
        
        this.lastTime = performance.now();
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.fitCameraToMap();
    }

    // Fit the whole map on screen and centre it (contain), with a small margin.
    fitCameraToMap() {
        this.camera.zoom = Math.min(this.canvas.width / this.mapW, this.canvas.height / this.mapH) * 0.98;
        this.camera.x = (this.mapW / 2) - (this.canvas.width / 2) / this.camera.zoom;
        this.camera.y = (this.mapH / 2) - (this.canvas.height / 2) / this.camera.zoom;
    }

    initShaders() {
        const vsSource = `#version 300 es
            layout(location = 0) in vec2 a_position;
            out vec2 v_uv;
            void main() {
                // Map from [-1, 1] to [0, 1]
                v_uv = a_position * 0.5 + 0.5;
                // Flip Y because WebGL textures are Y-up but our map is Y-down
                v_uv.y = 1.0 - v_uv.y;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const fsSource = `#version 300 es
            precision highp float;
            precision highp usampler2D;

            in vec2 v_uv;
            out vec4 outColor;

            // One u16 per cell: owner (bits 0-6), terrain (bits 7-10),
            // defense (bits 11-14), has-building (bit 15).
            uniform usampler2D u_cell_tex;
            // The terrain's look, painted once per map (TERRAIN_BAKE_FS).
            uniform sampler2D u_terrain_tex;

            uniform vec2 u_resolution;
            uniform vec2 u_camera_pos;
            uniform float u_zoom;
            uniform vec2 u_map_size;

            // Fog of war (simBridge fog layers, one texel per 8×8 block):
            // u_vis_tex 1 = this player sees the block (linear filtering softens
            // the fog's edge), u_coarse_tex the block's owner (what fogged
            // land shows). u_fog_on 0 = no fog (pre-match, spectating).
            uniform sampler2D u_vis_tex;
            uniform usampler2D u_coarse_tex;
            uniform float u_fog_on;

            // Per-faction troop density ratio (troops-per-cell / DIFFICULTY_CAP, 0..1).
            // Combined per-pixel with the cell's terrain cost to produce per-cell opacity:
            // mountains in a dense empire render fully solid; plains in a weak one stay faint.
            uniform float u_player_opacity[${FACTION_SLOTS}];

            // The local player's faction id (0 when spectating/pre-game). Their own
            // frontier is drawn as a bright highlight; all other borders are dark.
            uniform uint u_my_faction;

            // Per-faction territory color (index 0 = neutral, unused). Uploaded once
            // from factionRGB in constants.js — the SAME source the building icons
            // and HUD use — so a faction's territory matches its icon/label color.
            uniform vec3 u_palette[${FACTION_SLOTS}];

            // Troop cost of a terrain type for the territory opacity (lib.rs terrain_cost).
            float terrainCost(uint t) {
                if (t == 1u) return 3.0;
                if (t == 2u) return 6.0;
                if (t == 4u) return 4.0;
                if (t == 5u) return 5.0;
                if (t == 7u) return 6.0;
                if (t == 3u) return 0.0;
                return 1.0;
            }

            uint ownerAt(ivec2 tc) {
                return texelFetch(u_cell_tex, tc, 0).r & 127u;
            }

            // The territory tint of a single cell: faction colour × opacity in
            // rgb, opacity in a (0 for neutral). Mirrors the per-cell opacity
            // model: difficulty = (density + terrain) * defTier. The terrain
            // colour under it is computed once per pixel in main().
            vec4 tintAt(ivec2 tc) {
                uint packed = texelFetch(u_cell_tex, tc, 0).r;
                uint ownerVal = packed & 127u;
                if (ownerVal == 0u || ownerVal > ${MAX_FACTIONS}u) return vec4(0.0);
                uint terrainVal = (packed >> 7u) & 15u;
                uint defTierRaw = (packed >> 11u) & 15u;
                float defTier = float(defTierRaw == 0u ? 1u : defTierRaw);
                float diffNorm = clamp((u_player_opacity[ownerVal] + terrainCost(terrainVal) / 25.0) * defTier, 0.0, 1.0);
                // Territory is tinted, never painted over: the terrain stays
                // readable underneath (at most 82% faction colour).
                float opacity = 0.18 + 0.64 * diffNorm;
                return vec4(u_palette[ownerVal] * opacity, opacity);
            }

            void main() {
                // Calculate map coordinate based on screen UV, camera pos, and zoom
                vec2 pixelCoord = v_uv * u_resolution;
                vec2 worldCoord = (pixelCoord / u_zoom) + u_camera_pos;

                // Debug: if out of bounds, draw a grey backdrop so the map border reads clearly.
                if (worldCoord.x < 0.0 || worldCoord.x >= u_map_size.x ||
                    worldCoord.y < 0.0 || worldCoord.y >= u_map_size.y) {
                    outColor = vec4(0.20, 0.20, 0.22, 1.0);
                    return;
                }

                ivec2 sz = ivec2(u_map_size);
                ivec2 nearest = ivec2(worldCoord);

                // --- Fog of war: last-known coarse empires over darkened terrain ---
                float seen = u_fog_on > 0.5 ? texture(u_vis_tex, worldCoord / u_map_size).r : 1.0;
                vec3 fogColor = vec3(0.0);
                if (seen < 0.999) {
                    vec3 ter = texture(u_terrain_tex, worldCoord / u_map_size).rgb;
                    float grey = dot(ter, vec3(0.3, 0.59, 0.11));
                    fogColor = mix(ter, vec3(grey), 0.55) * 0.5;
                    uint co = texelFetch(u_coarse_tex, nearest >> 3, 0).r;
                    if (co > 0u && co <= ${MAX_FACTIONS}u) fogColor = mix(fogColor, u_palette[co] * 0.55, 0.38);
                    if (seen < 0.001) { outColor = vec4(fogColor, 1.0); return; }
                }

                uint ownerVal = ownerAt(nearest);

                // --- High-zoom smoothing ---
                // Bilinearly blend the 4 cells surrounding the sample point so contiguous
                // territory no longer reads as hard squares when zoomed in. Only neighbors
                // that share the nearest cell's owner contribute their own fill; a
                // differing-owner neighbor falls back to the nearest cell's fill, so
                // faction boundaries stay crisp (no muddy cross-faction color bleed).
                vec2 fp = worldCoord - 0.5;
                ivec2 c0 = ivec2(floor(fp));
                vec2 frac = fp - vec2(c0);
                ivec2 c00 = clamp(c0,               ivec2(0), sz - 1);
                ivec2 c10 = clamp(c0 + ivec2(1, 0), ivec2(0), sz - 1);
                ivec2 c01 = clamp(c0 + ivec2(0, 1), ivec2(0), sz - 1);
                ivec2 c11 = clamp(c0 + ivec2(1, 1), ivec2(0), sz - 1);
                vec4 nearestTint = tintAt(nearest);
                vec4 t00 = (ownerAt(c00) == ownerVal) ? tintAt(c00) : nearestTint;
                vec4 t10 = (ownerAt(c10) == ownerVal) ? tintAt(c10) : nearestTint;
                vec4 t01 = (ownerAt(c01) == ownerVal) ? tintAt(c01) : nearestTint;
                vec4 t11 = (ownerAt(c11) == ownerVal) ? tintAt(c11) : nearestTint;
                vec4 tint = mix(mix(t00, t10, frac.x), mix(t01, t11, frac.x), frac.y);

                // The baked terrain (colour, relief, coast), then the territory tint
                // over it — the terrain stays readable under every empire.
                vec3 terrainCol = texture(u_terrain_tex, worldCoord / u_map_size).rgb;
                vec3 baseColor = terrainCol * (1.0 - tint.a) + tint.rgb;

                // --- Crisp faction borders (decided on the nearest cell's owner) ---
                if (ownerVal > 0u && ownerVal <= ${MAX_FACTIONS}u) {
                    // Sample neighbors at a cell distance that grows as we zoom out, so
                    // the outline stays ~constant width on screen at any zoom (a flat
                    // 1-cell line vanishes when the whole map is fit to the screen).
                    int bw = int(clamp(floor(1.0 / u_zoom + 0.5), 1.0, 6.0));
                    // Out-of-bounds counts as the same owner so the map edge isn't outlined.
                    uint nl = (nearest.x - bw >= 0)    ? ownerAt(nearest + ivec2(-bw, 0)) : ownerVal;
                    uint nr = (nearest.x + bw < sz.x)  ? ownerAt(nearest + ivec2( bw, 0)) : ownerVal;
                    uint nu = (nearest.y - bw >= 0)    ? ownerAt(nearest + ivec2( 0,-bw)) : ownerVal;
                    uint nd = (nearest.y + bw < sz.y)  ? ownerAt(nearest + ivec2( 0, bw)) : ownerVal;

                    if (nl != ownerVal || nr != ownerVal || nu != ownerVal || nd != ownerVal) {
                        if (u_my_faction > 0u && ownerVal == u_my_faction) {
                            // The player's own frontier: bright gold so you instantly
                            // see the edge of your empire.
                            baseColor = mix(baseColor, vec3(1.0, 0.92, 0.45), 0.85);
                        } else {
                            // Every other border: a crisp near-black outline.
                            baseColor = mix(baseColor, vec3(0.04, 0.04, 0.06), 0.72);
                        }
                    }
                } else if (ownerVal > ${MAX_FACTIONS}u) {
                    baseColor = vec3(1.0, 0.0, 0.0); // debug: out-of-range owner
                }

                outColor = vec4(mix(fogColor, baseColor, seen), 1.0);
            }
        `;

        const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);

        this.program = this.gl.createProgram();
        this.gl.attachShader(this.program, vertexShader);
        this.gl.attachShader(this.program, fragmentShader);
        this.gl.linkProgram(this.program);

        if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
            throw new Error('Program link failed: ' + this.gl.getProgramInfoLog(this.program));
        }

        // Terrain bake program (same full-screen quad, attribute location 0).
        this.bakeProgram = this.gl.createProgram();
        this.gl.attachShader(this.bakeProgram, this.compileShader(this.gl.VERTEX_SHADER, vsSource));
        this.gl.attachShader(this.bakeProgram, this.compileShader(this.gl.FRAGMENT_SHADER, TERRAIN_BAKE_FS));
        this.gl.linkProgram(this.bakeProgram);
        if (!this.gl.getProgramParameter(this.bakeProgram, this.gl.LINK_STATUS)) {
            throw new Error('Terrain program link failed: ' + this.gl.getProgramInfoLog(this.bakeProgram));
        }
        this.bakeUniforms = {
            mapSize: this.gl.getUniformLocation(this.bakeProgram, 'u_map_size'),
            cellTex: this.gl.getUniformLocation(this.bakeProgram, 'u_cell_tex'),
        };

        this.gl.useProgram(this.program);

        this.uniforms = {
            resolution: this.gl.getUniformLocation(this.program, 'u_resolution'),
            cameraPos: this.gl.getUniformLocation(this.program, 'u_camera_pos'),
            zoom: this.gl.getUniformLocation(this.program, 'u_zoom'),
            mapSize: this.gl.getUniformLocation(this.program, 'u_map_size'),
            cellTex: this.gl.getUniformLocation(this.program, 'u_cell_tex'),
            playerOpacity: this.gl.getUniformLocation(this.program, 'u_player_opacity'),
            myFaction: this.gl.getUniformLocation(this.program, 'u_my_faction'),
            palette: this.gl.getUniformLocation(this.program, 'u_palette'),
            terrainTex: this.gl.getUniformLocation(this.program, 'u_terrain_tex'),
            visTex: this.gl.getUniformLocation(this.program, 'u_vis_tex'),
            coarseTex: this.gl.getUniformLocation(this.program, 'u_coarse_tex'),
            fogOn: this.gl.getUniformLocation(this.program, 'u_fog_on'),
        };
        this.gl.uniform1i(this.uniforms.terrainTex, 1); // Texture unit 1
        this.gl.uniform1i(this.uniforms.visTex, 2);     // Texture unit 2
        this.gl.uniform1i(this.uniforms.coarseTex, 3);  // Texture unit 3

        this.gl.uniform2f(this.uniforms.mapSize, this.mapW, this.mapH);
        this.gl.uniform1i(this.uniforms.cellTex, 0); // Texture unit 0

        // Upload the faction palette once (it's static). Built from factionRGB so
        // territory fill matches the building icons / HUD; index 0 (neutral) stays
        // black and is never sampled (only owners 1..MAX_FACTIONS read u_palette).
        const palette = new Float32Array(FACTION_SLOTS * 3);
        for (let i = 1; i <= MAX_FACTIONS; i++) {
            const rgb = factionRGB[i] || [128, 128, 128];
            palette[i * 3]     = rgb[0] / 255;
            palette[i * 3 + 1] = rgb[1] / 255;
            palette[i * 3 + 2] = rgb[2] / 255;
        }
        this.gl.uniform3fv(this.uniforms.palette, palette);
    }

    compileShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compile failed:', this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    initBuffers() {
        this.vao = this.gl.createVertexArray();
        this.gl.bindVertexArray(this.vao);

        // Full screen quad
        const positions = new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
            -1.0,  1.0,
             1.0, -1.0,
             1.0,  1.0,
        ]);

        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);

        const positionAttributeLocation = this.gl.getAttribLocation(this.program, "a_position");
        this.gl.enableVertexAttribArray(positionAttributeLocation);
        this.gl.vertexAttribPointer(positionAttributeLocation, 2, this.gl.FLOAT, false, 0, 0);
    }

    initTextures() {
        // Single packed-cell texture (R16UI - 16-bit unsigned integer per cell).
        this.cellTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R16UI, this.mapW, this.mapH, 0, this.gl.RED_INTEGER, this.gl.UNSIGNED_SHORT, null);

        // Baked terrain look (RGBA8, one texel per cell, linear filtering so
        // it stays smooth when zoomed in) and the framebuffer to paint it.
        this.terrainTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.terrainTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, this.mapW, this.mapH, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        this.terrainFbo = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.terrainFbo);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.terrainTexture, 0);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.bakedTerrainVersion = -1;

        // Fog layers, one texel per 8×8 block (uploaded when they change).
        const { bw, bh } = fogLayers();
        const blockTex = (internal, format, filter) => {
            const t = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, t);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, filter);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, filter);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, internal, bw, bh, 0, format, this.gl.UNSIGNED_BYTE, null);
            return t;
        };
        this.visTexture = blockTex(this.gl.R8, this.gl.RED, this.gl.LINEAR);
        this.coarseTexture = blockTex(this.gl.R8UI, this.gl.RED_INTEGER, this.gl.NEAREST);
        this.fogVer = -1;
    }

    // Paint the terrain's look into terrainTexture (once per map: see
    // simBridge.terrainVersion). Reads the cell texture, so it runs after the
    // cell upload.
    bakeTerrain() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.terrainFbo);
        gl.viewport(0, 0, this.mapW, this.mapH);
        gl.useProgram(this.bakeProgram);
        gl.uniform2f(this.bakeUniforms.mapSize, this.mapW, this.mapH);
        gl.uniform1i(this.bakeUniforms.cellTex, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.cellTexture);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.stats.terrainBakes = (this.stats.terrainBakes || 0) + 1;
    }

    // The room's map changed size: new textures, camera fitted to the new map.
    resizeMap() {
        this.mapW = mapWidth();
        this.mapH = mapHeight();
        this.mapSizeVer = mapSizeVersion();
        const gl = this.gl;
        if (this.cellTexture) gl.deleteTexture(this.cellTexture);
        if (this.terrainTexture) gl.deleteTexture(this.terrainTexture);
        if (this.terrainFbo) gl.deleteFramebuffer(this.terrainFbo);
        if (this.visTexture) gl.deleteTexture(this.visTexture);
        if (this.coarseTexture) gl.deleteTexture(this.coarseTexture);
        this.initTextures();
        gl.useProgram(this.program);
        gl.uniform2f(this.uniforms.mapSize, this.mapW, this.mapH);
        this.fitCameraToMap();
    }

    setupControls() {
        const DIRS = {
            KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
            KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
        };
        window.addEventListener('keydown', (e) => {
            const dir = DIRS[e.code];
            if (!dir || e.ctrlKey || e.metaKey || e.altKey) return;
            // Typing in a visible text field (guild chat…) must not move the camera.
            if (isTyping()) return;
            this.keys[dir] = true;
        });
        window.addEventListener('keyup', (e) => {
            const dir = DIRS[e.code];
            if (dir) this.keys[dir] = false;
        });
        // A key released while the window wasn't focused (Alt-Tab, a click
        // into another window) never sends keyup: forget every held key, or it
        // stays "down" — drifting the camera, or cancelling the opposite key.
        const releaseAll = () => { for (const k in this.keys) this.keys[k] = false; };
        window.addEventListener('blur', releaseAll);
        document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            if (e.shiftKey) {
                const change = e.deltaY < 0 ? 5 : -5;
                state.attackPercentage = Math.max(1, Math.min(90, state.attackPercentage + change));
                const sliderAttackPct = document.getElementById('sliderAttackPct');
                const lblAttackPct = document.getElementById('lblAttackPct');
                if (sliderAttackPct) {
                    sliderAttackPct.value = state.attackPercentage;
                }
                if (lblAttackPct) {
                    lblAttackPct.innerText = state.attackPercentage + '%';
                }
                return;
            }

            // Mouse coords
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // World coords before zoom
            const worldXBefore = (mouseX / this.camera.zoom) + this.camera.x;
            const worldYBefore = (mouseY / this.camera.zoom) + this.camera.y;

            const zoomSpeed = 0.1;
            if (e.deltaY < 0) {
                this.camera.zoom *= (1.0 + zoomSpeed);
            } else {
                this.camera.zoom *= (1.0 - zoomSpeed);
            }

            // Clamp zoom
            this.camera.zoom = Math.max(0.1, Math.min(this.camera.zoom, 10.0));

            // World coords after zoom (to keep mouse pointing at same spot)
            const worldXAfter = (mouseX / this.camera.zoom) + this.camera.x;
            const worldYAfter = (mouseY / this.camera.zoom) + this.camera.y;

            this.camera.x -= (worldXAfter - worldXBefore);
            this.camera.y -= (worldYAfter - worldYBefore);
        });
    }

    updateCamera(dt) {
        // Move camera at speed relative to zoom (so it feels consistent)
        const speed = 500.0 / this.camera.zoom * (dt / 1000);
        
        if (this.keys.up) this.camera.y -= speed;
        if (this.keys.down) this.camera.y += speed;
        if (this.keys.left) this.camera.x -= speed;
        if (this.keys.right) this.camera.x += speed;

        // View-aware clamp: when the map is smaller than the viewport on an axis
        // (zoomed out / letterboxed), pin it centred; once zoomed in past the
        // edge, clamp panning so the map can't be dragged fully off screen.
        const pad = 50;
        const viewW = this.canvas.width / this.camera.zoom;
        const viewH = this.canvas.height / this.camera.zoom;
        this.camera.x = viewW >= this.mapW
            ? (this.mapW - viewW) / 2
            : Math.max(-pad, Math.min(this.camera.x, this.mapW - viewW + pad));
        this.camera.y = viewH >= this.mapH
            ? (this.mapH - viewH) / 2
            : Math.max(-pad, Math.min(this.camera.y, this.mapH - viewH + pad));
    }

    screenToWorld(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;

        const worldX = (mouseX / this.camera.zoom) + this.camera.x;
        const worldY = (mouseY / this.camera.zoom) + this.camera.y;

        return { col: Math.floor(worldX), row: Math.floor(worldY) };
    }

    worldToScreen(worldX, worldY) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = (worldX - this.camera.x) * this.camera.zoom + rect.left;
        const screenY = (worldY - this.camera.y) * this.camera.zoom + rect.top;
        return { x: screenX, y: screenY };
    }

    render(time) {
        const dt = time - this.lastTime;
        this.lastTime = time;

        this.updateCamera(dt);

        // Upload the packed cell buffer to the GPU (owner + terrain in one
        // texture) — only the rows that changed since the last frame
        // (simBridge marks them), and nothing when nothing changed. The map
        // changes ~20 times a second at most, and only along the fronts.
        const tUp = performance.now();
        if (mapSizeVersion() !== this.mapSizeVer) this.resizeMap();
        const cellArray = cellView();
        if (cellArray) {
            const rects = takeDirtyRects();
            if (rects.length) {
                const gl = this.gl;
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.cellTexture);
                // Sub-rectangles of the map: rows of the source are mapW apart.
                gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.mapW);
                for (const [x, y, w, h] of rects) {
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h,
                        gl.RED_INTEGER, gl.UNSIGNED_SHORT, cellArray, y * this.mapW + x);
                    this.stats.uploadedBytes += w * h * 2;
                }
                gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
                this.stats.uploads++;
            }
        }
        this.stats.uploadMs += performance.now() - tUp;
        this.stats.frames++;
        if (cellArray && terrainVersion() !== this.bakedTerrainVersion) {
            this.bakedTerrainVersion = terrainVersion();
            this.bakeTerrain();
        }
        if (fogVersion() !== this.fogVer) {
            this.fogVer = fogVersion();
            const { vis, coarse, bw, bh } = fogLayers();
            const gl = this.gl;
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.visTexture);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RED, gl.UNSIGNED_BYTE, vis);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, this.coarseTexture);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RED_INTEGER, gl.UNSIGNED_BYTE, coarse);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        }

        // Draw
        this.gl.bindVertexArray(this.vao);
        this.gl.useProgram(this.program);
        this.gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
        this.gl.uniform2f(this.uniforms.cameraPos, this.camera.x, this.camera.y);
        this.gl.uniform1f(this.uniforms.zoom, this.camera.zoom);
        // Highlight the local player's own frontier (0 = none, e.g. spectating).
        const myFaction = parseInt(state.playerFaction);
        this.gl.uniform1ui(this.uniforms.myFaction, Number.isFinite(myFaction) ? myFaction : 0);

        // Territory opacity per faction (from difficulty_to_invade). Pull the
        // latest values the network layer computed from the last snapshot.
        if (state.factionOpacity) {
            this.playerOpacity.set(state.factionOpacity.subarray(0, FACTION_SLOTS));
        }
        this.gl.uniform1fv(this.uniforms.playerOpacity, this.playerOpacity);
        this.gl.uniform1f(this.uniforms.fogOn, fogEnabled() ? 1 : 0);
        this.gl.activeTexture(this.gl.TEXTURE1);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.terrainTexture);
        this.gl.activeTexture(this.gl.TEXTURE2);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.visTexture);
        this.gl.activeTexture(this.gl.TEXTURE3);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.coarseTexture);
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellTexture);

        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    // Called by main game loop to draw overlays after WebGL pass
    drawSpawnOverlay(ctx, spawnSelections, myFactionId, safeZoneRadius) {
        if (!spawnSelections || Object.keys(spawnSelections).length === 0) return;
        
        ctx.lineWidth = 2;
        
        for (const [fid, pos] of Object.entries(spawnSelections)) {
            const screenPos = this.worldToScreen(pos.col, pos.row);
            const isMe = parseInt(fid) === myFactionId;
            
            // Draw safe zone circle
            const screenRadius = safeZoneRadius * this.camera.zoom;
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, screenRadius, 0, Math.PI * 2);
            ctx.fillStyle = isMe ? 'rgba(40, 167, 69, 0.2)' : 'rgba(220, 53, 69, 0.2)';
            ctx.fill();
            ctx.strokeStyle = isMe ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)';
            ctx.stroke();

            // Draw center marker
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            
            ctx.fillStyle = '#fff';
            ctx.font = '12px Orbitron';
            ctx.textAlign = 'center';
            ctx.fillText(isMe ? 'YOU' : 'P' + fid, screenPos.x, screenPos.y - 10);
        }
    }

    // Draw each faction's name + total troops at its territory centroid.
    // `centroids` is { fid: { row, col, troops } } from the latest sim-snapshot.
    drawFactionLabels(ctx, centroids, slots, myFactionId) {
        if (!centroids) return;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';

        // Busy maps (a 64-player Mega Battle) would bury the map under names:
        // labels are placed biggest empire first (yours and the bounty target
        // before anyone), and one that would overlap a label already placed,
        // or whose territory is a speck at this zoom, is left out.
        const order = [];
        for (const fid in centroids) {
            const c = centroids[fid];
            // Only the sim-snapshot shape has row/col/troops; ignore the
            // spawn-time { r, c } entries until the first snapshot arrives.
            if (!c || typeof c.row !== 'number' || typeof c.col !== 'number' || typeof c.troops !== 'number') {
                continue;
            }
            const id = parseInt(fid);
            const rank = id === myFactionId ? 2e9 : id === state.bountyFid ? 1e9 : (c.cells || 0);
            order.push([rank, fid, c]);
        }
        order.sort((a, b) => b[0] - a[0]);
        const placed = [];

        for (const [, fid, c] of order) {
            const pos = this.worldToScreen(c.col, c.row);

            // Cull labels outside the viewport.
            if (pos.x < -60 || pos.x > this.canvas.width + 60 ||
                pos.y < -30 || pos.y > this.canvas.height + 30) { continue; }

            const isMine = parseInt(fid) === myFactionId;
            // A territory under ~22 px across on screen gets no label.
            if (!isMine && Math.sqrt(c.cells || 0) * this.camera.zoom < 22) continue;
            const boxSize = territoryLabelSize(c.cells || 0);
            const box = { x0: pos.x - boxSize * 3.2, x1: pos.x + boxSize * 3.2, y0: pos.y - boxSize * 1.4, y1: pos.y + boxSize * 1.4 };
            if (!isMine && placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) continue;
            placed.push(box);

            const slot = slots && slots[fid];
            const name = slot && slot.nickname ? slot.nickname : ('Faction ' + fid);
            const isMe = parseInt(fid) === myFactionId;
            const troopsText = formatTroops(c.troops);

            // Label size scales with territory size (owned cells), low-capped.
            const nameSize = territoryLabelSize(c.cells || 0);
            const troopSize = nameSize * 0.85;
            // Vertical offsets and outline width track the font size so the two
            // lines stay tidily stacked at every label scale.
            const gap = nameSize * 0.6;

            // Name (bold) on top, troop count below; dark outline for legibility.
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = Math.max(3, nameSize * 0.25);

            ctx.font = `bold ${nameSize.toFixed(1)}px 'Orbitron', sans-serif`;
            ctx.strokeText(name, pos.x, pos.y - gap);
            ctx.fillStyle = isMe ? '#ffe07a' : '#ffffff';
            ctx.fillText(name, pos.x, pos.y - gap);

            // The bounty target wears a tag above its name.
            if (parseInt(fid) === state.bountyFid) {
                const tagSize = Math.max(10, nameSize * 0.6);
                ctx.font = `bold ${tagSize.toFixed(1)}px 'Orbitron', sans-serif`;
                const tagY = pos.y - gap - nameSize * 0.95;
                ctx.lineWidth = Math.max(3, tagSize * 0.3);
                ctx.strokeText('🎯 BOUNTY', pos.x, tagY);
                ctx.fillStyle = '#ff6b4a';
                ctx.fillText('🎯 BOUNTY', pos.x, tagY);
                ctx.lineWidth = Math.max(3, nameSize * 0.25);
            }

            ctx.font = `${troopSize.toFixed(1)}px 'Orbitron', sans-serif`;
            ctx.strokeText(troopsText, pos.x, pos.y + gap);
            ctx.fillStyle = '#d0d0d0';
            ctx.fillText(troopsText, pos.x, pos.y + gap);
        }

        ctx.textBaseline = 'alphabetic';
    }

    // Synergy links: a glowing dashed line between every linked pair (both
    // buildings carry the link's bit, are the same faction's and in range),
    // drawn edge to edge between the two icons rather than through them.
    drawBuildingLinks(ctx, buildings) {
        if (!buildings || buildings.length < 2) return;
        if (!this.buildingLayer) this.buildingLayer = new BuildingLayer(this.gl);
        const me = parseInt(state.playerFaction);
        // Only buildings in view (plus link range, for a partner just off
        // screen): pairing is O(n²), and a spectator sees every building.
        const z = this.camera.zoom;
        const x0 = this.camera.x - LINK_RADIUS;
        const y0 = this.camera.y - LINK_RADIUS;
        const x1 = this.camera.x + this.canvas.width / z + LINK_RADIUS;
        const y1 = this.camera.y + this.canvas.height / z + LINK_RADIUS;
        const linked = buildings.filter(b => b.links && !b.constructing
            && b.col >= x0 && b.col <= x1 && b.row >= y0 && b.row <= y1
            && (b.factionId === me || isCellVisible(b.row * this.mapW + b.col)));
        if (linked.length < 2) return;
        const r2 = LINK_RADIUS * LINK_RADIUS;
        const t = performance.now() * 0.02;
        const W = this.canvas.width;
        const H = this.canvas.height;
        // Same icon size as drawBuildings, so the line starts at the hex edge.
        const hexR = Math.max(6, 11 * z) * 1.62;
        const glow = !state.lowGraphics;
        const shapes = [];
        const partnered = new Set();
        const scr = (b) => ({ x: (b.col - this.camera.x) * z, y: (b.row - this.camera.y) * z });
        for (let i = 0; i < linked.length; i++) {
            const a = linked[i];
            for (let j = i + 1; j < linked.length; j++) {
                const b = linked[j];
                if (a.factionId !== b.factionId || !(a.links & b.links)) continue;
                if ((a.row - b.row) ** 2 + (a.col - b.col) ** 2 > r2) continue;
                const shared = BUILDING_LINKS.some(l => (a.links & b.links & l.bit)
                    && l.types.includes(a.type) && l.types.includes(b.type) && a.type !== b.type);
                if (!shared) continue;
                partnered.add(a);
                partnered.add(b);
                const pa = scr(a);
                const pb = scr(b);
                const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
                if (len <= hexR * 2 + 4) continue; // icons overlap: nothing to draw
                if (Math.max(pa.x, pb.x) < 0 || Math.min(pa.x, pb.x) > W
                    || Math.max(pa.y, pb.y) < 0 || Math.min(pa.y, pb.y) > H) continue;
                const ux = (pb.x - pa.x) / len;
                const uy = (pb.y - pa.y) / len;
                const geom = [pa.x + ux * hexR, pa.y + uy * hexR, pb.x - ux * hexR, pb.y - uy * hexR];
                const [r, g, bl] = factionRGB[a.factionId] || [200, 200, 200];
                // Dark under-stroke so the link reads on any territory colour,
                // then the faction-coloured dashes, running along the link.
                shapes.push({ kind: 0, geom, color: [0, 0, 0, 0.55], width: Math.max(4, 2.4 * z) });
                shapes.push({ kind: 0, geom, color: [Math.min(255, r + 60) / 255, Math.min(255, g + 60) / 255, Math.min(255, bl + 60) / 255, 1],
                    width: Math.max(2, 1.2 * z), dash: [6, 5], offset: -t, glow: glow ? 5 : 0 });
            }
        }
        // A rotating dashed ring marks every linked building, so the link is
        // visible even when the two icons touch (no room for a line).
        for (const b of partnered) {
            const p = scr(b);
            if (p.x < -hexR * 2 || p.x > W + hexR * 2 || p.y < -hexR * 2 || p.y > H + hexR * 2) continue;
            shapes.push({ kind: 1, geom: [p.x, p.y, hexR * 1.2, 0], color: [140 / 255, 235 / 255, 1, 0.95],
                width: Math.max(1.5, 0.9 * z), dash: [hexR * 0.5, hexR * 0.3], offset: t * 0.5, glow: glow ? 6 : 0 });
        }
        const layer = this.buildingLayer;
        layer.begin(W, H);
        layer.drawShapes(shapes);
        layer.end();
    }

    // While placing a building of `type`: show the link radius and which of
    // the player's completed buildings it would link with, and the link names.
    drawLinkPreview(ctx, type, hoverRow, hoverCol, buildings, myFaction) {
        const center = this.worldToScreen(hoverCol, hoverRow);
        const r2 = LINK_RADIUS * LINK_RADIUS;
        const names = new Set();
        ctx.save();
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        for (const b of buildings || []) {
            if (b.factionId !== myFaction || b.constructing) continue;
            if ((b.row - hoverRow) ** 2 + (b.col - hoverCol) ** 2 > r2) continue;
            const link = BUILDING_LINKS.find(l => l.types.includes(type) && l.types.includes(b.type) && type !== b.type);
            if (!link) continue;
            names.add(link.name);
            const p = this.worldToScreen(b.col, b.row);
            ctx.strokeStyle = 'rgba(120, 230, 255, 0.95)';
            ctx.beginPath();
            ctx.moveTo(center.x, center.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
        }
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = 'rgba(120, 230, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(center.x, center.y, LINK_RADIUS * this.camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (names.size) {
            ctx.font = "bold 12px 'Orbitron', sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            const text = `Links: ${[...names].join(' · ')}`;
            const y = center.y + 6 * this.camera.zoom + 6;
            ctx.strokeText(text, center.x, y);
            ctx.fillStyle = 'rgba(120, 230, 255, 1)';
            ctx.fillText(text, center.x, y);
        }
        ctx.restore();
    }

    // Building icons, defense-zone rings and the per-building extras. The
    // icons and rings are drawn by the GPU (buildingLayer.js: one sprite atlas,
    // instanced draws) into the map canvas; only the extras that change over
    // time — construction bar, silo cooldown, anti-air charges — go on the
    // overlay canvas `ctx`, for the few buildings that show them.
    drawBuildings(ctx, buildings) {
        if (!buildings || buildings.length === 0) return;
        if (!this.buildingLayer) this.buildingLayer = new BuildingLayer(this.gl);
        const now = performance.now();
        const me = parseInt(state.playerFaction);
        const z = this.camera.zoom;
        const iconSize = Math.max(6, 11 * z);
        const W = this.canvas.width;
        const H = this.canvas.height;
        const lowGraphics = !!state.lowGraphics;
        const icons = [];
        const spins = [];
        const zones = [];
        for (const b of buildings) {
            // Rival buildings hidden in the fog of war stay hidden.
            if (b.factionId !== me && !isCellVisible(b.row * this.mapW + b.col)) continue;
            const x = (b.col - this.camera.x) * z;
            const y = (b.row - this.camera.y) * z;
            if (x < -80 || x > W + 80 || y < -80 || y > H + 80) continue;
            const constructing = !!b.constructing;
            const pulse = constructing ? 1 : 1 + 0.05 * Math.sin(now * 0.0028 + b.row * 0.6);
            const spec = { type: b.type, factionId: b.factionId, constructing, charged: (b.charges ?? 3) > 0, lowGraphics };
            icons.push({ x, y, iconSize, pulse, rot: 0, spec, layer: 'base' });
            if (b.type === 'antiair') spins.push({ x, y, iconSize, pulse, rot: (now * 0.0016) % (Math.PI * 2), spec, layer: 'spin' });
            if (b.type === 'mine' && !constructing) spins.push({ x, y, iconSize, pulse, rot: (now * 0.001) % (Math.PI * 2), spec, layer: 'spin' });
            // Defense zone ring (towers and cities, when zoomed in).
            if (b.type !== 'silo' && b.type !== 'mine' && b.type !== 'antiair' && z > 1.2) {
                zones.push({ kind: 1, geom: [x, y, b.radius * z, 0], color: [1, 200 / 255, 50 / 255, 0.28], width: 1.5, dash: [5, 7], offset: 0 });
            }
            this.drawBuildingExtras(ctx, b, x, y, iconSize, pulse, now);
        }
        const layer = this.buildingLayer;
        layer.begin(W, H);
        layer.drawShapes(zones);
        layer.drawIcons(icons);
        layer.drawIcons(spins);
        layer.end();
        this.stats.buildingsDrawn = (this.stats.buildingsDrawn || 0) + icons.length;
    }

    // Per-building extras that change over time (overlay canvas).
    drawBuildingExtras(ctx, b, x, y, iconSize, pulse, now) {
        const constructing = !!b.constructing;
        const z = this.camera.zoom;
        const color = factionHexColors[b.factionId] || '#888888';
        const rgb = factionRGB[b.factionId] || [136, 136, 136];
        const isMine = b.type === 'mine';

        // Silo cooldown: a "filling bullet" above the missile.
        if (b.type === 'silo' && !constructing && b.lastFiredAt) {
            const age = now - b.lastFiredAt;
            const cd = b.cooldownMs || 2000;
            if (age < cd) {
                const s = iconSize * pulse;
                const bw = s * 0.25;
                const bh = s * 0.6;
                const by = y - s * 1.75 * 1.4;
                ctx.fillStyle = 'rgba(10, 10, 15, 0.8)';
                ctx.fillRect(x - bw / 2, by - bh, bw, bh);
                ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`;
                ctx.lineWidth = Math.max(0.5, z * 0.5);
                ctx.strokeRect(x - bw / 2, by - bh, bw, bh);
                const fillH = bh * (age / cd);
                ctx.fillStyle = color;
                ctx.fillRect(x - bw / 2, by - fillH, bw, fillH);
            }
        }

        // Anti-air charge dots.
        if (b.type === 'antiair' && !constructing) {
            const charges = b.charges ?? 3;
            if (charges > 0 && iconSize > 8) {
                const dotR = Math.max(2, iconSize * 0.2);
                const spacing = dotR * 2.9;
                const dotY = y - iconSize * 2.5;
                if (!state.lowGraphics) { ctx.shadowColor = '#ff2020'; ctx.shadowBlur = dotR * 3; }
                ctx.fillStyle = '#ff4040';
                for (let i = 0; i < charges; i++) {
                    ctx.beginPath();
                    ctx.arc(x - ((charges - 1) * spacing) / 2 + i * spacing, dotY, dotR, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.shadowBlur = 0;
            }
        }

        // Construction progress bar.
        if (constructing) {
            const progress = Math.min(1, Math.max(0, (now - (b.builtAt || now)) / (b.buildMs || 5000)));
            const barW = iconSize * 3.5, barH = Math.max(3, iconSize * 0.4);
            const bx = x - barW / 2, by = y + iconSize * 2.35;
            const rad = barH / 2;
            const barAccent = isMine ? '#f59e0b' : color;
            const barRgb = isMine ? '245,158,11' : `${rgb[0]},${rgb[1]},${rgb[2]}`;
            ctx.fillStyle = 'rgba(3, 5, 12, 0.95)';
            ctx.beginPath(); ctx.roundRect(bx - 2, by - 2, barW + 4, barH + 4, rad + 2); ctx.fill();
            if (progress > 0.01) {
                const fillW = Math.max(barH, barW * progress);
                const fGrad = ctx.createLinearGradient(bx, 0, bx + fillW, 0);
                fGrad.addColorStop(0, barAccent); fGrad.addColorStop(0.75, '#ffffff'); fGrad.addColorStop(1, '#ffffff');
                ctx.fillStyle = fGrad;
                if (!state.lowGraphics) { ctx.shadowColor = barAccent; ctx.shadowBlur = barH * 2; }
                ctx.beginPath(); ctx.roundRect(bx, by, fillW, barH, rad); ctx.fill();
                ctx.shadowBlur = 0;
            }
            ctx.strokeStyle = `rgba(${barRgb},0.4)`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(bx - 2, by - 2, barW + 4, barH + 4, rad + 2); ctx.stroke();
        }
    }

    // Draw a placement preview (8×8 footprint + influence zone) at the hovered world cell.
    drawBuildingPlacementPreview(ctx, hoverRow, hoverCol) {
        const topLeft = this.worldToScreen(hoverCol - 4, hoverRow - 4);
        const bottomRight = this.worldToScreen(hoverCol + 4, hoverRow + 4);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;

        // Footprint square.
        ctx.fillStyle = 'rgba(255, 215, 50, 0.18)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(255, 215, 50, 0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);

        // Influence radius circle.
        const center = this.worldToScreen(hoverCol, hoverRow);
        const screenRadius = BUILDING_RADIUS * this.camera.zoom;
        ctx.beginPath();
        ctx.arc(center.x, center.y, screenRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 215, 50, 0.07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 215, 50, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Hint text above the footprint.
        ctx.font = "12px 'Orbitron', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,215,50,0.9)';
        ctx.fillText('Defense Tower (click to place)', center.x, topLeft.y - 4);
    }

    // Silo placement preview: 8×8 footprint + the dashed firing-range circle.
    drawSiloPlacementPreview(ctx, hoverRow, hoverCol) {
        const topLeft = this.worldToScreen(hoverCol - 4, hoverRow - 4);
        const bottomRight = this.worldToScreen(hoverCol + 4, hoverRow + 4);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        const center = this.worldToScreen(hoverCol, hoverRow);

        // Footprint square (cyan to distinguish from the gold defense tower).
        ctx.fillStyle = 'rgba(80, 200, 255, 0.18)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(80, 200, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);

        // Firing-range circle (black dashed).
        ctx.beginPath();
        ctx.arc(center.x, center.y, SILO_RANGE * this.camera.zoom, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = "12px 'Orbitron', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(80, 200, 255, 0.95)';
        ctx.fillText('Missile Silo (click to place)', center.x, topLeft.y - 4);
    }

    drawMinePlacementPreview(ctx, hoverRow, hoverCol) {
        const topLeft = this.worldToScreen(hoverCol - 4, hoverRow - 4);
        const bottomRight = this.worldToScreen(hoverCol + 4, hoverRow + 4);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        const center = this.worldToScreen(hoverCol, hoverRow);

        ctx.fillStyle = 'rgba(255, 215, 0, 0.18)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);

        ctx.font = "12px 'Orbitron', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255, 215, 0, 0.95)';
        ctx.fillText('Gold Mine (click to place)', center.x, topLeft.y - 4);
    }

    drawAntiAirPlacementPreview(ctx, hoverRow, hoverCol) {
        const topLeft = this.worldToScreen(hoverCol - 4, hoverRow - 4);
        const bottomRight = this.worldToScreen(hoverCol + 4, hoverRow + 4);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        const center = this.worldToScreen(hoverCol, hoverRow);

        ctx.fillStyle = 'rgba(120, 255, 120, 0.18)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(120, 255, 120, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);

        ctx.beginPath();
        ctx.arc(center.x, center.y, ANTIAIR_RADIUS * this.camera.zoom, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120, 255, 120, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = "12px 'Orbitron', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(120, 255, 120, 0.95)';
        ctx.fillText('Anti-Air Battery (click to place)', center.x, topLeft.y - 4);
    }

    drawCityPlacementPreview(ctx, hoverRow, hoverCol) {
        const topLeft = this.worldToScreen(hoverCol - 4, hoverRow - 4);
        const bottomRight = this.worldToScreen(hoverCol + 4, hoverRow + 4);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        const center = this.worldToScreen(hoverCol, hoverRow);

        ctx.fillStyle = 'rgba(167, 139, 250, 0.18)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);

        ctx.font = "12px 'Orbitron', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(167, 139, 250, 0.95)';
        ctx.fillText('City (click to place)', center.x, topLeft.y - 4);
    }

    // Missile-targeting overlay: dashed firing-range rings around the player's own
    // completed silos, plus a blast-radius preview at the hovered cell.
    drawMissileTargeting(ctx, buildings, myFaction, hoverRow, hoverCol) {
        if (buildings && buildings.length) {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 1.5;
            for (const b of buildings) {
                if (b.type !== 'silo' || b.constructing || b.factionId !== myFaction) continue;
                const c = this.worldToScreen(b.col, b.row);
                ctx.beginPath();
                // Radar Guidance (silo + anti-air link) extends the range.
                const range = b.links & 4 ? SILO_RANGE * RADAR_RANGE_MULT : SILO_RANGE;
                ctx.arc(c.x, c.y, range * this.camera.zoom, 0, Math.PI * 2);
                ctx.setLineDash([6, 8]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Blast-radius preview where the player is aiming.
        if (hoverRow >= 0) {
            const c = this.worldToScreen(hoverCol, hoverRow);
            const r = MISSILE_BLAST_RADIUS * this.camera.zoom;
            ctx.beginPath();
            ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 60, 30, 0.20)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 60, 30, 0.85)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // Draw parabolic missiles flying to their targets.
    drawMissiles(ctx, missiles, explosions) {
        if (!missiles || missiles.length === 0) return missiles || [];
        const now = performance.now();
        const surviving = [];
        
        for (const m of missiles) {
            const t = (now - m.startedAt) / m.flightTimeMs;
            
            if (t >= 1.0 || (m.intercepted && now >= m.interceptorArrivesAt)) {
                // Missile landed or intercepted! Trigger explosion.
                if (m.intercepted) {
                    const sCurr = this.worldToScreen(m.interceptCol, m.interceptRow);
                    const arcHeight = 150 * Math.sin(t * Math.PI);
                    explosions.push({ 
                        x: sCurr.x, 
                        y: sCurr.y - arcHeight, 
                        blastRadius: MISSILE_BLAST_RADIUS * 0.5, 
                        startedAt: now, 
                        type: 'intercepted_sky' 
                    });
                } else {
                    explosions.push({ row: m.targetRow, col: m.targetCol, blastRadius: MISSILE_BLAST_RADIUS, startedAt: now, type: 'normal' });
                }
                continue; 
            }
            
            surviving.push(m);
            
            // Interpolate position
            const currRow = m.sourceRow + (m.targetRow - m.sourceRow) * t;
            const currCol = m.sourceCol + (m.targetCol - m.sourceCol) * t;
            
            // Calculate screen positions

            const sCurr = this.worldToScreen(currCol, currRow);
            
            // Parabola math: peak at t = 0.5. Height in pixels.
            const arcHeight = 150 * Math.sin(t * Math.PI);
            
            // Actual draw Y is offset upwards by the arcHeight
            const drawX = sCurr.x;
            const drawY = sCurr.y - arcHeight;
            
            const factionColor = factionHexColors[m.factionId] || '#fff';
            
            // Tapered energy trail
            const tOld = Math.max(0, t - 0.05);
            const oldRow = m.sourceRow + (m.targetRow - m.sourceRow) * tOld;
            const oldCol = m.sourceCol + (m.targetCol - m.sourceCol) * tOld;
            const sOld = this.worldToScreen(oldCol, oldRow);
            const oldArc = 150 * Math.sin(tOld * Math.PI);
            const oldX = sOld.x;
            const oldY = sOld.y - oldArc;

            const angle = Math.atan2(drawY - oldY, drawX - oldX);

            // Draw the energy trail with gradient
            const gradient = ctx.createLinearGradient(oldX, oldY, drawX, drawY);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
            gradient.addColorStop(1, factionColor);
            
            ctx.beginPath();
            ctx.moveTo(oldX, oldY);
            ctx.lineTo(drawX, drawY);
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            if (!state.lowGraphics) { ctx.shadowColor = factionColor; ctx.shadowBlur = 8; }
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Draw the futuristic missile body
            ctx.save();
            ctx.translate(drawX, drawY);
            ctx.rotate(angle);

            // Missile main body (aerodynamic dart)
            ctx.beginPath();
            ctx.moveTo(12 * this.camera.zoom, 0); // Nose cone
            ctx.lineTo(-4 * this.camera.zoom, 5 * this.camera.zoom); // Right wing trailing edge
            ctx.lineTo(-2 * this.camera.zoom, 0); // Center rear
            ctx.lineTo(-4 * this.camera.zoom, -5 * this.camera.zoom); // Left wing trailing edge
            ctx.closePath();
            ctx.fillStyle = '#e2e8f0';
            ctx.fill();

            // Wing accents (colored by faction)
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(-6 * this.camera.zoom, 7 * this.camera.zoom);
            ctx.lineTo(-3 * this.camera.zoom, 0);
            ctx.lineTo(-6 * this.camera.zoom, -7 * this.camera.zoom);
            ctx.closePath();
            ctx.fillStyle = factionColor;
            ctx.fill();

            // Engine thrust/exhaust
            const thrustPulse = 4 + Math.random() * 4; // Flickering effect
            ctx.beginPath();
            ctx.moveTo(-2 * this.camera.zoom, 0);
            ctx.lineTo((-2 - thrustPulse) * this.camera.zoom, 2 * this.camera.zoom);
            ctx.lineTo((-4 - thrustPulse) * this.camera.zoom, 0);
            ctx.lineTo((-2 - thrustPulse) * this.camera.zoom, -2 * this.camera.zoom);
            ctx.closePath();
            ctx.fillStyle = '#ffffff';
            if (!state.lowGraphics) { ctx.shadowColor = factionColor; ctx.shadowBlur = 12; }
            ctx.fill();

            ctx.restore();
            ctx.shadowBlur = 0; // reset
        }
        
        return surviving;
    }

    // Draw AA interceptor missiles
    drawInterceptors(ctx, interceptors) {
        if (!interceptors || interceptors.length === 0) return interceptors || [];
        const now = performance.now();
        const surviving = [];
        for (const int of interceptors) {
            const progress = (now - int.startedAt) / int.durationMs;
            if (progress >= 1.0) continue;
            surviving.push(int);

            const start = this.worldToScreen(int.sourceCol, int.sourceRow);
            const end = this.worldToScreen(int.targetCol, int.targetRow);
            
            const currX = start.x + (end.x - start.x) * progress;
            const currY = start.y + (end.y - start.y) * progress;
            
            const currAltitude = int.targetAltitude * progress; 
            
            const drawX = currX;
            const drawY = currY - currAltitude;

            // Draw tiny interceptor rocket
            ctx.beginPath();
            ctx.arc(drawX, drawY, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#ff4444'; 
            ctx.fill();
            
            // Draw exhaust trail
            ctx.beginPath();
            ctx.moveTo(start.x, start.y - 10);
            ctx.lineTo(drawX, drawY);
            ctx.strokeStyle = `rgba(255, 200, 100, ${1.0 - progress})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        return surviving;
    }

    // Draw active missile blasts as an expanding fading flash. Returns the list of
    // explosions still animating (callers reassign to prune finished ones).
    drawExplosions(ctx, explosions) {
        if (!explosions || explosions.length === 0) return explosions || [];
        const now = performance.now();
        const surviving = [];
        for (const exp of explosions) {
            const durationMs = 800; // Increased duration
            const ageMs = now - exp.startedAt;
            if (ageMs > durationMs) continue; 
            surviving.push(exp);

            let c;
            if (exp.x !== undefined && exp.y !== undefined) {
                c = { x: exp.x, y: exp.y };
            } else {
                c = this.worldToScreen(exp.col, exp.row);
            }
            
            const t = ageMs / durationMs;
            const maxR = exp.blastRadius * this.camera.zoom;
            // Easing function for explosive expansion (fast start, slow end)
            const easeOutQuad = 1 - (1 - t) * (1 - t);
            
            const isFlak = (exp.type === 'intercepted' || exp.type === 'intercepted_sky');
            const coreColor = isFlak ? '200, 230, 255' : '255, 255, 200';
            const midColor = isFlak ? '100, 180, 255' : '255, 120, 0';
            const edgeColor = isFlak ? '50, 100, 200' : '255, 40, 0';

            // 1. Bright white core that disappears quickly
            if (t < 0.3) {
                const coreAlpha = 1 - (t / 0.3);
                ctx.beginPath();
                ctx.arc(c.x, c.y, maxR * 0.4 * easeOutQuad, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 255, 255, ${coreAlpha})`;
                if (!state.lowGraphics) { ctx.shadowColor = `rgb(${coreColor})`; ctx.shadowBlur = 20; }
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            // 2. Radial gradient shockwave/fireball
            const shockRadius = maxR * easeOutQuad;
            if (shockRadius > 0) {
                const gradient = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, shockRadius);
                gradient.addColorStop(0, `rgba(${coreColor}, ${0.8 * (1 - t)})`);
                gradient.addColorStop(0.5, `rgba(${midColor}, ${0.5 * (1 - t)})`);
                gradient.addColorStop(1, `rgba(${edgeColor}, 0)`);
                
                ctx.beginPath();
                ctx.arc(c.x, c.y, shockRadius, 0, Math.PI * 2);
                ctx.fillStyle = gradient;
                ctx.fill();
            }

            // 3. Expanding hard shockwave ring
            ctx.beginPath();
            ctx.arc(c.x, c.y, shockRadius * 1.1, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${midColor}, ${1.0 * (1 - t)})`;
            ctx.lineWidth = 3 * (1 - t);
            ctx.stroke();

            // 4. Debris/Sparks
            if (!state.lowGraphics && t < 0.6) {
                const sparkAlpha = 1 - (t / 0.6);
                ctx.fillStyle = `rgba(${coreColor}, ${sparkAlpha})`;
                for (let i = 0; i < 8; i++) {
                    const angle = (exp.startedAt + i * 1.345) % (Math.PI * 2);
                    const sparkDist = shockRadius * 1.3 * (0.4 + 0.6 * ((exp.startedAt + i) % 1));
                    const sx = c.x + Math.cos(angle) * sparkDist;
                    const sy = c.y + Math.sin(angle) * sparkDist;
                    ctx.beginPath();
                    ctx.arc(sx, sy, 2 * this.camera.zoom, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
        return surviving;
    }
}
