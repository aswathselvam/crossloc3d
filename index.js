// App State
let appData = [];
let globalMapData = [];
let currentQuery = null;
let currentStep = 3; // default to step 3 (final)
let isAnimating = false;

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
        const [vizRes, mapRes] = await Promise.all([
            fetch('visualization_data.json'),
            fetch('visuals/global_map_downsampled.json')
        ]);
        
        appData = await vizRes.json();
        globalMapData = await mapRes.json();
        console.log(`Loaded ${appData.length} queries and ${globalMapData.length} global map points.`);
        
        // Populate Select
        selectQuery.innerHTML = '';
        appData.forEach((item, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = `${item.location} - Query ${item.query_idx} (${item.category})`;
            selectQuery.appendChild(opt);
        });
        
        // Init Leaflet Map
        initLeafletMap();
        
        // Init Three.js local viewers
        initLocalViewers();
        
        // Init Three.js global 3D viewer
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
        selectQueryIndex(0);
        
    } catch (err) {
        console.error("Initialization failed:", err);
    }
});

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
    scene.background = new THREE.Color(0x060709);
    
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

// 3D Global Map Viewer Initialization
function initGlobal3dViewer() {
    const container = document.getElementById('global-3d-map');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c10);
    
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
    
    // Add static RGB Global Map points
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    
    globalMapData.forEach(pt => {
        // x, y, z, r, g, b
        positions.push(pt[0], pt[1], pt[2]);
        colors.push(pt[3] / 255.0, pt[4] / 255.0, pt[5] / 255.0);
    });
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    const material = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: false
    });
    
    const globalMapObj = new THREE.Points(geometry, material);
    scene.add(globalMapObj);
    console.log("RGB Global Map points loaded in Three.js Scene.");
    
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
        let sumZ = 0;
        let count = 0;
        for (let i = 0; i < globalMapData.length; i++) {
            const pt = globalMapData[i];
            const dx = pt[0] - x;
            const dy = pt[1] - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < radius * radius) {
                sumZ += pt[2];
                count++;
            }
        }
        return count > 0 ? (sumZ / count) : 30.0;
    }

    global3dViewer = {
        updateOverlays(qX, qY, qPcLocal, rX, rY, rPcLocal, isCorrect) {
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
            
            // Get local terrain heights to align query and retrieved patches in height with the global map
            const qZ = getGroundHeight(qX, qY);
            const rZ = getGroundHeight(rX, rY);
            
            // 1. Plot Query points globally
            const qGeom = new THREE.BufferGeometry();
            const qPos = [];
            qPcLocal.forEach(pt => {
                const x = qX + pt[0] * 20.0;
                const y = qY + pt[1] * 20.0;
                const z = qZ + pt[2] * 20.0 + 1.5; // lift slightly above ground to prevent z-fighting
                qPos.push(x, y, z);
            });
            qGeom.setAttribute('position', new THREE.Float32BufferAttribute(qPos, 3));
            const qMat = new THREE.PointsMaterial({
                size: 2.2, // slightly smaller points to look like point clouds
                color: new THREE.Color(0x00bcff), // bright blue
                transparent: true,
                opacity: 0.85
            });
            globalQueryPointsObj = new THREE.Points(qGeom, qMat);
            scene.add(globalQueryPointsObj);
            
            // 2. Plot Retrieved points globally
            const rGeom = new THREE.BufferGeometry();
            const rPos = [];
            rPcLocal.forEach(pt => {
                const x = rX + pt[0] * 100.0;
                const y = rY + pt[1] * 100.0;
                const z = rZ + pt[2] * 100.0 + 1.5; // lift slightly above ground
                rPos.push(x, y, z);
            });
            rGeom.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
            const rColor = isCorrect ? 0x10b981 : 0xef4444; // green / red
            const rMat = new THREE.PointsMaterial({
                size: 2.2, // slightly smaller points
                color: new THREE.Color(rColor),
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
            const rBoxMat = new THREE.LineBasicMaterial({ color: rColor, linewidth: 2 });
            globalRetrievedBoxObj = new THREE.LineSegments(rEdges, rBoxMat);
            globalRetrievedBoxObj.position.set(rX, rY, rZ + 100);
            scene.add(globalRetrievedBoxObj);
            
            // Focus camera dynamically on the actual local terrain height
            controls.target.set(qX, qY, qZ);
            camera.position.set(qX, qY - 150, qZ + 150);
            controls.update();
        }
    };
}

// Select a query index
function selectQueryIndex(index) {
    currentQuery = appData[index];
    console.log("Selected query:", currentQuery);
    
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
        const cardFooter = document.getElementById(`dist-step-1`); // wait: let's select correctly
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
    renderActiveStepState();
}

// Set active visual step (1, 2, 3)
function setActiveStep(step) {
    currentStep = step;
    renderActiveStepState();
}

// Update Map and Global 3D view overlays for active step
function renderActiveStepState() {
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
        
        // Plot query points (blue dots) globally
        currentQuery.pc_global.forEach(pt => {
            L.circleMarker([pt[0], pt[1]], {
                radius: 1.2,
                fillColor: '#00bcff',
                color: 'none',
                fillOpacity: 0.65
            }).addTo(mapPointsLayerGroup);
        });
        
        // Plot retrieved points (green/red dots) globally
        stepData.pc_global.forEach(pt => {
            L.circleMarker([pt[0], pt[1]], {
                radius: 1.2,
                fillColor: stepData.is_correct ? '#10b981' : '#ef4444',
                color: 'none',
                fillOpacity: 0.65
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
            stepData.is_correct
        );
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
