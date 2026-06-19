import { state } from './state.js';
import { factionHexColors, factionRGB, BUILDING_RADIUS, SILO_RANGE, MISSILE_BLAST_RADIUS, ANTIAIR_RADIUS } from './constants.js';

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const TOTAL_CELLS = 2073600;

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


export class WebGLRenderer {
    constructor(canvas, wasmMemory) {
        this.canvas = canvas;
        this.wasmMemory = wasmMemory;
        this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!this.gl) throw new Error("WebGL2 not supported");

        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false };

        // Single packed-cell buffer (u16/cell): owner + terrain + defense + building.
        this.cellDataPtr = null;
        this.cellTexture = null;

        // Per-faction troop density ratio (troops-per-cell / DIFFICULTY_CAP, 0..1),
        // indexed by owner id 0..20. Multiplied by per-cell enclosure in the shader
        // to produce per-cell opacity variation. Updated each sim snapshot.
        this.playerOpacity = new Float32Array(21).fill(1.0);

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
        this.camera.zoom = Math.min(this.canvas.width / MAP_WIDTH, this.canvas.height / MAP_HEIGHT) * 0.98;
        this.camera.x = (MAP_WIDTH / 2) - (this.canvas.width / 2) / this.camera.zoom;
        this.camera.y = (MAP_HEIGHT / 2) - (this.canvas.height / 2) / this.camera.zoom;
    }

    initShaders() {
        const vsSource = `#version 300 es
            in vec2 a_position;
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

            uniform vec2 u_resolution;
            uniform vec2 u_camera_pos;
            uniform float u_zoom;
            uniform vec2 u_map_size;

            // Per-faction troop density ratio (troops-per-cell / DIFFICULTY_CAP, 0..1).
            // Combined per-pixel with the cell's terrain cost to produce per-cell opacity:
            // mountains in a dense empire render fully solid; plains in a weak one stay faint.
            uniform float u_player_opacity[21];

            // The local player's faction id (0 when spectating/pre-game). Their own
            // frontier is drawn as a bright highlight; all other borders are dark.
            uniform uint u_my_faction;

            // Per-faction territory color (index 0 = neutral, unused). Uploaded once
            // from factionRGB in constants.js — the SAME source the building icons
            // and HUD use — so a faction's territory matches its icon/label color.
            uniform vec3 u_palette[21];

            // Terrain base color for a packed terrain value (bits 7-10).
            vec3 terrainColor(uint terrainVal) {
                if (terrainVal == 0u) return vec3(241.0/255.0, 245.0/255.0, 237.0/255.0); // Plains (#f1f5ed)
                if (terrainVal == 1u) return vec3(230.0/255.0, 223.0/255.0, 210.0/255.0); // Highlands (#e6dfd2)
                if (terrainVal == 2u) return vec3(215.0/255.0, 215.0/255.0, 215.0/255.0); // Mountains (#d7d7d7)
                if (terrainVal == 3u) return vec3(120.0/255.0, 190.0/255.0, 220.0/255.0); // Water (#78bedc)
                return vec3(1.0, 1.0, 0.0); // debug: out-of-range terrain
            }

            uint ownerAt(ivec2 tc) {
                return texelFetch(u_cell_tex, tc, 0).r & 127u;
            }

            // The terrain + owner-heatmap fill color for a single cell (no borders).
            // Mirrors the per-cell opacity model: difficulty = (density + terrain) * defTier.
            vec3 fillColorAt(ivec2 tc) {
                uint packed = texelFetch(u_cell_tex, tc, 0).r;
                uint ownerVal = packed & 127u;
                uint terrainVal = (packed >> 7u) & 15u;
                vec3 baseColor = terrainColor(terrainVal);
                if (ownerVal > 0u && ownerVal <= 20u) {
                    vec3 pColor = u_palette[ownerVal];
                    float terrainCost = (terrainVal == 0u) ? 1.0 : (terrainVal == 1u) ? 3.0 : (terrainVal == 2u) ? 6.0 : 0.0;
                    uint defTierRaw = (packed >> 11u) & 15u;
                    float defTier = float(defTierRaw == 0u ? 1u : defTierRaw);
                    float diffNorm = clamp((u_player_opacity[ownerVal] + terrainCost / 25.0) * defTier, 0.0, 1.0);
                    float opacity = 0.12 + 0.88 * diffNorm;
                    baseColor = mix(baseColor, pColor, opacity);
                }
                return baseColor;
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
                vec3 nearestFill = fillColorAt(nearest);
                vec3 f00 = (ownerAt(c00) == ownerVal) ? fillColorAt(c00) : nearestFill;
                vec3 f10 = (ownerAt(c10) == ownerVal) ? fillColorAt(c10) : nearestFill;
                vec3 f01 = (ownerAt(c01) == ownerVal) ? fillColorAt(c01) : nearestFill;
                vec3 f11 = (ownerAt(c11) == ownerVal) ? fillColorAt(c11) : nearestFill;
                vec3 baseColor = mix(mix(f00, f10, frac.x), mix(f01, f11, frac.x), frac.y);

                // --- Crisp faction borders (decided on the nearest cell's owner) ---
                if (ownerVal > 0u && ownerVal <= 20u) {
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
                } else if (ownerVal > 20u) {
                    baseColor = vec3(1.0, 0.0, 0.0); // debug: out-of-range owner
                }

                outColor = vec4(baseColor, 1.0);
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

        this.gl.useProgram(this.program);

        this.uniforms = {
            resolution: this.gl.getUniformLocation(this.program, 'u_resolution'),
            cameraPos: this.gl.getUniformLocation(this.program, 'u_camera_pos'),
            zoom: this.gl.getUniformLocation(this.program, 'u_zoom'),
            mapSize: this.gl.getUniformLocation(this.program, 'u_map_size'),
            cellTex: this.gl.getUniformLocation(this.program, 'u_cell_tex'),
            playerOpacity: this.gl.getUniformLocation(this.program, 'u_player_opacity'),
            myFaction: this.gl.getUniformLocation(this.program, 'u_my_faction'),
            palette: this.gl.getUniformLocation(this.program, 'u_palette')
        };

        this.gl.uniform2f(this.uniforms.mapSize, MAP_WIDTH, MAP_HEIGHT);
        this.gl.uniform1i(this.uniforms.cellTex, 0); // Texture unit 0

        // Upload the faction palette once (it's static). Built from factionRGB so
        // territory fill matches the building icons / HUD; index 0 (neutral) stays
        // black and is never sampled (only owners 1..20 read u_palette).
        const palette = new Float32Array(21 * 3);
        for (let i = 1; i <= 20; i++) {
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
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R16UI, MAP_WIDTH, MAP_HEIGHT, 0, this.gl.RED_INTEGER, this.gl.UNSIGNED_SHORT, null);
    }

    setMemoryPointers(cellDataPtr) {
        this.cellDataPtr = cellDataPtr;
    }

    setupControls() {
        window.addEventListener('keydown', (e) => {
            if (!e.key) return;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            if (Object.prototype.hasOwnProperty.call(this.keys, key)) this.keys[key] = true;
        });

        window.addEventListener('keyup', (e) => {
            if (!e.key) return;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            if (Object.prototype.hasOwnProperty.call(this.keys, key)) this.keys[key] = false;
        });

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
        
        if (this.keys['w'] || this.keys['ArrowUp']) this.camera.y -= speed;
        if (this.keys['s'] || this.keys['ArrowDown']) this.camera.y += speed;
        if (this.keys['a'] || this.keys['ArrowLeft']) this.camera.x -= speed;
        if (this.keys['d'] || this.keys['ArrowRight']) this.camera.x += speed;

        // View-aware clamp: when the map is smaller than the viewport on an axis
        // (zoomed out / letterboxed), pin it centred; once zoomed in past the
        // edge, clamp panning so the map can't be dragged fully off screen.
        const pad = 50;
        const viewW = this.canvas.width / this.camera.zoom;
        const viewH = this.canvas.height / this.camera.zoom;
        this.camera.x = viewW >= MAP_WIDTH
            ? (MAP_WIDTH - viewW) / 2
            : Math.max(-pad, Math.min(this.camera.x, MAP_WIDTH - viewW + pad));
        this.camera.y = viewH >= MAP_HEIGHT
            ? (MAP_HEIGHT - viewH) / 2
            : Math.max(-pad, Math.min(this.camera.y, MAP_HEIGHT - viewH + pad));
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

        // Upload the packed cell buffer to the GPU (owner + terrain in one texture).
        if (this.cellDataPtr !== null && this.wasmMemory) {
            const cellArray = new Uint16Array(this.wasmMemory.buffer, this.cellDataPtr, TOTAL_CELLS);
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellTexture);
            this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, MAP_WIDTH, MAP_HEIGHT, this.gl.RED_INTEGER, this.gl.UNSIGNED_SHORT, cellArray);
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
            this.playerOpacity.set(state.factionOpacity);
        }
        this.gl.uniform1fv(this.uniforms.playerOpacity, this.playerOpacity);

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

        for (const fid in centroids) {
            const c = centroids[fid];
            // Only the sim-snapshot shape has row/col/troops; ignore the
            // spawn-time { r, c } entries until the first snapshot arrives.
            if (!c || typeof c.row !== 'number' || typeof c.col !== 'number' || typeof c.troops !== 'number') {
                continue;
            }
            const pos = this.worldToScreen(c.col, c.row);

            // Cull labels outside the viewport.
            if (pos.x < -60 || pos.x > this.canvas.width + 60 ||
                pos.y < -30 || pos.y > this.canvas.height + 30) { continue; }

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

            ctx.font = `${troopSize.toFixed(1)}px 'Orbitron', sans-serif`;
            ctx.strokeText(troopsText, pos.x, pos.y + gap);
            ctx.fillStyle = '#d0d0d0';
            ctx.fillText(troopsText, pos.x, pos.y + gap);
        }

        ctx.textBaseline = 'alphabetic';
    }

    drawBuildings(ctx, buildings) {
        if (!buildings || buildings.length === 0) return;
        const now = performance.now();

        for (const b of buildings) {
            const pos = this.worldToScreen(b.col, b.row);
            if (pos.x < -80 || pos.x > this.canvas.width + 80 ||
                pos.y < -80 || pos.y > this.canvas.height + 80) continue;

            const z = this.camera.zoom;
            const iconSize = Math.max(6, 11 * z);
            const color = factionHexColors[b.factionId] || '#888888';
            const rgb = factionRGB[b.factionId] || [136, 136, 136];
            const constructing = !!b.constructing;
            const progress = constructing
                ? Math.min(1, Math.max(0, (now - (b.builtAt || now)) / (b.buildMs || 5000)))
                : 1;
            const isSilo    = b.type === 'silo';
            const isMine    = b.type === 'mine';
            const isAntiAir = b.type === 'antiair';
            const isCity    = b.type === 'city';
            const [r, g, bl] = rgb;

            const pulse = constructing ? 1 : 1 + 0.05 * Math.sin(now * 0.0028 + b.row * 0.6);

            ctx.save();
            ctx.translate(pos.x, pos.y);

            // ── Hex frame with neon glow ──
            const hexR = iconSize * 1.62 * pulse;
            const drawHex = (size, rot = Math.PI / 6) => {
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (Math.PI / 3) * i + rot;
                    if (i === 0) ctx.moveTo(Math.cos(a) * size, Math.sin(a) * size);
                    else         ctx.lineTo(Math.cos(a) * size, Math.sin(a) * size);
                }
                ctx.closePath();
            };

            const hexColor = isMine ? '#f59e0b' : isCity ? '#a78bfa' : color;
            const hexRgb   = isMine ? [245, 158, 11] : isCity ? [167, 139, 250] : rgb;

            drawHex(hexR);
            ctx.fillStyle = 'rgba(3, 5, 12, 0.92)';
            ctx.fill();

            if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = iconSize * 2; }
            drawHex(hexR);
            ctx.strokeStyle = constructing ? 'rgba(255,255,255,0.18)' : hexColor;
            ctx.lineWidth = Math.max(1, 1.6 * z);
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Dim inner hex ring — circuit frame detail
            if (!constructing) {
                drawHex(hexR * 0.76);
                ctx.strokeStyle = `rgba(${hexRgb[0]},${hexRgb[1]},${hexRgb[2]},0.22)`;
                ctx.lineWidth = Math.max(0.4, 0.5 * z);
                ctx.stroke();
            }

            if (constructing) ctx.globalAlpha = 0.55;
            const s = iconSize * pulse;

            if (isSilo) {
                // ── SILO: hypersonic angular missile ──
                const mh = s * 1.75, mw = s * 0.48;

                // Energy spine behind body
                ctx.beginPath();
                ctx.moveTo(0, -mh * 0.88); ctx.lineTo(0, mh * 0.56);
                ctx.strokeStyle = `rgba(${r},${g},${bl},0.6)`;
                ctx.lineWidth = Math.max(0.7, z * 0.8);
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.35; }
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Angular missile body (no bezier — hard edges)
                ctx.beginPath();
                ctx.moveTo(0,        -mh);
                ctx.lineTo( mw*0.48, -mh*0.52);
                ctx.lineTo( mw,       mh*0.38);
                ctx.lineTo( mw,       mh*0.62);
                ctx.lineTo( mw*1.88,  mh);
                ctx.lineTo( mw*0.78,  mh*0.74);
                ctx.lineTo(-mw*0.78,  mh*0.74);
                ctx.lineTo(-mw*1.88,  mh);
                ctx.lineTo(-mw,       mh*0.62);
                ctx.lineTo(-mw,       mh*0.38);
                ctx.lineTo(-mw*0.48, -mh*0.52);
                ctx.closePath();
                const mGrad = ctx.createLinearGradient(-mw, -mh, mw, mh);
                mGrad.addColorStop(0,    '#e8f4ff');
                mGrad.addColorStop(0.15, hexColor);
                mGrad.addColorStop(0.65, `rgba(${Math.floor(r*0.38)},${Math.floor(g*0.38)},${Math.floor(bl*0.38)},1)`);
                mGrad.addColorStop(1,    '#010306');
                ctx.fillStyle = mGrad;
                ctx.fill();
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.55; }
                ctx.strokeStyle = constructing ? 'rgba(255,255,255,0.25)' : `rgba(${r},${g},${bl},0.8)`;
                ctx.lineWidth = Math.max(0.5, z * 0.65);
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Nose tip dot
                if (s > 7) {
                    ctx.beginPath();
                    ctx.arc(0, -mh * 0.96, mw * 0.2, 0, Math.PI * 2);
                    ctx.fillStyle = '#eef8ff';
                    ctx.fill();
                }

                // Cooldown "filling bullet" indicator above the silo
                if (!constructing && b.lastFiredAt) {
                    const age = now - b.lastFiredAt;
                    const cd = b.cooldownMs || 2000;
                    if (age < cd) {
                        const progress = age / cd;
                        const bx = 0;
                        const by = -mh * 1.4;
                        const bw = s * 0.25;
                        const bh = s * 0.6;
                        
                        // Empty bullet background
                        ctx.fillStyle = 'rgba(10, 10, 15, 0.8)';
                        ctx.fillRect(bx - bw/2, by - bh, bw, bh);
                        ctx.strokeStyle = `rgba(${r},${g},${bl},0.5)`;
                        ctx.lineWidth = Math.max(0.5, z * 0.5);
                        ctx.strokeRect(bx - bw/2, by - bh, bw, bh);

                        // Filled progress
                        const fillH = bh * progress;
                        ctx.fillStyle = hexColor;
                        if (!state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.3; }
                        ctx.fillRect(bx - bw/2, by - fillH, bw, fillH);
                        ctx.shadowBlur = 0;
                    }
                }
                // Chevron detail lines
                if (s > 9) {
                    ctx.strokeStyle = `rgba(${r},${g},${bl},0.45)`;
                    ctx.lineWidth = Math.max(0.3, z * 0.4);
                    for (const yOff of [-mh * 0.12, mh * 0.12]) {
                        ctx.beginPath();
                        ctx.moveTo(-mw * 0.32, yOff + mh * 0.1);
                        ctx.lineTo(0,           yOff - mh * 0.04);
                        ctx.lineTo( mw * 0.32,  yOff + mh * 0.1);
                        ctx.stroke();
                    }
                }

            } else if (isMine) {
                // ── GOLD MINE: octagonal power core with rotating energy ring ──
                const gr = s * 1.08;
                // Octagon
                const oct = gr * 0.88, cut = oct * 0.38;
                ctx.beginPath();
                ctx.moveTo(-oct + cut, -oct); ctx.lineTo( oct - cut, -oct);
                ctx.lineTo( oct,  -oct + cut); ctx.lineTo( oct,  oct - cut);
                ctx.lineTo( oct - cut,  oct); ctx.lineTo(-oct + cut,  oct);
                ctx.lineTo(-oct,  oct - cut); ctx.lineTo(-oct, -oct + cut);
                ctx.closePath();
                const cGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
                cGrad.addColorStop(0,    '#fff5c0');
                cGrad.addColorStop(0.28, '#fbbf24');
                cGrad.addColorStop(0.68, '#b45309');
                cGrad.addColorStop(1,    '#0c0700');
                ctx.fillStyle = cGrad;
                ctx.fill();
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = s * 1.4; }
                ctx.strokeStyle = constructing ? 'rgba(245,158,11,0.28)' : '#f59e0b';
                ctx.lineWidth = Math.max(0.8, z * 1.0);
                ctx.stroke();
                ctx.shadowBlur = 0;

                // Rotating dashed energy ring
                if (!constructing) {
                    ctx.save();
                    ctx.rotate((now * 0.001) % (Math.PI * 2));
                    ctx.setLineDash([s * 0.27, s * 0.21]);
                    ctx.beginPath(); ctx.arc(0, 0, gr * 0.55, 0, Math.PI * 2);
                    ctx.strokeStyle = 'rgba(255, 220, 70, 0.65)';
                    ctx.lineWidth = Math.max(0.8, z * 0.9);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.restore();
                }
                // Inner hex
                drawHex(gr * 0.36);
                ctx.strokeStyle = 'rgba(255,240,140,0.45)';
                ctx.lineWidth = Math.max(0.4, z * 0.45);
                ctx.stroke();

                if (s > 7) {
                    ctx.fillStyle = '#fff8d6';
                    ctx.font = `bold ${Math.floor(s * 0.88)}px 'Orbitron', monospace`;
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText('$', 0, 0);
                }

            } else if (isAntiAir) {
                // ── ANTI-AIR: rotating targeting reticle + angular base + twin barrels ──
                const baseGrad = ctx.createLinearGradient(0, s * 0.08, 0, s * 0.72);
                baseGrad.addColorStop(0, `rgba(${r},${g},${bl},0.88)`);
                baseGrad.addColorStop(1, 'rgba(3, 5, 12, 0.96)');
                ctx.beginPath();
                ctx.moveTo(-s*0.78, s*0.72); ctx.lineTo(-s*0.48, s*0.08);
                ctx.lineTo( s*0.48, s*0.08); ctx.lineTo( s*0.78, s*0.72);
                ctx.closePath();
                ctx.fillStyle = baseGrad; ctx.fill();
                ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
                ctx.lineWidth = Math.max(0.4, z * 0.6); ctx.stroke();

                // Rotating targeting reticle
                const reticleAngle = (now * 0.0016) % (Math.PI * 2);
                ctx.save();
                ctx.rotate(reticleAngle);
                const rr = s * 0.92;
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.75; }
                ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2);
                ctx.strokeStyle = hexColor;
                ctx.lineWidth = Math.max(0.8, z * 1.0); ctx.stroke();
                // Crosshair arms with gap
                const gap = rr * 0.36;
                for (let i = 0; i < 4; i++) {
                    const a = (Math.PI / 2) * i;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a)*gap, Math.sin(a)*gap);
                    ctx.lineTo(Math.cos(a)*rr,  Math.sin(a)*rr);
                    ctx.stroke();
                }
                ctx.shadowBlur = 0;
                // Tick marks
                ctx.lineWidth = Math.max(0.35, z * 0.45);
                ctx.strokeStyle = `rgba(${r},${g},${bl},0.45)`;
                for (let i = 0; i < 8; i++) {
                    const a = (Math.PI / 4) * i + Math.PI / 8;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a)*rr*0.77, Math.sin(a)*rr*0.77);
                    ctx.lineTo(Math.cos(a)*rr,      Math.sin(a)*rr);
                    ctx.stroke();
                }
                ctx.restore();

                // Twin barrels with muzzle highlight
                const charges = b.charges ?? 3;
                const barFill = charges > 0 ? hexColor : '#2a2a2a';
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = barFill; ctx.shadowBlur = s * 0.4; }
                for (const bx of [-s*0.32, s*0.32]) {
                    ctx.fillStyle = barFill;
                    ctx.fillRect(bx - s*0.09, -s*0.55, s*0.18, s*0.64);
                    if (!constructing && charges > 0) {
                        ctx.fillStyle = '#d0eeff';
                        ctx.fillRect(bx - s*0.09, -s*0.55, s*0.18, s*0.1);
                    }
                }
                ctx.shadowBlur = 0;

            } else if (isCity) {
                // ── CITY: skyline silhouette — three towers of varying heights ──
                const [cr, cg, cb] = [167, 139, 250];
                const bw = s * 0.34, bh = s * 1.55;
                const buildings = [
                    { x: -s*0.52, w: bw*0.9,  h: bh * 0.72 },
                    { x: -s*0.13, w: bw*1.12, h: bh },
                    { x:  s*0.29, w: bw*0.9,  h: bh * 0.85 },
                ];
                const baseY = s * 0.72;
                // Fill gradient
                const cityGrad = ctx.createLinearGradient(0, -bh, 0, baseY);
                cityGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.95)`);
                cityGrad.addColorStop(1, `rgba(${Math.floor(cr*0.3)},${Math.floor(cg*0.3)},${Math.floor(cb*0.3)},0.88)`);
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = s * 1.2; }
                for (const bd of buildings) {
                    ctx.beginPath();
                    ctx.rect(bd.x, baseY - bd.h, bd.w, bd.h);
                    ctx.fillStyle = cityGrad; ctx.fill();
                    ctx.strokeStyle = constructing ? 'rgba(167,139,250,0.3)' : '#a78bfa';
                    ctx.lineWidth = Math.max(0.5, z * 0.7); ctx.stroke();
                }
                ctx.shadowBlur = 0;
                // Windows — tiny bright dots
                if (!constructing && s > 6) {
                    ctx.fillStyle = 'rgba(230,220,255,0.85)';
                    for (const bd of buildings) {
                        for (let wy = 0; wy < 3; wy++) {
                            for (let wx = 0; wx < 2; wx++) {
                                const wx0 = bd.x + bd.w * (0.22 + wx * 0.45);
                                const wy0 = baseY - bd.h * (0.25 + wy * 0.28);
                                ctx.fillRect(wx0, wy0, Math.max(1, s*0.09), Math.max(1, s*0.09));
                            }
                        }
                    }
                }

            } else {
                // ── DEFENSE TOWER: cyberpunk fortress with power conduits ──
                const tw = s * 1.05, th = s * 1.68;
                const tGrad = ctx.createLinearGradient(-tw, -th*0.45, tw*0.55, th*0.5);
                tGrad.addColorStop(0,    `rgba(${r},${g},${bl},0.9)`);
                tGrad.addColorStop(0.5,  `rgba(${Math.floor(r*0.38)},${Math.floor(g*0.38)},${Math.floor(bl*0.38)},0.9)`);
                tGrad.addColorStop(1,    'rgba(3,5,12,0.95)');
                ctx.beginPath();
                ctx.rect(-tw*0.58, -th*0.44, tw*1.16, th*0.94);
                ctx.fillStyle = tGrad; ctx.fill();

                // Angular battlements (notched tops)
                const mw = tw*0.3, mh = th*0.22, mTop = -th*0.44 - mh;
                ctx.fillStyle = `rgba(${r},${g},${bl},0.93)`;
                for (const mx of [-tw*0.5, 0, tw*0.5]) {
                    ctx.beginPath();
                    ctx.moveTo(mx - mw/2,    mTop + mh);
                    ctx.lineTo(mx - mw/2,    mTop + mh*0.28);
                    ctx.lineTo(mx - mw*0.14, mTop);
                    ctx.lineTo(mx + mw*0.14, mTop);
                    ctx.lineTo(mx + mw/2,    mTop + mh*0.28);
                    ctx.lineTo(mx + mw/2,    mTop + mh);
                    ctx.closePath(); ctx.fill();
                }

                // Neon outline
                if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.85; }
                ctx.strokeStyle = `rgba(${r},${g},${bl},0.78)`;
                ctx.lineWidth = Math.max(0.5, z * 0.75);
                ctx.strokeRect(-tw*0.58, -th*0.44, tw*1.16, th*0.94);
                ctx.shadowBlur = 0;

                // Power conduit lines
                ctx.strokeStyle = `rgba(${r},${g},${bl},0.4)`;
                ctx.lineWidth = Math.max(0.35, z * 0.45);
                ctx.beginPath(); ctx.moveTo(0, -th*0.3);  ctx.lineTo(0, th*0.46);  ctx.stroke();
                ctx.beginPath(); ctx.moveTo(-tw*0.46, th*0.05); ctx.lineTo(tw*0.46, th*0.05); ctx.stroke();

                // Central target node
                if (s > 7) {
                    ctx.beginPath();
                    ctx.arc(0, th*0.05, s*0.18, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(${r},${g},${bl},0.35)`; ctx.fill();
                    if (!constructing && !state.lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.5; }
                    ctx.strokeStyle = hexColor;
                    ctx.lineWidth = Math.max(0.5, z * 0.65); ctx.stroke();
                    ctx.shadowBlur = 0;
                    ctx.beginPath(); ctx.arc(0, th*0.05, s*0.07, 0, Math.PI * 2);
                    ctx.fillStyle = hexColor; ctx.fill();
                }

                // Corner tech brackets
                if (s > 10) {
                    const bLen = tw * 0.24;
                    ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
                    ctx.lineWidth = Math.max(0.5, z * 0.55);
                    for (const [cx, cy, dx, dy] of [
                        [-tw*0.58, -th*0.44,  1,  1],
                        [ tw*0.58, -th*0.44, -1,  1],
                        [-tw*0.58,  th*0.5,   1, -1],
                        [ tw*0.58,  th*0.5,  -1, -1],
                    ]) {
                        ctx.beginPath();
                        ctx.moveTo(cx + dx*bLen, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy*bLen);
                        ctx.stroke();
                    }
                }
            }

            ctx.restore();

            // ── Anti-Air charge dot indicators ──
            if (isAntiAir && !constructing) {
                const charges = b.charges ?? 3;
                if (charges > 0 && iconSize > 8) {
                    const dotR = Math.max(2, iconSize * 0.2);
                    const spacing = dotR * 2.9;
                    const dotY = pos.y - iconSize * 2.5;
                    if (!state.lowGraphics) { ctx.shadowColor = '#ff2020'; ctx.shadowBlur = dotR * 3; }
                    ctx.fillStyle = '#ff4040';
                    for (let i = 0; i < charges; i++) {
                        ctx.beginPath();
                        ctx.arc(pos.x - ((charges-1)*spacing)/2 + i*spacing, dotY, dotR, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    ctx.shadowBlur = 0;
                }
            }

            // ── Construction progress bar ──
            if (constructing) {
                const barW = iconSize * 3.5, barH = Math.max(3, iconSize * 0.4);
                const bx = pos.x - barW / 2, by = pos.y + iconSize * 2.35;
                const rad = barH / 2;
                const barAccent = isMine ? '#f59e0b' : color;
                const barRgb   = isMine ? '245,158,11' : `${rgb[0]},${rgb[1]},${rgb[2]}`;
                ctx.fillStyle = 'rgba(3, 5, 12, 0.95)';
                ctx.beginPath(); ctx.roundRect(bx-2, by-2, barW+4, barH+4, rad+2); ctx.fill();
                if (progress > 0.01) {
                    const fillW = Math.max(barH, barW * progress);
                    const fGrad = ctx.createLinearGradient(bx, 0, bx+fillW, 0);
                    fGrad.addColorStop(0, barAccent); fGrad.addColorStop(0.75, '#ffffff'); fGrad.addColorStop(1, '#ffffff');
                    ctx.fillStyle = fGrad;
                    if (!state.lowGraphics) { ctx.shadowColor = barAccent; ctx.shadowBlur = barH * 2; }
                    ctx.beginPath(); ctx.roundRect(bx, by, fillW, barH, rad); ctx.fill();
                    ctx.shadowBlur = 0;
                }
                ctx.strokeStyle = `rgba(${barRgb},0.4)`;
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.roundRect(bx-2, by-2, barW+4, barH+4, rad+2); ctx.stroke();
            }

            // ── Defense zone ring ──
            if (!isSilo && !isMine && !isAntiAir && this.camera.zoom > 1.2) {
                const screenRadius = b.radius * this.camera.zoom;
                ctx.beginPath(); ctx.arc(pos.x, pos.y, screenRadius, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255, 200, 50, 0.28)';
                ctx.lineWidth = 1.5; ctx.setLineDash([5, 7]); ctx.stroke(); ctx.setLineDash([]);
            }
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
                ctx.arc(c.x, c.y, SILO_RANGE * this.camera.zoom, 0, Math.PI * 2);
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
