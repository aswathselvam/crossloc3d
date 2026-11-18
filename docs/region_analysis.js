// Region contribution analysis: shared region colouring for the 3D view / preview cards,
// and the analysis panel (contribution matrix, cumulative share, flow, pair close-ups).
//
// Data per step (region_attribution.py): query_region_ids / region_ids (per displayed point),
// region_matrix[a][b] = contribution of query region a x retrieved region b to <q, r>
// (sums exactly to region_score.score), region_pairs (top pairs), query/region_contrib (row/col sums).
//
// Relies on globals from index.js: currentQuery, currentStep, isRegionView, localViewers,
// global3dViewer, queryPointsMeters, DB_PC_SCALE, REGION_PAIR_COLORS, THREE.

const RegionAnalysis = (() => {
    // Chart surface + ink (dark plot areas, like the point-cloud viewers)
    const SURFACE = '#1a1a19', INK = '#f0efec', INK2 = '#c3c2b7', MUTED = '#8a8981', GRID = '#383835';
    // Diverging pair for signed contributions: blue (lowers similarity) <-> red (raises it)
    const NEG_HEX = '#3987e5', POS_HEX = '#e66767', MID_HEX = '#383835';
    const DIVERGING_GRADIENT = `linear-gradient(to right, ${NEG_HEX}, #8a8981, ${POS_HEX})`;
    const STEP_COLORS = ['#3987e5', '#d95926', '#199e70']; // categorical slots 1-3 (validated, dark)
    const SELECT_RGB = [0.55, 0.95, 1.0];                  // selected region in 3D: bright cyan

    const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const NEG = hexRgb(NEG_HEX), POS = hexRgb(POS_HEX), MID = hexRgb(MID_HEX);
    const POINT_MID = [0.42, 0.42, 0.40]; // neutral for points on black (MID would vanish)

    const state = { mode: 'pairs', hover: null, pinned: null, key: null, corrDir: 'q' };

    // ---------- data helpers ----------
    const activeStep = () => (currentQuery ? currentQuery.steps[String(currentStep)] : null);
    const hasMatrix = sd => !!(sd && sd.region_matrix && sd.query_region_ids && sd.region_ids);
    const selection = () => state.hover || state.pinned;

    function stats(sd) {
        if (sd._raStats) return sd._raStats;
        const C = sd.region_matrix, score = sd.region_score.score;
        const rows = C.map(r => r.reduce((a, b) => a + b, 0));
        const cols = C[0].map((_, b) => C.reduce((a, r) => a + r[b], 0));
        let maxAbs = 0;
        C.forEach(r => r.forEach(v => { maxAbs = Math.max(maxAbs, Math.abs(v)); }));
        const ranked = [];
        C.forEach((r, a) => r.forEach((v, b) => ranked.push({ a, b, v })));
        ranked.sort((x, y) => y.v - x.v);
        let cum = 0;
        const cumulative = ranked.map(p => (cum += p.v) / score);
        const countIds = (ids, n) => { const c = new Array(n).fill(0); ids.forEach(i => c[i]++); return c; };
        sd._raStats = {
            C, score, rows, cols, maxAbs, ranked, cumulative,
            rank: new Map(ranked.map((p, i) => [p.a * 1000 + p.b, i + 1])),
            qCount: countIds(sd.query_region_ids, C.length), rCount: countIds(sd.region_ids, C[0].length),
            maxAbsRow: Math.max(...rows.map(Math.abs)), maxAbsCol: Math.max(...cols.map(Math.abs)),
        };
        return sd._raStats;
    }
    const pct = (v, score) => `${(v / score * 100).toFixed(2)}%`;
    const topPairIndex = (sd, a, b) =>
        sd.region_pairs.slice(0, REGION_PAIR_COLORS.length).findIndex(p => p[0] === a && p[1] === b);

    // signed value in [-1, 1] -> rgb (diverging, gamma lifts small values)
    function diverging(t, mid = POINT_MID) {
        const u = Math.min(1, Math.pow(Math.abs(t), 0.6));
        const pole = t < 0 ? NEG : POS;
        return mid.map((m, k) => m + (pole[k] - m) * u);
    }

    // ---------- colouring (3D view + preview cards) ----------
    // side: 'q' | 'r'; pts: that cloud's points (any unit, z used for height shading);
    // interactive: apply hover / pinned selection (only for the active step)
    function sideColors(sd, side, pts, interactive = true) {
        const ids = side === 'q' ? sd.query_region_ids : sd.region_ids;
        const sel = interactive ? selection() : null;
        let base; // region id -> [r,g,b] (coloured) or null (grey)
        let shadeLo = 0.45;
        if (sel && hasMatrix(sd)) {
            const s = stats(sd);
            if (sel.side === 'pair') {
                const k = topPairIndex(sd, sel.a, sel.b);
                const c = k >= 0 ? hexRgb(REGION_PAIR_COLORS[k]) : SELECT_RGB;
                const mine = side === 'q' ? sel.a : sel.b;
                base = r => (r === mine ? c : null);
            } else if (sel.side === side) {
                const mine = side === 'q' ? sel.a : sel.b;
                base = r => (r === mine ? SELECT_RGB : null);
            } else if (sel.side === 'q') { // colour retrieved regions by contribution with query region a
                const row = s.C[sel.a], m = Math.max(...row.map(Math.abs)) || 1;
                base = b => diverging(row[b] / m); shadeLo = 0.6;
            } else {                       // colour query regions by contribution with retrieved region b
                const col = s.C.map(r => r[sel.b]), m = Math.max(...col.map(Math.abs)) || 1;
                base = a => diverging(col[a] / m); shadeLo = 0.6;
            }
        } else if (state.mode === 'totals' && hasMatrix(sd)) {
            const s = stats(sd);
            base = side === 'q' ? a => diverging(s.rows[a] / (s.maxAbsRow || 1))
                : b => diverging(s.cols[b] / (s.maxAbsCol || 1));
            shadeLo = 0.6;
        } else {
            const pairOf = new Map();
            sd.region_pairs.slice(0, REGION_PAIR_COLORS.length).forEach((p, k) => {
                const r = side === 'q' ? p[0] : p[1];
                if (!pairOf.has(r)) pairOf.set(r, hexRgb(REGION_PAIR_COLORS[k]));
            });
            base = r => pairOf.get(r) || null;
        }
        let zMin = Infinity, zMax = -Infinity;
        pts.forEach(p => { if (p[2] < zMin) zMin = p[2]; if (p[2] > zMax) zMax = p[2]; });
        const cache = new Map();
        return pts.map((p, i) => {
            const h = zMax > zMin ? (p[2] - zMin) / (zMax - zMin) : 0.5;
            const r = ids[i];
            if (!cache.has(r)) cache.set(r, base(r));
            const c = cache.get(r);
            if (c) { const f = shadeLo + (1 - shadeLo) * h; return [c[0] * f, c[1] * f, c[2] * f]; }
            const g = 0.2 + 0.55 * h;
            return [g, g, g];
        });
    }

    function colors(sd, qPts, rPts) {
        return { q: sideColors(sd, 'q', qPts), r: sideColors(sd, 'r', rPts) };
    }

    function applyCardColors() {
        if (!localViewers.query || !currentQuery) return;
        const sd = activeStep();
        if (!isRegionView) {
            localViewers.query.setColors(null);
            for (let k = 1; k <= 3; k++) if (localViewers[`step${k}`]) localViewers[`step${k}`].setColors(null);
            return;
        }
        localViewers.query.setColors(sd && sd.query_region_ids
            ? sideColors(sd, 'q', queryPointsMeters(currentQuery)) : null);
        for (let k = 1; k <= 3; k++) {
            const sdk = currentQuery.steps[String(k)], v = localViewers[`step${k}`];
            if (!v || !sdk) continue;
            v.setColors(sdk.region_ids ? sideColors(sdk, 'r', sdk.pc_local, k === currentStep) : null);
        }
    }

    // ---------- legend + readout ----------
    function updateLegend(sd) {
        const qc = document.getElementById('legend-query-color'), ql = document.getElementById('legend-query-label');
        const rc = document.getElementById('legend-retrieved-color'), rl = document.getElementById('legend-retrieved-label');
        if (!qc || !ql || !rc || !rl) return;
        const sel = selection();
        const pairGrad = `linear-gradient(to right, ${REGION_PAIR_COLORS.join(', ')})`;
        if (sel && sel.side === 'q') {
            qc.style.background = 'rgb(140, 242, 255)'; ql.textContent = `Query: selected region R${sel.a}`;
            rc.style.background = DIVERGING_GRADIENT; rl.textContent = `Retrieved: contribution with Query R${sel.a} (blue −, red +)`;
        } else if (sel && sel.side === 'r') {
            qc.style.background = DIVERGING_GRADIENT; ql.textContent = `Query: contribution with Retrieved R${sel.b} (blue −, red +)`;
            rc.style.background = 'rgb(140, 242, 255)'; rl.textContent = `Retrieved: selected region R${sel.b}`;
        } else if (sel && sel.side === 'pair') {
            qc.style.background = rc.style.background = pairGrad;
            ql.textContent = `Query: region R${sel.a} of the selected pair`;
            rl.textContent = `Retrieved: region R${sel.b} of the selected pair`;
        } else if (state.mode === 'totals') {
            qc.style.background = rc.style.background = DIVERGING_GRADIENT;
            ql.textContent = 'Query: region total share (blue −, red +)';
            rl.textContent = 'Retrieved: region total share (blue −, red +)';
        } else {
            qc.style.background = rc.style.background = pairGrad;
            ql.textContent = 'Query: top-pair regions in pair colour, rest grey (shaded by height)';
            rl.textContent = 'Retrieved: top-pair regions in pair colour, rest grey (shaded by height)';
        }
    }

    function readoutText(sd) {
        if (!hasMatrix(sd)) return 'This step has no region matrix (re-run region_attribution.py).';
        const s = stats(sd), sel = selection();
        const pinnedNote = state.pinned && !state.hover ? ' (pinned; click it again to release)' : '';
        if (!sel) {
            return state.mode === 'totals'
                ? 'Each region is coloured by its total share of the similarity (red raises it, blue lowers it). Hover a region in the 3D view, the matrix or the flow; click to pin.'
                : 'The 3 strongest region pairs are coloured like their link lines. Hover a region in the 3D view, the matrix or the flow; click to pin.';
        }
        if (sel.side === 'q') {
            const row = s.C[sel.a];
            const best = row.indexOf(Math.max(...row)), worst = row.indexOf(Math.min(...row));
            return `Query R${sel.a} (${s.qCount[sel.a]} pts): ${pct(s.rows[sel.a], s.score)} of the similarity in total. ` +
                `Strongest partner Retrieved R${best} (${pct(row[best], s.score)}); ${row[worst] < 0 ? 'most negative' : 'weakest'} R${worst} (${pct(row[worst], s.score)}). ` +
                `Submap coloured by contribution with R${sel.a}${pinnedNote}.`;
        }
        if (sel.side === 'r') {
            const col = s.C.map(r => r[sel.b]);
            const best = col.indexOf(Math.max(...col)), worst = col.indexOf(Math.min(...col));
            return `Retrieved R${sel.b} (${s.rCount[sel.b]} pts): ${pct(s.cols[sel.b], s.score)} of the similarity in total. ` +
                `Strongest partner Query R${best} (${pct(col[best], s.score)}); ${col[worst] < 0 ? 'most negative' : 'weakest'} R${worst} (${pct(col[worst], s.score)}). ` +
                `Query coloured by contribution with R${sel.b}${pinnedNote}.`;
        }
        const v = s.C[sel.a][sel.b];
        return `Query R${sel.a} ↔ Retrieved R${sel.b}: ${pct(v, s.score)} of the similarity ` +
            `(rank ${s.rank.get(sel.a * 1000 + sel.b)} of ${s.ranked.length}; even share ${(100 / s.ranked.length).toFixed(2)}%)${pinnedNote}.`;
    }

    // ---------- canvas helpers ----------
    function sizedCanvas(canvas, w, h) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }
    const css = rgb => `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;
    const roundRect = (ctx, x, y, w, h, r) => {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    };

    // ---------- 1. contribution matrix ----------
    const M = { left: 34, top: 38, gap: 1, barW: 64, barH: 44 };
    let matrixGeom = null;

    function drawMatrix(sd) {
        const canvas = document.getElementById('ra-matrix');
        const wrap = canvas.parentElement;
        const s = stats(sd), nq = s.C.length, nr = s.C[0].length;
        const cell = Math.max(10, Math.min(22, Math.floor((wrap.clientWidth - M.left - M.barW - 12) / nr)));
        const gw = nr * cell, gh = nq * cell;
        const W = M.left + gw + 8 + M.barW, H = M.top + gh + 6 + M.barH + 16;
        const ctx = sizedCanvas(canvas, W, H);
        matrixGeom = { cell, gw, gh, nq, nr, W, H };
        ctx.fillStyle = SURFACE; ctx.fillRect(0, 0, W, H);
        ctx.font = '10px Inter, sans-serif'; ctx.textBaseline = 'middle';

        // axis titles + ticks
        ctx.fillStyle = INK2; ctx.textAlign = 'left';
        ctx.fillText('Retrieved region →', M.left, 9);
        ctx.textAlign = 'center';
        for (let b = 0; b < nr; b += (cell >= 16 ? 1 : 2)) ctx.fillText(String(b), M.left + b * cell + cell / 2, M.top - 8);
        ctx.textAlign = 'right';
        for (let a = 0; a < nq; a++) ctx.fillText(`Q${a}`, M.left - 5, M.top + a * cell + cell / 2);

        const sel = selection();
        // cells
        for (let a = 0; a < nq; a++) for (let b = 0; b < nr; b++) {
            ctx.fillStyle = css(diverging(s.C[a][b] / (s.maxAbs || 1), MID));
            ctx.fillRect(M.left + b * cell + M.gap, M.top + a * cell + M.gap, cell - 2 * M.gap, cell - 2 * M.gap);
        }
        // hovered row / column band
        if (sel && sel.side !== 'pair') {
            ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
            if (sel.side === 'q') ctx.strokeRect(M.left + 0.5, M.top + sel.a * cell + 0.5, gw - 1, cell - 1);
            else ctx.strokeRect(M.left + sel.b * cell + 0.5, M.top + 0.5, cell - 1, gh - 1);
        }
        // top-3 pairs outlined in their pair colour, numbered
        sd.region_pairs.slice(0, REGION_PAIR_COLORS.length).forEach(([a, b], k) => {
            const x = M.left + b * cell, y = M.top + a * cell;
            ctx.strokeStyle = REGION_PAIR_COLORS[k]; ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
            if (cell >= 14) { ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.fillText(String(k + 1), x + cell / 2, y + cell / 2 + 0.5); }
        });
        if (sel && sel.side === 'pair') {
            ctx.strokeStyle = INK; ctx.lineWidth = 2;
            ctx.strokeRect(M.left + sel.b * cell - 1, M.top + sel.a * cell - 1, cell + 2, cell + 2);
        }

        // row totals (bars to the right) and column totals (bars below), signed
        const rx0 = M.left + gw + 8;
        const rowScale = (M.barW - 6) / (Math.max(...s.rows.map(Math.abs)) || 1);
        s.rows.forEach((v, a) => {
            const len = Math.max(1, Math.abs(v) * rowScale);
            ctx.fillStyle = v >= 0 ? (sel && sel.side === 'q' && sel.a === a ? INK : INK2) : NEG_HEX;
            roundRect(ctx, rx0, M.top + a * cell + 3, len, cell - 6, 2); ctx.fill();
        });
        const cy0 = M.top + gh + 6;
        const colScale = (M.barH - 4) / (Math.max(...s.cols.map(Math.abs)) || 1);
        s.cols.forEach((v, b) => {
            const len = Math.max(1, Math.abs(v) * colScale);
            ctx.fillStyle = v >= 0 ? (sel && sel.side === 'r' && sel.b === b ? INK : INK2) : NEG_HEX;
            roundRect(ctx, M.left + b * cell + 3, cy0, cell - 6, len, 2); ctx.fill();
        });
        ctx.fillStyle = MUTED; ctx.textAlign = 'left'; ctx.font = '9px Inter, sans-serif';
        ctx.fillText('row total', rx0, M.top - 8);
        ctx.fillText('column total ↓', M.left, H - 7);

        // scale legend
        const lg = document.getElementById('ra-matrix-scale');
        if (lg) lg.textContent = `Cell = share of the similarity. Blue −${pct(s.maxAbs, s.score)} … grey 0 … red +${pct(s.maxAbs, s.score)}. ` +
            `Outlined: top 3 pairs. ${s.ranked.filter(p => p.v < 0).length} of ${s.ranked.length} pairs are negative.`;
    }

    function matrixHit(ev) {
        if (!matrixGeom) return null;
        const r = ev.target.getBoundingClientRect();
        const x = ev.clientX - r.left, y = ev.clientY - r.top;
        const { cell, gw, gh, nq, nr } = matrixGeom;
        const b = Math.floor((x - M.left) / cell), a = Math.floor((y - M.top) / cell);
        const inCols = b >= 0 && b < nr, inRows = a >= 0 && a < nq;
        if (inCols && inRows) return { side: 'pair', a, b };
        if (inRows && (x < M.left || x > M.left + gw)) return { side: 'q', a };
        if (inCols && (y < M.top || y > M.top + gh)) return { side: 'r', b };
        return null;
    }

    // ---------- 2. cumulative share ----------
    let cumGeom = null;
    function drawCumulative() {
        const svg = document.getElementById('ra-cumulative');
        const W = Math.max(260, svg.parentElement.clientWidth), H = 220;
        const pad = { l: 44, r: 52, t: 14, b: 30 };
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
        const steps = [1, 2, 3].map(k => currentQuery.steps[String(k)]).filter(hasMatrix);
        const series = steps.map(sd => stats(sd).cumulative.map(v => v * 100));
        const n = series.length ? series[0].length : 1;
        let yMax = 100, yMin = 0;
        series.forEach(c => c.forEach(v => { yMax = Math.max(yMax, v); yMin = Math.min(yMin, v); }));
        yMax = Math.ceil(yMax / 10) * 10;
        const X = i => pad.l + Math.log(i) / Math.log(n) * (W - pad.l - pad.r);        // rank 1..n, log
        const Y = v => pad.t + (yMax - v) / (yMax - yMin) * (H - pad.t - pad.b);
        cumGeom = { X, Y, n, pad, W, H, series };
        const el = (tag, attrs, text) => {
            const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
            if (text != null) e.textContent = text;
            svg.appendChild(e); return e;
        };
        svg.replaceChildren();
        el('rect', { x: 0, y: 0, width: W, height: H, fill: SURFACE, rx: 6 });
        for (let v = 0; v <= yMax; v += yMax > 100 ? 50 : 25) {
            el('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: GRID, 'stroke-width': 1, 'stroke-dasharray': v === 100 ? '4 3' : '' });
            el('text', { x: pad.l - 6, y: Y(v) + 3, fill: MUTED, 'font-size': 10, 'text-anchor': 'end' }, `${v}%`);
        }
        [1, 3, 10, 30, 100, n].forEach(i => {
            if (i > n) return;
            el('text', { x: X(i), y: H - pad.b + 14, fill: MUTED, 'font-size': 10, 'text-anchor': 'middle' }, String(i));
        });
        el('text', { x: (pad.l + W - pad.r) / 2, y: H - 3, fill: MUTED, 'font-size': 10, 'text-anchor': 'middle' }, 'top N region pairs (log scale)');
        steps.forEach((sd, idx) => {
            const k = [1, 2, 3].find(j => currentQuery.steps[String(j)] === sd);
            const c = series[idx];
            const d = c.map((v, i) => `${i ? 'L' : 'M'}${X(i + 1).toFixed(1)},${Y(v).toFixed(1)}`).join('');
            const active = k === currentStep;
            el('path', { d, fill: 'none', stroke: STEP_COLORS[k - 1], 'stroke-width': active ? 2.5 : 1.5, opacity: active ? 1 : 0.6, 'stroke-linejoin': 'round' });
            el('text', { x: W - pad.r + 6, y: Y(c[c.length - 1]) + 3 + (idx - 1) * 11, fill: INK2, 'font-size': 10 }, `Step ${k}`);
            if (active) {
                const i50 = c.findIndex(v => v >= 50);
                el('circle', { cx: X(3), cy: Y(c[2]), r: 4, fill: STEP_COLORS[k - 1], stroke: SURFACE, 'stroke-width': 2 });
                el('text', { x: X(3) + 7, y: Y(c[2]) - 6, fill: INK, 'font-size': 10 }, `top 3: ${c[2].toFixed(1)}%`);
                if (i50 >= 0) {
                    el('circle', { cx: X(i50 + 1), cy: Y(c[i50]), r: 4, fill: STEP_COLORS[k - 1], stroke: SURFACE, 'stroke-width': 2 });
                    el('text', { x: X(i50 + 1) - 7, y: Y(c[i50]) - 7, fill: INK, 'font-size': 10, 'text-anchor': 'end' }, `50% needs ${i50 + 1} pairs`);
                }
            }
        });
        el('line', { id: 'ra-cum-cross', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, stroke: INK2, 'stroke-width': 1, visibility: 'hidden' });
        const legend = document.getElementById('ra-cum-legend');
        if (legend) {
            legend.replaceChildren(...steps.map(sd => {
                const k = [1, 2, 3].find(j => currentQuery.steps[String(j)] === sd);
                const item = document.createElement('span'); item.className = 'ra-legend-item';
                const sw = document.createElement('span'); sw.className = 'ra-swatch-line'; sw.style.background = STEP_COLORS[k - 1];
                item.append(sw, document.createTextNode(`Step ${k}${k === currentStep ? ' (active)' : ''}`));
                return item;
            }));
        }
    }

    function cumulativeHover(ev) {
        const tip = document.getElementById('ra-cum-tip'), cross = document.getElementById('ra-cum-cross');
        if (!cumGeom || !tip || !cross) return;
        const svg = ev.currentTarget, r = svg.getBoundingClientRect();
        const x = (ev.clientX - r.left) * (cumGeom.W / r.width);
        const { pad, W, n } = cumGeom;
        if (x < pad.l || x > W - pad.r) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); return; }
        const i = Math.max(1, Math.min(n, Math.round(Math.exp((x - pad.l) / (W - pad.l - pad.r) * Math.log(n)))));
        const xi = cumGeom.X(i);
        cross.setAttribute('x1', xi); cross.setAttribute('x2', xi); cross.setAttribute('visibility', 'visible');
        tip.hidden = false;
        tip.textContent = `Top ${i} pair${i > 1 ? 's' : ''}: ` + cumGeom.series.map((c, idx) => `Step ${idx + 1} ${c[i - 1].toFixed(1)}%`).join(' · ');
        tip.style.left = `${Math.min(r.width - 10, Math.max(10, xi * r.width / W))}px`;
    }

    // ---------- 3. flow (top pairs) ----------
    const FLOW_PAIRS = 12;
    function drawFlow(sd) {
        const svg = document.getElementById('ra-flow');
        const s = stats(sd);
        const W = Math.max(260, svg.parentElement.clientWidth), H = 260;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
        svg.replaceChildren();
        const el = (tag, attrs, text, parent = svg) => {
            const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
            if (text != null) e.textContent = text;
            parent.appendChild(e); return e;
        };
        el('rect', { x: 0, y: 0, width: W, height: H, fill: SURFACE, rx: 6 });
        const pairs = s.ranked.slice(0, FLOW_PAIRS);
        const qs = [...new Set(pairs.map(p => p.a))].sort((x, y) => s.rows[y] - s.rows[x]);
        const rs = [...new Set(pairs.map(p => p.b))].sort((x, y) => s.cols[y] - s.cols[x]);
        const total = pairs.reduce((t, p) => t + p.v, 0);
        const top = 26, bot = 12, gap = 5, nodeW = 10, x0 = 64, x1 = W - 64;
        const usable = H - top - bot;
        const scale = (usable - gap * (Math.max(qs.length, rs.length) - 1)) / total;
        const layout = (nodes, key) => {
            const pos = new Map(); let y = top;
            nodes.forEach(n => {
                const h = pairs.filter(p => p[key] === n).reduce((t, p) => t + p.v, 0) * scale;
                pos.set(n, { y, h, off: 0 }); y += h + gap;
            });
            return pos;
        };
        const qPos = layout(qs, 'a'), rPos = layout(rs, 'b');
        el('text', { x: x0, y: 14, fill: MUTED, 'font-size': 10, 'text-anchor': 'middle' }, 'Query');
        el('text', { x: x1, y: 14, fill: MUTED, 'font-size': 10, 'text-anchor': 'middle' }, 'Retrieved');
        const sel = selection();
        pairs.forEach(p => {
            const qn = qPos.get(p.a), rn = rPos.get(p.b), h = p.v * scale;
            const ya = qn.y + qn.off + h / 2, yb = rn.y + rn.off + h / 2;
            qn.off += h; rn.off += h;
            const k = topPairIndex(sd, p.a, p.b);
            const isSel = sel && ((sel.side === 'pair' && sel.a === p.a && sel.b === p.b) ||
                (sel.side === 'q' && sel.a === p.a) || (sel.side === 'r' && sel.b === p.b));
            const color = k >= 0 ? REGION_PAIR_COLORS[k] : INK2;
            const xm = (x0 + x1) / 2;
            const path = el('path', {
                d: `M${x0 + nodeW / 2},${ya} C${xm},${ya} ${xm},${yb} ${x1 - nodeW / 2},${yb}`,
                fill: 'none', stroke: color, 'stroke-width': Math.max(1.5, h - 1),
                opacity: sel ? (isSel ? 0.95 : 0.15) : (k >= 0 ? 0.85 : 0.35), 'data-a': p.a, 'data-b': p.b, class: 'ra-flow-band',
            });
            el('title', {}, `Query R${p.a} ↔ Retrieved R${p.b}: ${pct(p.v, s.score)}`, path);
        });
        const node = (pos, side, x) => pos.forEach((n, id) => {
            const r = el('rect', { x: x - nodeW / 2, y: n.y, width: nodeW, height: Math.max(2, n.h), rx: 2, fill: INK2, class: 'ra-flow-node', [`data-${side}`]: id });
            el('title', {}, `${side === 'a' ? 'Query' : 'Retrieved'} R${id}: ${pct(side === 'a' ? s.rows[id] : s.cols[id], s.score)} in total`, r);
            el('text', { x: side === 'a' ? x - nodeW : x + nodeW, y: n.y + n.h / 2 + 3, fill: INK, 'font-size': 10, 'text-anchor': side === 'a' ? 'end' : 'start' },
                `R${id}`);
        });
        node(qPos, 'a', x0); node(rPos, 'b', x1);
        const note = document.getElementById('ra-flow-note');
        if (note) note.textContent = `Top ${FLOW_PAIRS} pairs carry ${pct(total, s.score)} of the similarity; band width ∝ share.`;
    }

    // ---------- 4. pair close-ups ----------
    function drawCloseups(sd) {
        const host = document.getElementById('ra-closeups');
        const s = stats(sd);
        const qM = queryPointsMeters(currentQuery);
        const rM = sd.pc_local.map(p => [p[0] * DB_PC_SCALE, p[1] * DB_PC_SCALE, p[2] * DB_PC_SCALE]);
        const rows = sd.region_pairs.slice(0, REGION_PAIR_COLORS.length).map((p, k) => ({ a: p[0], b: p[1], k }));
        const sel = state.pinned && state.pinned.side === 'pair' ? state.pinned : null;
        if (sel && topPairIndex(sd, sel.a, sel.b) < 0) rows.push({ a: sel.a, b: sel.b, k: -1 });
        host.replaceChildren();
        const size = 150;
        rows.forEach(({ a, b, k }) => {
            const color = k >= 0 ? REGION_PAIR_COLORS[k] : 'rgb(140, 242, 255)';
            const row = document.createElement('div'); row.className = 'ra-closeup-row';
            const head = document.createElement('div'); head.className = 'ra-closeup-head';
            const sw = document.createElement('span'); sw.className = 'ra-swatch-line'; sw.style.background = color;
            head.append(sw, document.createTextNode(
                `${k >= 0 ? `${k + 1}.` : 'Pinned:'} Query R${a} ↔ Retrieved R${b} · ${pct(s.C[a][b], s.score)}`));
            row.appendChild(head);
            // shared metres-per-pixel within the row so the two regions compare in size
            const ext = (pts, ids, id) => {
                const sel = pts.filter((_, i) => ids[i] === id);
                const mn = [0, 1, 2].map(j => Math.min(...sel.map(p => p[j]))), mx = [0, 1, 2].map(j => Math.max(...sel.map(p => p[j])));
                return { sel, mn, mx, c: [0, 1].map(j => (mn[j] + mx[j]) / 2) };
            };
            const eq = ext(qM, sd.query_region_ids, a), er = ext(rM, sd.region_ids, b);
            const half = Math.max(8, ...[eq, er].map(e => Math.max(e.mx[0] - e.mn[0], e.mx[1] - e.mn[1]) / 2 * 1.25));
            const pair = document.createElement('div'); pair.className = 'ra-closeup-pair';
            [[eq, qM, sd.query_region_ids, a, 'Query'], [er, rM, sd.region_ids, b, 'Retrieved']].forEach(([e, pts, ids, id, label]) => {
                const fig = document.createElement('figure'); fig.className = 'ra-closeup';
                const cv = document.createElement('canvas');
                const H = size + 48;
                const ctx = sizedCanvas(cv, size, H);
                ctx.fillStyle = SURFACE; roundRect(ctx, 0, 0, size, H, 6); ctx.fill();
                const sx = v => size / 2 + (v - e.c[0]) / half * (size / 2 - 6);
                const sy = v => size / 2 - (v - e.c[1]) / half * (size / 2 - 6);
                const zMin = Math.min(...pts.map(p => p[2])), zMax = Math.max(...pts.map(p => p[2]));
                const rgb = hexRgb(color.startsWith('#') ? color : '#8cf2ff');
                // top-down: surrounding points dim, region points in pair colour (shaded by height)
                pts.forEach((p, i) => {
                    const x = sx(p[0]), y = sy(p[1]);
                    if (x < 0 || x > size || y < 0 || y > size) return;
                    const h = zMax > zMin ? (p[2] - zMin) / (zMax - zMin) : 0.5;
                    if (ids[i] === id) { const f = 0.45 + 0.55 * h; ctx.fillStyle = css(rgb.map(c => c * f)); ctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
                    else { const g = 0.18 + 0.3 * h; ctx.fillStyle = css([g, g, g]); ctx.fillRect(x - 1, y - 1, 2, 2); }
                });
                // side view (x vs height) of the region only, same horizontal scale
                const sideTop = size + 4, sideH = 38;
                ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(4, sideTop + sideH); ctx.lineTo(size - 4, sideTop + sideH); ctx.stroke();
                const zr = Math.max(1, e.mx[2] - e.mn[2]);
                const zs = Math.min((sideH - 2) / zr, (size / 2 - 6) / half);
                e.sel.forEach(p => {
                    const h = (p[2] - e.mn[2]) / zr;
                    const f = 0.45 + 0.55 * h; ctx.fillStyle = css(rgb.map(c => c * f));
                    ctx.fillRect(sx(p[0]) - 1, sideTop + sideH - (p[2] - e.mn[2]) * zs - 1, 2, 2);
                });
                // 10 m scale bar
                const bar = 10 / half * (size / 2 - 6);
                ctx.fillStyle = INK2; ctx.fillRect(size - 8 - bar, size - 10, bar, 2);
                ctx.font = '9px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.fillText('10 m', size - 8, size - 15);
                const cap = document.createElement('figcaption');
                cap.textContent = `${label} R${id} · ${e.sel.length} pts · ${(e.mx[0] - e.mn[0]).toFixed(0)}×${(e.mx[1] - e.mn[1]).toFixed(0)} m · ${(e.mx[2] - e.mn[2]).toFixed(1)} m tall`;
                fig.append(cv, cap);
                pair.appendChild(fig);
            });
            row.appendChild(pair);
            host.appendChild(row);
        });
    }

    // ---------- 5. correspondence table (full overview, no hovering needed) ----------
    // One row per region (query or retrieved, sorted by total share). Each row shows a thumbnail
    // of the whole cloud with that region highlighted, its total share, its 3 strongest partners
    // (thumbnail of the other cloud with the partner highlighted) and its most negative partner.
    const THUMB = 64, CORR_PARTNERS = 3;
    const SELECT_HEX = '#8cf2ff';
    const thumbCache = new Map(); // key -> { bg: canvas, proj, pts }

    function cloudThumbBase(key, pts) {
        if (thumbCache.has(key)) return thumbCache.get(key);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        pts.forEach(p => {
            x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
            z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
        });
        const span = Math.max(x1 - x0, y1 - y0) || 1, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const dpr = window.devicePixelRatio || 1;
        const proj = pts.map(p => [
            (THUMB / 2 + (p[0] - cx) / span * (THUMB - 6)) * dpr,
            (THUMB / 2 - (p[1] - cy) / span * (THUMB - 6)) * dpr,
            z1 > z0 ? (p[2] - z0) / (z1 - z0) : 0.5]);
        const bg = document.createElement('canvas');
        bg.width = bg.height = Math.round(THUMB * dpr);
        const ctx = bg.getContext('2d');
        ctx.fillStyle = SURFACE; roundRect(ctx, 0, 0, bg.width, bg.height, 4 * dpr); ctx.fill();
        proj.forEach(([x, y, h]) => { const g = 0.16 + 0.26 * h; ctx.fillStyle = css([g, g, g]); ctx.fillRect(x - dpr / 2, y - dpr / 2, dpr, dpr); });
        const out = { bg, proj, dpr };
        thumbCache.set(key, out);
        return out;
    }

    function regionThumb(base, ids, id, hex) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = base.bg.width;
        cv.style.width = cv.style.height = `${THUMB}px`;
        const ctx = cv.getContext('2d');
        ctx.drawImage(base.bg, 0, 0);
        const rgb = hexRgb(hex), d = base.dpr;
        base.proj.forEach(([x, y, h], i) => {
            if (ids[i] !== id) return;
            const f = 0.55 + 0.45 * h; ctx.fillStyle = css(rgb.map(c => c * f));
            ctx.fillRect(x - d, y - d, 2 * d, 2 * d);
        });
        return cv;
    }

    function shareBar(v, maxAbs) {
        const bar = document.createElement('div'); bar.className = 'ra-corr-bar';
        const fill = document.createElement('span');
        const w = Math.min(50, Math.abs(v) / (maxAbs || 1) * 50);
        fill.style.width = `${w}%`; fill.style.left = v >= 0 ? '50%' : `${50 - w}%`;
        fill.style.background = v >= 0 ? POS_HEX : NEG_HEX;
        bar.appendChild(fill);
        return bar;
    }

    function drawCorrespondence(sd) {
        const head = document.getElementById('ra-corr-head'), body = document.getElementById('ra-corr-body');
        if (!head || !body) return;
        const s = stats(sd), dir = state.corrDir;
        const tag = `${currentQuery.query_idx}:${currentStep}`;
        const qBase = cloudThumbBase(`q:${currentQuery.query_idx}`, queryPointsMeters(currentQuery));
        const rBase = cloudThumbBase(`r:${tag}`, sd.pc_local);
        const me = dir === 'q'
            ? { name: 'Query', base: qBase, ids: sd.query_region_ids, totals: s.rows, count: s.qCount, maxTot: s.maxAbsRow }
            : { name: 'Retrieved', base: rBase, ids: sd.region_ids, totals: s.cols, count: s.rCount, maxTot: s.maxAbsCol };
        const other = dir === 'q'
            ? { name: 'Retrieved', base: rBase, ids: sd.region_ids }
            : { name: 'Query', base: qBase, ids: sd.query_region_ids };
        const nOther = dir === 'q' ? s.C[0].length : s.C.length;
        const val = (i, j) => (dir === 'q' ? s.C[i][j] : s.C[j][i]);
        const pairSel = (i, j) => (dir === 'q' ? { side: 'pair', a: i, b: j } : { side: 'pair', a: j, b: i });
        const regionSel = i => (dir === 'q' ? { side: 'q', a: i } : { side: 'r', b: i });

        const th = ['Rank', `${me.name} region`, 'Total share', 'Best match', '2nd', '3rd', 'Most negative partner'];
        const htr = document.createElement('tr');
        th.forEach(t => { const e = document.createElement('th'); e.textContent = t; htr.appendChild(e); });
        head.replaceChildren(htr);

        const order = me.totals.map((v, i) => i).sort((x, y) => me.totals[y] - me.totals[x]);
        const pairColor = (i, j) => {
            const k = dir === 'q' ? topPairIndex(sd, i, j) : topPairIndex(sd, j, i);
            return k >= 0 ? REGION_PAIR_COLORS[k] : null;
        };
        const rows = order.map((i, rank) => {
            const tr = document.createElement('tr');
            tr.dataset.region = i;
            const td = (...kids) => { const c = document.createElement('td'); c.append(...kids); tr.appendChild(c); return c; };
            const meta = (...lines) => {
                const m = document.createElement('div'); m.className = 'ra-corr-meta';
                lines.forEach(([txt, cls]) => { const e = document.createElement('span'); e.className = cls; e.textContent = txt; m.appendChild(e); });
                return m;
            };
            td(String(rank + 1));
            const own = document.createElement('div'); own.className = 'ra-corr-cell';
            own.append(regionThumb(me.base, me.ids, i, SELECT_HEX), meta([`R${i}`, 'ra-corr-id'], [`${me.count[i]} pts`, 'ra-corr-dim']));
            td(own);
            td(meta([pct(me.totals[i], s.score), 'ra-corr-id'], ['', 'ra-corr-dim'])).firstChild.lastChild.replaceWith(shareBar(me.totals[i], me.maxTot));
            const partners = Array.from({ length: nOther }, (_, j) => j).sort((x, y) => val(i, y) - val(i, x));
            partners.slice(0, CORR_PARTNERS).forEach(j => {
                const v = val(i, j), pc = pairColor(i, j);
                const cell = document.createElement('div'); cell.className = 'ra-corr-cell';
                cell.dataset.partner = j;
                const rk = s.rank.get(dir === 'q' ? i * 1000 + j : j * 1000 + i);
                const tagLine = pc ? `top pair ${topPairIndex(sd, ...(dir === 'q' ? [i, j] : [j, i])) + 1}` : `rank ${rk} / ${s.ranked.length}`;
                const m = meta([`R${j} · ${pct(v, s.score)}`, 'ra-corr-id'], [tagLine, 'ra-corr-dim']);
                m.appendChild(shareBar(v, s.maxAbs));
                cell.append(regionThumb(other.base, other.ids, j, pc || (v >= 0 ? POS_HEX : NEG_HEX)), m);
                td(cell);
            });
            const worst = partners[partners.length - 1], wv = val(i, worst);
            td(meta([wv < 0 ? `R${worst} · ${pct(wv, s.score)}` : 'none (all ≥ 0)', wv < 0 ? '' : 'ra-corr-dim'],
                [wv < 0 ? `${partners.filter(j => val(i, j) < 0).length} negative partners` : '', 'ra-corr-dim']));
            tr.addEventListener('mouseenter', () => setHover(regionSel(i)));
            tr.addEventListener('click', ev => {
                const c = ev.target.closest('.ra-corr-cell[data-partner]');
                togglePin(c ? pairSel(i, +c.dataset.partner) : regionSel(i));
            });
            tr.querySelectorAll('.ra-corr-cell[data-partner]').forEach(c => {
                c.addEventListener('mouseenter', () => setHover(pairSel(i, +c.dataset.partner)));
                c.addEventListener('mouseleave', () => setHover(regionSel(i)));
            });
            return tr;
        });
        body.replaceChildren(...rows);
        const wrap = body.closest('.ra-corr-wrap');
        if (wrap && !wrap._raBound) { wrap._raBound = true; wrap.addEventListener('mouseleave', () => setHover(null)); }
        const note = document.getElementById('ra-corr-note');
        if (note) note.textContent = `${me.name} regions sorted by total share of the similarity. Thumbnails are top-down views of the whole cloud: ` +
            `the row's region in cyan, each partner in its top-pair colour or red (raises the score) / blue (lowers it). ` +
            `Partner bars share one scale (largest single pair = full half). Hover a row or partner to highlight it in 3D; click to pin.`;
        markCorrespondence();
    }

    function markCorrespondence() {
        const body = document.getElementById('ra-corr-body');
        if (!body) return;
        const hit = (sel, i) => sel && ((state.corrDir === 'q' && (sel.side === 'q' || sel.side === 'pair') && sel.a === i) ||
            (state.corrDir === 'r' && (sel.side === 'r' || sel.side === 'pair') && sel.b === i));
        body.querySelectorAll('tr').forEach(tr => {
            const i = +tr.dataset.region;
            tr.classList.toggle('ra-active', !!hit(state.hover, i));
            tr.classList.toggle('ra-pinned', !!hit(state.pinned, i));
        });
    }

    // ---------- table view ----------
    function drawTable(sd) {
        const body = document.getElementById('ra-table-body');
        if (!body) return;
        const s = stats(sd);
        body.replaceChildren(...s.ranked.slice(0, 20).map((p, i) => {
            const tr = document.createElement('tr');
            [i + 1, `Q R${p.a}`, `R R${p.b}`, pct(p.v, s.score), `${(s.cumulative[i] * 100).toFixed(1)}%`].forEach(v => {
                const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
            });
            return tr;
        }));
    }

    // ---------- refresh / render ----------
    function refreshInteractive() {
        const sd = activeStep();
        if (!isRegionView || !hasMatrix(sd)) return;
        if (global3dViewer && global3dViewer.setOverlayColors) {
            const c = colors(sd, queryPointsMeters(currentQuery), sd.pc_local);
            global3dViewer.setOverlayColors(c.q, c.r);
        }
        applyCardColors();
        updateLegend(sd);
        const ro = document.getElementById('ra-readout');
        if (ro) ro.textContent = readoutText(sd);
        drawMatrix(sd);
        drawFlow(sd);
        markCorrespondence();
    }

    function setHover(h) {
        const same = (x, y) => (!x && !y) || (x && y && x.side === y.side && x.a === y.a && x.b === y.b);
        if (same(h, state.hover)) return;
        state.hover = h;
        refreshInteractive();
    }

    function togglePin(h) {
        const same = state.pinned && h && state.pinned.side === h.side && state.pinned.a === h.a && state.pinned.b === h.b;
        state.pinned = same ? null : h;
        state.hover = null;
        refreshInteractive();
        const sd = activeStep();
        if (hasMatrix(sd)) drawCloseups(sd);
    }

    // From the 3D view: a picked point index on the query ('q') or retrieved ('r') cloud
    function hoverPoint(side, index) {
        const sd = activeStep();
        if (!isRegionView || !hasMatrix(sd)) return;
        if (side == null) { setHover(null); return; }
        setHover(side === 'q' ? { side: 'q', a: sd.query_region_ids[index] } : { side: 'r', b: sd.region_ids[index] });
    }
    function clickPoint(side, index) {
        const sd = activeStep();
        if (!isRegionView || !hasMatrix(sd) || side == null) return;
        togglePin(side === 'q' ? { side: 'q', a: sd.query_region_ids[index] } : { side: 'r', b: sd.region_ids[index] });
    }

    function render() {
        const panel = document.getElementById('region-analysis');
        if (!panel) return;
        const sd = activeStep();
        if (!isRegionView || !currentQuery) {
            panel.hidden = true; state.hover = state.pinned = null;
            return;
        }
        const key = `${currentQuery.query_idx}:${currentStep}`;
        if (key !== state.key) { state.key = key; state.pinned = null; state.hover = null; }
        panel.hidden = false;
        const stepLabel = document.getElementById('ra-step');
        if (stepLabel) stepLabel.textContent = `Query ${currentQuery.query_idx} · Step ${currentStep}`;
        if (!hasMatrix(sd)) {
            document.getElementById('ra-readout').textContent = readoutText(sd);
            return;
        }
        drawCumulative();
        drawCloseups(sd);
        drawTable(sd);
        drawCorrespondence(sd);
        refreshInteractive();
    }

    function init() {
        const matrix = document.getElementById('ra-matrix');
        if (matrix) {
            matrix.addEventListener('mousemove', ev => setHover(matrixHit(ev)));
            matrix.addEventListener('mouseleave', () => setHover(null));
            matrix.addEventListener('click', ev => { const h = matrixHit(ev); if (h) togglePin(h); });
        }
        const flow = document.getElementById('ra-flow');
        if (flow) {
            const hit = ev => {
                const t = ev.target;
                if (t.classList.contains('ra-flow-band')) return { side: 'pair', a: +t.dataset.a, b: +t.dataset.b };
                if (t.classList.contains('ra-flow-node')) return t.dataset.a != null ? { side: 'q', a: +t.dataset.a } : { side: 'r', b: +t.dataset.b };
                return null;
            };
            flow.addEventListener('mousemove', ev => setHover(hit(ev)));
            flow.addEventListener('mouseleave', () => setHover(null));
            flow.addEventListener('click', ev => { const h = hit(ev); if (h) togglePin(h); });
        }
        const cum = document.getElementById('ra-cumulative');
        if (cum) {
            cum.addEventListener('mousemove', cumulativeHover);
            cum.addEventListener('mouseleave', () => {
                const tip = document.getElementById('ra-cum-tip'), cross = document.getElementById('ra-cum-cross');
                if (tip) tip.hidden = true; if (cross) cross.setAttribute('visibility', 'hidden');
            });
        }
        document.querySelectorAll('.ra-corr-btn').forEach(btn => btn.addEventListener('click', () => {
            state.corrDir = btn.dataset.dir;
            document.querySelectorAll('.ra-corr-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
            const sd = activeStep();
            if (hasMatrix(sd)) drawCorrespondence(sd);
        }));
        document.querySelectorAll('.ra-mode-btn[data-mode]').forEach(btn => btn.addEventListener('click', () => {
            state.mode = btn.dataset.mode;
            document.querySelectorAll('.ra-mode-btn[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
            refreshInteractive();
        }));
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { if (isRegionView) render(); }, 150);
        });
    }
    document.addEventListener('DOMContentLoaded', init);

    return { colors, sideColors, applyCardColors, render, hoverPoint, clickPoint };
})();
