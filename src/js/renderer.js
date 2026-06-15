import { state } from './state.js';
import { factionHexColors, BUILDING_RADIUS, SILO_RANGE, MISSILE_BLAST_RADIUS } from './constants.js';

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

            // Palette for 20 players (Index 0 is Neutral)
            const vec3 playerColors[21] = vec3[](
                vec3(0.0, 0.0, 0.0),       // 0: Neutral (Unused directly in blend)
                vec3(0.9, 0.3, 0.3),       // 1: Red
                vec3(0.3, 0.5, 0.9),       // 2: Blue
                vec3(0.3, 0.8, 0.4),       // 3: Green
                vec3(0.9, 0.8, 0.2),       // 4: Yellow
                vec3(0.8, 0.3, 0.9),       // 5: Purple
                vec3(0.9, 0.5, 0.2),       // 6: Orange
                vec3(0.2, 0.8, 0.8),       // 7: Cyan
                vec3(0.9, 0.4, 0.7),       // 8: Pink
                vec3(0.5, 0.3, 0.1),       // 9: Brown
                vec3(0.5, 0.9, 0.6),       // 10: Mint
                vec3(0.6, 0.6, 0.9),       // 11: Periwinkle
                vec3(0.8, 0.9, 0.3),       // 12: Lime
                vec3(0.9, 0.6, 0.5),       // 13: Salmon
                vec3(0.4, 0.2, 0.6),       // 14: Deep Purple
                vec3(0.2, 0.5, 0.4),       // 15: Teal
                vec3(0.7, 0.2, 0.3),       // 16: Maroon
                vec3(0.6, 0.5, 0.2),       // 17: Olive
                vec3(0.3, 0.3, 0.6),       // 18: Navy
                vec3(0.9, 0.3, 0.5),       // 19: Magenta
                vec3(0.5, 0.5, 0.5)        // 20: Grey
            );

            void main() {
                // Calculate map coordinate based on screen UV, camera pos, and zoom
                vec2 pixelCoord = v_uv * u_resolution;
                vec2 worldCoord = (pixelCoord / u_zoom) + u_camera_pos;

                // Debug: if out of bounds, draw bright magenta
                if (worldCoord.x < 0.0 || worldCoord.x >= u_map_size.x ||
                    worldCoord.y < 0.0 || worldCoord.y >= u_map_size.y) {
                    outColor = vec4(0.20, 0.20, 0.22, 1.0); // Grey backdrop so the map border reads clearly
                    return;
                }

                ivec2 texCoord = ivec2(worldCoord);
                uint packed = texelFetch(u_cell_tex, texCoord, 0).r;
                uint ownerVal = packed & 127u;
                uint terrainVal = (packed >> 7u) & 15u;

                vec3 baseColor;
                if (terrainVal == 0u) {
                    baseColor = vec3(241.0/255.0, 245.0/255.0, 237.0/255.0); // Plains (#f1f5ed)
                } else if (terrainVal == 1u) {
                    baseColor = vec3(230.0/255.0, 223.0/255.0, 210.0/255.0); // Highlands (#e6dfd2)
                } else if (terrainVal == 2u) {
                    baseColor = vec3(215.0/255.0, 215.0/255.0, 215.0/255.0); // Mountains (#d7d7d7)
                } else if (terrainVal == 3u) {
                    baseColor = vec3(120.0/255.0, 190.0/255.0, 220.0/255.0); // Water (#78bedc)
                } else {
                    // Debug: if terrainVal is wildly out of range, draw bright yellow
                    baseColor = vec3(1.0, 1.0, 0.0);
                }

                if (ownerVal > 0u && ownerVal <= 20u) {
                    vec3 pColor = playerColors[ownerVal];
                    ivec2 sz = ivec2(u_map_size);
                    bool inL = texCoord.x > 0;
                    bool inR = texCoord.x < sz.x - 1;
                    bool inU = texCoord.y > 0;
                    bool inD = texCoord.y < sz.y - 1;

                    // Cardinal neighbors for border outline detection.
                    uint nl = inL ? (texelFetch(u_cell_tex, texCoord + ivec2(-1, 0), 0).r & 127u) : ownerVal;
                    uint nr = inR ? (texelFetch(u_cell_tex, texCoord + ivec2( 1, 0), 0).r & 127u) : ownerVal;
                    uint nu = inU ? (texelFetch(u_cell_tex, texCoord + ivec2( 0,-1), 0).r & 127u) : ownerVal;
                    uint nd = inD ? (texelFetch(u_cell_tex, texCoord + ivec2( 0, 1), 0).r & 127u) : ownerVal;

                    // Per-cell HEATMAP opacity: proportional to that cell's
                    // difficulty_to_invade = (density + terrain) * defense_tier.
                    // terrainVal 0=plains(1pt), 1=highlands(3pt), 2=mountains(6pt).
                    float terrainCost = (terrainVal == 0u) ? 1.0 : (terrainVal == 1u) ? 3.0 : (terrainVal == 2u) ? 6.0 : 0.0;
                    // Defense tier in bits 11-14; defaults to 1 until buildings raise it.
                    uint defTierRaw = (packed >> 11u) & 15u;
                    float defTier = float(defTierRaw == 0u ? 1u : defTierRaw);
                    // u_player_opacity[owner] = density / DIFFICULTY_CAP. Normalize the
                    // full per-cell difficulty to 0..1 (its share of DIFFICULTY_CAP).
                    float diffNorm = clamp((u_player_opacity[ownerVal] + terrainCost / 25.0) * defTier, 0.0, 1.0);
                    // Linear ramp from a visibility floor: easy cells stay faint but
                    // visible (0.12), the hardest cells render fully solid (1.0). Using
                    // a ramp (not a hard clamp) keeps EVERY difficulty step visible, so
                    // the territory reads as a heatmap instead of flattening at the floor.
                    float opacity = 0.12 + 0.88 * diffNorm;
                    baseColor = mix(baseColor, pColor, opacity);

                    // Border outline: darken cells where any cardinal neighbor differs.
                    if (nl != ownerVal || nr != ownerVal || nu != ownerVal || nd != ownerVal) {
                        baseColor *= 0.45;
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
            playerOpacity: this.gl.getUniformLocation(this.program, 'u_player_opacity')
        };

        this.gl.uniform2f(this.uniforms.mapSize, MAP_WIDTH, MAP_HEIGHT);
        this.gl.uniform1i(this.uniforms.cellTex, 0); // Texture unit 0
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

    // Draw a shield icon at each placed defense building.
    drawBuildings(ctx, buildings) {
        if (!buildings || buildings.length === 0) return;

        const now = performance.now();

        for (const b of buildings) {
            const pos = this.worldToScreen(b.col, b.row);

            // Cull off-screen buildings.
            if (pos.x < -50 || pos.x > this.canvas.width + 50 ||
                pos.y < -50 || pos.y > this.canvas.height + 50) continue;

            const iconSize = Math.max(5, 10 * this.camera.zoom);
            const color = factionHexColors[b.factionId] || '#888888';

            // Construction progress (0..1), clamped so a wall-clock bar can't
            // overshoot before the authoritative `building-completed` arrives.
            const constructing = !!b.constructing;
            const progress = constructing
                ? Math.min(1, Math.max(0, (now - (b.builtAt || now)) / (b.buildMs || 5000)))
                : 1;

            // Dark backdrop circle.
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, iconSize * 1.4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(8, 8, 18, 0.78)';
            ctx.fill();

            const isSilo = b.type === 'silo';

            // Icon silhouette (dimmed while still under construction).
            ctx.save();
            ctx.translate(pos.x, pos.y);
            if (constructing) ctx.globalAlpha = 0.5;
            const sw = iconSize * 0.8;
            const sh = iconSize;
            ctx.beginPath();
            if (isSilo) {
                // Upward rocket: nose cone, body, fins.
                ctx.moveTo(0, -sh);
                ctx.lineTo(sw * 0.7, -sh * 0.1);
                ctx.lineTo(sw * 0.7, sh * 0.55);
                ctx.lineTo(sw, sh);             // right fin
                ctx.lineTo(sw * 0.35, sh * 0.7);
                ctx.lineTo(-sw * 0.35, sh * 0.7);
                ctx.lineTo(-sw, sh);            // left fin
                ctx.lineTo(-sw * 0.7, sh * 0.55);
                ctx.lineTo(-sw * 0.7, -sh * 0.1);
            } else {
                // Defense shield.
                ctx.moveTo(0, -sh);
                ctx.lineTo(sw, -sh * 0.35);
                ctx.lineTo(sw, sh * 0.2);
                ctx.lineTo(0, sh);
                ctx.lineTo(-sw, sh * 0.2);
                ctx.lineTo(-sw, -sh * 0.35);
            }
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = Math.max(1, 1.5 * this.camera.zoom);
            ctx.stroke();

            // Glyph inside the icon (only when large enough to read).
            if (iconSize > 7 && !isSilo) {
                ctx.fillStyle = '#fff';
                ctx.font = `bold ${Math.floor(iconSize * 0.9)}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('⛌', 0, sh * 0.05); // ⛌ castle-tower glyph
            }
            ctx.restore();

            // Construction progress bar under the icon — fills left→right over the
            // build time, then disappears once `building-completed` clears the flag.
            if (constructing) {
                const barW = iconSize * 3;
                const barH = Math.max(3, iconSize * 0.45);
                const barX = pos.x - barW / 2;
                const barY = pos.y + iconSize * 1.8;
                // Track.
                ctx.fillStyle = 'rgba(8, 8, 18, 0.85)';
                ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
                // Fill.
                ctx.fillStyle = color;
                ctx.fillRect(barX, barY, barW * progress, barH);
                // Border.
                ctx.strokeStyle = 'rgba(255,255,255,0.7)';
                ctx.lineWidth = 1;
                ctx.strokeRect(barX - 1, barY - 1, barW + 2, barH + 2);
            }

            // Dashed influence ring — defense towers only (silos have no zone and
            // carry `range`, not `radius`), and only when zoomed in enough to be useful.
            if (!isSilo && this.camera.zoom > 1.2) {
                const screenRadius = b.radius * this.camera.zoom;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, screenRadius, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255, 200, 50, 0.28)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([5, 7]);
                ctx.stroke();
                ctx.setLineDash([]);
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
            
            if (t >= 1.0) {
                // Missile landed! Trigger explosion.
                explosions.push({ row: m.targetRow, col: m.targetCol, blastRadius: MISSILE_BLAST_RADIUS, startedAt: now });
                continue; 
            }
            
            surviving.push(m);
            
            // Interpolate position
            const currRow = m.sourceRow + (m.targetRow - m.sourceRow) * t;
            const currCol = m.sourceCol + (m.targetCol - m.sourceCol) * t;
            
            // Calculate screen positions
            const sStart = this.worldToScreen(m.sourceCol, m.sourceRow);
            const sTarget = this.worldToScreen(m.targetCol, m.targetRow);
            const sCurr = this.worldToScreen(currCol, currRow);
            
            // Parabola math: peak at t = 0.5. Height in pixels.
            const arcHeight = 150 * Math.sin(t * Math.PI);
            
            // Actual draw Y is offset upwards by the arcHeight
            const drawX = sCurr.x;
            const drawY = sCurr.y - arcHeight;
            
            const factionColor = factionHexColors[m.factionId] || '#fff';
            
            // Draw a tiny trailing line (from slightly earlier t)
            const tOld = Math.max(0, t - 0.05);
            const oldRow = m.sourceRow + (m.targetRow - m.sourceRow) * tOld;
            const oldCol = m.sourceCol + (m.targetCol - m.sourceCol) * tOld;
            const sOld = this.worldToScreen(oldCol, oldRow);
            const oldArc = 150 * Math.sin(tOld * Math.PI);
            
            ctx.beginPath();
            ctx.moveTo(sOld.x, sOld.y - oldArc);
            ctx.lineTo(drawX, drawY);
            ctx.strokeStyle = factionColor;
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Draw the glowing missile head
            ctx.beginPath();
            ctx.arc(drawX, drawY, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.shadowColor = factionColor;
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0; // reset
        }
        
        return surviving;
    }

    // Draw active missile blasts as an expanding fading flash. Returns the list of
    // explosions still animating (callers reassign to prune finished ones).
    drawExplosions(ctx, explosions) {
        if (!explosions || explosions.length === 0) return explosions || [];
        const now = performance.now();
        const DURATION = 700; // ms
        const surviving = [];
        for (const ex of explosions) {
            const t = (now - ex.startedAt) / DURATION;
            if (t >= 1) continue; // finished — drop it
            surviving.push(ex);
            const c = this.worldToScreen(ex.col, ex.row);
            const maxR = ex.blastRadius * this.camera.zoom;
            // Shockwave ring expands outward; bright core fades.
            const ringR = maxR * Math.min(1, t * 1.3);
            ctx.beginPath();
            ctx.arc(c.x, c.y, ringR, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, ${Math.floor(180 * (1 - t))}, 40, ${0.55 * (1 - t)})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(255, 240, 180, ${0.9 * (1 - t)})`;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        return surviving;
    }
}
