"""Region contribution analysis for ground -> aerial retrieval (the paper's cross-source task).

Same decomposition as retrieval_regions.py (full evaluation embedding, Euclidean ranking criterion):
    -1/2 ||q - r||^2 = sum_ab <u_a, v_b>  -  1/2 sum_b <v_b, r>  -  1/2 ||q||^2

To compare region positions, the ground scan is put on the map (ground_heading.py):
  rotation  GPS-track heading + mounting offset; the offset is calibrated on the umd_gps_3 frames, whose
            exact scale and offset are known from the bag, by fitting their yaw to the aerial height grid
  scale     78.8 m per unit (median; true per-frame scale is 45-101 m)
  position  GPS = sensor; the bin is centred on its point centroid, which is ~11 m from the sensor
            (median on bag frames) in an unknown direction -> treated as 0
so ground-to-aerial centroid distances carry ~10-20 m of error. Aerial tiles are exact (x100, north-up).
Frames where the robot stands still take the heading of the nearest moving frame (<= 30 s away).

Writes docs/ground_aerial/summary.json and docs/ground_aerial/query_<idx>.json.
Run: /home/screwdriver/anaconda3/envs/crossloc/bin/python ground_aerial_regions.py --cache emb.npz
"""
import argparse
import glob
import json
import os
import pickle

import numpy as np
from scipy.spatial import cKDTree

import ground_heading as gh
from ground_retrieval import B, AERIAL_SET, embed_all, QUERY_SCALE_FALLBACK
from retrieval_regions import (Decomposer, terms, centroids, coloc, pair_record, summarise, sqdist,
                               K_GROUND, K_AERIAL, AERIAL_M, NEAR_M, RAD)

OUT = 'docs/ground_aerial'
N_STATS = 100
FILL_S = 30.0


def headings_filled(entries):
    """Track heading per file; stationary frames borrow the nearest moving frame of the same run."""
    raw = gh.track_headings(entries)
    by_run = {}
    for v in entries:
        by_run.setdefault(v['query'].split('/')[1], []).append(v['query'])
    out = {}
    for files in by_run.values():
        t = {f: float(os.path.basename(f)[:-4]) for f in files}
        moving = [f for f in files if raw[f] is not None]
        for f in files:
            if raw[f] is not None:
                out[f] = (raw[f], 0.0)
                continue
            if not moving:
                out[f] = (None, None)
                continue
            g = min(moving, key=lambda m: abs(t[m] - t[f]))
            dt = abs(t[g] - t[f])
            out[f] = (raw[g], dt) if dt <= FILL_S else (None, None)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=None)
    ap.add_argument('--n-stats', type=int, default=N_STATS)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(0)

    db_cat = pickle.load(open(B + 'umd_evaluation_database.pickle', 'rb'))
    q_cat = pickle.load(open(B + 'umd_evaluation_query.pickle', 'rb'))[0]
    db_emb, q_emb = embed_all(args.cache)
    a_items = list(db_cat[AERIAL_SET].values())
    a_emb = db_emb[AERIAL_SET]
    a_en = np.array([[v['easting'], v['northing']] for v in a_items])
    q_en = np.array([[v['easting'], v['northing']] for v in q_cat])
    a_tree = cKDTree(a_en)

    # ---------- heading calibration ----------
    grid = gh.HeightGrid()
    offset, cal_stats, cal_rows = gh.calibrate(grid, n=0)
    heads = headings_filled(list(q_cat) + [v for m in range(2, 14) for v in db_cat[m].values()])
    bag_deltas = [round(float(np.degrees(r['delta'])), 1) for r in cal_rows if r['kind'] == 'bag' and 'delta' in r]

    # ---------- retrieval statistics ----------
    D2 = sqdist(q_emb, a_emb)
    order = np.argsort(D2, axis=1)
    top1 = order[:, 0]
    off1 = np.linalg.norm(a_en[top1] - q_en, axis=1)
    nearest_tile = a_tree.query(q_en)[1]
    rank_nearest = np.array([int(np.flatnonzero(order[i] == nearest_tile[i])[0]) + 1 for i in range(len(q_cat))])
    pos = a_tree.query_ball_point(q_en, RAD)
    first_pos = np.array([next((r + 1 for r, j in enumerate(order[i, :500]) if j in set(pos[i])), 501) for i in range(len(q_cat))])
    hist_edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 300, 500, 1000, 2000]
    summary = {
        'note': 'campus_best.pth, full evaluation embedding (batched as core/eval.py), Euclidean distance. '
                'Queries: ground scans of runs 13-19; database: aerial set 1 (all tiles, sample _1).',
        'n_queries': len(q_cat), 'n_tiles': len(a_items),
        'r1': round(100 * float((first_pos <= 1).mean()), 2), 'r5': round(100 * float((first_pos <= 5).mean()), 2),
        'r25': round(100 * float((first_pos <= 25).mean()), 2),
        'median_top1_m': round(float(np.median(off1)), 1),
        'top1_within': {str(m): round(100 * float((off1 <= m).mean()), 1) for m in (25, 50, 100, 200)},
        'top1_hist': {'edges': hist_edges, 'counts': np.histogram(np.clip(off1, 0, 1999), bins=hist_edges)[0].tolist()},
        'nearest_tile_rank': {'median': int(np.median(rank_nearest)), 'top1': round(100 * float((rank_nearest == 1).mean()), 1),
                              'top25': round(100 * float((rank_nearest <= 25).mean()), 1),
                              'quantiles': [int(np.percentile(rank_nearest, p)) for p in (10, 25, 50, 75, 90)]},
        'heading': {'offset_deg': cal_stats['offset_deg'], 'bag': cal_stats.get('bag'), 'bag_deltas_deg': bag_deltas,
                    'queries_with_heading': int(sum(heads[v['query']][0] is not None for v in q_cat)),
                    'queries_moving': int(sum(heads[v['query']][1] == 0.0 for v in q_cat))},
    }
    print(json.dumps({k: v for k, v in summary.items() if k not in ('top1_hist',)}), flush=True)

    dec = Decomposer()

    def q_geom(i, q, scale=QUERY_SCALE_FALLBACK, zoff=0.0):
        h = heads[q_cat[i]['query']][0]
        if h is None:
            return None, None
        yaw = h + offset
        xy = gh.place(q['pc_ds'], yaw, (0.0, 0.0), scale=scale)           # metres, east/north around the GPS position
        pts = np.column_stack([xy, q['pc_ds'][:, 2] * scale + zoff])
        return pts, centroids(pts, q['labels'])

    def a_geom(i, j, r):
        off = np.array([a_en[j, 0] - q_en[i, 0], a_en[j, 1] - q_en[i, 1], 0.0])
        pts = r['pc_ds'] * AERIAL_M + off
        return pts, centroids(pts, r['labels'])

    # ---------- co-location statistics ----------
    ok = np.array([top1[i] in set(pos[i]) for i in range(len(q_cat))])
    has_h = np.array([heads[v['query']][0] is not None for v in q_cat])
    # controls: same pairs with a random heading, and a rotation-free check (region distance from the sensor
    # vs aerial region distance from the GPS point, "near" = within 15 m) that needs no heading at all
    stats = {k: [] for k in ('correct', 'nearest_tile', 'correct_random_heading', 'correct_radial', 'nearest_tile_radial')}
    for cat, pool in (('correct', np.flatnonzero(ok & has_h)), ('nearest_tile', np.flatnonzero(has_h))):
        for i in rng.choice(pool, min(args.n_stats, len(pool)), replace=False):
            j = nearest_tile[i] if cat == 'nearest_tile' else top1[i]
            q, r = dec(q_cat[i]['query'], K_GROUND), dec(a_items[j]['query'], K_AERIAL)
            C = terms(q, r)[0]
            _, qc = q_geom(i, q)
            _, rc = a_geom(i, j, r)
            stats[cat].append(coloc(C, qc, rc))
            qr = np.linalg.norm(centroids(q['pc_ds'] * QUERY_SCALE_FALLBACK, q['labels']), axis=1)
            D = np.abs(qr[:, None] - np.linalg.norm(rc, axis=1)[None])
            pos_c = np.clip(C, 0, None)
            stats[cat + '_radial'].append({'near_share': float(pos_c[D < 15].sum() / max(pos_c.sum(), 1e-12)),
                                           'near_chance': float((D < 15).mean()),
                                           'top_d': float(np.median(D.flat[np.argsort(-C, axis=None)[:3]])),
                                           'all_d': float(np.median(D))})
            if cat == 'correct':
                yaw = rng.uniform(0, 2 * np.pi)
                xy = gh.place(q['pc_ds'], yaw, (0.0, 0.0))
                stats['correct_random_heading'].append(coloc(C, centroids(xy, q['labels']), rc))
        print(cat, summarise(stats[cat]), summarise(stats[cat + '_radial']), flush=True)
    summary['coloc'] = {'near_m': NEAR_M, 'radial_near_m': 15, 'top_n': 3, **{k: summarise(v) for k, v in stats.items()}}
    json.dump(summary, open(f'{OUT}/summary.json', 'w'), separators=(',', ':'))

    # ---------- per page query ----------
    for entry in json.load(open('docs/metadata.json')):
        qi = entry['query_idx']
        page_q = json.load(open(f'docs/queries/query_{qi}.json'))
        scale = page_q.get('pc_scale', QUERY_SCALE_FALLBACK)
        zoff = page_q.get('pc_offset', [0, 0, 0])[2]
        q = dec(q_cat[qi]['query'], K_GROUND)
        qp, qc = q_geom(qi, q, scale, zoff)
        h, dt = heads[q_cat[qi]['query']]
        rec = {'query_idx': qi, 'query_ids': q['labels'].tolist(),
               'heading_deg': None if h is None else round(float(np.degrees(h + offset)), 1),
               'heading_from_neighbour_s': dt, 'nearest_tile_rank': int(rank_nearest[qi]),
               'nearest_tile_m': round(float(np.linalg.norm(a_en[nearest_tile[qi]] - q_en[qi])), 1),
               'first_correct_rank': int(first_pos[qi]), 'pairs': []}
        if qp is None:   # no heading: show the scan in its sensor frame, no distances
            qp = np.column_stack([q['pc_ds'][:, :2] * scale, q['pc_ds'][:, 2] * scale + zoff])
            qc = centroids(qp, q['labels'])
        rec['query_pts'] = np.round(qp, 1).tolist()
        rec['query_cent'] = np.round(qc, 1).tolist()
        cand = [(f'#{k + 1}', int(order[qi, k])) for k in range(3)]
        cand.append(('true tile', int(nearest_tile[qi])))
        for label, j in cand:
            r = dec(a_items[j]['query'], K_AERIAL)
            C, pen, qconst, d2 = terms(q, r)
            rp, rc = a_geom(qi, j, r)
            dxy = a_en[j] - q_en[qi]
            p = pair_record(C, pen, qconst, d2, q, r, qc, rc, rp, {
                'label': label, 'tile': j, 'rank': int(np.flatnonzero(order[qi] == j)[0]) + 1,
                'offset_en': [round(float(dxy[0]), 1), round(float(dxy[1]), 1)],
                'dist_m': round(float(np.hypot(*dxy)), 1), 'correct': bool(np.hypot(*dxy) <= RAD),
                'eval_emb_dist': round(float(np.sqrt(D2[qi, j])), 4)})
            if h is None:
                p['coloc'] = None
                for t in p['top_pairs']:
                    t[3] = None
            rec['pairs'].append(p)
        json.dump(rec, open(f'{OUT}/query_{qi}.json', 'w'), separators=(',', ':'))
        print(f"query {qi}: heading {rec['heading_deg']} (dt {dt}) | #1 {rec['pairs'][0]['dist_m']} m | "
              f"true tile rank {rec['nearest_tile_rank']}", flush=True)


if __name__ == '__main__':
    main()
