// App State
let appData = [];
let globalMapData = [];
let currentQuery = null;
let currentStep = 3; // default to step 3 (final)
let isAnimating = false;
let isQueryHeatmap = true;
let isRetrievedHeatmap = false;
let isGlobalMapVisible = true;
let isAlignedQueryVisible = false;

// Viewers state
const localViewers = {
    query: null,
    step1: null,
    step2: null,
    step3: null
};
let global3dViewer = null;
let leafletMap = null;

// Leaflet markers/layers
let queryMarker = null;
let queryCircle = null;
let retrievedMarker = null;
let mapPointsLayerGroup = null;

// Three.js Global overlays
let globalQueryPointsObj = null;
let globalRetrievedPointsObj = null;
let globalAlignedPointsObj = null;
let globalQueryBoxObj = null;
let globalRetrievedBoxObj = null;
let globalMapObj = null;

// DOM Elements
const selectQuery = document.getElementById('query-select');
const sliderStep = document.getElementById('step-slider');
const btnPlay = document.getElementById('btn-play');

const infoQueryIdx = document.getElementById('info-query-idx');
const infoQueryFile = document.getElementById('info-query-file');
const infoQueryUtm = document.getElementById('info-query-utm');
const infoQueryLatlon = document.getElementById('info-query-latlon');

const distStep1 = document.getElementById('dist-step-1');
const distStep2 = document.getElementById('dist-step-2');
const distStep3 = document.getElementById('dist-step-3');

const badgeStep1 = document.getElementById('badge-step-1');
const badgeStep2 = document.getElementById('badge-step-2');
const badgeStep3 = document.getElementById('badge-step-3');

const timelineS1 = document.getElementById('timeline-s1');
const timelineS2 = document.getElementById('timeline-s2');
const timelineS3 = document.getElementById('timeline-s3');
const statusS1 = document.getElementById('status-s1');
const statusS2 = document.getElementById('status-s2');
const statusS3 = document.getElementById('status-s3');

// Initialize Application
window.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log("Loading datasets...");
        const metaRes = await fetch('metadata.json');
        appData = await metaRes.json();
        console.log(`Loaded ${appData.length} query metadata.`);
        
        // Populate Select
        selectQuery.innerHTML = '';
        appData.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.query_idx;
            opt.textContent = `${item.location} - Query ${item.query_idx} (${item.category})`;
            selectQuery.appendChild(opt);
        });
        
        // Init Leaflet Map
        initLeafletMap();
        
        // Init Three.js local viewers
        initLocalViewers();
        
        // Init Three.js global 3D viewer (with empty global map initially)
        initGlobal3dViewer();
        
        // Setup Event Listeners
        selectQuery.addEventListener('change', (e) => {
            selectQueryIndex(parseInt(e.target.value));
        });
        
        sliderStep.addEventListener('input', (e) => {
            setActiveStep(parseInt(e.target.value));
        });
        
        btnPlay.addEventListener('click', animateRefinement);
        
        // Select first query by default
        if (appData.length > 0) {
            selectQueryIndex(appData[0].query_idx);
        }
        
        // Load the global map in background asynchronously
        loadGlobalMap();
        
    } catch (err) {
        console.error("Initialization failed:", err);
    }
});

// Load the full RGB Global Map in the background
async function loadGlobalMap() {
    try {
        console.log("Loading global map in background...");
        const response = await fetch('visuals/global_map_downsampled.bin').catch(() => fetch('visuals/global_map_downsampled.json'));
        
        const isBin = response.url.endsWith('.bin');
        let buffer;
        
        if (isBin) {
            const contentLength = response.headers.get('content-length');
            const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            
            if (!response.body || totalBytes === 0) {
                // Fallback if ReadableStream is not supported or content-length is missing
                buffer = await response.arrayBuffer();
            } else {
                const reader = response.body.getReader();
                const progressBar = document.getElementById('global-map-progress-bar');
                const loadingText = document.getElementById('global-map-loading-text');
                
                let receivedBytes = 0;
                const chunks = [];
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    receivedBytes += value.length;
                    
                    const pct = Math.round((receivedBytes / totalBytes) * 100);
                    if (progressBar) progressBar.style.width = `${pct}%`;
                    if (loadingText) loadingText.textContent = `Loading 3D Campus Map... (${pct}%)`;
                }
                
                // Concatenate chunks
                const allChunks = new Uint8Array(receivedBytes);
                let position = 0;
                for (const chunk of chunks) {
                    allChunks.set(chunk, position);
                    position += chunk.length;
                }
                buffer = allChunks.buffer;
            }
            
            const view = new DataView(buffer);
            const numPoints = view.getUint32(0, true);
            const floatView = new Float32Array(buffer, 4, numPoints * 3);
            const uint8View = new Uint8Array(buffer, 4 + numPoints * 12, numPoints * 3);
            globalMapData = { positions: floatView, colors: uint8View, length: numPoints };
        } else {
            const jsonData = await response.json();
            globalMapData = {
                positions: Float32Array.from(jsonData.flatMap(pt => [pt[0], pt[1], pt[2]])),
                colors: Uint8Array.from(jsonData.flatMap(pt => [pt[3], pt[4], pt[5]])),
                length: jsonData.length
            };
        }
        console.log(`Global map loaded in background: ${globalMapData.length} points.`);
        
        // Hide loader overlay if present
        const loader = document.getElementById('global-map-loading');
        if (loader) {
            loader.style.display = 'none';
        }
        
        // Update Three.js global map geometry with the full map
        if (globalMapObj) {
            globalMapObj.geometry.setAttribute('position', new THREE.BufferAttribute(globalMapData.positions, 3));
            globalMapObj.geometry.setAttribute('color', new THREE.BufferAttribute(globalMapData.colors, 3, true));
            globalMapObj.geometry.attributes.position.needsUpdate = true;
            globalMapObj.geometry.attributes.color.needsUpdate = true;
            globalMapObj.geometry.computeBoundingSphere();
            globalMapObj.visible = isGlobalMapVisible;
        }
        
        // Force rendering overlays if query was selected prior to loading completion
        if (currentQuery) {
            renderActiveStepState(true);
        }
    } catch (err) {
        console.error("Failed to load global map in background:", err);
    }
}

// Initialize Leaflet Map
function initLeafletMap() {
    // Center around UMD College Park campus
    leafletMap = L.map('map', {
        zoomControl: true,
        preferCanvas: true // Use canvas renderer for point cloud plotting
    }).setView([38.9904, -76.9375], 16);
    
    // Add Esri Satellite Layer
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, GeoEye, Aerogrid, IGN, and the GIS User Community',
        maxZoom: 19
    }).addTo(leafletMap);
    
    mapPointsLayerGroup = L.layerGroup().addTo(leafletMap);
}

// 3D Local Viewers Initialization
function initLocalViewers() {
    localViewers.query = createLocalViewer('canvas-query', 'query');
    localViewers.step1 = createLocalViewer('canvas-step-1', 'step-1');
    localViewers.step2 = createLocalViewer('canvas-step-2', 'step-2');
    localViewers.step3 = createLocalViewer('canvas-step-3', 'step-3');
}

// 3D local viewer builder
function createLocalViewer(elementId, type) {
    const container = document.getElementById(elementId);
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);
    
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.up.set(0, 0, 1); // Set Z as up vector to match point cloud coordinates
    camera.position.set(0, -3, 1);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = true;
    controls.maxPolarAngle = Math.PI / 2; // Restrict viewing below ground level
    
    let pointsObj = null;
    
    // Resize handler
    window.addEventListener('resize', () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
    
    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
    
    return {
        updatePoints(pointsArray, isCorrect = true) {
            // Clear existing
            if (pointsObj) {
                scene.remove(pointsObj);
                pointsObj.geometry.dispose();
                pointsObj.material.dispose();
                pointsObj = null;
            }
            
            if (!pointsArray || pointsArray.length === 0) return;
            
            const geometry = new THREE.BufferGeometry();
            const positions = [];
            const colors = [];
            
            // Calculate height ranges for color gradient mapping
            let zMin = Infinity, zMax = -Infinity;
            pointsArray.forEach(pt => {
                const z = pt[2];
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
            });
            
            pointsArray.forEach(pt => {
                const x = pt[0];
                const y = pt[1];
                const z = pt[2];
                positions.push(x, y, z);
                
                const normZ = (zMax - zMin) > 0 ? (z - zMin) / (zMax - zMin) : 0.5;
                
                if (type === 'query') {
                    // Blue height-gradient: Dark blue (bottom) to light blue/cyan (top)
                    const r = 0.1 + normZ * 0.6; // some red to lighten
                    const g = 0.3 + normZ * 0.6; // cyan tone
                    const b = 1.0;
                    colors.push(r, g, b);
                } else {
                    // Retrieval: Green/Red fading to white as height increases
                    if (isCorrect) {
                        const r = 0.06 + normZ * (1.0 - 0.06);
                        const g = 0.73 + normZ * (1.0 - 0.73);
                        const b = 0.51 + normZ * (1.0 - 0.51);
                        colors.push(r, g, b);
                    } else {
                        const r = 0.94 + normZ * (1.0 - 0.94);
                        const g = 0.27 + normZ * (1.0 - 0.27);
                        const b = 0.27 + normZ * (1.0 - 0.27);
                        colors.push(r, g, b);
                    }
                }
            });
            
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            
            const material = new THREE.PointsMaterial({
                size: 0.05,
                vertexColors: true,
                transparent: true,
                opacity: 0.85
            });
            
            pointsObj = new THREE.Points(geometry, material);
            scene.add(pointsObj);
            
            // Adjust camera view
            geometry.computeBoundingSphere();
            const sphere = geometry.boundingSphere;
            if (sphere) {
                controls.target.copy(sphere.center);
                camera.position.set(sphere.center.x, sphere.center.y, sphere.radius * 2);
                controls.update();
            }
        }
    };
}

// Helper to generate a ring texture dynamically on a canvas
function createRingTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    // Clear and draw a thick ring (hollow circle)
    ctx.clearRect(0, 0, 64, 64);
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

// 3D Global Map Viewer Initialization
function initGlobal3dViewer() {
    const container = document.getElementById('global-3d-map');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);
    
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
    camera.up.set(0, 0, 1); // Set Z as up vector
    camera.position.set(0, -1000, 500);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.01; // Don't orbit below ground
    
    // Add static RGB Global Map points (initially empty)
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(0);
    const colors = new Float32Array(0);
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    
    const material = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: false
    });
    
    globalMapObj = new THREE.Points(geometry, material);
    scene.add(globalMapObj);
    console.log("RGB Global Map points loaded in Three.js Scene.");
    
    const btnQueryHeatmap = document.getElementById('btn-toggle-query-heatmap');
    btnQueryHeatmap.addEventListener('click', () => {
        isQueryHeatmap = !isQueryHeatmap;
        if (isQueryHeatmap) {
            btnQueryHeatmap.textContent = "Query Heatmap: ON";
            btnQueryHeatmap.classList.replace('btn-secondary', 'btn-primary');
        } else {
            btnQueryHeatmap.textContent = "Query Heatmap: OFF";
            btnQueryHeatmap.classList.replace('btn-primary', 'btn-secondary');
        }
        if (currentQuery) {
            renderActiveStepState();
        }
    });

    const btnRetrievedHeatmap = document.getElementById('btn-toggle-retrieved-heatmap');
    btnRetrievedHeatmap.addEventListener('click', () => {
        isRetrievedHeatmap = !isRetrievedHeatmap;
        if (isRetrievedHeatmap) {
            btnRetrievedHeatmap.textContent = "Retrieved Heatmap: ON";
            btnRetrievedHeatmap.classList.replace('btn-secondary', 'btn-primary');
        } else {
            btnRetrievedHeatmap.textContent = "Retrieved Heatmap: OFF";
            btnRetrievedHeatmap.classList.replace('btn-primary', 'btn-secondary');
        }
        if (currentQuery) {
            renderActiveStepState();
        }
    });

    const btnGlobalVisibility = document.getElementById('btn-toggle-global-visibility');
    btnGlobalVisibility.addEventListener('click', () => {
        isGlobalMapVisible = !isGlobalMapVisible;
        if (globalMapObj) {
            globalMapObj.visible = isGlobalMapVisible;
        }
        if (isGlobalMapVisible) {
            btnGlobalVisibility.textContent = "Global Map: Visible";
            btnGlobalVisibility.classList.replace('btn-secondary', 'btn-primary');
        } else {
            btnGlobalVisibility.textContent = "Global Map: Hidden";
            btnGlobalVisibility.classList.replace('btn-primary', 'btn-secondary');
        }
        if (currentQuery) {
            renderActiveStepState();
        }
    });

    const btnAlignedQuery = document.getElementById('btn-toggle-aligned-query');
    btnAlignedQuery.addEventListener('click', () => {
        isAlignedQueryVisible = !isAlignedQueryVisible;
        if (isAlignedQueryVisible) {
            btnAlignedQuery.textContent = "Aligned Query: ON";
            btnAlignedQuery.classList.replace('btn-secondary', 'btn-primary');
        } else {
            btnAlignedQuery.textContent = "Aligned Query: OFF";
            btnAlignedQuery.classList.replace('btn-primary', 'btn-secondary');
            // Stop any running animations
            if (activeIcpAnimation) {
                clearInterval(activeIcpAnimation);
                activeIcpAnimation = null;
            }
        }
        if (currentQuery) {
            renderActiveStepState();
        }
    });

    // Active animation handle
    let activeIcpAnimation = null;

    // Helper functions for 3D matrix math and SVD (Kabsch alignment)
    function solveKabsch(sourcePts, targetPts, sourceWeights, targetWeights) {
        // sourcePts: array of [x, y, z], targetPts: array of [x, y, z]
        // Weights: arrays of numbers
        const N = sourcePts.length;
        if (N === 0 || targetPts.length === 0) return { R: [[1,0,0],[0,1,0],[0,0,1]], T: [0,0,0] };

        // 1. Compute weighted centroids
        let sumW = 0;
        let centroidSrc = [0, 0, 0];
        let centroidTgt = [0, 0, 0];

        for (let i = 0; i < N; i++) {
            // Match with target point
            const src = sourcePts[i];
            const tgt = targetPts[i] || [0,0,0];
            const w = (sourceWeights ? sourceWeights[i] : 1.0) * (targetWeights ? targetWeights[i] : 1.0);
            sumW += w;
            centroidSrc[0] += w * src[0];
            centroidSrc[1] += w * src[1];
            centroidSrc[2] += w * src[2];
            centroidTgt[0] += w * tgt[0];
            centroidTgt[1] += w * tgt[1];
            centroidTgt[2] += w * tgt[2];
        }

        if (sumW < 1e-6) {
            sumW = 1.0;
        }

        centroidSrc[0] /= sumW;
        centroidSrc[1] /= sumW;
        centroidSrc[2] /= sumW;
        centroidTgt[0] /= sumW;
        centroidTgt[1] /= sumW;
        centroidTgt[2] /= sumW;

        // 2. Compute cross-covariance matrix H (3x3)
        const H = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];

        for (let i = 0; i < N; i++) {
            const src = sourcePts[i];
            const tgt = targetPts[i] || [0,0,0];
            const w = (sourceWeights ? sourceWeights[i] : 1.0) * (targetWeights ? targetWeights[i] : 1.0);

            const dxSrc = src[0] - centroidSrc[0];
            const dySrc = src[1] - centroidSrc[1];
            const dzSrc = src[2] - centroidSrc[2];

            const dxTgt = tgt[0] - centroidTgt[0];
            const dyTgt = tgt[1] - centroidTgt[1];
            const dzTgt = tgt[2] - centroidTgt[2];

            H[0][0] += w * dxSrc * dxTgt;
            H[0][1] += w * dxSrc * dyTgt;
            H[0][2] += w * dxSrc * dzTgt;

            H[1][0] += w * dySrc * dxTgt;
            H[1][1] += w * dySrc * dyTgt;
            H[1][2] += w * dySrc * dzTgt;

            H[2][0] += w * dzSrc * dxTgt;
            H[2][1] += w * dzSrc * dyTgt;
            H[2][2] += w * dzSrc * dzTgt;
        }

        // 3. Singular Value Decomposition (SVD) of H = U * S * V^T
        // For 3x3 matrices, we can use a basic Jacobi SVD solver
        const svd = svd3x3(H);
        const U = svd.U;
        const V = svd.V;

        // R = V * U^T
        const R = [
            [0,0,0],
            [0,0,0],
            [0,0,0]
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                R[i][j] = V[i][0]*U[j][0] + V[i][1]*U[j][1] + V[i][2]*U[j][2];
            }
        }

        // Handle reflection
        const det = R[0][0]*(R[1][1]*R[2][2] - R[1][2]*R[2][1]) -
                    R[0][1]*(R[1][0]*R[2][2] - R[1][2]*R[2][0]) +
                    R[0][2]*(R[1][0]*R[2][1] - R[1][1]*R[2][0]);

        if (det < 0) {
            // Adjust last column of V to handle reflection
            for (let i = 0; i < 3; i++) {
                V[i][2] = -V[i][2];
            }
            // Recompute R
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    R[i][j] = V[i][0]*U[j][0] + V[i][1]*U[j][1] + V[i][2]*U[j][2];
                }
            }
        }

        // T = centroidTgt - R * centroidSrc
        const T = [
            centroidTgt[0] - (R[0][0]*centroidSrc[0] + R[0][1]*centroidSrc[1] + R[0][2]*centroidSrc[2]),
            centroidTgt[1] - (R[1][0]*centroidSrc[0] + R[1][1]*centroidSrc[1] + R[1][2]*centroidSrc[2]),
            centroidTgt[2] - (R[2][0]*centroidSrc[0] + R[2][1]*centroidSrc[1] + R[2][2]*centroidSrc[2])
        ];

        return { R, T };
    }

    // Jacobi SVD solver for 3x3 matrix
    function svd3x3(A) {
        // Fast Jacobi method for symmetric matrices applied to A^T * A to find V, then U.
        // For general A:
        const V = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        // Calculate S = A^T * A
        const S = [
            [0,0,0],
            [0,0,0],
            [0,0,0]
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                S[i][j] = A[0][i]*A[0][j] + A[1][i]*A[1][j] + A[2][i]*A[2][j];
            }
        }

        // Jacobi rotation to diagonalize S (finding eigenvalues/eigenvectors V)
        const maxSweep = 15;
        for (let sweep = 0; sweep < maxSweep; sweep++) {
            let offDiag = Math.abs(S[0][1]) + Math.abs(S[0][2]) + Math.abs(S[1][2]);
            if (offDiag < 1e-10) break;

            for (let p = 0; p < 2; p++) {
                for (let q = p + 1; q < 3; q++) {
                    const diff = S[q][q] - S[p][p];
                    if (Math.abs(S[p][q]) < 1e-12) continue;

                    let t;
                    if (Math.abs(diff) < 1e-12) {
                        t = S[p][q] > 0 ? 1 : -1;
                    } else {
                        const phi = diff / (2.0 * S[p][q]);
                        t = Math.sign(phi) / (Math.abs(phi) + Math.sqrt(phi * phi + 1.0));
                    }
                    const c = 1.0 / Math.sqrt(t * t + 1.0);
                    const s = t * c;

                    // Update S
                    const S_pp = S[p][p];
                    const S_qq = S[q][q];
                    const S_pq = S[p][q];

                    S[p][p] = c * c * S_pp - 2.0 * c * s * S_pq + s * s * S_qq;
                    S[q][q] = s * s * S_pp + 2.0 * c * s * S_pq + c * c * S_qq;
                    S[p][q] = S[q][p] = 0.0;

                    for (let r = 0; r < 3; r++) {
                        if (r !== p && r !== q) {
                            const S_rp = S[r][p];
                            const S_rq = S[r][q];
                            S[r][p] = S[p][r] = c * S_rp - s * S_rq;
                            S[r][q] = S[q][r] = s * S_rp + c * S_rq;
                        }
                    }

                    // Update V
                    for (let r = 0; r < 3; r++) {
                        const V_rp = V[r][p];
                        const V_rq = V[r][q];
                        V[r][p] = c * V_rp - s * V_rq;
                        V[r][q] = s * V_rp + c * V_rq;
                    }
                }
            }
        }

        // Now singular values are eigenvalues' square roots
        const s0 = Math.sqrt(Math.max(0, S[0][0]));
        const s1 = Math.sqrt(Math.max(0, S[1][1]));
        const s2 = Math.sqrt(Math.max(0, S[2][2]));

        // Calculate U: U = A * V * inv(Sigma)
        const U = [
            [0,0,0],
            [0,0,0],
            [0,0,0]
        ];
        for (let i = 0; i < 3; i++) {
            U[i][0] = A[i][0]*V[0][0] + A[i][1]*V[1][0] + A[i][2]*V[2][0];
            U[i][1] = A[i][0]*V[0][1] + A[i][1]*V[1][1] + A[i][2]*V[2][1];
            U[i][2] = A[i][0]*V[0][2] + A[i][1]*V[1][2] + A[i][2]*V[2][2];
        }

        // Normalize columns of U
        const n0 = Math.sqrt(U[0][0]*U[0][0] + U[1][0]*U[1][0] + U[2][0]*U[2][0]) || 1;
        const n1 = Math.sqrt(U[0][1]*U[0][1] + U[1][1]*U[1][1] + U[2][1]*U[2][1]) || 1;
        const n2 = Math.sqrt(U[0][2]*U[0][2] + U[1][2]*U[1][2] + U[2][2]*U[2][2]) || 1;

        for (let i = 0; i < 3; i++) {
            U[i][0] /= n0;
            U[i][1] /= n1;
            U[i][2] /= n2;
        }

        return { U, V };
    }
    
    // Resize handler
    window.addEventListener('resize', () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
    
    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
    
    // Helper to get average height of the global map around a coordinate dynamically
    function getGroundHeight(x, y, radius = 25) {
        if (!globalMapData || !globalMapData.positions) return 30.0;
        let sumZ = 0;
        let count = 0;
        const len = globalMapData.length;
        const pos = globalMapData.positions;
        for (let i = 0; i < len; i++) {
            const px = pos[i * 3];
            const py = pos[i * 3 + 1];
            const pz = pos[i * 3 + 2];
            const dx = px - x;
            const dy = py - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < radius * radius) {
                sumZ += pz;
                count++;
            }
        }
        return count > 0 ? (sumZ / count) : 30.0;
    }

    global3dViewer = {
        updateOverlays(qX, qY, qPcLocal, rX, rY, rPcLocal, isCorrect, attentionHeatmap, queryAttentionHeatmap, resetCamera = false) {
            // Remove previous overlays
            if (globalQueryPointsObj) {
                scene.remove(globalQueryPointsObj);
                globalQueryPointsObj.geometry.dispose();
                globalQueryPointsObj.material.dispose();
                globalQueryPointsObj = null;
            }
            if (globalRetrievedPointsObj) {
                scene.remove(globalRetrievedPointsObj);
                globalRetrievedPointsObj.geometry.dispose();
                globalRetrievedPointsObj.material.dispose();
                globalRetrievedPointsObj = null;
            }
            if (globalQueryBoxObj) {
                scene.remove(globalQueryBoxObj);
                globalQueryBoxObj.geometry.dispose();
                globalQueryBoxObj.material.dispose();
                globalQueryBoxObj = null;
            }
            if (globalRetrievedBoxObj) {
                scene.remove(globalRetrievedBoxObj);
                globalRetrievedBoxObj.geometry.dispose();
                globalRetrievedBoxObj.material.dispose();
                globalRetrievedBoxObj = null;
            }
            if (globalAlignedPointsObj) {
                scene.remove(globalAlignedPointsObj);
                globalAlignedPointsObj.geometry.dispose();
                globalAlignedPointsObj.material.dispose();
                globalAlignedPointsObj = null;
            }

            // Stop any running ICP animation
            if (activeIcpAnimation) {
                clearInterval(activeIcpAnimation);
                activeIcpAnimation = null;
            }
            
            // Global map is loaded once and static, no update needed here
 
            // Get local terrain heights to align query and retrieved patches in height with the global map
            const qZ = getGroundHeight(qX, qY);
            const rZ = getGroundHeight(rX, rY);
            
            // 1. Plot Query points globally (using height-fading gradient matching Input Query)
            const qGeom = new THREE.BufferGeometry();
            const qPos = [];
            const qColors = [];
            
            // Calculate height ranges for color gradient mapping
            let qZMin = Infinity, qZMax = -Infinity;
            qPcLocal.forEach(pt => {
                const z = pt[2];
                if (z < qZMin) qZMin = z;
                if (z > qZMax) qZMax = z;
            });
            
            qPcLocal.forEach((pt, i) => {
                const x = qX + pt[0] * 100.0;
                const y = qY + pt[1] * 100.0;
                const z = qZ + pt[2] * 100.0 + 1.5; // lift slightly above ground to prevent z-fighting
                qPos.push(x, y, z);
                
                if (isQueryHeatmap && queryAttentionHeatmap && queryAttentionHeatmap.length > i) {
                    const weight = queryAttentionHeatmap[i];
                    // Turbo-like colormap approximation (Blue -> Green -> Yellow -> Red)
                    const r = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * (weight - 0.5))));
                    const g = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * (weight - 0.25))));
                    const b = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * weight)));
                    qColors.push(r, g, b);
                } else if (isQueryHeatmap) {
                    const normZ = (qZMax - qZMin) > 0 ? (pt[2] - qZMin) / (qZMax - qZMin) : 0.5;
                    // Blue height-gradient: Dark blue (bottom) to light blue/cyan (top)
                    const r = 0.1 + normZ * 0.6;
                    const g = 0.3 + normZ * 0.6;
                    const b = 1.0;
                    qColors.push(r, g, b);
                } else {
                    // Solid bright blue
                    qColors.push(0.0, 0.45, 1.0);
                }
            });
            qGeom.setAttribute('position', new THREE.Float32BufferAttribute(qPos, 3));
            qGeom.setAttribute('color', new THREE.Float32BufferAttribute(qColors, 3));
            
            const qMat = new THREE.PointsMaterial({
                size: 6.0,
                vertexColors: true,
                map: createRingTexture(),
                transparent: true,
                opacity: 0.9,
                depthWrite: false
            });
            globalQueryPointsObj = new THREE.Points(qGeom, qMat);
            scene.add(globalQueryPointsObj);
            
            // 2. Plot Retrieved points globally
            const rGeom = new THREE.BufferGeometry();
            const rPos = [];
            const rColors = [];
            rPcLocal.forEach((pt, i) => {
                const x = rX + pt[0] * 100.0;
                const y = rY + pt[1] * 100.0;
                const z = rZ + pt[2] * 100.0 + 1.5; // lift slightly above ground
                rPos.push(x, y, z);
                
                // Assign color based on heatmap if enabled
                if (isRetrievedHeatmap && attentionHeatmap && attentionHeatmap.length > i) {
                    // Generate a color map (jet or turbo) using the attention weight
                    const weight = attentionHeatmap[i];
                    // Turbo-like colormap approximation (Blue -> Green -> Yellow -> Red)
                    const r = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * (weight - 0.5))));
                    const g = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * (weight - 0.25))));
                    const b = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(1.0 - 4.0 * weight)));
                    rColors.push(r, g, b);
                } else {
                    const rColorHex = isCorrect ? 0x10b981 : 0xef4444;
                    const c = new THREE.Color(rColorHex);
                    rColors.push(c.r, c.g, c.b);
                }
            });
            rGeom.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
            rGeom.setAttribute('color', new THREE.Float32BufferAttribute(rColors, 3));
            
            const rMat = new THREE.PointsMaterial({
                size: 3.5, // slightly larger points for heatmap
                vertexColors: true,
                transparent: true,
                opacity: 0.85
            });
            globalRetrievedPointsObj = new THREE.Points(rGeom, rMat);
            scene.add(globalRetrievedPointsObj);

            // 3. Add Query Bounding Box (40m x 40m x 40m)
            const qBoxGeom = new THREE.BoxGeometry(40, 40, 40);
            const qEdges = new THREE.EdgesGeometry(qBoxGeom);
            const qBoxMat = new THREE.LineBasicMaterial({ color: 0x00bcff, linewidth: 2 });
            globalQueryBoxObj = new THREE.LineSegments(qEdges, qBoxMat);
            globalQueryBoxObj.position.set(qX, qY, qZ + 20); // center box at ground + height offset
            scene.add(globalQueryBoxObj);
            
            // 4. Add Retrieved Bounding Box (200m x 200m x 200m)
            const rBoxGeom = new THREE.BoxGeometry(200, 200, 200);
            const rEdges = new THREE.EdgesGeometry(rBoxGeom);
            const rColorHex = isCorrect ? 0x10b981 : 0xef4444;
            const rBoxMat = new THREE.LineBasicMaterial({ color: rColorHex, linewidth: 2 });
            globalRetrievedBoxObj = new THREE.LineSegments(rEdges, rBoxMat);
            globalRetrievedBoxObj.position.set(rX, rY, rZ + 100);
            scene.add(globalRetrievedBoxObj);

            // 5. Aligned Query Point Cloud & Fitting Animation
            if (isAlignedQueryVisible) {
                // Initialize aligned points with the query point cloud, scaled and placed at the query's location
                // We'll then animate it shifting to the retrieved location!
                const alignedGeom = new THREE.BufferGeometry();
                const alignedPos = new Float32Array(qPcLocal.length * 3);
                
                // Start points at the current Query coordinates
                qPcLocal.forEach((pt, i) => {
                    alignedPos[i * 3] = qX + pt[0] * 100.0;
                    alignedPos[i * 3 + 1] = qY + pt[1] * 100.0;
                    alignedPos[i * 3 + 2] = qZ + pt[2] * 100.0 + 1.5;
                });
                
                alignedGeom.setAttribute('position', new THREE.BufferAttribute(alignedPos, 3));
                
                // Color aligned points magenta
                const alignedColors = new Float32Array(qPcLocal.length * 3);
                for (let i = 0; i < qPcLocal.length; i++) {
                    alignedColors[i * 3] = 0.85; // red
                    alignedColors[i * 3 + 1] = 0.27; // green
                    alignedColors[i * 3 + 2] = 0.94; // blue
                }
                alignedGeom.setAttribute('color', new THREE.BufferAttribute(alignedColors, 3));

                const alignedMat = new THREE.PointsMaterial({
                    size: 6.5,
                    vertexColors: true,
                    map: createRingTexture(),
                    transparent: true,
                    opacity: 0.95,
                    depthWrite: false
                });

                globalAlignedPointsObj = new THREE.Points(alignedGeom, alignedMat);
                scene.add(globalAlignedPointsObj);

                // Run visual ICP animation
                // Start source points at local query coordinates (scaled by 100)
                let currentSourcePts = qPcLocal.map(pt => [pt[0] * 100.0, pt[1] * 100.0, pt[2] * 100.0]);
                // Target points are local retrieved coordinates (scaled by 100)
                const targetPts = rPcLocal.map(pt => [pt[0] * 100.0, pt[1] * 100.0, pt[2] * 100.0]);

                let iter = 0;
                const maxIcpIterations = 25;

                activeIcpAnimation = setInterval(() => {
                    if (iter >= maxIcpIterations || !globalAlignedPointsObj) {
                        clearInterval(activeIcpAnimation);
                        activeIcpAnimation = null;
                        return;
                    }

                    // 1. Association: For each source point, find the closest target point
                    const matchedTargetPts = [];
                    const matchedTargetWeights = [];
                    for (let i = 0; i < currentSourcePts.length; i++) {
                        const sPt = currentSourcePts[i];
                        let bestDistSq = Infinity;
                        let bestTgt = targetPts[0];
                        let bestIdx = 0;

                        // Simple nearest neighbor search
                        for (let j = 0; j < targetPts.length; j++) {
                            const tPt = targetPts[j];
                            const dx = sPt[0] - tPt[0];
                            const dy = sPt[1] - tPt[1];
                            const dz = sPt[2] - tPt[2];
                            const distSq = dx * dx + dy * dy + dz * dz;
                            if (distSq < bestDistSq) {
                                bestDistSq = distSq;
                                bestTgt = tPt;
                                bestIdx = j;
                            }
                        }
                        matchedTargetPts.push(bestTgt);
                        matchedTargetWeights.push(attentionHeatmap ? attentionHeatmap[bestIdx] : 1.0);
                    }

                    // 2. Solve Kabsch using attention heatmaps as weights
                    const solveResult = solveKabsch(
                        currentSourcePts, 
                        matchedTargetPts, 
                        queryAttentionHeatmap, 
                        matchedTargetWeights
                    );

                    const R = solveResult.R;
                    const T = solveResult.T;

                    // 3. Apply transformation locally, then render globally at retrieved position
                    // We interpolate the global position from current Query to Retrieved location to animate the translation!
                    const t = Math.min(1.0, (iter + 1) / maxIcpIterations);
                    const currentGlobalX = qX + (rX - qX) * t;
                    const currentGlobalY = qY + (rY - qY) * t;
                    const currentGlobalZ = qZ + (rZ - qZ) * t;

                    const positions = globalAlignedPointsObj.geometry.attributes.position.array;
                    for (let i = 0; i < currentSourcePts.length; i++) {
                        const p = currentSourcePts[i];
                        // Transform local coordinate
                        const nx = R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + T[0];
                        const ny = R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + T[1];
                        const nz = R[2][0] * p[0] * 0.95 + R[2][1] * p[1] * 0.95 + R[2][2] * p[2] + T[2]; // slight scale correction on Z if needed

                        currentSourcePts[i] = [nx, ny, nz];

                        // Set global positions
                        positions[i * 3] = nx + currentGlobalX;
                        positions[i * 3 + 1] = ny + currentGlobalY;
                        positions[i * 3 + 2] = nz + currentGlobalZ + 1.5;
                    }

                    globalAlignedPointsObj.geometry.attributes.position.needsUpdate = true;
                    iter++;
                }, 40); // 40ms per step
            }
            
            // Focus camera dynamically on the actual local terrain height only when changing query
            if (resetCamera) {
                controls.target.set(qX, qY, qZ);
                camera.position.set(qX, qY - 150, qZ + 150);
                controls.update();
            }
        }
    };
}

// Select a query index (On-Demand Loading)
async function selectQueryIndex(queryIdx) {
    try {
        // Disable selector while loading to prevent race conditions
        selectQuery.disabled = true;
        
        console.log(`Fetching query ${queryIdx} details...`);
        const res = await fetch(`queries/query_${queryIdx}.json`);
        currentQuery = await res.json();
        console.log("Loaded query details:", currentQuery);
        
        // Update summary labels safely using textContent
        infoQueryIdx.textContent = currentQuery.query_idx;
        infoQueryFile.textContent = currentQuery.query_file.split('/').pop();
        infoQueryUtm.textContent = `E: ${currentQuery.easting.toFixed(2)} | N: ${currentQuery.northing.toFixed(2)}`;
        infoQueryLatlon.textContent = `${currentQuery.lat.toFixed(6)}, ${currentQuery.lon.toFixed(6)}`;
        
        // Update local query viewer
        localViewers.query.updatePoints(currentQuery.pc_local);
        
        // Update step cards distance labels
        for (let step = 1; step <= 3; step++) {
            const stepData = currentQuery.steps[step.toString()];
            document.getElementById(`dist-step-${step}`).textContent = `Distance: ${stepData.dist_to_query_meters.toFixed(2)} m`;
            
            // Update local viewer for each step card
            localViewers[`step${step}`].updatePoints(stepData.pc_local, stepData.is_correct);
            
            // Update badges
            const badge = document.getElementById(`badge-step-${step}`);
            badge.className = 'badge ' + (stepData.is_correct ? 'badge-correct' : 'badge-incorrect');
            badge.textContent = stepData.is_correct ? 'Correct' : 'Incorrect';
            
            // Update timeline status colors
            const timeline = document.getElementById(`timeline-s${step}`);
            const statusText = document.getElementById(`status-s${step}`);
            timeline.className = 'timeline-step ' + (stepData.is_correct ? 'correct' : 'incorrect');
            statusText.textContent = `${stepData.is_correct ? 'Correct' : 'Incorrect'} (${stepData.dist_to_query_meters.toFixed(1)}m)`;
        }
        
        // Reset to step 3 visual by default
        currentStep = 3;
        sliderStep.value = 3;
        
        // Display current step details on map and 3D global view
        renderActiveStepState(true);
    } catch (err) {
        console.error(`Failed to load query ${queryIdx}:`, err);
    } finally {
        selectQuery.disabled = false;
    }
}

// Set active visual step (1, 2, 3)
function setActiveStep(step) {
    currentStep = step;
    renderActiveStepState(false);
}

// Update Map and Global 3D view overlays for active step
function renderActiveStepState(resetCamera = false) {
    if (!currentQuery) return;
    
    const stepData = currentQuery.steps[currentStep.toString()];
    
    // Update active highlight in timeline
    for (let step = 1; step <= 3; step++) {
        const timeline = document.getElementById(`timeline-s${step}`);
        if (step === currentStep) {
            timeline.classList.add('active');
        } else {
            timeline.classList.remove('active');
        }
    }
    
    // Convert centers
    const qLat = currentQuery.lat;
    const qLon = currentQuery.lon;
    const rLat = stepData.lat;
    const rLon = stepData.lon;
    
    // 1. Leaflet map updates
    if (leafletMap) {
        // Clear previous layers
        mapPointsLayerGroup.clearLayers();
        
        // Place query circle (100m)
        queryCircle = L.circle([qLat, qLon], {
            radius: 100,
            color: '#00bcff',
            fillColor: '#00bcff',
            fillOpacity: 0.1,
            weight: 2
        }).addTo(mapPointsLayerGroup);
        
        // Place query center marker
        queryMarker = L.circleMarker([qLat, qLon], {
            radius: 6,
            fillColor: '#00bcff',
            color: '#ffffff',
            weight: 1.5,
            fillOpacity: 1.0
        }).bindPopup(`Query Center<br>${qLat.toFixed(6)}, ${qLon.toFixed(6)}`).addTo(mapPointsLayerGroup);
        
        // Place retrieved center marker
        retrievedMarker = L.circleMarker([rLat, rLon], {
            radius: 6,
            fillColor: stepData.is_correct ? '#10b981' : '#ef4444',
            color: '#ffffff',
            weight: 1.5,
            fillOpacity: 1.0
        }).bindPopup(`Step ${currentStep} Retrieved Center<br>Dist: ${stepData.dist_to_query_meters.toFixed(2)}m`).addTo(mapPointsLayerGroup);
        
        // Plot query points (magenta dots) globally - scaled by x5 (from 20m to 100m scale)
        currentQuery.pc_global.forEach(pt => {
            const dLat = pt[0] - qLat;
            const dLon = pt[1] - qLon;
            const scaledLat = qLat + dLat * 5.0;
            const scaledLon = qLon + dLon * 5.0;
            
            L.circleMarker([scaledLat, scaledLon], {
                radius: 1.5,
                fillColor: '#00bcff',
                stroke: false,
                fillOpacity: 0.75
            }).addTo(mapPointsLayerGroup);
        });
        
        // Plot retrieved points (green/red dots) globally
        stepData.pc_global.forEach(pt => {
            L.circleMarker([pt[0], pt[1]], {
                radius: 1.5,
                fillColor: stepData.is_correct ? '#10b981' : '#ef4444',
                stroke: false,
                fillOpacity: 0.75
            }).addTo(mapPointsLayerGroup);
        });
        
        // Fit map view to include query and retrieval
        const bounds = L.latLngBounds([
            [qLat, qLon],
            [rLat, rLon]
        ]);
        leafletMap.fitBounds(bounds.pad(0.35));
    }
    
    // 2. Three.js Global 3D Map updates
    if (global3dViewer) {
        // Centered coordinates around UTM origin
        const qX = currentQuery.easting - 332100.0;
        const qY = currentQuery.northing - 4317500.0;
        const rX = stepData.easting - 332100.0;
        const rY = stepData.northing - 4317500.0;
        
        global3dViewer.updateOverlays(
            qX, qY, currentQuery.pc_local,
            rX, rY, stepData.pc_local,
            stepData.is_correct,
            stepData.attention_heatmap,
            stepData.query_attention_heatmap,
            resetCamera
        );
    }

    // 3. Update Legend overlay dynamically
    const legendQueryColor = document.getElementById('legend-query-color');
    const legendQueryLabel = document.getElementById('legend-query-label');
    const legendRetrievedColor = document.getElementById('legend-retrieved-color');
    const legendRetrievedLabel = document.getElementById('legend-retrieved-label');
    const legendGlobalColor = document.getElementById('legend-global-color');
    const legendGlobalLabel = document.getElementById('legend-global-label');
    const legendRetrievedBox = document.getElementById('legend-retrieved-box');
    const legendRetrievedBoxLabel = document.getElementById('legend-retrieved-box-label');

    if (legendQueryColor && legendQueryLabel) {
        if (isQueryHeatmap && stepData.query_attention_heatmap) {
            legendQueryColor.style.background = 'linear-gradient(to right, #0000ff, #00ff00, #ffff00, #ff0000)';
            legendQueryLabel.textContent = 'Query: Attention Heatmap';
        } else if (isQueryHeatmap) {
            legendQueryColor.style.background = 'linear-gradient(to right, #050530, #00bcff)';
            legendQueryLabel.textContent = 'Query: Height Gradient';
        } else {
            legendQueryColor.style.background = '#0073ff';
            legendQueryLabel.textContent = 'Query: Solid Blue';
        }
    }

    if (legendRetrievedColor && legendRetrievedLabel && legendRetrievedBox) {
        if (isRetrievedHeatmap && stepData.attention_heatmap) {
            legendRetrievedColor.style.background = 'linear-gradient(to right, #0000ff, #00ff00, #ffff00, #ff0000)';
            legendRetrievedLabel.textContent = 'Retrieved: Attention Heatmap';
            legendRetrievedBox.style.borderColor = stepData.is_correct ? '#10b981' : '#ef4444';
            legendRetrievedBoxLabel.textContent = `Retrieved Box (${stepData.is_correct ? 'Correct' : 'Incorrect'})`;
        } else {
            const color = stepData.is_correct ? '#10b981' : '#ef4444';
            legendRetrievedColor.style.background = color;
            legendRetrievedLabel.textContent = `Retrieved: ${stepData.is_correct ? 'Correct Match' : 'Incorrect Match'}`;
            legendRetrievedBox.style.borderColor = color;
            legendRetrievedBoxLabel.textContent = `Retrieved Box (${stepData.is_correct ? 'Correct' : 'Incorrect'})`;
        }
    }

    if (legendGlobalColor && legendGlobalLabel) {
        if (isGlobalMapVisible) {
            legendGlobalColor.style.background = 'linear-gradient(to right, #455a64, #cfd8dc)';
            legendGlobalLabel.textContent = 'Global Map: RGB Campus';
        } else {
            legendGlobalColor.style.background = '#cbd5e1';
            legendGlobalLabel.textContent = 'Global Map: Hidden';
        }
    }
}

// Animate refinement step-by-step
function animateRefinement() {
    if (isAnimating || !currentQuery) return;
    isAnimating = true;
    btnPlay.disabled = true;
    
    let step = 1;
    setActiveStep(step);
    
    const interval = setInterval(() => {
        step++;
        if (step > 3) {
            clearInterval(interval);
            isAnimating = false;
            btnPlay.disabled = false;
        } else {
            setActiveStep(step);
            sliderStep.value = step;
        }
    }, 1200); // 1.2s delay per step
}

// ============================================================
// TRAJECTORY PLAYBACK MODULE
// ============================================================

(function() {
    // Trajectory state
    let trajMetadata = [];
    let trajCurrentIdx = 0;
    let trajCurrentStep = 1;
    let trajIsPlaying = false;
    let trajPlayInterval = null;
    let trajShowTrail = true;
    let trajShowRetrieved = true;
    let trajShowAligned = false;
    let trajQueryCache = {};  // cache loaded query JSONs
    let trajCurrentQueryData = null;

    // Trajectory Three.js state
    let traj3dScene = null;
    let traj3dCamera = null;
    let traj3dRenderer = null;
    let traj3dControls = null;
    let trajGlobalMapObj = null;
    let trajTrailLineObj = null;
    let trajTrailDotsObj = null;
    let trajActiveTrailObj = null; // partial trail up to current index
    let trajQueryCloudObj = null;
    let trajRetrievedCloudObj = null;
    let trajAlignedCloudObj = null;
    let trajCurrentDotObj = null;
    let trajRetrievedDotObj = null;

    // Active animation handle for trajectory ICP
    let trajIcpInterval = null;

    // Trajectory local viewers
    let trajLocalQuery = null;
    let trajLocalRetrieved = null;

    // UTM origin (same as main viewer)
    const UTM_E_ORIGIN = 332100.0;
    const UTM_N_ORIGIN = 4317500.0;

    // Wait for DOM
    window.addEventListener('DOMContentLoaded', () => {
        initTrajectoryModule();
    });

    async function initTrajectoryModule() {
        try {
            const res = await fetch('trajectory_metadata.json');
            trajMetadata = await res.json();
            console.log(`Loaded trajectory metadata: ${trajMetadata.length} points.`);

            const totalEl = document.getElementById('traj-total-count');
            if (totalEl) totalEl.textContent = trajMetadata.length;

            const slider = document.getElementById('traj-slider');
            if (slider) {
                slider.max = trajMetadata.length - 1;
            }
            const endLabel = document.getElementById('traj-slider-end');
            if (endLabel) endLabel.textContent = trajMetadata.length - 1;

            // Init trajectory 3D viewer
            initTraj3dViewer();

            // Init local viewers for trajectory
            trajLocalQuery = createLocalViewer('traj-canvas-query', 'query');
            trajLocalRetrieved = createLocalViewer('traj-canvas-retrieved', 'step-1');

            // Setup controls
            setupTrajControls();

            // Update status
            const pill = document.getElementById('traj-status-pill');
            const statusText = document.getElementById('traj-status-text');
            if (pill) pill.classList.add('ready');
            if (statusText) statusText.textContent = `${trajMetadata.length} timestamps ready`;

            // Load first point
            await trajGoToIndex(0);

        } catch (err) {
            console.error('Failed to init trajectory module:', err);
            const statusText = document.getElementById('traj-status-text');
            if (statusText) statusText.textContent = 'Failed to load trajectory data';
        }
    }

    function initTraj3dViewer() {
        const container = document.getElementById('traj-3d-map');
        if (!container) return;

        const width = container.clientWidth;
        const height = container.clientHeight;

        traj3dScene = new THREE.Scene();
        traj3dScene.background = new THREE.Color(0xf1f5f9);

        traj3dCamera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
        traj3dCamera.up.set(0, 0, 1);

        traj3dRenderer = new THREE.WebGLRenderer({ antialias: true });
        traj3dRenderer.setSize(width, height);
        traj3dRenderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(traj3dRenderer.domElement);

        traj3dControls = new THREE.OrbitControls(traj3dCamera, traj3dRenderer.domElement);
        traj3dControls.enableDamping = true;
        traj3dControls.dampingFactor = 0.05;
        traj3dControls.enableZoom = true;
        traj3dControls.maxPolarAngle = Math.PI / 2 - 0.01;

        // Add global map placeholder (will fill once globalMapData is available)
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
        geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
        const mat = new THREE.PointsMaterial({ size: 1.5, vertexColors: true });
        trajGlobalMapObj = new THREE.Points(geom, mat);
        traj3dScene.add(trajGlobalMapObj);

        // Build full trajectory trail
        buildTrajectoryTrail();

        // Set initial camera
        if (trajMetadata.length > 0) {
            const firstPt = trajMetadata[0];
            const midPt = trajMetadata[Math.floor(trajMetadata.length / 2)];
            const cx = (firstPt.easting + midPt.easting) / 2 - UTM_E_ORIGIN;
            const cy = (firstPt.northing + midPt.northing) / 2 - UTM_N_ORIGIN;
            traj3dCamera.position.set(cx, cy - 120, 100);
            traj3dControls.target.set(cx, cy, 30);
            traj3dControls.update();
        }

        // Resize
        window.addEventListener('resize', () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            traj3dCamera.aspect = w / h;
            traj3dCamera.updateProjectionMatrix();
            traj3dRenderer.setSize(w, h);
        });

        // Animate
        function animate() {
            requestAnimationFrame(animate);
            traj3dControls.update();
            traj3dRenderer.render(traj3dScene, traj3dCamera);
        }
        animate();

        // Attempt to fill global map data (it may already be loaded from main viewer)
        fillTrajGlobalMap();
    }

    function fillTrajGlobalMap() {
        if (globalMapData && globalMapData.length > 0 && trajGlobalMapObj) {
            trajGlobalMapObj.geometry.setAttribute('position', new THREE.BufferAttribute(globalMapData.positions, 3));
            trajGlobalMapObj.geometry.setAttribute('color', new THREE.BufferAttribute(globalMapData.colors, 3, true));
            trajGlobalMapObj.geometry.attributes.position.needsUpdate = true;
            trajGlobalMapObj.geometry.attributes.color.needsUpdate = true;
            trajGlobalMapObj.geometry.computeBoundingSphere();

            // Hide loading overlay
            const loader = document.getElementById('traj-map-loading');
            if (loader) loader.style.display = 'none';
        } else {
            // Retry later (global map still loading)
            setTimeout(fillTrajGlobalMap, 500);
        }
    }

    function buildTrajectoryTrail() {
        if (!traj3dScene || trajMetadata.length < 2) return;

        // Full trail as a line
        const positions = [];
        const colors = [];
        trajMetadata.forEach((pt, i) => {
            const x = pt.easting - UTM_E_ORIGIN;
            const y = pt.northing - UTM_N_ORIGIN;
            const z = 32.0; // slightly above ground
            positions.push(x, y, z);
            // Gradient from cyan to white along the path
            const t = i / (trajMetadata.length - 1);
            colors.push(0.0 + t * 0.7, 0.74 - t * 0.2, 1.0 - t * 0.3);
        });

        const lineGeom = new THREE.BufferGeometry();
        lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const lineMat = new THREE.LineBasicMaterial({
            vertexColors: true,
            linewidth: 2,
            transparent: true,
            opacity: 0.25
        });
        trajTrailLineObj = new THREE.Line(lineGeom, lineMat);
        traj3dScene.add(trajTrailLineObj);

        // Trail dots at each position
        const dotGeom = new THREE.BufferGeometry();
        dotGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        dotGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const dotMat = new THREE.PointsMaterial({
            size: 4.0,
            vertexColors: true,
            transparent: true,
            opacity: 0.3
        });
        trajTrailDotsObj = new THREE.Points(dotGeom, dotMat);
        traj3dScene.add(trajTrailDotsObj);
    }

    function updateActiveTrail(upToIdx) {
        // Remove previous active trail
        if (trajActiveTrailObj) {
            traj3dScene.remove(trajActiveTrailObj);
            trajActiveTrailObj.geometry.dispose();
            trajActiveTrailObj.material.dispose();
            trajActiveTrailObj = null;
        }

        if (upToIdx < 1) return;

        const positions = [];
        const colors = [];
        for (let i = 0; i <= upToIdx && i < trajMetadata.length; i++) {
            const pt = trajMetadata[i];
            const x = pt.easting - UTM_E_ORIGIN;
            const y = pt.northing - UTM_N_ORIGIN;
            const z = 33.0; // slightly above the faint trail
            positions.push(x, y, z);
            // Bright cyan -> blue
            const t = i / Math.max(upToIdx, 1);
            colors.push(0.0, 0.74 * (1 - t * 0.3), 1.0);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            linewidth: 3,
            transparent: true,
            opacity: 0.9
        });
        trajActiveTrailObj = new THREE.Line(geom, mat);
        traj3dScene.add(trajActiveTrailObj);
    }

    function getGroundHeightTraj(x, y, radius) {
        radius = radius || 25;
        if (!globalMapData || !globalMapData.positions) return 30.0;
        let sumZ = 0, count = 0;
        const len = globalMapData.length;
        const pos = globalMapData.positions;
        for (let i = 0; i < len; i++) {
            const dx = pos[i * 3] - x;
            const dy = pos[i * 3 + 1] - y;
            if (dx * dx + dy * dy < radius * radius) {
                sumZ += pos[i * 3 + 2];
                count++;
            }
        }
        return count > 0 ? sumZ / count : 30.0;
    }

    function updateTraj3dOverlays(queryData, stepStr, resetCamera) {
        const stepData = queryData.steps[stepStr];
        if (!stepData) return;

        // Remove previous query / retrieved clouds + markers
        [trajQueryCloudObj, trajRetrievedCloudObj, trajCurrentDotObj, trajRetrievedDotObj, trajAlignedCloudObj].forEach(obj => {
            if (obj) {
                traj3dScene.remove(obj);
                obj.geometry.dispose();
                obj.material.dispose();
            }
        });
        trajQueryCloudObj = trajRetrievedCloudObj = trajCurrentDotObj = trajRetrievedDotObj = trajAlignedCloudObj = null;

        if (trajIcpInterval) {
            clearInterval(trajIcpInterval);
            trajIcpInterval = null;
        }

        const qX = queryData.easting - UTM_E_ORIGIN;
        const qY = queryData.northing - UTM_N_ORIGIN;
        const rX = stepData.easting - UTM_E_ORIGIN;
        const rY = stepData.northing - UTM_N_ORIGIN;
        const qZ = getGroundHeightTraj(qX, qY);
        const rZ = getGroundHeightTraj(rX, rY);

        // Query point cloud
        const qGeom = new THREE.BufferGeometry();
        const qPos = [], qColors = [];
        let qZMin = Infinity, qZMax = -Infinity;
        queryData.pc_local.forEach(pt => {
            if (pt[2] < qZMin) qZMin = pt[2];
            if (pt[2] > qZMax) qZMax = pt[2];
        });
        queryData.pc_local.forEach((pt, i) => {
            qPos.push(qX + pt[0] * 100, qY + pt[1] * 100, qZ + pt[2] * 100 + 1.5);
            const normZ = (qZMax - qZMin) > 0 ? (pt[2] - qZMin) / (qZMax - qZMin) : 0.5;
            // Check if we have query attention heatmap for this step
            const qHeatmap = stepData.query_attention_heatmap;
            if (qHeatmap && qHeatmap.length > i) {
                const w = qHeatmap[i];
                const r = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * (w - 0.5))));
                const g = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * (w - 0.25))));
                const b = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * w)));
                qColors.push(r, g, b);
            } else {
                qColors.push(0.1 + normZ * 0.6, 0.3 + normZ * 0.6, 1.0);
            }
        });
        qGeom.setAttribute('position', new THREE.Float32BufferAttribute(qPos, 3));
        qGeom.setAttribute('color', new THREE.Float32BufferAttribute(qColors, 3));
        const qMat = new THREE.PointsMaterial({
            size: 6.0, vertexColors: true, map: createRingTexture(),
            transparent: true, opacity: 0.9, depthWrite: false
        });
        trajQueryCloudObj = new THREE.Points(qGeom, qMat);
        traj3dScene.add(trajQueryCloudObj);

        // Current position marker (bright sphere sprite)
        const dotGeom = new THREE.BufferGeometry();
        dotGeom.setAttribute('position', new THREE.Float32BufferAttribute([qX, qY, qZ + 5], 3));
        const dotMat = new THREE.PointsMaterial({
            size: 12, color: 0x00bcff, transparent: true, opacity: 1.0,
            map: createRingTexture(), depthWrite: false
        });
        trajCurrentDotObj = new THREE.Points(dotGeom, dotMat);
        traj3dScene.add(trajCurrentDotObj);

        // Retrieved point cloud
        if (trajShowRetrieved) {
            const rGeom = new THREE.BufferGeometry();
            const rPos = [], rColors = [];
            stepData.pc_local.forEach((pt, i) => {
                rPos.push(rX + pt[0] * 100, rY + pt[1] * 100, rZ + pt[2] * 100 + 1.5);
                const heatmap = stepData.attention_heatmap;
                if (heatmap && heatmap.length > i) {
                    const w = heatmap[i];
                    const r = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * (w - 0.5))));
                    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * (w - 0.25))));
                    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(1 - 4 * w)));
                    rColors.push(r, g, b);
                } else {
                    const c = new THREE.Color(stepData.is_correct ? 0x10b981 : 0xef4444);
                    rColors.push(c.r, c.g, c.b);
                }
            });
            rGeom.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
            rGeom.setAttribute('color', new THREE.Float32BufferAttribute(rColors, 3));
            const rMat = new THREE.PointsMaterial({
                size: 3.5, vertexColors: true, transparent: true, opacity: 0.85
            });
            trajRetrievedCloudObj = new THREE.Points(rGeom, rMat);
            traj3dScene.add(trajRetrievedCloudObj);

            // Retrieved dot
            const rDotGeom = new THREE.BufferGeometry();
            rDotGeom.setAttribute('position', new THREE.Float32BufferAttribute([rX, rY, rZ + 5], 3));
            const rDotMat = new THREE.PointsMaterial({
                size: 10, color: stepData.is_correct ? 0x10b981 : 0xef4444,
                transparent: true, opacity: 0.9, depthWrite: false
            });
            trajRetrievedDotObj = new THREE.Points(rDotGeom, rDotMat);
            traj3dScene.add(trajRetrievedDotObj);
        }

        // Aligned Query Point Cloud for Trajectory
        if (trajShowAligned) {
            const alignedGeom = new THREE.BufferGeometry();
            const alignedPos = new Float32Array(queryData.pc_local.length * 3);
            
            // Start points at the current Query coordinates
            queryData.pc_local.forEach((pt, i) => {
                alignedPos[i * 3] = qX + pt[0] * 100.0;
                alignedPos[i * 3 + 1] = qY + pt[1] * 100.0;
                alignedPos[i * 3 + 2] = qZ + pt[2] * 100.0 + 1.5;
            });
            
            alignedGeom.setAttribute('position', new THREE.BufferAttribute(alignedPos, 3));
            
            // Color aligned points magenta
            const alignedColors = new Float32Array(queryData.pc_local.length * 3);
            for (let i = 0; i < queryData.pc_local.length; i++) {
                alignedColors[i * 3] = 0.85; // red
                alignedColors[i * 3 + 1] = 0.27; // green
                alignedColors[i * 3 + 2] = 0.94; // blue
            }
            alignedGeom.setAttribute('color', new THREE.BufferAttribute(alignedColors, 3));

            const alignedMat = new THREE.PointsMaterial({
                size: 6.5,
                vertexColors: true,
                map: createRingTexture(),
                transparent: true,
                opacity: 0.95,
                depthWrite: false
            });

            trajAlignedCloudObj = new THREE.Points(alignedGeom, alignedMat);
            traj3dScene.add(trajAlignedCloudObj);

            // Run visual ICP animation
            // Start source points at local query coordinates (scaled by 100)
            let currentSourcePts = queryData.pc_local.map(pt => [pt[0] * 100.0, pt[1] * 100.0, pt[2] * 100.0]);
            // Target points are local retrieved coordinates (scaled by 100)
            const targetPts = stepData.pc_local.map(pt => [pt[0] * 100.0, pt[1] * 100.0, pt[2] * 100.0]);

            let iter = 0;
            const maxIcpIterations = 25;

            trajIcpInterval = setInterval(() => {
                if (iter >= maxIcpIterations || !trajAlignedCloudObj) {
                    clearInterval(trajIcpInterval);
                    trajIcpInterval = null;
                    return;
                }

                // 1. Association
                const matchedTargetPts = [];
                const matchedTargetWeights = [];
                for (let i = 0; i < currentSourcePts.length; i++) {
                    const sPt = currentSourcePts[i];
                    let bestDistSq = Infinity;
                    let bestTgt = targetPts[0];
                    let bestIdx = 0;

                    for (let j = 0; j < targetPts.length; j++) {
                        const tPt = targetPts[j];
                        const dx = sPt[0] - tPt[0];
                        const dy = sPt[1] - tPt[1];
                        const dz = sPt[2] - tPt[2];
                        const distSq = dx * dx + dy * dy + dz * dz;
                        if (distSq < bestDistSq) {
                            bestDistSq = distSq;
                            bestTgt = tPt;
                            bestIdx = j;
                        }
                    }
                    matchedTargetPts.push(bestTgt);
                    matchedTargetWeights.push(stepData.attention_heatmap ? stepData.attention_heatmap[bestIdx] : 1.0);
                }

                // 2. Solve Kabsch using attention heatmaps as weights
                const solveResult = solveKabsch(
                    currentSourcePts, 
                    matchedTargetPts, 
                    stepData.query_attention_heatmap, 
                    matchedTargetWeights
                );

                const R = solveResult.R;
                const T = solveResult.T;

                // 3. Apply transformation locally, then render globally at retrieved position
                const t = Math.min(1.0, (iter + 1) / maxIcpIterations);
                const currentGlobalX = qX + (rX - qX) * t;
                const currentGlobalY = qY + (rY - qY) * t;
                const currentGlobalZ = qZ + (rZ - qZ) * t;

                const positions = trajAlignedCloudObj.geometry.attributes.position.array;
                for (let i = 0; i < currentSourcePts.length; i++) {
                    const p = currentSourcePts[i];
                    const nx = R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + T[0];
                    const ny = R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + T[1];
                    const nz = R[2][0] * p[0] * 0.95 + R[2][1] * p[1] * 0.95 + R[2][2] * p[2] + T[2];

                    currentSourcePts[i] = [nx, ny, nz];

                    positions[i * 3] = nx + currentGlobalX;
                    positions[i * 3 + 1] = ny + currentGlobalY;
                    positions[i * 3 + 2] = nz + currentGlobalZ + 1.5;
                }

                trajAlignedCloudObj.geometry.attributes.position.needsUpdate = true;
                iter++;
            }, 40);
        }

        // Trail visibility
        if (trajTrailLineObj) trajTrailLineObj.visible = trajShowTrail;
        if (trajTrailDotsObj) trajTrailDotsObj.visible = trajShowTrail;
        if (trajActiveTrailObj) trajActiveTrailObj.visible = trajShowTrail;

        if (resetCamera) {
            traj3dControls.target.set(qX, qY, qZ);
            traj3dCamera.position.set(qX, qY - 80, qZ + 60);
            traj3dControls.update();
        }
    }

    async function trajGoToIndex(idx) {
        if (idx < 0 || idx >= trajMetadata.length) return;
        trajCurrentIdx = idx;

        // Update slider
        const slider = document.getElementById('traj-slider');
        if (slider) slider.value = idx;
        const currentLabel = document.getElementById('traj-slider-current');
        if (currentLabel) currentLabel.textContent = `${idx} / ${trajMetadata.length}`;

        // Load query data (with cache)
        let queryData = trajQueryCache[idx];
        if (!queryData) {
            try {
                const res = await fetch(`trajectories/query_${idx}.json`);
                queryData = await res.json();
                trajQueryCache[idx] = queryData;
            } catch (err) {
                console.error(`Failed to load trajectory query ${idx}:`, err);
                return;
            }
        }
        trajCurrentQueryData = queryData;

        const stepStr = trajCurrentStep.toString();
        const stepData = queryData.steps[stepStr];

        // Update info panel
        const fileEl = document.getElementById('traj-info-file');
        const latlonEl = document.getElementById('traj-info-latlon');
        const distEl = document.getElementById('traj-info-dist');
        const resultEl = document.getElementById('traj-info-result');
        if (fileEl) fileEl.textContent = queryData.query_file.split('/').pop();
        if (latlonEl) latlonEl.textContent = `${queryData.lat.toFixed(6)}, ${queryData.lon.toFixed(6)}`;
        if (stepData) {
            if (distEl) distEl.textContent = `${stepData.dist_to_query_meters.toFixed(2)} m`;
            if (resultEl) {
                resultEl.textContent = stepData.is_correct ? 'Correct' : 'Incorrect';
                resultEl.className = 'badge ' + (stepData.is_correct ? 'badge-correct' : 'badge-incorrect');
            }
        }

        // Update local viewers
        if (trajLocalQuery) {
            trajLocalQuery.updatePoints(queryData.pc_local);
        }
        if (trajLocalRetrieved && stepData) {
            trajLocalRetrieved.updatePoints(stepData.pc_local, stepData.is_correct);
        }

        // Update badge
        const badge = document.getElementById('traj-badge-retrieved');
        if (badge && stepData) {
            badge.className = 'badge ' + (stepData.is_correct ? 'badge-correct' : 'badge-incorrect');
            badge.textContent = stepData.is_correct ? 'Correct' : 'Incorrect';
        }
        const distFooter = document.getElementById('traj-dist-retrieved');
        if (distFooter && stepData) {
            distFooter.textContent = `Distance: ${stepData.dist_to_query_meters.toFixed(2)} m`;
        }

        // Update active trail line
        updateActiveTrail(idx);

        // Update 3D overlays (don't reset camera during playback)
        const shouldResetCamera = (idx === 0 && !trajIsPlaying);
        updateTraj3dOverlays(queryData, stepStr, shouldResetCamera);
    }

    function setupTrajControls() {
        // Slider
        const slider = document.getElementById('traj-slider');
        if (slider) {
            slider.addEventListener('input', (e) => {
                const idx = parseInt(e.target.value);
                trajGoToIndex(idx);
            });
        }

        // Play/Pause
        const btnPlay = document.getElementById('traj-btn-play');
        const playIcon = document.getElementById('traj-play-icon');
        const pauseIcon = document.getElementById('traj-pause-icon');
        if (btnPlay) {
            btnPlay.addEventListener('click', () => {
                if (trajIsPlaying) {
                    trajStop();
                } else {
                    trajPlay();
                }
            });
        }

        // Prev/Next
        const btnPrev = document.getElementById('traj-btn-prev');
        const btnNext = document.getElementById('traj-btn-next');
        if (btnPrev) {
            btnPrev.addEventListener('click', () => {
                trajStop();
                trajGoToIndex(Math.max(0, trajCurrentIdx - 1));
            });
        }
        if (btnNext) {
            btnNext.addEventListener('click', () => {
                trajStop();
                trajGoToIndex(Math.min(trajMetadata.length - 1, trajCurrentIdx + 1));
            });
        }

        // Step buttons
        document.querySelectorAll('.traj-step-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const step = parseInt(e.currentTarget.dataset.step);
                trajCurrentStep = step;
                document.querySelectorAll('.traj-step-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                // Re-render current position with new step
                if (trajCurrentQueryData) {
                    trajGoToIndex(trajCurrentIdx);
                }
            });
        });

        // Toggle trail
        const btnTrail = document.getElementById('traj-btn-toggle-trail');
        if (btnTrail) {
            btnTrail.addEventListener('click', () => {
                trajShowTrail = !trajShowTrail;
                btnTrail.textContent = `Trail: ${trajShowTrail ? 'ON' : 'OFF'}`;
                if (trajShowTrail) {
                    btnTrail.classList.replace('btn-secondary', 'btn-primary');
                } else {
                    btnTrail.classList.replace('btn-primary', 'btn-secondary');
                }
                if (trajTrailLineObj) trajTrailLineObj.visible = trajShowTrail;
                if (trajTrailDotsObj) trajTrailDotsObj.visible = trajShowTrail;
                if (trajActiveTrailObj) trajActiveTrailObj.visible = trajShowTrail;
            });
        }

        // Toggle retrieved
        const btnRetrieved = document.getElementById('traj-btn-toggle-retrieved');
        if (btnRetrieved) {
            btnRetrieved.addEventListener('click', () => {
                trajShowRetrieved = !trajShowRetrieved;
                btnRetrieved.textContent = `Retrieved: ${trajShowRetrieved ? 'ON' : 'OFF'}`;
                if (trajShowRetrieved) {
                    btnRetrieved.classList.replace('btn-secondary', 'btn-primary');
                } else {
                    btnRetrieved.classList.replace('btn-primary', 'btn-secondary');
                }
                if (trajCurrentQueryData) {
                    trajGoToIndex(trajCurrentIdx);
                }
            });
        }

        // Toggle aligned
        const btnAligned = document.getElementById('traj-btn-toggle-aligned');
        if (btnAligned) {
            btnAligned.addEventListener('click', () => {
                trajShowAligned = !trajShowAligned;
                btnAligned.textContent = `Aligned Query: ${trajShowAligned ? 'ON' : 'OFF'}`;
                if (trajShowAligned) {
                    btnAligned.classList.replace('btn-secondary', 'btn-primary');
                } else {
                    btnAligned.classList.replace('btn-primary', 'btn-secondary');
                    if (trajIcpInterval) {
                        clearInterval(trajIcpInterval);
                        trajIcpInterval = null;
                    }
                }
                if (trajCurrentQueryData) {
                    trajGoToIndex(trajCurrentIdx);
                }
            });
        }
    }

    function trajPlay() {
        if (trajIsPlaying) return;
        trajIsPlaying = true;

        const playIcon = document.getElementById('traj-play-icon');
        const pauseIcon = document.getElementById('traj-pause-icon');
        if (playIcon) playIcon.style.display = 'none';
        if (pauseIcon) pauseIcon.style.display = '';

        const pill = document.getElementById('traj-status-pill');
        const statusText = document.getElementById('traj-status-text');
        if (pill) { pill.classList.remove('ready'); pill.classList.add('playing'); }
        if (statusText) statusText.textContent = 'Playing...';

        // If at end, restart
        if (trajCurrentIdx >= trajMetadata.length - 1) {
            trajCurrentIdx = 0;
        }

        function advance() {
            if (!trajIsPlaying) return;
            const nextIdx = trajCurrentIdx + 1;
            if (nextIdx >= trajMetadata.length) {
                trajStop();
                return;
            }
            trajGoToIndex(nextIdx).then(() => {
                if (trajIsPlaying) {
                    const speed = parseInt(document.getElementById('traj-speed').value) || 1000;
                    trajPlayInterval = setTimeout(advance, speed);
                }
            });
        }

        const speed = parseInt(document.getElementById('traj-speed').value) || 1000;
        trajPlayInterval = setTimeout(advance, speed);
    }

    function trajStop() {
        trajIsPlaying = false;
        if (trajPlayInterval) {
            clearTimeout(trajPlayInterval);
            trajPlayInterval = null;
        }

        const playIcon = document.getElementById('traj-play-icon');
        const pauseIcon = document.getElementById('traj-pause-icon');
        if (playIcon) playIcon.style.display = '';
        if (pauseIcon) pauseIcon.style.display = 'none';

        const pill = document.getElementById('traj-status-pill');
        const statusText = document.getElementById('traj-status-text');
        if (pill) { pill.classList.remove('playing'); pill.classList.add('ready'); }
        if (statusText) statusText.textContent = `${trajMetadata.length} timestamps ready`;
    }

})();

