// Region contribution analysis for same-modality retrieval (ground -> ground, aerial -> aerial),
// and the Aerial-to-Aerial Retrieval section. Data: docs/ground/regions_<idx>.json,
// docs/aerial/tile_<idx>.json and docs/aerial/summary.json (retrieval_regions.py).
//
// The evaluation ranks by Euclidean distance between unnormalised embeddings, so each pair stores
//   -1/2 ||q - r||^2 = sum_ab matrix[a][b] + sum_b penalty[b] + query_const
// matrix[a][b] = <u_a, v_b> (query region a x retrieved region b), penalty[b] = -1/2 <v_b, r>.

const RegionPairPanel = (() => {
    const SURFACE = '#111111';
    const PAIR = (typeof REGION_PAIR_COLORS !== 'undefined') ? REGION_PAIR_COLORS : ['#ffd400', '#ff7a00', '#ff2dd4'];
    const SELECT = '#8cf2ff';
    const NEG = [57, 135, 229], POS = [230, 103, 103];
    const Q_HEX = '#5aa9ff', R_HEX = '#d946ef';
    const NEAR_M = 30;

    const html = (tag, cls, text, parent) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    };
    const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const rgb = c => `rgb(${c.map(Math.round).join(',')})`;
    const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
    // signed t in [-1, 1] -> colour; mid is the neutral (point grey on dark, near-white in the matrix)
    const diverging = (t, mid) => mix(mid, t < 0 ? NEG : POS, Math.min(1, Math.pow(Math.abs(t), 0.6)));

    function create(host, opts) {
        const st = { rec: null, k: 0, hover: null, pinned: null };
        host.classList.add('rp');
        const tabs = html('div', 'rp-tabs', null, host);
        const readout = html('p', 'rp-readout', null, host);
        readout.setAttribute('aria-live', 'polite');
        const views = html('div', 'rp-views', null, host);
        const mk = (title, sub) => {
            const fig = html('figure', 'rp-view', null, views);
            const cap = html('figcaption', null, null, fig);
            html('b', null, title, cap); html('span', null, sub, cap);
            const cv = html('canvas', null, null, fig);
            return cv;
        };
        const CAP = {
            ground: ['ground scan, sensor frame', 'fitted into the query frame'],
            aerial: ['aerial tile, north up', 'at its true offset'],
            ground_aerial: ['ground scan, north up via GPS heading', 'aerial tile at its offset from the query GPS'],
        }[opts.kind];
        const cvQ = mk('Query', CAP[0]);
        const cvR = mk('Retrieved', CAP[1]);
        const cvO = mk('Overlay', 'strongest region pairs linked');
        const legend = html('div', 'rp-legend', null, host);
        const lower = html('div', 'rp-lower', null, host);
        const mWrap = html('div', 'rp-matrix', null, lower);
        const mHead = html('div', 'rp-sub', null, mWrap);
        const cvM = html('canvas', null, null, mWrap);
        const tip = html('div', 'rp-tip', null, mWrap); tip.hidden = true;
        const tWrap = html('div', 'rp-table-wrap', null, lower);
        const table = html('table', 'rp-table', null, tWrap);
        const note = html('p', 'rp-note', opts.note || '', host);
        void note;

        const pair = () => st.rec && st.rec.pairs[st.k];
        const sel = () => st.hover || st.pinned;

        function stats(p) {
            if (p._s) return p._s;
            const M = p.matrix, nq = M.length, nr = M[0].length;
            let sum = 0, posSum = 0, maxAbs = 0;
            M.forEach(r => r.forEach(v => { sum += v; if (v > 0) posSum += v; maxAbs = Math.max(maxAbs, Math.abs(v)); }));
            const rows = M.map(r => r.reduce((a, b) => a + b, 0));
            const cols = M[0].map((_, b) => M.reduce((a, r) => a + r[b], 0));
            const D = (a, b) => Math.hypot(st.rec.query_cent[a][0] - p.r_cent[b][0], st.rec.query_cent[a][1] - p.r_cent[b][1]);
            const ranked = [];
            M.forEach((r, a) => r.forEach((v, b) => ranked.push({ a, b, v, d: D(a, b) })));
            ranked.sort((x, y) => y.v - x.v);
            p._s = { M, nq, nr, sum, posSum, maxAbs, rows, cols, ranked, D };
            return p._s;
        }
        const topIndex = (a, b) => pair().top_pairs.slice(0, PAIR.length).findIndex(t => t[0] === a && t[1] === b);

        // region id -> colour (array) or null (grey), for one side
        function regionColour(side) {
            const p = pair(), s = stats(p), h = sel();
            if (h) {
                if (h.side === 'pair') {
                    const k = topIndex(h.a, h.b), c = hexRgb(k >= 0 ? PAIR[k] : SELECT);
                    const mine = side === 'q' ? h.a : h.b;
                    return id => (id === mine ? c : null);
                }
                if (h.side === side) { const c = hexRgb(SELECT); return id => (id === h.id ? c : null); }
                const vals = side === 'r' ? s.M[h.id] : s.M.map(r => r[h.id]);
                const m = Math.max(...vals.map(Math.abs)) || 1;
                return id => diverging(vals[id] / m, [105, 105, 100]);
            }
            const map = new Map();
            p.top_pairs.slice(0, PAIR.length).forEach((t, k) => {
                const id = side === 'q' ? t[0] : t[1];
                if (!map.has(id)) map.set(id, hexRgb(PAIR[k]));
            });
            return id => map.get(id) || null;
        }

        let view = null; // shared world window for the three canvases
        function computeView() {
            const p = pair();
            const pts = st.rec.query_pts.concat(p.r_pts);
            const xs = pts.map(v => v[0]).sort((a, b) => a - b), ys = pts.map(v => v[1]).sort((a, b) => a - b);
            const q = (arr, f) => arr[Math.floor(f * (arr.length - 1))];
            const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
            view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, half: Math.max(x1 - x0, y1 - y0) / 2 * 1.06 + 2 };
        }

        function setupCanvas(cv) {
            const size = Math.max(150, Math.min(320, Math.floor(cv.parentElement.clientWidth)));
            const dpr = window.devicePixelRatio || 1;
            if (cv.width !== Math.round(size * dpr)) { cv.width = cv.height = Math.round(size * dpr); cv.style.width = cv.style.height = `${size}px`; }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = SURFACE; ctx.fillRect(0, 0, size, size);
            const k = (size / 2 - 4) / view.half;
            return { ctx, size, X: x => size / 2 + (x - view.cx) * k, Y: y => size / 2 - (y - view.cy) * k, k };
        }

        function drawCloud(cv, pts, ids, side) {
            const g = setupCanvas(cv), col = regionColour(side);
            let zMin = Infinity, zMax = -Infinity;
            pts.forEach(p => { zMin = Math.min(zMin, p[2]); zMax = Math.max(zMax, p[2]); });
            const order = pts.map((_, i) => i).sort((a, b) => pts[a][2] - pts[b][2]);
            const cache = new Map();
            order.forEach(i => {
                const p = pts[i], h = zMax > zMin ? (p[2] - zMin) / (zMax - zMin) : 0.5;
                if (!cache.has(ids[i])) cache.set(ids[i], col(ids[i]));
                const c = cache.get(ids[i]);
                g.ctx.fillStyle = c ? rgb(c.map(v => v * (0.55 + 0.45 * h))) : rgb([1, 1, 1].map(() => 55 + 120 * h));
                g.ctx.fillRect(g.X(p[0]) - 1.2, g.Y(p[1]) - 1.2, 2.4, 2.4);
            });
            scaleBar(g);
            cv._g = g;
        }

        function scaleBar(g) {
            const m = view.half > 120 ? 50 : 20, bar = m * g.k;
            g.ctx.fillStyle = '#d4d4d4'; g.ctx.fillRect(g.size - 8 - bar, g.size - 10, bar, 2);
            g.ctx.font = '9px Inter, sans-serif'; g.ctx.textAlign = 'right';
            g.ctx.fillText(`${opts.kind !== 'aerial' ? '~' : ''}${m} m`, g.size - 8, g.size - 14);
        }

        function drawOverlay() {
            const p = pair(), s = stats(p), g = setupCanvas(cvO), ctx = g.ctx;
            ctx.globalAlpha = 0.45;
            const dots = (pts, c) => { ctx.fillStyle = c; pts.forEach(v => ctx.fillRect(g.X(v[0]) - 1, g.Y(v[1]) - 1, 2, 2)); };
            dots(st.rec.query_pts, Q_HEX); dots(p.r_pts, R_HEX);
            ctx.globalAlpha = 1;
            const h = sel();
            let links = p.top_pairs.slice(0, 5).map((t, k) => ({ a: t[0], b: t[1], v: t[2], col: k < PAIR.length ? PAIR[k] : '#e5e5e5' }));
            if (h && h.side === 'pair' && topIndex(h.a, h.b) < 0) links.push({ a: h.a, b: h.b, v: s.M[h.a][h.b], col: SELECT });
            if (h && h.side !== 'pair') {   // all partners of the hovered region, positive only
                links = (h.side === 'q' ? s.M[h.id].map((v, b) => ({ a: h.id, b, v })) : s.M.map((r, a) => ({ a, b: h.id, v: r[h.id] })))
                    .filter(l => l.v > 0).sort((x, y) => y.v - x.v).slice(0, 5).map(l => ({ ...l, col: SELECT }));
            }
            const vmax = Math.max(...links.map(l => Math.abs(l.v))) || 1;
            links.slice().reverse().forEach(l => {
                const qa = st.rec.query_cent[l.a], rb = p.r_cent[l.b];
                const on = !h || h.side !== 'pair' || (h.a === l.a && h.b === l.b);
                ctx.globalAlpha = on ? 1 : 0.25;
                ctx.strokeStyle = l.col; ctx.lineWidth = 1 + 3.5 * Math.abs(l.v) / vmax;
                ctx.beginPath(); ctx.moveTo(g.X(qa[0]), g.Y(qa[1])); ctx.lineTo(g.X(rb[0]), g.Y(rb[1])); ctx.stroke();
            });
            ctx.globalAlpha = 1;
            const ring = (c, col, fill) => {
                ctx.beginPath(); ctx.arc(g.X(c[0]), g.Y(c[1]), 4, 0, Math.PI * 2);
                ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke();
            };
            st.rec.query_cent.forEach(c => ring(c, Q_HEX, SURFACE));
            p.r_cent.forEach(c => ring(c, R_HEX, SURFACE));
            links.forEach(l => { ring(st.rec.query_cent[l.a], Q_HEX, l.col); ring(p.r_cent[l.b], R_HEX, l.col); });
            scaleBar(g);
            cvO._g = g;
        }

        function drawMatrix() {
            const p = pair(), s = stats(p);
            const W = Math.max(240, mWrap.clientWidth), L = 30, T = 18;
            const cell = Math.max(6, Math.min(s.nr > 12 ? 14 : 20, Math.floor((W - L - 6) / s.nr)));
            const H = T + cell * (s.nq + 1) + 8 + 16;
            const dpr = window.devicePixelRatio || 1;
            cvM.width = Math.round(W * dpr); cvM.height = Math.round(H * dpr); cvM.style.width = `${W}px`; cvM.style.height = `${H}px`;
            const ctx = cvM.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            const mid = [241, 245, 249], h = sel();
            const m = s.maxAbs || 1;
            ctx.font = '9px Inter, sans-serif'; ctx.fillStyle = '#475569';
            ctx.textAlign = 'left'; ctx.fillText('Retrieved region →', L, 10);
            for (let a = 0; a < s.nq; a++) {
                ctx.textAlign = 'right'; ctx.fillStyle = '#475569'; ctx.fillText(`Q${a}`, L - 4, T + a * cell + cell / 2 + 3);
                for (let b = 0; b < s.nr; b++) {
                    ctx.fillStyle = rgb(diverging(s.M[a][b] / m, mid));
                    ctx.fillRect(L + b * cell, T + a * cell, cell - 1, cell - 1);
                }
            }
            const py = T + s.nq * cell + 8;
            ctx.textAlign = 'right'; ctx.fillStyle = '#475569'; ctx.fillText('norm', L - 4, py + cell / 2 + 3);
            p.penalty.forEach((v, b) => { ctx.fillStyle = rgb(diverging(v / m, mid)); ctx.fillRect(L + b * cell, py, cell - 1, cell - 1); });
            if (cell >= 14) {
                ctx.textAlign = 'center'; ctx.fillStyle = '#475569';
                for (let b = 0; b < s.nr; b++) ctx.fillText(b, L + b * cell + cell / 2, py + cell + 11);
            }
            // top pairs outlined in pair colour, selection in dark ink
            p.top_pairs.slice(0, PAIR.length).forEach((t, k) => {
                ctx.strokeStyle = PAIR[k]; ctx.lineWidth = 2; ctx.strokeRect(L + t[1] * cell + 0.5, T + t[0] * cell + 0.5, cell - 2, cell - 2);
            });
            if (h) {
                ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.5;
                if (h.side === 'pair') ctx.strokeRect(L + h.b * cell - 0.5, T + h.a * cell - 0.5, cell, cell);
                else if (h.side === 'q') ctx.strokeRect(L - 0.5, T + h.id * cell - 0.5, s.nr * cell, cell);
                else ctx.strokeRect(L + h.id * cell - 0.5, T - 0.5, cell, s.nq * cell);
            }
            cvM._geo = { L, T, cell, nq: s.nq, nr: s.nr, py };
            mHead.innerHTML = `<b>Region-pair terms</b> ⟨u<sub>a</sub>, v<sub>b</sub>⟩ (${s.nq} × ${s.nr}), red raises similarity, blue lowers it. ` +
                `Bottom row: each retrieved region's share of −½‖r‖².`;
        }

        function drawTable() {
            const p = pair(), s = stats(p), h = sel();
            const rows = s.ranked.slice(0, 8);
            const geo = { ground: 'after fit', aerial: 'exact', ground_aerial: '±10–20 m' }[opts.kind];
            const geoOk = !opts.geoValid || opts.geoValid(st.rec);
            table.innerHTML = `<thead><tr><th>#</th><th>Pair</th><th>Term</th><th>Share of pair sum</th><th>Centroids apart <span>(${geo})</span></th></tr></thead>`;
            const body = html('tbody', null, null, table);
            rows.forEach((r, i) => {
                const tr = html('tr', null, null, body);
                const td0 = html('td', null, null, tr);
                const sw = html('span', 'rp-swatch', null, td0);
                sw.style.background = i < PAIR.length ? PAIR[i] : '#cbd5e1';
                td0.appendChild(document.createTextNode(` ${i + 1}`));
                html('td', null, `Q${r.a} ↔ R${r.b}`, tr);
                html('td', 'rp-num', r.v.toFixed(4), tr);
                html('td', 'rp-num', `${(r.v / s.sum * 100).toFixed(1)}%`, tr);
                const td = html('td', 'rp-num', geoOk ? `${r.d.toFixed(0)} m ` : '—', tr);
                if (geoOk) html('span', `rp-pill ${r.d <= NEAR_M ? 'rp-pill-near' : 'rp-pill-far'}`, r.d <= NEAR_M ? 'same place' : 'elsewhere', td);
                if (h && h.side === 'pair' && h.a === r.a && h.b === r.b) tr.classList.add('rp-active');
                tr.addEventListener('mouseenter', () => { st.hover = { side: 'pair', a: r.a, b: r.b }; redraw(false); });
                tr.addEventListener('mouseleave', () => { st.hover = null; redraw(false); });
                tr.addEventListener('click', () => { st.pinned = (st.pinned && st.pinned.side === 'pair' && st.pinned.a === r.a && st.pinned.b === r.b) ? null : { side: 'pair', a: r.a, b: r.b }; redraw(false); });
            });
        }

        function drawReadout() {
            const p = pair(), s = stats(p), sc = p.score, c = p.coloc;
            const top3 = s.ranked.slice(0, 3).reduce((a, r) => a + r.v, 0) / s.sum * 100;
            const h = sel();
            let focus = '';
            if (h && h.side === 'pair') focus = ` Selected: Q${h.a} ↔ R${h.b}, term ${s.M[h.a][h.b].toFixed(4)} (${(s.M[h.a][h.b] / s.sum * 100).toFixed(1)}% of the pair sum), centroids ${s.D(h.a, h.b).toFixed(0)} m apart.`;
            else if (h) focus = ` Selected: ${h.side === 'q' ? 'query' : 'retrieved'} region ${h.side === 'q' ? 'Q' : 'R'}${h.id}, total ${(h.side === 'q' ? s.rows[h.id] : s.cols[h.id]).toFixed(4)}; the other cloud is coloured by its terms with it.`;
            readout.innerHTML =
                `‖q − r‖ = <b>${p.emb_dist.toFixed(3)}</b> <span class="rp-dim">(evaluation run: ${p.eval_emb_dist.toFixed(3)})</span>. ` +
                `−½‖q − r‖² = ${sc.neg_half_d2.toFixed(3)} = pair terms <b>${sc.pairs.toFixed(3)}</b> ` +
                `${sc.penalty < 0 ? '−' : '+'} retrieved norm ${Math.abs(sc.penalty).toFixed(3)} ` +
                `${sc.query_const < 0 ? '−' : '+'} query norm ${Math.abs(sc.query_const).toFixed(3)} <span class="rp-dim">(same for every candidate)</span>. ` +
                `Top 3 pairs: ${top3.toFixed(0)}% of the pair terms. ` +
                (c ? `Pairs whose centroids are within ${NEAR_M} m carry <b>${(c.near_share * 100).toFixed(0)}%</b> of the positive terms, ` +
                     `while ${(c.near_chance * 100).toFixed(0)}% of all pairs are that close.` : 'No heading for this scan, so no distances.') + focus;
        }

        function drawTabs() {
            tabs.replaceChildren(...st.rec.pairs.map((p, i) => {
                const b = html('button', `rp-tab${i === st.k ? ' active' : ''}`, null);
                b.type = 'button';
                html('span', null, opts.tabLabel(p, i), b);
                html('i', `rp-dot ${p.correct ? 'ok' : 'bad'}`, null, b).title = p.correct ? 'within 100 m' : 'more than 100 m away';
                b.addEventListener('click', () => { st.k = i; st.hover = st.pinned = null; redraw(true); });
                return b;
            }));
        }

        function drawLegend() {
            const h = sel();
            legend.innerHTML = h && h.side !== 'pair'
                ? `<span><i style="background:${SELECT}"></i>selected region</span><span class="rp-grad"></span><span>other cloud: blue lowers, red raises similarity with it</span>`
                : `${PAIR.map((c, k) => `<span><i style="background:${c}"></i>pair ${k + 1}</span>`).join('')}` +
                  `<span><i style="background:${Q_HEX}"></i>query (overlay)</span><span><i style="background:${R_HEX}"></i>retrieved (overlay)</span>` +
                  `<span class="rp-dim">Hover a region or a matrix cell; click to pin.</span>`;
        }

        function redraw(full) {
            if (!pair()) return;
            if (full) { computeView(); drawTabs(); }
            const p = pair();
            drawCloud(cvQ, st.rec.query_pts, st.rec.query_ids, 'q');
            drawCloud(cvR, p.r_pts, p.r_ids, 'r');
            drawOverlay(); drawMatrix(); drawTable(); drawReadout(); drawLegend();
        }

        // ---------- interaction ----------
        function nearest(cv, ev, pts) {
            const g = cv._g; if (!g) return -1;
            const b = cv.getBoundingClientRect(), mx = ev.clientX - b.left, my = ev.clientY - b.top;
            let best = -1, bd = 64;
            pts.forEach((p, i) => { const d = (g.X(p[0]) - mx) ** 2 + (g.Y(p[1]) - my) ** 2; if (d < bd) { bd = d; best = i; } });
            return best;
        }
        const same = (a, b) => a && b && a.side === b.side && a.id === b.id && a.a === b.a && a.b === b.b;
        function bindCloud(cv, side) {
            const pick = ev => {
                const pts = side === 'q' ? st.rec.query_pts : pair().r_pts, ids = side === 'q' ? st.rec.query_ids : pair().r_ids;
                const i = nearest(cv, ev, pts);
                return i < 0 ? null : { side, id: ids[i] };
            };
            cv.addEventListener('mousemove', ev => { if (!pair()) return; const h = pick(ev); if (!same(h, st.hover)) { st.hover = h; redraw(false); } });
            cv.addEventListener('mouseleave', () => { if (st.hover) { st.hover = null; redraw(false); } });
            cv.addEventListener('click', ev => { if (!pair()) return; const h = pick(ev); st.pinned = same(h, st.pinned) ? null : h; redraw(false); });
        }
        bindCloud(cvQ, 'q'); bindCloud(cvR, 'r');
        const pickOverlay = ev => {
            const qi = nearest(cvO, ev, st.rec.query_cent), ri = nearest(cvO, ev, pair().r_cent);
            if (qi < 0 && ri < 0) return null;
            const g = cvO._g, b = cvO.getBoundingClientRect(), mx = ev.clientX - b.left, my = ev.clientY - b.top;
            const dist = (c) => (g.X(c[0]) - mx) ** 2 + (g.Y(c[1]) - my) ** 2;
            if (ri < 0 || (qi >= 0 && dist(st.rec.query_cent[qi]) <= dist(pair().r_cent[ri]))) return { side: 'q', id: qi };
            return { side: 'r', id: ri };
        };
        cvO.addEventListener('mousemove', ev => { if (!pair()) return; const h = pickOverlay(ev); if (!same(h, st.hover)) { st.hover = h; redraw(false); } });
        cvO.addEventListener('mouseleave', () => { if (st.hover) { st.hover = null; redraw(false); } });
        cvO.addEventListener('click', ev => { if (!pair()) return; const h = pickOverlay(ev); st.pinned = same(h, st.pinned) ? null : h; redraw(false); });

        const cellAt = ev => {
            const g = cvM._geo; if (!g) return null;
            const b = cvM.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top;
            const col = Math.floor((x - g.L) / g.cell);
            if (col < 0 || col >= g.nr) return null;
            const row = Math.floor((y - g.T) / g.cell);
            if (row >= 0 && row < g.nq) return { side: 'pair', a: row, b: col, x, y };
            if (y >= g.py && y < g.py + g.cell) return { side: 'r', id: col, x, y, norm: true };
            return null;
        };
        cvM.addEventListener('mousemove', ev => {
            if (!pair()) return;
            const c = cellAt(ev), s = stats(pair());
            if (!c) { tip.hidden = true; if (st.hover) { st.hover = null; redraw(false); } return; }
            tip.textContent = c.norm
                ? `R${c.id}: norm term ${pair().penalty[c.id].toFixed(4)} (its share of −½‖r‖²)`
                : `Q${c.a} × R${c.b}: ${s.M[c.a][c.b].toFixed(4)} (${(s.M[c.a][c.b] / s.sum * 100).toFixed(1)}% of pair sum), centroids ${s.D(c.a, c.b).toFixed(0)} m apart`;
            tip.hidden = false;
            tip.style.left = `${Math.min(Math.max(c.x, 90), mWrap.clientWidth - 90)}px`; tip.style.top = `${c.y + 30}px`;
            const h = c.norm ? { side: 'r', id: c.id } : { side: 'pair', a: c.a, b: c.b };
            if (!same(h, st.hover)) { st.hover = h; redraw(false); }
        });
        cvM.addEventListener('mouseleave', () => { tip.hidden = true; if (st.hover) { st.hover = null; redraw(false); } });
        cvM.addEventListener('click', ev => {
            const c = cellAt(ev); if (!c) return;
            const h = c.norm ? { side: 'r', id: c.id } : { side: 'pair', a: c.a, b: c.b };
            st.pinned = same(h, st.pinned) ? null : h; redraw(false);
        });

        return {
            show(rec) { st.rec = rec; st.k = Math.min(st.k, rec.pairs.length - 1); st.hover = st.pinned = null; redraw(true); },
            resize() { if (pair()) redraw(false); },
            message(text) { readout.textContent = text; },
        };
    }
    return { create };
})();


// ---------- shared data loading, both sections ----------
const SameSourceRegions = (() => {
    const NS = 'http://www.w3.org/2000/svg';
    const C = {
        aa: '#3987e5', gg: '#d95926', ga: '#199e70',   // categorical slots 1-3 (validated, light)
        ink: '#0f172a', ink2: '#475569', muted: '#94a3b8', grid: '#e2e8f0', surface: '#ffffff',
    };
    const el = (tag, attrs = {}, parent) => {
        const e = document.createElementNS(NS, tag);
        Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
        if (parent) parent.appendChild(e);
        return e;
    };
    const html = (tag, cls, text, parent) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    };
    const cache = new Map();
    const load = async url => {
        if (!cache.has(url)) cache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }));
        return cache.get(url);
    };
    let summary = null, meta = null, groundPanel = null, aerialPanel = null, aerialCurrent = null;
    const widthOf = svg => Math.max(280, svg.parentElement.clientWidth);
    function showTip(tip, svg, x, y, text) {
        tip.textContent = text; tip.hidden = false;
        const w = svg.parentElement.clientWidth;
        tip.style.left = `${Math.min(Math.max(x, 80), w - 80)}px`; tip.style.top = `${Math.max(0, y - 34)}px`;
    }

    // ---------- ground section: region panel ----------
    async function showGround(qi) {
        if (!groundPanel) return;
        try { groundPanel.show(await load(`ground/regions_${qi}.json`)); }
        catch (e) { groundPanel.message(`No region data for query ${qi} (run retrieval_regions.py).`); }
    }

    // ---------- aerial section ----------
    function drawTiles() {
        const a = summary.aerial, host = document.getElementById('aa-tiles');
        const tiles = [
            [`${a.twin_top1.toFixed(1)}%`, 'Twin tile ranked first', 'same tile, other 4096-point sample'],
            [`${a.r1_without_twin.toFixed(2)}%`, 'R@1 without the twin', `top-1 within 100 m (median ${a.median_positives} true neighbours)`],
            [`${a.median_top1_offset_without_twin.toFixed(0)} m`, 'Median top-1 offset', `without the twin · tiles every ~${a.tile_spacing_m.toFixed(0)} m`],
            [`${summary.ground.r1_pooled.toFixed(1)}% · ${summary.ground_aerial.r1.toFixed(1)}%`, 'For comparison: R@1', 'ground → pooled ground · ground → aerial'],
        ];
        host.replaceChildren(...tiles.map(([v, l, s]) => {
            const t = html('div', 'gg-tile');
            html('div', 'gg-tile-value', v, t); html('div', 'gg-tile-label', l, t); html('div', 'gg-tile-sub', s, t);
            return t;
        }));
    }

    function lineChart(svg, tip, series, opts) {
        const W = widthOf(svg), H = 220, L = 40, R = 14, T = 12, B = 30;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const X = v => L + (v - opts.x0) / (opts.x1 - opts.x0) * (W - L - R);
        const Y = v => T + (1 - (v - opts.y0) / (opts.y1 - opts.y0)) * (H - T - B);
        opts.yTicks.forEach(v => {
            el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: C.grid }, svg);
            el('text', { x: L - 5, y: Y(v) + 3, 'text-anchor': 'end', 'font-size': 10, fill: C.ink2 }, svg).textContent = opts.yFmt(v);
        });
        opts.xTicks.filter((v, i) => W >= 480 || i % 2 === 0).forEach(v =>
            el('text', { x: X(v), y: H - 12, 'text-anchor': 'middle', 'font-size': 10, fill: C.ink2 }, svg).textContent = opts.xFmt(v));
        el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: C.muted }, svg);
        if (opts.refY != null) el('line', { x1: L, x2: W - R, y1: Y(opts.refY), y2: Y(opts.refY), stroke: C.ink2, 'stroke-dasharray': '3 3' }, svg);
        series.forEach(s => {
            if (s.band) {
                const up = s.band.map(p => `${X(p[0])},${Y(p[2])}`), lo = s.band.slice().reverse().map(p => `${X(p[0])},${Y(p[1])}`);
                el('polygon', { points: up.concat(lo).join(' '), fill: s.color, opacity: 0.12 }, svg);
            }
            el('polyline', { points: s.pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash || 'none', 'stroke-linejoin': 'round' }, svg);
            const last = s.pts[s.pts.length - 1];
            if (opts.endLabels && W >= 480) el('text', { x: X(last[0]) + 6, y: Y(last[1]) + 3 + (s.dy || 0), 'font-size': 10.5, 'font-weight': 600, fill: s.color }, svg).textContent = s.label;
        });
        // hover: vertical crosshair, values of each series at nearest x
        const xs = series[0].pts.map(p => p[0]);
        const hl = el('line', { y1: T, y2: H - B, stroke: C.muted, visibility: 'hidden' }, svg);
        const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: C.surface, 'stroke-width': 2, visibility: 'hidden' }, svg));
        const hit = el('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' }, svg);
        hit.addEventListener('mousemove', ev => {
            const b = svg.getBoundingClientRect(), mx = ev.clientX - b.left;
            let i = 0; xs.forEach((x, k) => { if (Math.abs(X(x) - mx) < Math.abs(X(xs[i]) - mx)) i = k; });
            hl.setAttribute('x1', X(xs[i])); hl.setAttribute('x2', X(xs[i])); hl.setAttribute('visibility', 'visible');
            const parts = [];
            series.forEach((s, k) => {
                const p = s.pts.find(q => q[0] === xs[i]);
                if (!p) { dots[k].setAttribute('visibility', 'hidden'); return; }
                dots[k].setAttribute('cx', X(p[0])); dots[k].setAttribute('cy', Y(p[1])); dots[k].setAttribute('visibility', 'visible');
                parts.push(`${s.label} ${opts.yFmt(p[1], true)}`);
            });
            showTip(tip, svg, X(xs[i]), T + 10, `${opts.xFmt(xs[i], true)}: ${parts.join(' · ')}`);
        });
        hit.addEventListener('mouseleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); });
    }

    function legendHtml(items) {
        return items.map(([c, l, dash]) => `<span class="gg-legend-item"><span class="aa-swatch" style="border-color:${c};border-top-style:${dash ? 'dashed' : 'solid'}"></span>${l}</span>`).join('');
    }

    function drawCurves() {
        const cv = summary.curves, far = cv.aerial_aerial.far_m || 400;
        const ser = (key, color, label, dy) => {
            const bins = cv[key].bins.filter(b => b[2] != null);
            return { color, label, dy, pts: bins.map(b => [b[0] + 5, b[2]]), band: bins.map(b => [b[0] + 5, b[1], b[3]]) };
        };
        const series = [ser('aerial_aerial', C.aa, 'aerial → aerial'), ser('ground_ground', C.gg, 'ground → ground'), ser('ground_aerial', C.ga, 'ground → aerial')];
        const all = series.flatMap(s => s.band.flatMap(b => [b[1], b[2]]));
        const y0 = Math.floor(Math.min(...all) * 10) / 10, y1 = Math.max(1.05, Math.ceil(Math.max(...all) * 10) / 10);
        const yt = []; for (let v = y0; v <= y1 + 1e-9; v += 0.1) yt.push(Math.round(v * 10) / 10);
        lineChart(document.getElementById('aa-curve'), document.getElementById('aa-curve-tip'), series, {
            x0: 0, x1: 400, y0, y1, refY: 1, xTicks: [0, 50, 100, 150, 200, 250, 300, 350, 400], yTicks: yt,
            xFmt: (v, long) => long ? `${v - 5}–${v + 5} m apart` : `${v} m`, yFmt: (v, long) => long ? v.toFixed(2) : v.toFixed(1),
        });
        document.getElementById('aa-curve-legend').innerHTML = legendHtml(series.map(s => [s.color, s.label])) +
            `<span class="gg-legend-item"><span class="aa-swatch" style="border-color:${C.ink2};border-top-style:dashed"></span>pairs &gt;${far} m apart (= 1)</span>`;
        const at = (key, m) => { const b = cv[key].bins.find(x => x[0] === m); return b && b[2] != null ? b[2] : NaN; };
        document.getElementById('aa-curve-note').textContent =
            `Median descriptor distance at each offset, divided by the median for pairs more than ${far} m apart (band: middle 50%). ` +
            `At 0–10 m the aerial curve sits at ${at('aerial_aerial', 0).toFixed(2)} (this bin includes the twin tile), ground → ground at ${at('ground_ground', 0).toFixed(2)} ` +
            `and ground → aerial at ${at('ground_aerial', 0).toFixed(2)}. The aerial descriptor separates nearby from distant tiles far more strongly than either ground task.`;
    }

    function drawCdf() {
        const c = summary.top1_cdf;
        const ser = (key, color, label, dash, dy) => ({ color, label, dash, dy, pts: c[key].map(p => [p[0], p[1] * 100]) });
        const series = [ser('aerial_aerial_with_twin', C.aa, 'aerial, twin kept', '4 3', -6), ser('aerial_aerial', C.aa, 'aerial, twin removed', null, 6),
            ser('ground_ground', C.gg, 'ground → ground'), ser('ground_aerial', C.ga, 'ground → aerial')];
        lineChart(document.getElementById('aa-cdf'), document.getElementById('aa-cdf-tip'), series, {
            x0: 0, x1: 300, y0: 0, y1: 100, xTicks: [0, 50, 100, 150, 200, 250, 300], yTicks: [0, 25, 50, 75, 100],
            xFmt: (v, long) => long ? `top-1 within ${v} m` : `${v} m`, yFmt: (v, long) => long ? `${v.toFixed(1)}%` : `${v}%`,
        });
        document.getElementById('aa-cdf-legend').innerHTML = legendHtml(series.map(s => [s.color, s.label, s.dash]));
        const a = summary.aerial;
        document.getElementById('aa-cdf-note').textContent =
            `Share of queries whose top-1 lies within a given distance. Without the twin, ${a.r1_25m_without_twin.toFixed(0)}% of aerial tiles retrieve a tile within 25 m; ` +
            `the 100 m success radius used by the paper is almost always met because each tile has ~${a.median_positives} neighbours inside it.`;
    }

    // rows: [{ label, sub, s: {near_share, near_chance, top_d, all_d, n}, color, unit }]
    function colocChart(svg, tip, rows) {
        const W = widthOf(svg), rowH = 30, T = 8, L = W < 480 ? 150 : 210, R = 16, H = T + rows.length * rowH + 28;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const X = v => L + v / 0.5 * (W - L - R);
        [0, 0.1, 0.2, 0.3, 0.4, 0.5].forEach(v => {
            el('line', { x1: X(v), x2: X(v), y1: T, y2: H - 24, stroke: C.grid }, svg);
            el('text', { x: X(v), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: C.ink2 }, svg).textContent = `${Math.round(v * 100)}%`;
        });
        rows.forEach((r, i) => {
            if (r.sep) return;
            const s = r.s, cy = T + i * rowH + rowH / 2;
            const g = el('g', {}, svg);
            el('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: 'transparent' }, g);
            el('text', { x: 6, y: cy - 1, 'font-size': 11.5, 'font-weight': 600, fill: C.ink }, g).textContent = r.label;
            el('text', { x: 6, y: cy + 11, 'font-size': 9.5, fill: C.ink2 }, g).textContent = r.sub;
            el('line', { x1: X(s.near_chance), x2: X(s.near_share), y1: cy, y2: cy, stroke: C.muted, 'stroke-width': 2 }, g);
            el('circle', { cx: X(s.near_chance), cy, r: 4.5, fill: C.surface, stroke: C.ink2, 'stroke-width': 2 }, g);
            el('circle', { cx: X(s.near_share), cy, r: 5, fill: r.color, stroke: C.surface, 'stroke-width': 2 }, g);
            const text = `${r.label}: close pairs carry ${(s.near_share * 100).toFixed(0)}% of the positive pair terms vs ${(s.near_chance * 100).toFixed(0)}% of pairs being close. ` +
                `Top-3 pairs: median ${s.top_d.toFixed(0)} m apart vs ${s.all_d.toFixed(0)} m for all pairs (n = ${s.n}).`;
            g.addEventListener('mousemove', () => showTip(tip, svg, X(s.near_share), cy, text));
            g.addEventListener('mouseleave', () => { tip.hidden = true; });
        });
    }
    const colocLegend = colors => colors.map(([c, l]) => `<span class="gg-legend-item"><span class="gg-dot" style="background:${c}"></span>${l}</span>`).join('') +
        `<span class="gg-legend-item"><span class="gg-dot" style="background:#fff;border:2px solid ${C.ink2};box-sizing:border-box"></span>share of pairs that are that close (chance)</span>`;

    function drawColoc() {
        const co = summary.coloc;
        const rows = [
            ['aerial_twin', 'Aerial: twin tile', 'same place, other sample', C.aa],
            ['aerial_top1', 'Aerial: top-1 (no twin)', 'retrieved neighbour', C.aa],
            ['aerial_far', 'Aerial: tile 60–120 m away', 'overlapping, not retrieved', C.aa],
            ['ground_correct', 'Ground: correct top-1', 'fitted frame, approximate', C.gg],
            ['ground_wrong', 'Ground: wrong top-1', 'fitted frame, approximate', C.gg],
        ].filter(r => co[r[0]]).map(([k, label, sub, color]) => ({ label, sub, color, s: co[k] }));
        colocChart(document.getElementById('aa-coloc'), document.getElementById('aa-coloc-tip'), rows);
        document.getElementById('aa-coloc-legend').innerHTML = colocLegend([[C.aa, 'share of positive pair terms from co-located pairs (aerial → aerial)'], [C.gg, '(ground → ground)']]);
        document.getElementById('aa-coloc-note').textContent =
            `"Co-located" = region centroids within ${co.near_m} m. If the descriptor matched by place, the coloured dot would sit well to the right of the hollow one. ` +
            `Medians over ${co.aerial_twin ? co.aerial_twin.n : ''} sampled pairs per row; aerial geometry is exact, ground geometry comes from the yaw/scale fit.`;
    }

    // ---------- ground -> aerial section ----------
    let gaSummary = null, gaPanel = null;
    function drawGaTiles() {
        const s = gaSummary, host = document.getElementById('ga-tiles');
        const tiles = [
            [`${s.r1.toFixed(1)}%`, 'R@1 (top-1 within 100 m)', `R@5 ${s.r5.toFixed(1)}% · R@25 ${s.r25.toFixed(1)}%`],
            [`${s.top1_within['25'].toFixed(0)}%`, 'Top-1 within 25 m', `median top-1 distance ${s.median_top1_m.toFixed(0)} m`],
            [`#${s.nearest_tile_rank.median}`, 'Median rank of the true tile', `tile centred nearest the query; ranked first for ${s.nearest_tile_rank.top1.toFixed(0)}%`],
            [`${s.heading.offset_deg.toFixed(1)}°`, 'Sensor yaw vs GPS track', `checked on ${s.heading.bag.n} run-3 frames: median error ${s.heading.bag.median_abs_deg.toFixed(0)}°`],
        ];
        host.replaceChildren(...tiles.map(([v, l, sub]) => {
            const t = html('div', 'gg-tile');
            html('div', 'gg-tile-value', v, t); html('div', 'gg-tile-label', l, t); html('div', 'gg-tile-sub', sub, t);
            return t;
        }));
    }

    function barChart(svg, tip, bars, color, fmtTip) {
        const W = widthOf(svg), H = 180, L = 36, R = 8, T = 10, B = 40;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const maxC = Math.max(...bars.map(b => b.v)) || 1, bw = (W - L - R) / bars.length;
        const Y = c => T + (1 - c / maxC) * (H - T - B);
        const step = maxC > 200 ? 100 : maxC > 80 ? 50 : maxC > 30 ? 10 : 5;
        for (let c = 0; c <= maxC; c += step) {
            el('line', { x1: L, x2: W - R, y1: Y(c), y2: Y(c), stroke: C.grid }, svg);
            el('text', { x: L - 5, y: Y(c) + 3, 'text-anchor': 'end', 'font-size': 10, fill: C.ink2 }, svg).textContent = c;
        }
        bars.forEach((b, i) => {
            const x = L + i * bw, g = el('g', {}, svg);
            el('rect', { x, y: T, width: bw, height: H - T - B, fill: 'transparent' }, g);
            if (b.v > 0) {
                const h = H - B - Y(b.v), r = Math.min(3, bw / 2 - 1, h);
                el('path', { d: `M${x + 1},${H - B} V${Y(b.v) + r} Q${x + 1},${Y(b.v)} ${x + 1 + r},${Y(b.v)} H${x + bw - 1 - r} Q${x + bw - 1},${Y(b.v)} ${x + bw - 1},${Y(b.v) + r} V${H - B} Z`, fill: b.color || color }, g);
            }
            if (b.tick) {
                const t = el('text', { x: x + bw / 2, y: H - B + 13, 'text-anchor': 'middle', 'font-size': 9.5, fill: C.ink2 }, svg);
                t.textContent = b.tick;
            }
            g.addEventListener('mousemove', () => showTip(tip, svg, x + bw / 2, Y(b.v), fmtTip(b)));
            g.addEventListener('mouseleave', () => { tip.hidden = true; });
        });
        el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: C.muted }, svg);
    }

    function drawGaHist() {
        const h = gaSummary.top1_hist, n = gaSummary.n_queries, W = widthOf(document.getElementById('ga-hist'));
        const bars = h.counts.map((v, i) => {
            const lo = h.edges[i], hi = h.edges[i + 1];
            return { v, lo, hi, color: hi <= 100 ? C.ga : C.muted,
                tick: (W >= 480 || i % 2 === 0) ? (i === h.counts.length - 1 ? `${lo}+` : `${lo}`) : '' };
        });
        barChart(document.getElementById('ga-hist'), document.getElementById('ga-hist-tip'), bars, C.ga,
            b => `${b.lo}–${b.hi === 2000 ? '…' : b.hi} m: ${b.v} queries (${(b.v / n * 100).toFixed(1)}%)`);
        const svg = document.getElementById('ga-hist');
        el('text', { x: 36, y: 176, 'font-size': 10, fill: C.ink2 }, svg).textContent = 'top-1 distance from the query (m); bins widen after 100 m';
        const s = gaSummary;
        document.getElementById('ga-hist-note').textContent =
            `Green bars count as correct (within 100 m). ${s.top1_within['25'].toFixed(0)}% of top-1 tiles are centred within 25 m and ${s.top1_within['50'].toFixed(0)}% within 50 m; ` +
            `${(100 - s.top1_within['200']).toFixed(0)}% are more than 200 m away. The tile centred nearest the query has median rank ${s.nearest_tile_rank.median} ` +
            `(quartiles ${s.nearest_tile_rank.quantiles[1]}–${s.nearest_tile_rank.quantiles[3]}) among ${s.n_tiles.toLocaleString()} tiles.`;
    }

    function drawGaHeading() {
        const d = gaSummary.heading.bag_deltas_deg, edges = [];
        for (let a = -180; a < 180; a += 15) edges.push(a);
        const bars = edges.map(lo => ({ lo, hi: lo + 15, v: d.filter(x => x >= lo && x < lo + 15).length,
            color: Math.abs(lo + 7.5) <= 15 ? C.ga : C.muted, tick: lo % 90 === 0 ? `${lo}°` : '' }));
        barChart(document.getElementById('ga-head'), document.getElementById('ga-head-tip'), bars, C.ga,
            b => `${b.lo}° to ${b.hi}°: ${b.v} frames`);
        const svg = document.getElementById('ga-head');
        el('text', { x: 36, y: 176, 'font-size': 10, fill: C.ink2 }, svg).textContent = 'fitted yaw − GPS track heading';
        const h = gaSummary.heading;
        document.getElementById('ga-head-note').textContent =
            `Each run-3 frame (exact scale and offset from the bag) is rotated to the yaw that puts most of its points on tall cells of the aerial height map, ` +
            `with no use of GPS heading. ${(h.bag.within_15deg * 100).toFixed(0)}% land within 15° of the GPS-track heading (offset ${h.offset_deg.toFixed(1)}°), so the scanner faces the direction of travel. ` +
            `Test scans use the track heading; ${h.queries_moving} of ${gaSummary.n_queries} were moving, the rest take the nearest moving frame's heading.`;
    }

    function drawGaColoc() {
        const co = gaSummary.coloc, aa = summary && summary.coloc;
        const rows = [];
        if (co.correct) rows.push({ label: 'Ground → aerial: correct top-1', sub: 'GPS heading, 30 m', s: co.correct, color: C.ga });
        if (co.nearest_tile) rows.push({ label: 'Ground → aerial: true tile', sub: 'tile at the query position, 30 m', s: co.nearest_tile, color: C.ga });
        if (co.correct_random_heading) rows.push({ label: 'Control: random heading', sub: 'correct top-1, scan spun at random', s: co.correct_random_heading, color: C.muted });
        if (co.correct_radial) rows.push({ label: 'Rotation-free: correct top-1', sub: 'distance from sensor, within 15 m', s: co.correct_radial, color: C.ga });
        if (aa && aa.ground_correct) rows.push({ label: 'Ground → ground: correct top-1', sub: 'for comparison', s: aa.ground_correct, color: C.gg });
        if (aa && aa.aerial_top1) rows.push({ label: 'Aerial → aerial: top-1', sub: 'for comparison', s: aa.aerial_top1, color: C.aa });
        colocChart(document.getElementById('ga-coloc'), document.getElementById('ga-coloc-tip'), rows);
        document.getElementById('ga-coloc-legend').innerHTML = colocLegend([[C.ga, 'ground → aerial'], [C.gg, 'ground → ground'], [C.aa, 'aerial → aerial']]);
        document.getElementById('ga-coloc-note').textContent =
            `Share of the positive region-pair terms carried by pairs whose centroids are close, against the share of pairs that are that close. ` +
            `For ground → aerial the two are nearly equal, whatever the heading (GPS, random) and also with the rotation-free check, ` +
            `so the regions that make a cross-source match are not the ones at the same place, at least at the ~10–20 m accuracy available here. ` +
            `Same-source retrieval shows a clear excess.`;
    }

    async function selectGa(qi) {
        const sel = document.getElementById('ga-select');
        if (sel.value !== String(qi)) sel.value = String(qi);
        let rec;
        try { rec = await load(`ground_aerial/query_${qi}.json`); } catch (e) {
            gaPanel.message(`No ground-to-aerial data for query ${qi} (run ground_aerial_regions.py).`); return;
        }
        if (sel.value !== String(qi)) return;
        const m = meta.find(x => String(x.query_idx) === String(qi));
        const first = rec.first_correct_rank > 500 ? 'not in the top 500' : `#${rec.first_correct_rank}`;
        document.getElementById('ga-readout').textContent =
            `Query ${qi}${m ? ` (${m.location})` : ''}: top-1 tile ${rec.pairs[0].dist_m} m away (${rec.pairs[0].correct ? 'correct' : 'wrong'}); first correct tile ${first}. ` +
            `The tile centred nearest the query (${rec.nearest_tile_m} m) ranks #${rec.nearest_tile_rank}. ` +
            (rec.heading_deg == null ? 'No GPS heading for this scan.' :
                `Heading ${((90 - rec.heading_deg + 360) % 360).toFixed(0)}° (compass) from the GPS track${rec.heading_from_neighbour_s ? `, taken from a moving frame ${rec.heading_from_neighbour_s} s away (robot standing still)` : ''}.`);
        gaPanel.show(rec);
    }
    async function selectAerial(qi) {
        const sel = document.getElementById('aa-select');
        if (sel.value !== String(qi)) sel.value = String(qi);
        let rec;
        try { rec = await load(`aerial/tile_${qi}.json`); } catch (e) {
            document.getElementById('aa-readout').textContent = `No aerial data for query ${qi} (run retrieval_regions.py).`;
            return;
        }
        if (sel.value !== String(qi)) return;
        aerialCurrent = rec;
        const m = meta.find(x => String(x.query_idx) === String(qi));
        document.getElementById('aa-readout').textContent =
            `Aerial tile ${rec.tile} is the tile centred nearest to ground query ${qi}${m ? ` (${m.location})` : ''}, ${rec.ground_query_offset_m} m away. ` +
            `Its twin (the same tile, other point sample) ranks #${rec.twin_rank}. ${rec.n_positives} other tiles lie within 100 m.`;
        const body = document.getElementById('aa-top5');
        body.replaceChildren(...rec.top5.map(t => {
            const tr = html('tr');
            html('td', null, `#${t.rank}`, tr);
            html('td', null, `${t.offset_en[0] >= 0 ? '+' : ''}${t.offset_en[0].toFixed(0)} E, ${t.offset_en[1] >= 0 ? '+' : ''}${t.offset_en[1].toFixed(0)} N`, tr);
            html('td', null, `${t.dist_m.toFixed(0)} m`, tr);
            html('td', null, t.emb_dist.toFixed(3), tr);
            return tr;
        }));
        aerialPanel.show(rec);
    }

    async function init() {
        const gHost = document.getElementById('gg-regions');
        if (gHost) {
            groundPanel = RegionPairPanel.create(gHost, {
                kind: 'ground',
                tabLabel: p => `#${p.rank} · run ${p.run} · ${p.dist_m} m`,
                note: 'The retrieved scan is fitted into the query frame (yaw, scale, shift), so centroid distances are approximate and only meaningful when the fit found the right overlap. Scale ~79 m per unit is estimated.',
            });
        }
        const gaSec = document.getElementById('ground-aerial');
        if (gaSec) {
            gaPanel = RegionPairPanel.create(document.getElementById('ga-regions'), {
                kind: 'ground_aerial',
                tabLabel: p => (p.label === 'true tile' ? `True tile · rank ${p.rank} · ${p.dist_m} m` : `${p.label} · ${p.dist_m} m`),
                geoValid: rec => rec.heading_deg != null,
                note: 'The ground scan is rotated north-up with its GPS-track heading and placed at its GPS position with the median scale (78.8 m per unit). '
                    + 'Its true scale (45–101 m) and the ~11 m offset between sensor and point centroid are unknown, so ground region positions carry ~10–20 m of error.',
            });
        }
        const aSec = document.getElementById('aerial-retrieval');
        if (aSec) {
            aerialPanel = RegionPairPanel.create(document.getElementById('aa-regions'), {
                kind: 'aerial',
                tabLabel: p => (p.label === 'twin' ? 'Twin (same tile)' : `${p.label} · ${p.dist_m} m`),
                note: 'Aerial tiles are north-up and centred on their position, so the retrieved tile is placed at its true offset and centroid distances are exact (to the region segmentation).',
            });
        }
        try {
            meta = await load('metadata.json');
            if (aSec) summary = await load('aerial/summary.json');
            if (gaSec) gaSummary = await load('ground_aerial/summary.json');
        } catch (e) {
            if (aSec) document.getElementById('aa-readout').textContent = 'Aerial data not found (run retrieval_regions.py).';
        }
        const drawGa = () => { drawGaHist(); drawGaHeading(); drawGaColoc(); };
        if (gaSummary) { drawGaTiles(); drawGa(); }
        if (summary) {
            drawTiles(); drawCurves(); drawCdf(); drawColoc();
            const b = summary.batch_dependence;
            if (b) document.getElementById('aa-batch-note').textContent =
                `The evaluation embeds clouds in batches of 64 and the transformer attends over zero-padded points, so a cloud's evaluation embedding depends on its batch-mates ` +
                `(median ${(b.median_rel_diff * 100).toFixed(1)}%, max ${(b.max_rel_diff * 100).toFixed(1)}% relative change vs embedding it alone). ` +
                `Rankings shown are the evaluation's; the decomposition is exact for each cloud embedded alone, so ‖q − r‖ differs slightly from the evaluation value shown beside it.`;
        }
        const main = document.getElementById('query-select'), gsel = document.getElementById('gg-select');
        const start = main && main.value ? main.value : (meta && meta[0] ? meta[0].query_idx : null);
        if (aSec && meta) {
            const sel = document.getElementById('aa-select');
            meta.forEach(m => {
                const o = document.createElement('option');
                o.value = m.query_idx; o.textContent = `${m.location} - Query ${m.query_idx} (${m.category})`;
                sel.appendChild(o);
            });
            sel.addEventListener('change', () => selectAerial(sel.value));
        }
        if (gaSec && meta) {
            const sel = document.getElementById('ga-select');
            meta.forEach(m => {
                const o = document.createElement('option');
                o.value = m.query_idx; o.textContent = `${m.location} - Query ${m.query_idx} (${m.category})`;
                sel.appendChild(o);
            });
            sel.addEventListener('change', () => selectGa(sel.value));
        }
        if (main) main.addEventListener('change', () => {
            showGround(main.value);
            if (gaSec && gaSummary) selectGa(main.value);
            if (aSec && summary) selectAerial(main.value);
        });
        if (gsel) gsel.addEventListener('change', () => showGround(gsel.value));
        if (start != null) { showGround(start); if (gaSec && gaSummary) selectGa(start); if (aSec && summary) selectAerial(start); }
        let t = null;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                if (summary) { drawCurves(); drawCdf(); drawColoc(); }
                if (gaSummary) drawGa();
                if (gaPanel) gaPanel.resize();
                if (groundPanel) groundPanel.resize();
                if (aerialPanel && aerialCurrent) aerialPanel.resize();
            }, 150);
        });
    }
    document.addEventListener('DOMContentLoaded', init);
    return { showGround, selectAerial, selectGa };
})();
