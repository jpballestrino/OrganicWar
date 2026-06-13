import { state } from './state.js';

const MAP_WIDTH = 1920;
const MAP_HEIGHT = 1080;
const TOTAL_CELLS = 2073600;


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
                    baseColor = mix(baseColor, pColor, 0.5); // More visible mix
                } else if (ownerVal > 20u) {
                    // Debug: if ownerVal is out of range, draw red
                    baseColor = vec3(1.0, 0.0, 0.0);
                }

                // Territory borders: darken an owned cell that touches a cell with
                // a different owner, drawing a 1-cell outline around each territory
                // (against neutral land and against other factions alike).
                if (ownerVal > 0u) {
                    ivec2 sz = ivec2(u_map_size);
                    uint l = (texCoord.x > 0)        ? (texelFetch(u_cell_tex, texCoord + ivec2(-1, 0), 0).r & 127u) : 0u;
                    uint r = (texCoord.x < sz.x - 1) ? (texelFetch(u_cell_tex, texCoord + ivec2( 1, 0), 0).r & 127u) : 0u;
                    uint u = (texCoord.y > 0)        ? (texelFetch(u_cell_tex, texCoord + ivec2( 0,-1), 0).r & 127u) : 0u;
                    uint d = (texCoord.y < sz.y - 1) ? (texelFetch(u_cell_tex, texCoord + ivec2( 0, 1), 0).r & 127u) : 0u;
                    if (l != ownerVal || r != ownerVal || u != ownerVal || d != ownerVal) {
                        baseColor *= 0.45; // border line: darker shade of the territory color
                    }
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
            cellTex: this.gl.getUniformLocation(this.program, 'u_cell_tex')
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
            if (this.keys.hasOwnProperty(key)) this.keys[key] = true;
        });

        window.addEventListener('keyup', (e) => {
            if (!e.key) return;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            if (this.keys.hasOwnProperty(key)) this.keys[key] = false;
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
            const troopsText = c.troops.toLocaleString();

            // Name (bold) on top, troop count below; dark outline for legibility.
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 3;

            ctx.font = "bold 13px 'Orbitron', sans-serif";
            ctx.strokeText(name, pos.x, pos.y - 8);
            ctx.fillStyle = isMe ? '#ffe07a' : '#ffffff';
            ctx.fillText(name, pos.x, pos.y - 8);

            ctx.font = "12px 'Orbitron', sans-serif";
            ctx.strokeText(troopsText, pos.x, pos.y + 8);
            ctx.fillStyle = '#d0d0d0';
            ctx.fillText(troopsText, pos.x, pos.y + 8);
        }

        ctx.textBaseline = 'alphabetic';
    }
}
