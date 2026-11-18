// Ground-to-ground retrieval section (data: docs/ground/, written by ground_retrieval.py).
// Self-contained: loads its own data, follows the main query selector when it changes.

const GroundRetrieval = (() => {
    const C = {
        r1: '#3987e5', r25: '#d95926',                 // categorical slots 1-2 (validated, light)
        ok: '#10b981', bad: '#ef4444',                 // site's correct / incorrect
        query: '#5aa9ff', retrieved: '#d946ef',        // overlay on black: query blue, fitted retrieval magenta
        ink: '#0f172a', ink2: '#475569', muted: '#94a3b8', grid: '#e2e8f0', surface: '#ffffff', dark: '#111111',
    };
    const NS = 'http://www.w3.org/2000/svg';
    let summary = null, meta = null, current = null;
    const cache = new Map();

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
    const widthOf = svg => Math.max(280, svg.parentElement.clientWidth);
    function showTip(tip, svg, x, y, text) {
        tip.textContent = text; tip.hidden = false;
        const w = svg.parentElement.clientWidth;
        tip.style.left = `${Math.min(Math.max(x, 70), w - 70)}px`; tip.style.top = `${Math.max(0, y - 34)}px`;
    }

    // ---------- summary: tiles ----------
    function drawTiles() {
        const host = document.getElementById('gg-tiles');
        const a = summary.per_db[0], rep = summary.reported, pool = summary.pooled_ground;
        const near = summary.queries.nearest_train_m.slice().sort((x, y) => x - y);
        const median = near[Math.floor(near.length / 2)];
        const tiles = [
            [`${a.r1.toFixed(1)}%`, 'Aerial database R@1', 'the cross-source result (paper: "Aerial-only")'],
            [`${rep.ground_mean_r1.toFixed(1)}%`, 'Ground runs R@1 (mean of 12)', 'ground query → ground training run'],
            [`${rep.all13_mean_r1.toFixed(1)}%`, 'Paper\'s "Aerial + Ground" R@1', 'mean of the 13 databases above'],
            [`${median.toFixed(1)} m`, 'Median distance to a training scan', 'test query → nearest ground scan of runs 1–12'],
        ];
        host.replaceChildren(...tiles.map(([v, l, s]) => {
            const t = html('div', 'gg-tile');
            html('div', 'gg-tile-value', v, t); html('div', 'gg-tile-label', l, t); html('div', 'gg-tile-sub', s, t);
            return t;
        }));
        document.getElementById('gg-pool-size').textContent =
            summary.per_db.filter(r => r.kind === 'ground').reduce((s, r) => s + r.size, 0).toLocaleString();
        void pool;
    }

    // ---------- summary: recall dot plot ----------
    function drawRecall() {
        const svg = document.getElementById('gg-recall'), tip = document.getElementById('gg-recall-tip');
        const rows = [];
        const a = summary.per_db[0];
        rows.push({ label: 'Aerial map', sub: `${a.size.toLocaleString()} patches`, ...a, strong: true });
        summary.per_db.filter(r => r.kind === 'ground').sort((x, y) => x.run - y.run)
            .forEach(r => rows.push({ label: `Ground run ${r.run}`, sub: `${r.size} scans`, ...r }));
        const g = summary.per_db.filter(r => r.kind === 'ground');
        const avg = (k, list) => list.reduce((s, r) => s + r[k], 0) / list.length;
        rows.push({ sep: true });
        rows.push({ label: 'Mean of 12 runs', sub: 'ground only', r1: avg('r1', g), r5: avg('r5', g), r25: avg('r25', g), derived: true });
        rows.push({ label: 'Paper average', sub: '13 databases', r1: avg('r1', summary.per_db), r5: avg('r5', summary.per_db), r25: avg('r25', summary.per_db), derived: true, strong: true });
        const p = summary.pooled_ground;
        rows.push({ label: 'Pooled ground', sub: 'all runs, one DB', ...p, derived: true });

        const W = widthOf(svg), rowH = 22, top = 26, left = 128, right = 16;
        const H = top + rows.reduce((h, r) => h + (r.sep ? 10 : rowH), 0) + 26;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const x0 = 30, x1 = 100, X = v => left + (Math.max(v, x0) - x0) / (x1 - x0) * (W - left - right);
        for (let v = x0; v <= x1; v += 10) {
            if (W < 520 && (v - x0) % 20) { el('line', { x1: X(v), x2: X(v), y1: top - 6, y2: H - 22, stroke: C.grid }, svg); continue; }
            el('line', { x1: X(v), x2: X(v), y1: top - 6, y2: H - 22, stroke: C.grid }, svg);
            el('text', { x: X(v), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: C.ink2 }, svg).textContent = `${v}%`;
        }
        el('line', { x1: X(a.r1), x2: X(a.r1), y1: top - 6, y2: H - 22, stroke: C.r1, 'stroke-dasharray': '3 3', 'stroke-width': 1 }, svg);
        el('text', { x: X(a.r1) + 3, y: top - 10, 'font-size': 10, fill: C.ink2 }, svg).textContent = `aerial R@1 ${a.r1.toFixed(1)}%`;
        let y = top;
        rows.forEach(r => {
            if (r.sep) { el('line', { x1: 8, x2: W - right, y1: y + 4, y2: y + 4, stroke: C.grid, 'stroke-dasharray': '2 3' }, svg); y += 10; return; }
            const cy = y + rowH / 2;
            const g = el('g', { class: 'gg-row' }, svg);
            el('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }, g);
            el('text', { x: 8, y: cy + 4, 'font-size': 11.5, 'font-weight': r.strong ? 700 : 500, fill: C.ink, 'font-style': r.derived ? 'italic' : 'normal' }, g).textContent = r.label;
            el('line', { x1: X(r.r1), x2: X(r.r25), y1: cy, y2: cy, stroke: C.muted, 'stroke-width': 2 }, g);
            el('circle', { cx: X(r.r25), cy, r: 4.5, fill: C.r25, stroke: C.surface, 'stroke-width': 2 }, g);
            el('circle', { cx: X(r.r1), cy, r: 4.5, fill: C.r1, stroke: C.surface, 'stroke-width': 2 }, g);
            const text = `${r.label} (${r.sub}): R@1 ${r.r1.toFixed(1)}%, R@5 ${r.r5.toFixed(1)}%, R@25 ${r.r25.toFixed(1)}%` +
                (r.n_queries != null && r.n_queries !== 1059 ? ` · ${r.n_queries} queries have a true neighbour here` : '');
            g.addEventListener('mousemove', ev => {
                const b = svg.getBoundingClientRect();
                showTip(tip, svg, ev.clientX - b.left, cy, text);
            });
            g.addEventListener('mouseleave', () => { tip.hidden = true; });
            y += rowH;
        });
        const leg = document.getElementById('gg-recall-legend');
        leg.innerHTML = `<span class="gg-legend-item"><span class="gg-dot" style="background:${C.r1}"></span>Recall@1</span>` +
            `<span class="gg-legend-item"><span class="gg-dot" style="background:${C.r25}"></span>Recall@25</span>` +
            `<span class="gg-legend-item"><span class="gg-dash" style="border-color:${C.r1}"></span>aerial Recall@1</span>`;
        document.getElementById('gg-recall-note').textContent =
            `Each ground run is scored as its own database and only counts queries with a scan of that run within 100 m. ` +
            `Run 3 has 54 scans, so almost any hit is correct. Pooling all 12 runs into one database gives R@1 ${p.r1.toFixed(1)}%.`;
    }

    // ---------- summary: nearest training scan histogram ----------
    function drawNear() {
        const svg = document.getElementById('gg-near'), tip = document.getElementById('gg-near-tip');
        const d = summary.queries.nearest_train_m, n = d.length;
        const step = 1, maxD = Math.max(25, Math.ceil(Math.max(...d)));
        const bins = new Array(maxD / step).fill(0);
        d.forEach(v => { bins[Math.min(bins.length - 1, Math.floor(v / step))]++; });
        const W = widthOf(svg), H = 170, L = 36, R = 10, T = 10, B = 28;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const maxC = Math.max(...bins), bw = (W - L - R) / bins.length;
        const Y = c => T + (1 - c / maxC) * (H - T - B);
        const niceStep = maxC > 200 ? 100 : maxC > 80 ? 50 : 20;
        for (let c = 0; c <= maxC; c += niceStep) {
            el('line', { x1: L, x2: W - R, y1: Y(c), y2: Y(c), stroke: C.grid }, svg);
            el('text', { x: L - 5, y: Y(c) + 3, 'text-anchor': 'end', 'font-size': 10, fill: C.ink2 }, svg).textContent = c;
        }
        bins.forEach((c, i) => {
            const x = L + i * bw, h = H - B - Y(c);
            const g = el('g', {}, svg);
            el('rect', { x, y: T, width: bw, height: H - T - B, fill: 'transparent' }, g);
            if (c > 0) {
                const r = Math.min(3, bw / 2 - 1, h);
                el('path', { d: `M${x + 1},${H - B} V${Y(c) + r} Q${x + 1},${Y(c)} ${x + 1 + r},${Y(c)} H${x + bw - 1 - r} Q${x + bw - 1},${Y(c)} ${x + bw - 1},${Y(c) + r} V${H - B} Z`, fill: C.r1 }, g);
            }
            g.addEventListener('mousemove', () => showTip(tip, svg, x + bw / 2, Y(c), `${i * step}–${(i + 1) * step} m: ${c} queries (${(c / n * 100).toFixed(1)}%)`));
            g.addEventListener('mouseleave', () => { tip.hidden = true; });
        });
        for (let v = 0; v <= maxD; v += 5) el('text', { x: L + v / step * bw, y: H - 10, 'text-anchor': 'middle', 'font-size': 10, fill: C.ink2 }, svg).textContent = `${v} m`;
        el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: C.muted }, svg);
        const within = t => (d.filter(v => v < t).length / n * 100).toFixed(0);
        document.getElementById('gg-near-note').textContent =
            `${within(5)}% of test queries are within 5 m of a training ground scan, ${within(10)}% within 10 m and ${within(25.0001)}% within 25 m. ` +
            `No area is held out, so the test drives revisit trained places.`;
    }

    function drawOutcome() {
        const o = summary.outcome, n = o.both + o.ground_only + o.aerial_only + o.neither;
        const cell = (v, cls) => `<td class="${cls}"><b>${v}</b><span>${(v / n * 100).toFixed(1)}%</span></td>`;
        document.getElementById('gg-outcome').innerHTML =
            `<thead><tr><th></th><th>Aerial top-1 correct</th><th>Aerial top-1 wrong</th></tr></thead><tbody>` +
            `<tr><th>Ground top-1 correct</th>${cell(o.both, 'gg-both')}${cell(o.ground_only, '')}</tr>` +
            `<tr><th>Ground top-1 wrong</th>${cell(o.aerial_only, '')}${cell(o.neither, 'gg-neither')}</tr></tbody>`;
    }

    // ---------- explorer ----------
    async function loadQuery(qi) {
        if (!cache.has(qi)) {
            const res = await fetch(`ground/query_${qi}.json`);
            if (!res.ok) throw new Error(`ground/query_${qi}.json: ${res.status}`);
            cache.set(qi, await res.json());
        }
        return cache.get(qi);
    }

    async function select(qi) {
        qi = Number(qi);
        const sel = document.getElementById('gg-select');
        if (sel.value !== String(qi)) sel.value = String(qi);
        let q;
        try { q = await loadQuery(qi); } catch (e) {
            document.getElementById('gg-readout').textContent = `No ground-retrieval data for query ${qi} (run ground_retrieval.py).`;
            return;
        }
        if (Number(sel.value) !== qi) return; // a newer selection won
        current = q;
        drawReadout(q); drawMap(q); drawRuns(q); drawCards(q);
    }

    function drawReadout(q) {
        const g = q.ground[0], a = q.aerial[0];
        const scored = q.per_run.filter(r => r.has_positive), ok = scored.filter(r => r.correct).length;
        document.getElementById('gg-readout').textContent =
            `Query ${q.query_idx} (${q.location}, ${q.category.toLowerCase()} in the aerial view): the nearest training ground scan is ${q.nearest_train_m} m away. ` +
            `Ground top-1: run ${g.run}, ${g.dist_m} m (${g.correct ? 'correct' : 'wrong'}). Aerial top-1: ${a.dist_m} m (${a.correct ? 'correct' : 'wrong'}). ` +
            `Correct top-1 in ${ok} of the ${scored.length} runs that pass within 100 m.`;
    }

    function drawMap(q) {
        const svg = document.getElementById('gg-map'), tip = document.getElementById('gg-map-tip');
        const W = widthOf(svg), H = Math.min(W, 380), half = 250;
        svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
        const [qn, qe] = q.query_ne, k = Math.min(W, H) / (2 * half);
        const X = e => W / 2 + (e - qe) * k, Y = n => H / 2 - (n - qn) * k;
        el('rect', { x: 0, y: 0, width: W, height: H, fill: '#f8fafc', rx: 6 }, svg);
        Object.values(summary.train_ground).forEach(list => list.forEach(([n, e]) => {
            const x = X(e), y = Y(n);
            if (x > -2 && x < W + 2 && y > -2 && y < H + 2) el('circle', { cx: x, cy: y, r: 1.4, fill: '#a3adb9' }, svg);
        }));
        el('circle', { cx: X(qe), cy: Y(qn), r: 100 * k, fill: 'none', stroke: C.ink2, 'stroke-dasharray': '4 4' }, svg);
        el('text', { x: X(qe) + 100 * k * 0.72 + 4, y: Y(qn) - 100 * k * 0.72, 'font-size': 10, fill: C.ink2 }, svg).textContent = '100 m';
        const hover = (node, text, x, y) => {
            node.addEventListener('mousemove', () => showTip(tip, svg, x, y, text));
            node.addEventListener('mouseleave', () => { tip.hidden = true; });
        };
        // aerial top-1..5 (squares)
        q.aerial.slice().reverse().forEach(a => {
            const x = X(a.ne[1]), y = Y(a.ne[0]), s = a.rank === 1 ? 11 : 7;
            const r = el('rect', { x: x - s / 2, y: y - s / 2, width: s, height: s, fill: a.rank === 1 ? (a.correct ? C.ok : C.bad) : C.surface, stroke: a.correct ? C.ok : C.bad, 'stroke-width': 2, rx: 2 }, svg);
            hover(r, `Aerial #${a.rank}: ${a.dist_m} m · ${a.correct ? 'correct' : 'wrong'}`, x, y);
        });
        // ground top-5 (numbered circles)
        q.ground.slice().reverse().forEach(g => {
            const x = X(g.ne[1]), y = Y(g.ne[0]);
            const grp = el('g', {}, svg);
            el('circle', { cx: x, cy: y, r: 8, fill: g.correct ? C.ok : C.bad, stroke: C.surface, 'stroke-width': 2 }, grp);
            el('text', { x, y: y + 3.5, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#fff' }, grp).textContent = g.rank;
            hover(grp, `Ground #${g.rank}: run ${g.run}, ${g.dist_m} m · ${g.correct ? 'correct' : 'wrong'}`, x, y);
        });
        // query
        const qx = X(qe), qy = Y(qn);
        el('path', { d: `M${qx},${qy - 9} L${qx + 9},${qy} L${qx},${qy + 9} L${qx - 9},${qy} Z`, fill: '#00bcff', stroke: C.ink, 'stroke-width': 1.5 }, svg);
        // off-map markers
        const off = [...q.ground.map(g => ({ ne: g.ne, t: `G${g.rank}` })), ...q.aerial.filter(a => a.rank === 1).map(a => ({ ne: a.ne, t: 'A1' }))]
            .filter(p => Math.abs(p.ne[1] - qe) > W / (2 * k) || Math.abs(p.ne[0] - qn) > H / (2 * k));
        if (off.length) el('text', { x: 8, y: H - 8, 'font-size': 10, fill: C.ink2 }, svg).textContent =
            `Off map: ${off.map(p => `${p.t} (${Math.round(Math.hypot(p.ne[0] - qn, p.ne[1] - qe))} m)`).join(', ')}`;
        el('line', { x1: W - 18 - 50 * k, x2: W - 18, y1: 16, y2: 16, stroke: C.ink, 'stroke-width': 2 }, svg);
        el('text', { x: W - 18, y: 30, 'text-anchor': 'end', 'font-size': 10, fill: C.ink2 }, svg).textContent = '50 m';
        el('text', { x: 10, y: 18, 'font-size': 11, 'font-weight': 700, fill: C.ink2 }, svg).textContent = 'N ↑';
        document.getElementById('gg-map-legend').innerHTML =
            `<span class="gg-legend-item"><span class="gg-diamond"></span>Query</span>` +
            `<span class="gg-legend-item"><span class="gg-dot gg-num" style="background:${C.ok}">1</span>Ground top-5 (green correct, red wrong)</span>` +
            `<span class="gg-legend-item"><span class="gg-sq" style="background:${C.ok}"></span>Aerial top-1 (hollow: #2–5)</span>` +
            `<span class="gg-legend-item"><span class="gg-dot" style="background:#a3adb9;width:6px;height:6px"></span>Training ground scans (runs 1–12)</span>`;
    }

    function drawRuns(q) {
        const body = document.getElementById('gg-runs');
        body.replaceChildren(...q.per_run.map(r => {
            const tr = html('tr');
            html('td', null, `Run ${r.run}`, tr);
            html('td', null, `${r.nearest_in_run_m.toFixed(1)} m`, tr);
            html('td', null, `${r.dist_m.toFixed(1)} m`, tr);
            const td = html('td', null, null, tr);
            if (!r.has_positive) html('span', 'gg-pill gg-pill-skip', 'not scored', td);
            else html('span', `badge ${r.correct ? 'badge-correct' : 'badge-incorrect'}`, r.correct ? 'Correct' : 'Wrong', td);
            if (!r.has_positive) tr.classList.add('gg-row-skip');
            return tr;
        }));
    }

    function drawCards(q) {
        const host = document.getElementById('gg-cards');
        const size = 210, dpr = window.devicePixelRatio || 1;
        // shared window: query extent (metres) around its centroid
        const qp = q.query_pts;
        const cx = qp.reduce((s, p) => s + p[0], 0) / qp.length, cy = qp.reduce((s, p) => s + p[1], 0) / qp.length;
        const ext = qp.map(p => Math.max(Math.abs(p[0] - cx), Math.abs(p[1] - cy))).sort((a, b) => a - b);
        const half = Math.max(10, ext[Math.floor(ext.length * 0.95)] * 1.1);
        host.replaceChildren(...q.ground.map(g => {
            const card = html('div', 'gg-rcard');
            const head = html('div', 'gg-rcard-head', null, card);
            html('span', 'gg-rank', `#${g.rank}`, head);
            html('span', 'gg-rcard-title', `Run ${g.run} · ${g.dist_m} m`, head);
            html('span', `badge ${g.correct ? 'badge-correct' : 'badge-incorrect'}`, g.correct ? 'Correct' : 'Wrong', head);
            const cv = html('canvas', null, null, card);
            cv.width = cv.height = Math.round(size * dpr); cv.style.width = cv.style.height = `${size}px`;
            const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
            ctx.fillStyle = C.dark; ctx.fillRect(0, 0, size, size);
            const sx = x => size / 2 + (x - cx) / half * (size / 2 - 4), sy = y => size / 2 - (y - cy) / half * (size / 2 - 4);
            const dot = (pts, col, r) => { ctx.fillStyle = col; pts.forEach(p => ctx.fillRect(sx(p[0]) - r / 2, sy(p[1]) - r / 2, r, r)); };
            ctx.globalAlpha = 0.9; dot(qp, C.query, 2.2); dot(g.pts, C.retrieved, 2.2); ctx.globalAlpha = 1;
            const bar = 20 / half * (size / 2 - 4);
            ctx.fillStyle = '#d4d4d4'; ctx.fillRect(size - 8 - bar, size - 10, bar, 2);
            ctx.font = '9px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.fillText('~20 m', size - 8, size - 14);
            const ov = g.align.overlap, base = q.random_far_overlap;
            const info = html('div', 'gg-rcard-info', null, card);
            const line = (k, v) => { const r = html('div', 'gg-kv', null, info); html('span', null, k, r); html('b', null, v, r); };
            line('Overlap after fit', `${(ov * 100).toFixed(0)}%`);
            line('Same fit, random far scan', `${(base * 100).toFixed(0)}%`);
            line('Embedding distance', g.emb_dist.toFixed(3));
            line('Fitted yaw / scale', `${g.align.yaw_deg.toFixed(0)}° / ${g.align.scale_ratio.toFixed(2)}×`);
            const meter = html('div', 'gg-meter', null, info);
            const fill = html('span', null, null, meter); fill.style.width = `${Math.min(100, ov * 200)}%`;
            const mark = html('i', null, null, meter); mark.style.left = `${Math.min(100, base * 200)}%`;
            mark.title = 'overlap with a random scan >300 m away';
            return card;
        }));
    }

    async function init() {
        if (!document.getElementById('ground-retrieval')) return;
        try {
            [summary, meta] = await Promise.all([
                fetch('ground/summary.json').then(r => r.json()),
                fetch('metadata.json').then(r => r.json()),
            ]);
        } catch (e) {
            document.getElementById('gg-readout').textContent = 'Ground-retrieval data not found (run ground_retrieval.py).';
            return;
        }
        drawTiles(); drawRecall(); drawNear(); drawOutcome();
        const sel = document.getElementById('gg-select');
        meta.forEach(m => {
            const o = document.createElement('option');
            o.value = m.query_idx; o.textContent = `${m.location} - Query ${m.query_idx} (${m.category})`;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => select(sel.value));
        const main = document.getElementById('query-select');
        if (main) main.addEventListener('change', () => select(main.value));
        select(main && main.value ? main.value : meta[0].query_idx);
        let t = null;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(() => { drawRecall(); drawNear(); if (current) { drawMap(current); drawCards(current); } }, 150);
        });
    }
    document.addEventListener('DOMContentLoaded', init);
    return { select };
})();
