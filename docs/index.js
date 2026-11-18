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
let isRegionView = false;
let localViewersRegionColored = false;

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
let globalRegionLinksObj = null;
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
    scene.background = new THREE.Color(0x000000);

    // All preview cards are drawn in meters with the same framing (true relative scale).
    // Query clouds are passed already in meters (queryPointsMeters); submaps are normalized.
    const pcScale = type === 'query' ? 1.0 : DB_PC_SCALE;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 5000);
    camera.up.set(0, 0, 1); // Set Z as up vector to match point cloud coordinates
    camera.position.set(0, -300, 100);

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
    let baseColors = null; // default colours of the current cloud, restored by setColors(null)

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

            pointsArray.forEach((pt, i) => {
                const x = pt[0] * pcScale;
                const y = pt[1] * pcScale;
                const z = pt[2] * pcScale;
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
                size: type === 'query' ? 2.5 : 4.0, // meters
                vertexColors: true,
                transparent: true,
                opacity: 0.85
            });

            baseColors = colors.slice();
            pointsObj = new THREE.Points(geometry, material);
            scene.add(pointsObj);

            // Common framing for every card: top-down view of the full 200 m submap extent,
            // centered on the cloud origin (not auto-fit, which would hide the scale difference).
            const frameRadius = DB_PC_SCALE * Math.SQRT2;
            controls.target.set(0, 0, 0);
            camera.position.set(0, 0, frameRadius * 2);
            controls.update();
        },

        // Recolour in place (no camera reset). colorList: [[r,g,b], ...] per point, or null = default.
        setColors(colorList) {
            if (!pointsObj || !baseColors) return;
            const attr = pointsObj.geometry.attributes.color;
            if (!colorList) attr.array.set(baseColors);
            else colorList.forEach((c, i) => { attr.array[i * 3] = c[0]; attr.array[i * 3 + 1] = c[1]; attr.array[i * 3 + 2] = c[2]; });
            attr.needsUpdate = true;
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

// ---------------------------------------------------------------------------
// Shared point-cloud helpers (used by the global viewer and the trajectory viewer)
// ---------------------------------------------------------------------------

// pc_local is normalized: centroid-centred, larger XY side spanning [-1, 1].
// Aerial database submaps: x100 m (verified against the raw aerial map).
// Ground queries: each bin is a full Velodyne scan normalized by its own extent, so the
// scale differs per frame. query_scale.py stores it per query as pc_scale / pc_offset
// (exact from the raw bag where available, otherwise an estimate: pc_scale_source).
// pc_local * pc_scale + pc_offset = points in meters around the sensor (GPS) position.
const QUERY_PC_SCALE_FALLBACK = 78.8;
const DB_PC_SCALE = 100.0;

function queryPointsMeters(q) {
    if (!q._pcMeters) {
        const s = q.pc_scale || QUERY_PC_SCALE_FALLBACK;
        const o = q.pc_offset || [0, 0, 0];
        q._pcMeters = q.pc_local.map(p => [p[0] * s + o[0], p[1] * s + o[1], p[2] * s + o[2]]);
    }
    return q._pcMeters;
}

function queryScaleLabel(q) {
    const s = q.pc_scale || QUERY_PC_SCALE_FALLBACK;
    return q.pc_scale_source === 'bag'
        ? `scale ${s.toFixed(1)} m, from raw scan`
        : `scale ≈ ${s.toFixed(0)} m, estimated`;
}

// Jet colormap for attention weights in [0, 1]:
// dark blue -> blue -> cyan -> yellow -> red -> dark red.
const JET_LEGEND_GRADIENT = 'linear-gradient(to right, #000080 0%, #0000ff 12.5%, #00ffff 37.5%, #ffff00 62.5%, #ff0000 87.5%, #800000 100%)';
function jetColor(w) {
    const v = Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0;
    const clamp = x => Math.max(0, Math.min(1, x));
    return [
        clamp(1.5 - Math.abs(4 * v - 3)),
        clamp(1.5 - Math.abs(4 * v - 2)),
        clamp(1.5 - Math.abs(4 * v - 1))
    ];
}

// ---------------------------------------------------------------------------
// Region contribution view (data from region_attribution.py)
// ---------------------------------------------------------------------------
// Each cloud is split into regions; the similarity <q, r> of the two global descriptors is
// decomposed exactly into region-pair contributions. A region is colored by its share relative
// to the average region of its cloud (0 = none, 0.5 on the colormap = average, 1 = 2x average).
const REGION_PAIR_COLORS = ['#ffd400', '#ff7a00', '#ff2dd4'];
// Region view colouring lives in region_analysis.js (RegionAnalysis.sideColors).
const REGION_PAIR_GRADIENT = `linear-gradient(to right, ${REGION_PAIR_COLORS.join(', ')})`;
function hasRegionData(stepData) {
    return !!(stepData && stepData.region_ids && stepData.query_region_ids &&
        stepData.region_contrib && stepData.query_region_contrib && stepData.region_pairs);
}

// Weighted, trimmed point-to-point ICP with a gravity-aligned (4-DoF: x, y, z, yaw)
// motion model. Ground queries and aerial submaps are both z-up, so we only solve
// for heading + translation; this avoids spurious tilts from partial overlap.
//
// src, tgt: arrays of [x, y, z] in meters, both expressed in the same frame.
// srcW / tgtW: optional per-point attention weights in [0, 1].
// Returns { poses, rmse, inliers } where poses[k] = { yaw, t: [x, y, z] } is the
// cumulative transform after iteration k (poses[0] is identity).
function runWeightedIcp(src, tgt, srcW, tgtW, opts = {}) {
    const maxIter = opts.maxIter ?? 40;
    const startDist = opts.startDist ?? 8.0;   // initial correspondence gate (m)
    const endDist = opts.endDist ?? 3.0;       // final gate (m); aerial submaps are ~6 m point spacing
    const annealIters = opts.annealIters ?? 15;
    const weightFloor = 0.05;                  // keep zero-attention points from vanishing entirely

    const poses = [{ yaw: 0, t: [0, 0, 0] }];
    if (!src.length || !tgt.length) return { poses, rmse: NaN, inliers: 0 };

    // 2D uniform grid over the target for fast radius-bounded nearest neighbor search.
    const cell = startDist;
    const grid = new Map();
    tgt.forEach((p, j) => {
        const key = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, bucket = []);
        bucket.push(j);
    });

    let cur = src.map(p => [p[0], p[1], p[2]]);
    let yaw = 0, t = [0, 0, 0];
    let rmse = NaN, inliers = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        const a = Math.min(1, iter / annealIters);
        const gate = startDist + (endDist - startDist) * a;
        const gateSq = gate * gate;

        // 1. Correspondences (gated nearest neighbors)
        const pairs = [];
        let sqErr = 0;
        for (let i = 0; i < cur.length; i++) {
            const s = cur[i];
            const cx = Math.floor(s[0] / cell), cy = Math.floor(s[1] / cell);
            let best = -1, bestD = gateSq;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const bucket = grid.get((cx + dx) + ',' + (cy + dy));
                    if (!bucket) continue;
                    for (const j of bucket) {
                        const q = tgt[j];
                        const ex = s[0] - q[0], ey = s[1] - q[1], ez = s[2] - q[2];
                        const d = ex * ex + ey * ey + ez * ez;
                        if (d < bestD) { bestD = d; best = j; }
                    }
                }
            }
            if (best < 0) continue;
            const ws = srcW && srcW.length > i ? srcW[i] : 1;
            const wt = tgtW && tgtW.length > best ? tgtW[best] : 1;
            pairs.push([i, best, (weightFloor + ws) * (weightFloor + wt)]);
            sqErr += bestD;
        }
        inliers = pairs.length;
        rmse = inliers ? Math.sqrt(sqErr / inliers) : NaN;
        if (inliers < 10) break;

        // 2. Weighted closed-form 4-DoF solve
        let sw = 0;
        const cs = [0, 0, 0], ct = [0, 0, 0];
        for (const [i, j, w] of pairs) {
            sw += w;
            for (let k = 0; k < 3; k++) { cs[k] += w * cur[i][k]; ct[k] += w * tgt[j][k]; }
        }
        for (let k = 0; k < 3; k++) { cs[k] /= sw; ct[k] /= sw; }
        let A = 0, B = 0;
        for (const [i, j, w] of pairs) {
            const sx = cur[i][0] - cs[0], sy = cur[i][1] - cs[1];
            const tx = tgt[j][0] - ct[0], ty = tgt[j][1] - ct[1];
            A += w * (sx * tx + sy * ty);
            B += w * (sx * ty - sy * tx);
        }
        const dYaw = Math.atan2(B, A);
        const c = Math.cos(dYaw), s = Math.sin(dYaw);
        const dt = [
            ct[0] - (c * cs[0] - s * cs[1]),
            ct[1] - (s * cs[0] + c * cs[1]),
            ct[2] - cs[2]
        ];

        // 3. Apply increment and compose with the cumulative pose
        cur = cur.map(p => [c * p[0] - s * p[1] + dt[0], s * p[0] + c * p[1] + dt[1], p[2] + dt[2]]);
        t = [c * t[0] - s * t[1] + dt[0], s * t[0] + c * t[1] + dt[1], t[2] + dt[2]];
        yaw += dYaw;
        poses.push({ yaw, t: t.slice() });

        const step = Math.abs(dYaw) + Math.hypot(dt[0], dt[1], dt[2]);
        if (iter >= annealIters && step < 1e-3) break;
    }
    return { poses, rmse, inliers };
}

// Build the ICP problem in meters relative to the retrieved submap origin.
// queryOffset: [dx, dy, dz] world offset of the query's GPS position from the retrieved origin.
// If the query lies inside the retrieved submap, ICP starts from its GPS position (a real
// overlap to refine). Otherwise it starts from the retrieval hypothesis "query at submap center".
// qPcMeters: query points in meters around the sensor (queryPointsMeters).
function setupQueryRegistration(qPcMeters, rPcLocal, queryOffset, qW, rW) {
    const inside = Math.abs(queryOffset[0]) < DB_PC_SCALE && Math.abs(queryOffset[1]) < DB_PC_SCALE;
    const init = inside ? queryOffset : [0, 0, 0];
    const srcLocal = qPcMeters.map(p => [p[0] + init[0], p[1] + init[1], p[2] + init[2]]);
    const tgtLocal = rPcLocal.map(p => [p[0] * DB_PC_SCALE, p[1] * DB_PC_SCALE, p[2] * DB_PC_SCALE]);
    const icp = runWeightedIcp(srcLocal, tgtLocal, qW, rW);
    // Offset from the ICP start to the query's true position (zero when starting from GPS).
    const startOffset = queryOffset.map((v, k) => v - init[k]);
    return { srcLocal, startOffset, icp, init: inside ? 'gps' : 'center' };
}

// Animate a THREE.Points cloud through registration:
//   phase 1: rigidly slide the query from its true position to the retrieval hypothesis
//            (query centered on the retrieved submap), then
//   phase 2: play the ICP iterations.
// srcLocal: query points (m) relative to the retrieved origin under the hypothesis.
// origin:   [x, y, z] world position of the retrieved submap origin.
// startOffset: [dx, dy, dz] world offset of the true query position from origin.
// Returns the interval handle.
function animateIcpAlignment(pointsObj, srcLocal, origin, startOffset, poses, onDone) {
    const positions = pointsObj.geometry.attributes.position.array;
    const write = (yaw, t) => {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        for (let i = 0; i < srcLocal.length; i++) {
            const p = srcLocal[i];
            positions[i * 3] = origin[0] + c * p[0] - s * p[1] + t[0];
            positions[i * 3 + 1] = origin[1] + s * p[0] + c * p[1] + t[1];
            positions[i * 3 + 2] = origin[2] + p[2] + t[2];
        }
        pointsObj.geometry.attributes.position.needsUpdate = true;
    };

    const slideFrames = startOffset.some(v => Math.abs(v) > 1e-6) ? 20 : 0;
    const totalFrames = slideFrames + poses.length;
    let frame = 0;
    write(0, startOffset);
    const handle = setInterval(() => {
        frame++;
        if (frame <= slideFrames) {
            const u = frame / slideFrames;
            const e = u * u * (3 - 2 * u); // smoothstep
            write(0, startOffset.map(v => v * (1 - e)));
        } else {
            const pose = poses[Math.min(frame - slideFrames, poses.length - 1)];
            write(pose.yaw, pose.t);
        }
        if (frame >= totalFrames) {
            clearInterval(handle);
            if (onDone) onDone();
        }
    }, 40);
    return handle;
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

    const btnRegionView = document.getElementById('btn-toggle-region-view');
    if (btnRegionView) {
        btnRegionView.addEventListener('click', () => {
            isRegionView = !isRegionView;
            btnRegionView.textContent = isRegionView ? 'Region Contribution: ON' : 'Region Contribution: OFF';
            btnRegionView.classList.replace(isRegionView ? 'btn-secondary' : 'btn-primary',
                isRegionView ? 'btn-primary' : 'btn-secondary');
            if (currentQuery) {
                renderActiveStepState();
            }
        });
    }

    // Active animation handle
    let activeIcpAnimation = null;

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

    // Region view: hover / click a point of the query or retrieved cloud to select its region
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 3; // meters
    const pointer = new THREE.Vector2();
    let pickQueued = false, lastPointerEvent = null, downAt = null;
    function pickRegionPoint(ev) {
        if (!isRegionView || !globalQueryPointsObj) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects([globalQueryPointsObj, globalRetrievedPointsObj].filter(Boolean));
        if (!hits.length) return { side: null };
        return { side: hits[0].object === globalQueryPointsObj ? 'q' : 'r', index: hits[0].index };
    }
    renderer.domElement.addEventListener('pointermove', ev => {
        if (!isRegionView || ev.buttons) return; // ignore while orbiting
        lastPointerEvent = ev;
        if (pickQueued) return;
        pickQueued = true;
        requestAnimationFrame(() => {
            pickQueued = false;
            const hit = pickRegionPoint(lastPointerEvent);
            if (hit) RegionAnalysis.hoverPoint(hit.side, hit.index);
        });
    });
    renderer.domElement.addEventListener('pointerleave', () => { if (isRegionView) RegionAnalysis.hoverPoint(null); });
    renderer.domElement.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
    renderer.domElement.addEventListener('pointerup', ev => {
        if (!isRegionView || !downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return; // a drag, not a click
        const hit = pickRegionPoint(ev);
        if (hit && hit.side) RegionAnalysis.clickPoint(hit.side, hit.index);
    });

    global3dViewer = {
        // Recolour the query / retrieved overlay clouds in place (region hover, colour mode)
        setOverlayColors(qList, rList) {
            [[globalQueryPointsObj, qList], [globalRetrievedPointsObj, rList]].forEach(([obj, list]) => {
                if (!obj || !list) return;
                const attr = obj.geometry.attributes.color;
                if (attr.count !== list.length) return;
                list.forEach((c, i) => { attr.array[i * 3] = c[0]; attr.array[i * 3 + 1] = c[1]; attr.array[i * 3 + 2] = c[2]; });
                attr.needsUpdate = true;
            });
        },
        updateOverlays(qX, qY, qPcMeters, rX, rY, rPcLocal, isCorrect, attentionHeatmap, queryAttentionHeatmap, resetCamera = false, regionData = null) {
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
            if (globalRegionLinksObj) {
                scene.remove(globalRegionLinksObj);
                globalRegionLinksObj.traverse(o => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) o.material.dispose();
                });
                globalRegionLinksObj = null;
            }
            const showRegions = isRegionView && regionData;
            const regionColors = showRegions ? RegionAnalysis.colors(regionData, qPcMeters, rPcLocal) : null;
            // Dim the RGB campus map so the highlighted regions stand out
            if (globalMapObj) {
                globalMapObj.material.transparent = !!showRegions;
                globalMapObj.material.opacity = showRegions ? 0.25 : 1.0;
                globalMapObj.material.needsUpdate = true;
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
            qPcMeters.forEach(pt => {
                const z = pt[2];
                if (z < qZMin) qZMin = z;
                if (z > qZMax) qZMax = z;
            });

            qPcMeters.forEach((pt, i) => {
                const x = qX + pt[0];
                const y = qY + pt[1];
                const z = qZ + pt[2] + 1.5; // query points are in meters; sensor ~1.5 m above ground
                qPos.push(x, y, z);

                if (showRegions) {
                    qColors.push(...regionColors.q[i]);
                } else if (isQueryHeatmap && queryAttentionHeatmap && queryAttentionHeatmap.length > i) {
                    qColors.push(...jetColor(queryAttentionHeatmap[i]));
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
                const x = rX + pt[0] * DB_PC_SCALE;
                const y = rY + pt[1] * DB_PC_SCALE;
                const z = rZ + pt[2] * DB_PC_SCALE + 1.5; // lift slightly above ground
                rPos.push(x, y, z);

                // Assign color based on heatmap if enabled
                if (showRegions) {
                    rColors.push(...regionColors.r[i]);
                } else if (isRetrievedHeatmap && attentionHeatmap && attentionHeatmap.length > i) {
                    rColors.push(...jetColor(attentionHeatmap[i]));
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

            // 3. Add Query Bounding Box (extent of the scan, in meters)
            const qMin = [Infinity, Infinity, Infinity], qMax = [-Infinity, -Infinity, -Infinity];
            qPcMeters.forEach(pt => {
                for (let k = 0; k < 3; k++) {
                    if (pt[k] < qMin[k]) qMin[k] = pt[k];
                    if (pt[k] > qMax[k]) qMax[k] = pt[k];
                }
            });
            const qBoxGeom = new THREE.BoxGeometry(qMax[0] - qMin[0], qMax[1] - qMin[1], Math.max(qMax[2] - qMin[2], 1));
            const qEdges = new THREE.EdgesGeometry(qBoxGeom);
            const qBoxMat = new THREE.LineBasicMaterial({ color: 0x00bcff, linewidth: 2 });
            globalQueryBoxObj = new THREE.LineSegments(qEdges, qBoxMat);
            globalQueryBoxObj.position.set(qX + (qMin[0] + qMax[0]) / 2, qY + (qMin[1] + qMax[1]) / 2, qZ + 1.5 + (qMin[2] + qMax[2]) / 2);
            scene.add(globalQueryBoxObj);

            // 4. Add Retrieved Bounding Box (200m x 200m x 200m)
            const rBoxGeom = new THREE.BoxGeometry(200, 200, 200);
            const rEdges = new THREE.EdgesGeometry(rBoxGeom);
            const rColorHex = isCorrect ? 0x10b981 : 0xef4444;
            const rBoxMat = new THREE.LineBasicMaterial({ color: rColorHex, linewidth: 2 });
            globalRetrievedBoxObj = new THREE.LineSegments(rEdges, rBoxMat);
            globalRetrievedBoxObj.position.set(rX, rY, rZ + 100);
            scene.add(globalRetrievedBoxObj);

            // 4b. Region contribution view: link the top region pairs (centroid to centroid)
            if (showRegions) {
                const centroid = (pts, ids, region, ox, oy, oz, scale) => {
                    let sx = 0, sy = 0, sz = 0, n = 0;
                    for (let i = 0; i < pts.length; i++) {
                        if (ids[i] !== region) continue;
                        sx += pts[i][0]; sy += pts[i][1]; sz += pts[i][2]; n++;
                    }
                    if (!n) return null;
                    return new THREE.Vector3(ox + sx / n * scale, oy + sy / n * scale, oz + sz / n * scale + 1.5);
                };
                globalRegionLinksObj = new THREE.Group();
                regionData.region_pairs.slice(0, REGION_PAIR_COLORS.length).forEach(([qa, rb], k) => {
                    const a = centroid(qPcMeters, regionData.query_region_ids, qa, qX, qY, qZ, 1.0);
                    const b = centroid(rPcLocal, regionData.region_ids, rb, rX, rY, rZ, DB_PC_SCALE);
                    if (!a || !b) return;
                    const color = new THREE.Color(REGION_PAIR_COLORS[k]);
                    // Arc the link upward so it stays visible above the clouds
                    const mid = a.clone().add(b).multiplyScalar(0.5);
                    mid.z += 15 + 0.15 * a.distanceTo(b);
                    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
                    const line = new THREE.Line(
                        new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
                        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false })
                    );
                    line.renderOrder = 10;
                    globalRegionLinksObj.add(line);
                    const ends = new THREE.Points(
                        new THREE.BufferGeometry().setFromPoints([a, b]),
                        new THREE.PointsMaterial({ color, size: 14, map: createRingTexture(), transparent: true, depthTest: false })
                    );
                    ends.renderOrder = 11;
                    globalRegionLinksObj.add(ends);
                });
                scene.add(globalRegionLinksObj);
            }

            // 5. Aligned Query Point Cloud & Fitting Animation
            if (isAlignedQueryVisible) {
                // Weighted ICP in meters relative to the retrieved submap origin.
                const { srcLocal, startOffset, icp, init } = setupQueryRegistration(
                    qPcMeters, rPcLocal, [qX - rX, qY - rY, qZ - rZ], queryAttentionHeatmap, attentionHeatmap);
                const finalPose = icp.poses[icp.poses.length - 1];
                console.log(`ICP (init: ${init}): ${icp.poses.length - 1} iters, yaw ${(finalPose.yaw * 180 / Math.PI).toFixed(2)} deg, ` +
                    `t [${finalPose.t.map(v => v.toFixed(2)).join(', ')}] m, RMSE ${icp.rmse.toFixed(2)} m, inliers ${icp.inliers}/${srcLocal.length}`);

                const alignedGeom = new THREE.BufferGeometry();
                alignedGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(srcLocal.length * 3), 3));
                const alignedColors = new Float32Array(srcLocal.length * 3);
                for (let i = 0; i < srcLocal.length; i++) {
                    alignedColors[i * 3] = 0.85;
                    alignedColors[i * 3 + 1] = 0.27;
                    alignedColors[i * 3 + 2] = 0.94;
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

                const alignedLabel = document.getElementById('legend-aligned-label');
                if (alignedLabel) alignedLabel.textContent = 'Aligned Query (ICP running…)';
                activeIcpAnimation = animateIcpAlignment(
                    globalAlignedPointsObj, srcLocal,
                    [rX, rY, rZ + 1.5],
                    startOffset,
                    icp.poses,
                    () => {
                        activeIcpAnimation = null;
                        if (alignedLabel) {
                            alignedLabel.textContent = Number.isFinite(icp.rmse)
                                ? `Aligned Query (ICP RMSE ${icp.rmse.toFixed(2)} m)`
                                : 'Aligned Query (ICP: no overlap)';
                        }
                    }
                );
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
        infoQueryFile.textContent = `${currentQuery.query_file.split('/').pop()} (${queryScaleLabel(currentQuery)})`;
        infoQueryUtm.textContent = `E: ${currentQuery.easting.toFixed(2)} | N: ${currentQuery.northing.toFixed(2)}`;
        infoQueryLatlon.textContent = `${currentQuery.lat.toFixed(6)}, ${currentQuery.lon.toFixed(6)}`;

        // Update local query viewer
        localViewers.query.updatePoints(queryPointsMeters(currentQuery));

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

        // Plot query points globally at metric scale. pc_global is projected by
        // query_scale.py with the query's pc_scale / pc_offset, matching the 3D view.
        currentQuery.pc_global.forEach(pt => {
            L.circleMarker([pt[0], pt[1]], {
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

    // Preview cards: region colours are applied in place by RegionAnalysis (no camera reset);
    // only touch them while the region view is on or was just turned off.
    if (localViewers.query && (isRegionView || localViewersRegionColored)) {
        localViewersRegionColored = isRegionView;
        RegionAnalysis.applyCardColors();
    }

    // 2. Three.js Global 3D Map updates
    if (global3dViewer) {
        // Centered coordinates around UTM origin
        const qX = currentQuery.easting - 332100.0;
        const qY = currentQuery.northing - 4317500.0;
        const rX = stepData.easting - 332100.0;
        const rY = stepData.northing - 4317500.0;

        global3dViewer.updateOverlays(
            qX, qY, queryPointsMeters(currentQuery),
            rX, rY, stepData.pc_local,
            stepData.is_correct,
            stepData.attention_heatmap,
            stepData.query_attention_heatmap,
            resetCamera,
            hasRegionData(stepData) ? stepData : null
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
            legendQueryColor.style.background = JET_LEGEND_GRADIENT;
            legendQueryLabel.textContent = 'Query: Attention Heatmap';
        } else if (isQueryHeatmap) {
            legendQueryColor.style.background = 'linear-gradient(to right, #1a4dff, #b3e6ff)';
            legendQueryLabel.textContent = 'Query: Height Gradient';
        } else {
            legendQueryColor.style.background = '#0073ff';
            legendQueryLabel.textContent = 'Query: Solid Blue';
        }
    }

    if (legendRetrievedColor && legendRetrievedLabel && legendRetrievedBox) {
        if (isRetrievedHeatmap && stepData.attention_heatmap) {
            legendRetrievedColor.style.background = JET_LEGEND_GRADIENT;
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

    // Region contribution view overrides the query/retrieved coloring and fills the pairs panel
    const regionPanel = document.getElementById('legend-region-panel');
    const regionPairsEl = document.getElementById('legend-region-pairs');
    const regionNoteEl = document.getElementById('legend-region-note');
    const showRegions = isRegionView && hasRegionData(stepData);
    if (regionPanel) regionPanel.style.display = showRegions ? 'flex' : 'none';
    if (showRegions) {
        if (legendQueryColor && legendQueryLabel) {
            legendQueryColor.style.background = REGION_PAIR_GRADIENT;
            legendQueryLabel.textContent = 'Query: top-pair regions in pair colour, rest grey (shaded by height)';
        }
        if (legendRetrievedColor && legendRetrievedLabel) {
            legendRetrievedColor.style.background = REGION_PAIR_GRADIENT;
            legendRetrievedLabel.textContent = 'Retrieved: top-pair regions in pair colour, rest grey (shaded by height)';
        }
        if (regionPairsEl) {
            regionPairsEl.replaceChildren();
            stepData.region_pairs.slice(0, REGION_PAIR_COLORS.length).forEach(([qa, rb, , share], k) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 6px; color: var(--text-secondary);';
                const swatch = document.createElement('span');
                swatch.style.cssText = `width: 14px; height: 3px; background: ${REGION_PAIR_COLORS[k]}; display: inline-block; flex: none;`;
                const label = document.createElement('span');
                label.textContent = `${k + 1}. Query R${qa} ↔ Retrieved R${rb}: ${(share * 100).toFixed(1)}%`;
                row.append(swatch, label);
                regionPairsEl.appendChild(row);
            });
        }
        if (regionNoteEl) {
            const nPairs = stepData.query_region_contrib.length * stepData.region_contrib.length;
            const top3 = stepData.region_pairs.slice(0, 3).reduce((a, p) => a + p[3], 0);
            regionNoteEl.textContent = `Top 3 explain ${(top3 * 100).toFixed(1)}% of the similarity; ` +
                `the rest is spread over ${nPairs} region pairs (even share ${(100 / nPairs).toFixed(2)}% each).`;
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

    // Region contribution analysis panel (matrix, cumulative share, flow, close-ups) + legend
    RegionAnalysis.render();
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

(function () {
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
        const qPcMeters = queryPointsMeters(queryData);
        qPcMeters.forEach(pt => {
            if (pt[2] < qZMin) qZMin = pt[2];
            if (pt[2] > qZMax) qZMax = pt[2];
        });
        qPcMeters.forEach((pt, i) => {
            qPos.push(qX + pt[0], qY + pt[1], qZ + pt[2] + 1.5);
            const normZ = (qZMax - qZMin) > 0 ? (pt[2] - qZMin) / (qZMax - qZMin) : 0.5;
            // Check if we have query attention heatmap for this step
            const qHeatmap = stepData.query_attention_heatmap;
            if (qHeatmap && qHeatmap.length > i) {
                qColors.push(...jetColor(qHeatmap[i]));
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
                rPos.push(rX + pt[0] * DB_PC_SCALE, rY + pt[1] * DB_PC_SCALE, rZ + pt[2] * DB_PC_SCALE + 1.5);
                const heatmap = stepData.attention_heatmap;
                if (heatmap && heatmap.length > i) {
                    rColors.push(...jetColor(heatmap[i]));
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
            // Weighted ICP in meters relative to the retrieved submap origin.
            const { srcLocal, startOffset, icp } = setupQueryRegistration(
                queryPointsMeters(queryData), stepData.pc_local, [qX - rX, qY - rY, qZ - rZ],
                stepData.query_attention_heatmap, stepData.attention_heatmap);

            const alignedGeom = new THREE.BufferGeometry();
            alignedGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(srcLocal.length * 3), 3));
            const alignedColors = new Float32Array(srcLocal.length * 3);
            for (let i = 0; i < srcLocal.length; i++) {
                alignedColors[i * 3] = 0.85;
                alignedColors[i * 3 + 1] = 0.27;
                alignedColors[i * 3 + 2] = 0.94;
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

            trajIcpInterval = animateIcpAlignment(
                trajAlignedCloudObj, srcLocal,
                [rX, rY, rZ + 1.5],
                startOffset,
                icp.poses,
                () => { trajIcpInterval = null; }
            );
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
            trajLocalQuery.updatePoints(queryPointsMeters(queryData));
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

