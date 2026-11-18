"""Region contribution analysis for same-modality retrieval: ground -> ground and aerial -> aerial.

The evaluation ranks database clouds by Euclidean distance between *unnormalised* embeddings
(configs/campus_ours.py: normalize_embeddings=False), so this decomposes the ranking criterion itself:

    -1/2 ||q - r||^2  =  sum_{a,b} <u_a, v_b>   -  1/2 sum_b <v_b, r>   -  1/2 ||q||^2
                         region-pair terms        retrieved-region       same for every
                         (matrix, as on the        norm penalty          candidate
                         cross-source panel)

with q = sum_a u_a and r = sum_b v_b the region parts of the full evaluation embedding
(region_attribution.region_embeddings with step=None; every refinement step fused).

Geometry, to check whether the strongest pairs join regions that really are the same place:
  ground -> ground  retrieved scan fitted to the query (yaw + scale + shift, ground_retrieval.align);
                    approximate, ground scans have unknown heading and per-frame scale
  aerial -> aerial  exact: tiles are north-up and centred on their position (x = easting, y = northing, x100 m)

Writes
  docs/ground/regions_<idx>.json   query vs its top-3 pooled ground retrievals, per page query
  docs/aerial/tile_<idx>.json      the aerial tile (set 0) nearest each page query vs its twin (same tile,
                                   other 4096-point sample in set 1) and its top-3 set-1 retrievals without the twin
  docs/aerial/summary.json         aerial -> aerial recall, descriptor distance vs offset for the three
                                   retrieval types, top-1 offsets, and region co-location statistics

Run: /home/screwdriver/anaconda3/envs/crossloc/bin/python retrieval_regions.py --cache emb.npz
"""
import argparse
import json
import os
import pickle

import numpy as np
import torch

import region_attribution as ra
from ground_retrieval import B, GROUND_SETS, AERIAL_SET, embed_all, align, rz, QUERY_SCALE_FALLBACK

AERIAL_Q_SET = 0        # aerial tiles, sample _0 (core/eval.py never uses it as a database)
K_GROUND, K_AERIAL = 12, 24
AERIAL_M = 100.0
NEAR_M = 30.0           # region centroids closer than this count as "the same place"
TOPN = 3
N_STATS = 100           # pairs per category for the co-location statistics
RAD = 100.0             # success radius (as the paper)
FAR_M = 400.0           # descriptor distances are shown relative to the median for pairs further apart than this


def sqdist(Q, D, chunk=1024):
    out = np.empty((len(Q), len(D)), dtype=np.float32)
    dn = (D ** 2).sum(1)
    for i in range(0, len(Q), chunk):
        q = Q[i:i + chunk]
        out[i:i + chunk] = (q ** 2).sum(1)[:, None] + dn[None] - 2 * q @ D.T
    return np.maximum(out, 0)


class Decomposer:
    def __init__(self):
        self.cfg, self.task, self.loader = ra.load_model()
        self.cache = {}

    def __call__(self, f, k):
        key = (f, k)
        if key not in self.cache:
            self.cache[key] = ra.region_embeddings(self.task, self.cfg, self.loader, f, None, 1.0, k)
        return self.cache[key]


def terms(q, r):
    C = q['u_R'] @ r['u_R'].T
    pen = -0.5 * (r['u_R'] @ r['e'])
    qconst = -0.5 * float(q['e'] @ q['e'])
    d2 = float(((q['e'] - r['e']) ** 2).sum())
    assert abs(C.sum() + pen.sum() + qconst + 0.5 * d2) < 1e-3 * max(1.0, d2), (C.sum() + pen.sum() + qconst, -0.5 * d2)
    return C, pen, qconst, d2


def centroids(pts, ids):
    return np.array([pts[ids == j, :2].mean(0) for j in range(ids.max() + 1)])


def coloc(C, qc, rc):
    D = np.linalg.norm(qc[:, None] - rc[None], axis=2)
    pos = np.clip(C, 0, None)
    flat = np.argsort(-C, axis=None)[:TOPN]
    return {'near_share': float(pos[D < NEAR_M].sum() / max(pos.sum(), 1e-12)),
            'near_chance': float((D < NEAR_M).mean()),
            'top_d': float(np.median(D.flat[flat])), 'all_d': float(np.median(D))}


def pair_record(C, pen, qconst, d2, q, r, qc, rc, r_pts, extra):
    D = np.linalg.norm(qc[:, None] - rc[None], axis=2)
    flat = np.argsort(-C, axis=None)[:10]
    return {**extra,
            'emb_dist': round(float(np.sqrt(d2)), 4),
            'score': {'pairs': round(float(C.sum()), 5), 'penalty': round(float(pen.sum()), 5),
                      'query_const': round(qconst, 5), 'neg_half_d2': round(-0.5 * d2, 5)},
            'r_ids': r['labels'].tolist(), 'r_pts': np.round(r_pts, 1).tolist(),
            'r_cent': np.round(rc, 1).tolist(),
            'matrix': np.round(C, 5).tolist(), 'penalty': np.round(pen, 5).tolist(),
            'top_pairs': [[int(i // C.shape[1]), int(i % C.shape[1]), round(float(C.flat[i]), 5),
                           round(float(D.flat[i]), 1)] for i in flat],
            'coloc': {k: round(v, 3) for k, v in coloc(C, qc, rc).items()}}


def ground_geometry(q, r, scale, offset):
    """Query and retrieved region points/centroids in the query's metric frame (retrieved fitted to query)."""
    s, yaw, t, ov = align(r['pc_ds'], q['pc_ds'])
    to_m = lambda p: p * scale + offset
    qp, rp = to_m(q['pc_ds']), to_m(s * r['pc_ds'] @ rz(yaw).T + t)
    return qp, rp, centroids(qp, q['labels']), centroids(rp, r['labels']), \
        {'yaw_deg': round(np.degrees(yaw) % 360, 1), 'scale_ratio': round(s, 3), 'overlap': round(ov, 3)}


def aerial_geometry(q, r, q_ne, r_ne):
    off = np.array([r_ne[1] - q_ne[1], r_ne[0] - q_ne[0], 0.0])   # (easting, northing) of r relative to q
    qp, rp = q['pc_ds'] * AERIAL_M, r['pc_ds'] * AERIAL_M + off
    return qp, rp, centroids(qp, q['labels']), centroids(rp, r['labels'])


def summarise(rows):
    if not rows:
        return None
    return {'n': len(rows), **{k: round(float(np.median([r[k] for r in rows])), 3)
                               for k in ('near_share', 'near_chance', 'top_d', 'all_d')}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=None)
    ap.add_argument('--n-stats', type=int, default=N_STATS)
    ap.add_argument('--curves-only', action='store_true', help='recompute curves/recall in docs/aerial/summary.json and stop')
    args = ap.parse_args()
    os.makedirs('docs/aerial', exist_ok=True)
    rng = np.random.default_rng(0)

    db_cat = pickle.load(open(B + 'umd_evaluation_database.pickle', 'rb'))
    q_cat = pickle.load(open(B + 'umd_evaluation_query.pickle', 'rb'))[0]
    db_emb, q_emb = embed_all(args.cache)
    run_of = lambda m: int(next(iter(db_cat[m].values()))['query'].split('/')[1].split('_')[-1])
    qxy = np.array([[v['northing'], v['easting']] for v in q_cat])
    g_items = [(m, k) for m in GROUND_SETS for k in range(len(db_cat[m]))]
    g_emb = np.concatenate([db_emb[m] for m in GROUND_SETS])
    g_xy = np.array([[db_cat[m][k]['northing'], db_cat[m][k]['easting']] for m, k in g_items])
    a_q = list(db_cat[AERIAL_Q_SET].values())
    a_d = list(db_cat[AERIAL_SET].values())
    a_xy = np.array([[v['northing'], v['easting']] for v in a_q])
    assert np.allclose(a_xy, [[v['northing'], v['easting']] for v in a_d])
    aq_emb, ad_emb = db_emb[AERIAL_Q_SET], db_emb[AERIAL_SET]
    dec = Decomposer()

    # ---------------- retrieval statistics ----------------
    from scipy.spatial import cKDTree
    a_tree = cKDTree(a_xy)
    nn_twin, nn_ex = np.empty(len(a_xy), int), np.empty(len(a_xy), int)
    for s0 in range(0, len(a_xy), 2048):                          # 13760 x 13760 in chunks
        A2 = sqdist(aq_emb[s0:s0 + 2048], ad_emb)
        nn_twin[s0:s0 + 2048] = A2.argmin(1)
        A2[np.arange(len(A2)), np.arange(s0, s0 + len(A2))] = np.inf   # remove the twin (same tile, other sample)
        nn_ex[s0:s0 + 2048] = A2.argmin(1)
    off_twin = np.linalg.norm(a_xy[nn_twin] - a_xy, axis=1)
    off_ex = np.linalg.norm(a_xy[nn_ex] - a_xy, axis=1)
    G2 = sqdist(q_emb, g_emb)
    GA2 = sqdist(q_emb, ad_emb)
    off_gg = np.linalg.norm(g_xy[G2.argmin(1)] - qxy, axis=1)
    off_ga = np.linalg.norm(a_xy[GA2.argmin(1)] - qxy, axis=1)

    # descriptor distance vs geographic offset (relative to the median for pairs > FAR_M apart)
    edges = np.arange(0, 410, 10.0)

    def curve(Dist2, P, Qxy, sample=None):
        idx = np.arange(len(Qxy)) if sample is None else sample
        d = np.sqrt(Dist2[idx])
        off = np.linalg.norm(Qxy[idx][:, None] - P[None], axis=2)
        far = np.median(d[off > FAR_M])
        out = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (off >= lo) & (off < hi) & np.isfinite(d)
            v = d[m] / far
            out.append([lo, round(float(np.percentile(v, 25)), 3), round(float(np.median(v)), 3),
                        round(float(np.percentile(v, 75)), 3), int(m.sum())] if m.sum() >= 20 else [lo, None, None, None, int(m.sum())])
        return {'far_median': round(float(far), 4), 'far_m': FAR_M, 'bins': out}

    samp = rng.choice(len(a_xy), 1500, replace=False)
    A2t = sqdist(aq_emb[samp], ad_emb)    # keep the twin for the curve (offset 0 bin)
    curves = {'aerial_aerial': curve(A2t, a_xy, a_xy[samp], None),
              'ground_ground': curve(G2, g_xy, qxy), 'ground_aerial': curve(GA2, a_xy, qxy)}
    del A2t

    def cdf(off):
        xs = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500]
        return [[x, round(float((off <= x).mean()), 4)] for x in xs]

    a_pos = a_tree.query_ball_point(a_xy, RAD)
    summary = {
        'note': 'campus_best.pth, full evaluation embedding, Euclidean distance (normalize_embeddings=False). '
                'Aerial queries: set 0 (sample _0 of each tile); database: set 1 (sample _1). Both are training data.',
        'aerial': {
            'n_tiles': len(a_xy),
            'twin_top1': round(100 * float((nn_twin == np.arange(len(a_xy))).mean()), 2),
            'r1_with_twin': round(100 * float((off_twin <= RAD).mean()), 2),
            'r1_without_twin': round(100 * float((off_ex <= RAD).mean()), 2),
            'r1_25m_without_twin': round(100 * float((off_ex <= 25).mean()), 2),
            'median_top1_offset_without_twin': round(float(np.median(off_ex)), 1),
            'median_positives': int(np.median([len(p) for p in a_pos])),
            'tile_spacing_m': round(float(np.median(a_tree.query(a_xy, k=2)[0][:, 1])), 1),
        },
        'ground': {'r1_pooled': round(100 * float((off_gg <= RAD).mean()), 2),
                   'median_top1_offset': round(float(np.median(off_gg)), 1)},
        'ground_aerial': {'r1': round(100 * float((off_ga <= RAD).mean()), 2),
                          'median_top1_offset': round(float(np.median(off_ga)), 1)},
        'curves': curves,
        'top1_cdf': {'aerial_aerial_with_twin': cdf(off_twin), 'aerial_aerial': cdf(off_ex),
                     'ground_ground': cdf(off_gg), 'ground_aerial': cdf(off_ga)},
    }
    print(json.dumps({k: summary[k] for k in ('aerial', 'ground', 'ground_aerial')}, indent=1), flush=True)
    if args.curves_only:
        old = json.load(open('docs/aerial/summary.json'))
        old.update({k: summary[k] for k in summary if k != 'note'})
        json.dump(old, open('docs/aerial/summary.json', 'w'), separators=(',', ':'))
        return

    # ---------------- region co-location statistics ----------------
    stats = {'ground_correct': [], 'ground_wrong': [], 'aerial_twin': [], 'aerial_top1': [], 'aerial_far': []}
    g_top1 = G2.argmin(1)
    g_pos = [set(p) for p in cKDTree(g_xy).query_ball_point(qxy, RAD)]
    ok = np.array([g_top1[i] in g_pos[i] for i in range(len(q_cat))])
    for cat, pool in (('ground_correct', np.flatnonzero(ok)), ('ground_wrong', np.flatnonzero(~ok))):
        for i in rng.choice(pool, min(args.n_stats, len(pool)), replace=False):
            m, k = g_items[g_top1[i]]
            q, r = dec(q_cat[i]['query'], K_GROUND), dec(db_cat[m][k]['query'], K_GROUND)
            C = terms(q, r)[0]
            _, _, qc, rc, _ = ground_geometry(q, r, QUERY_SCALE_FALLBACK, 0.0)
            stats[cat].append(coloc(C, qc, rc))
        print(cat, summarise(stats[cat]), flush=True)
    for cat in ('aerial_twin', 'aerial_top1', 'aerial_far'):
        for i in rng.choice(len(a_xy), args.n_stats, replace=False):
            if cat == 'aerial_twin':
                j = i
            elif cat == 'aerial_top1':
                j = nn_ex[i]
            else:   # control: a tile 60-120 m away that does overlap but was not retrieved
                cand = [c for c in a_tree.query_ball_point(a_xy[i], 120) if np.linalg.norm(a_xy[c] - a_xy[i]) > 60]
                if not cand:
                    continue
                j = cand[rng.integers(len(cand))]
            q, r = dec(a_q[i]['query'], K_AERIAL), dec(a_d[j]['query'], K_AERIAL)
            C = terms(q, r)[0]
            _, _, qc, rc = aerial_geometry(q, r, a_xy[i], a_xy[j])
            row = coloc(C, qc, rc)
            row['offset'] = float(np.linalg.norm(a_xy[j] - a_xy[i]))
            stats[cat].append(row)
        print(cat, summarise(stats[cat]), flush=True)
    summary['coloc'] = {'near_m': NEAR_M, 'top_n': TOPN, **{k: summarise(v) for k, v in stats.items()}}
    json.dump(summary, open('docs/aerial/summary.json', 'w'), separators=(',', ':'))

    # ---------------- per page query ----------------
    meta = json.load(open('docs/metadata.json'))
    batch_dev = []
    for entry in meta:
        qi = entry['query_idx']
        page_q = json.load(open(f'docs/queries/query_{qi}.json'))
        scale = page_q.get('pc_scale', QUERY_SCALE_FALLBACK)
        offset = np.array(page_q.get('pc_offset', [0, 0, 0]))
        gq = json.load(open(f'docs/ground/query_{qi}.json'))
        q = dec(q_cat[qi]['query'], K_GROUND)
        batch_dev.append(float(np.linalg.norm(q['e'] - q_emb[qi]) / np.linalg.norm(q_emb[qi])))
        qp = q['pc_ds'] * scale + offset
        qc = centroids(qp, q['labels'])
        rec = {'query_idx': qi, 'query_ids': q['labels'].tolist(), 'query_pts': np.round(qp, 1).tolist(),
               'query_cent': np.round(qc, 1).tolist(), 'pairs': []}
        for g in gq['ground'][:TOPN]:
            r = dec(g['file'], K_GROUND)
            C, pen, qconst, d2 = terms(q, r)
            _, rp, _, rc, al = ground_geometry(q, r, scale, offset)
            rec['pairs'].append(pair_record(C, pen, qconst, d2, q, r, qc, rc, rp, {
                'rank': g['rank'], 'run': g['run'], 'file': g['file'], 'dist_m': g['dist_m'],
                'correct': g['correct'], 'align': al, 'eval_emb_dist': g['emb_dist']}))
        json.dump(rec, open(f'docs/ground/regions_{qi}.json', 'w'), separators=(',', ':'))

        # aerial tile nearest the page query
        ne = np.array([page_q['northing'], page_q['easting']])
        i = int(a_tree.query(ne)[1])
        q = dec(a_q[i]['query'], K_AERIAL)
        batch_dev.append(float(np.linalg.norm(q['e'] - aq_emb[i]) / np.linalg.norm(aq_emb[i])))
        d_all = np.sqrt(sqdist(aq_emb[i:i + 1], ad_emb)[0])
        order = [j for j in np.argsort(d_all) if j != i][:TOPN]
        origin = a_xy[i]
        arec = {'query_idx': qi, 'tile': i, 'file': a_q[i]['query'], 'tile_ne': np.round(a_xy[i], 1).tolist(),
                'ground_query_offset_m': round(float(np.linalg.norm(a_xy[i] - qxy[qi])), 1),
                'twin_rank': int((d_all < d_all[i]).sum()) + 1,
                'n_positives': len(a_pos[i]) - 1,
                'query_ids': q['labels'].tolist(), 'query_pts': np.round(q['pc_ds'] * AERIAL_M, 1).tolist(),
                'top5': [], 'pairs': []}
        qc = centroids(q['pc_ds'] * AERIAL_M, q['labels'])
        arec['query_cent'] = np.round(qc, 1).tolist()
        for rank, j in enumerate([j for j in np.argsort(d_all) if j != i][:5]):
            dxy = a_xy[j] - origin
            arec['top5'].append({'rank': rank + 1, 'tile': int(j), 'offset_en': [round(float(dxy[1]), 1), round(float(dxy[0]), 1)],
                                 'dist_m': round(float(np.linalg.norm(dxy)), 1), 'emb_dist': round(float(d_all[j]), 4)})
        for label, j in [('twin', i)] + [(f'#{n + 1}', j) for n, j in enumerate(order)]:
            r = dec(a_d[j]['query'], K_AERIAL)
            C, pen, qconst, d2 = terms(q, r)
            _, rp, _, rc = aerial_geometry(q, r, a_xy[i], a_xy[j])
            dxy = a_xy[j] - origin
            arec['pairs'].append(pair_record(C, pen, qconst, d2, q, r, qc, rc, rp, {
                'label': label, 'tile': int(j), 'file': a_d[j]['query'],
                'offset_en': [round(float(dxy[1]), 1), round(float(dxy[0]), 1)],
                'dist_m': round(float(np.linalg.norm(dxy)), 1), 'correct': bool(np.linalg.norm(dxy) <= RAD),
                'eval_emb_dist': round(float(d_all[j]), 4)}))
        json.dump(arec, open(f'docs/aerial/tile_{qi}.json', 'w'), separators=(',', ':'))
        top = rec['pairs'][0]
        print(f"query {qi}: ground #1 near-share {top['coloc']['near_share']:.2f} (chance {top['coloc']['near_chance']:.2f}) | "
              f"aerial tile {i}: twin rank {arec['twin_rank']}, #1 {arec['pairs'][1]['dist_m']} m "
              f"near-share {arec['pairs'][1]['coloc']['near_share']:.2f}", flush=True)

    # The evaluation embeds clouds in batches of 64, and the transformer attends over zero-padded points,
    # so a cloud's evaluation embedding depends on its batch. The decomposition is exact for the cloud alone.
    summary['batch_dependence'] = {'median_rel_diff': round(float(np.median(batch_dev)), 4),
                                   'max_rel_diff': round(float(np.max(batch_dev)), 4), 'n': len(batch_dev)}
    json.dump(summary, open('docs/aerial/summary.json', 'w'), separators=(',', ':'))
    print('batch dependence', summary['batch_dependence'])


if __name__ == '__main__':
    main()
