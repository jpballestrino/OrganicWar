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

        this.ownerPtr = null;
        this.resourceYieldPtr = null;
        
        this.ownerTexture = null;
        this.terrainTexture = null;

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

            uniform usampler2D u_owner_tex;
            uniform usampler2D u_terrain_tex;

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
                uint terrainVal = texelFetch(u_terrain_tex, texCoord, 0).r;
                uint ownerVal = texelFetch(u_owner_tex, texCoord, 0).r;

                vec3 baseColor;
                if (terrainVal == 0u) {
                    baseColor = vec3(0.95, 0.98, 0.90); 
                } else if (terrainVal == 1u) {
                    baseColor = vec3(0.92, 0.85, 0.75); 
                } else if (terrainVal == 2u) {
                    baseColor = vec3(0.85, 0.85, 0.88); 
                } else if (terrainVal == 3u) {
                    baseColor = vec3(0.75, 0.88, 0.96); 
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
            ownerTex: this.gl.getUniformLocation(this.program, 'u_owner_tex'),
            terrainTex: this.gl.getUniformLocation(this.program, 'u_terrain_tex')
        };

        this.gl.uniform2f(this.uniforms.mapSize, MAP_WIDTH, MAP_HEIGHT);
        this.gl.uniform1i(this.uniforms.ownerTex, 0); // Texture unit 0
        this.gl.uniform1i(this.uniforms.terrainTex, 1); // Texture unit 1
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
        // Create Owner Texture (R32UI - 32-bit unsigned integer)
        this.ownerTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.ownerTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R32UI, MAP_WIDTH, MAP_HEIGHT, 0, this.gl.RED_INTEGER, this.gl.UNSIGNED_INT, null);

        // Create Terrain Texture (R8UI - 8-bit unsigned integer)
        this.terrainTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.terrainTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R8UI, MAP_WIDTH, MAP_HEIGHT, 0, this.gl.RED_INTEGER, this.gl.UNSIGNED_BYTE, null);
    }

    setMemoryPointers(ownerPtr, resourceYieldPtr) {
        this.ownerPtr = ownerPtr;
        this.resourceYieldPtr = resourceYieldPtr;
        this.terrainUploaded = false;
    }

    uploadTerrainOnce() {
        if (this.terrainUploaded || this.resourceYieldPtr === null || !this.wasmMemory) return;
        const terrainArray = new Uint8Array(this.wasmMemory.buffer, this.resourceYieldPtr, TOTAL_CELLS);
        this.gl.activeTexture(this.gl.TEXTURE1);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.terrainTexture);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, MAP_WIDTH, MAP_HEIGHT, this.gl.RED_INTEGER, this.gl.UNSIGNED_BYTE, terrainArray);
        this.terrainUploaded = true;
    }

    invalidateTerrain() {
        // Call this if terrain ever changes (e.g., naval flooding, terraforming).
        this.terrainUploaded = false;
    }

    setupControls() {
        window.addEventListener('keydown', (e) => {
            if (this.keys.hasOwnProperty(e.key)) this.keys[e.key] = true;
        });

        window.addEventListener('keyup', (e) => {
            if (this.keys.hasOwnProperty(e.key)) this.keys[e.key] = false;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
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

    render(time) {
        const dt = time - this.lastTime;
        this.lastTime = time;

        this.updateCamera(dt);

        // Upload memory to GPU
        if (this.ownerPtr !== null && this.resourceYieldPtr !== null && this.wasmMemory) {
            this.uploadTerrainOnce();

            const ownerArray = new Uint32Array(this.wasmMemory.buffer, this.ownerPtr, TOTAL_CELLS);
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.ownerTexture);
            this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, MAP_WIDTH, MAP_HEIGHT, this.gl.RED_INTEGER, this.gl.UNSIGNED_INT, ownerArray);
        }

        // Draw
        this.gl.bindVertexArray(this.vao);
        this.gl.useProgram(this.program);
        this.gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
        this.gl.uniform2f(this.uniforms.cameraPos, this.camera.x, this.camera.y);
        this.gl.uniform1f(this.uniforms.zoom, this.camera.zoom);

        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }
}
