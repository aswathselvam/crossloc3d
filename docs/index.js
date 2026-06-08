// App State
let appData = [];
let globalMapData = [];
let currentQuery = null;
let currentStep = 3; // default to step 3 (final)
let isAnimating = false;
let isQueryHeatmap = true;
let isRetrievedHeatmap = false;
let isGlobalMapVisible = true;

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
