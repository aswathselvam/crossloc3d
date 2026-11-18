"""Ground-to-ground retrieval data for the project page (docs/ground/).

The CS-Campus3D "Aerial + Ground" evaluation averages 13 separate retrievals: the aerial
database (set 1) and 12 ground training runs (sets 2-13). This script reproduces that
evaluation with campus_best.pth (embeddings from task.step, as core/eval.py), then writes

  docs/ground/summary.json         per-database recall, pooled ground vs aerial top-1 outcome
                                   for all 1059 test queries, distance from each test query to
                                   the nearest training ground scan, and positions for a map
  docs/ground/query_<idx>.json     for each page query: top-5 retrievals from the pooled ground
                                   database (all 12 runs), aerial top-5, per-run top-1, and the
                                   retrieved scans aligned to the query (yaw + scale + shift ICP)

Run:  /home/screwdriver/anaconda3/envs/crossloc/bin/python ground_retrieval.py [--cache emb.npz]
"""
import argparse
import json
import os
import pickle

import numpy as np
import torch
from scipy.spatial import cKDTree

from datasets import create_dataloaders
from tasks import create_task
from utils import Config, Logger

B = 'data/benchmark_datasets/'
OUT = 'docs/ground'
AERIAL_SET = 1          # set 0 is the other half of the aerial patches; core/eval.py skips it (i != j)
GROUND_SETS = list(range(2, 14))
TOPK = 5
N_PTS = 1024
QUERY_SCALE_FALLBACK = 78.8   # ground bins are normalised per frame; see query_scale.py


def embed_all(cache):
    if cache and os.path.exists(cache):
        z = np.load(cache, allow_pickle=True)
        return list(z['db']), z['q']
    cfg = Config.fromfile('./configs/campus_ours.py')
    cfg.work_dir, cfg.resume_from, cfg.resume_items = './workspace/temp', './campus_best.pth', ['model']
    cfg.mode, cfg.debug = 'val', False
    log = Logger(name='ground_retrieval')
    task = create_task(cfg.task_type, cfg, log)
    if torch.cuda.is_available():
        task.cuda()
    task.load(cfg.resume_from)
    task.eval()
    (db_loader, _), (q_loader, _) = create_dataloaders(
        dataset_type=cfg.dataset_type, cfg=cfg, subset_types=('database', 'queries'), log=log, debug=False)

    def run(loader, i):
        loader.dataset.set_subset(i)
        out = []
        for meta, data in loader:
            with torch.no_grad():
                out.append(task.step(meta, data).detach().cpu().numpy())
        return np.concatenate(out, 0)

    db = [run(db_loader, i) for i in range(db_loader.dataset.subset_len())]
    q = run(q_loader, 0)
    if cache:
        np.savez(cache, db=np.array(db, dtype=object), q=q)
    return db, q


def load_bin(path, n=N_PTS, seed=0):
    pc = np.fromfile(os.path.join(B, path), dtype=np.float64).reshape(-1, 3)
    idx = np.random.default_rng(seed).choice(len(pc), size=min(n, len(pc)), replace=False)
    return pc[idx]


def align(src, dst, yaws=36, iters=30, inlier=0.02):
    """Fit src -> dst with rotation about z only: dst ~ s * Rz(yaw) @ src + t, s in [0.8, 1.25].
    Both are unrotated sensor-frame ground scans (heading unknown), so yaw is searched globally.
    Scored by the symmetric inlier fraction (NN distance < `inlier` in normalised units, ~1.6 m):
    on 16 test queries this gives median 0.31 for a scan <5 m away vs 0.135 for one >300 m away.
    Returns (s, yaw, t, overlap)."""
    tree = cKDTree(dst)
    best = None
    for y0 in np.linspace(0, 2 * np.pi, yaws, endpoint=False):
        s, yaw, t = 1.0, y0, dst.mean(0) - src.mean(0)
        for _ in range(iters):
            cur = s * src @ rz(yaw).T + t
            d, j = tree.query(cur)
            keep = d <= np.quantile(d, 0.7)          # trimmed: scans only partly overlap
            a, b = src[keep], dst[j[keep]]
            ma, mb = a.mean(0), b.mean(0)
            A, Bc = a - ma, b - mb
            # yaw from 2D Procrustes, scale from 3D least squares given yaw
            H = A[:, :2].T @ Bc[:, :2]
            yaw = np.arctan2(H[0, 1] - H[1, 0], H[0, 0] + H[1, 1])
            Ra = A @ rz(yaw).T
            s = float(np.clip((Ra * Bc).sum() / max((Ra * Ra).sum(), 1e-9), 0.8, 1.25))
            t = mb - s * ma @ rz(yaw).T
        cur = s * src @ rz(yaw).T + t
        d, _ = tree.query(cur)
        d2, _ = cKDTree(cur).query(dst)
        overlap = float(((d < inlier).mean() + (d2 < inlier).mean()) / 2)
        if best is None or overlap > best[3]:
            best = (s, float(yaw), t, overlap)
    return best


def rz(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def recall_at(D, Q, pos, ks=(1, 5, 25)):
    """D, Q embeddings; pos[i] = list of true db indices for query i. Mirrors core/eval.get_recall."""
    tree = cKDTree(D)
    _, nn = tree.query(Q, k=max(ks))
    ok = [i for i in range(len(Q)) if len(pos[i])]
    hits = {k: 0 for k in ks}
    for i in ok:
        s = set(pos[i])
        first = next((r for r, j in enumerate(nn[i]) if j in s), None)
        for k in ks:
            hits[k] += first is not None and first < k
    return {**{f'r{k}': round(100 * hits[k] / len(ok), 2) for k in ks}, 'n_queries': len(ok)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=None, help='npz to cache embeddings')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    db_cat = pickle.load(open(B + 'umd_evaluation_database.pickle', 'rb'))
    q_cat = pickle.load(open(B + 'umd_evaluation_query.pickle', 'rb'))[0]
    db_emb, q_emb = embed_all(args.cache)
    run_of = lambda m: next(iter(db_cat[m].values()))['query'].split('/')[1].split('_')[-1]
    qxy = np.array([[v['northing'], v['easting']] for v in q_cat])

    # ---- per-database recall (same protocol as the paper's 13-pair average) ----
    per_db = []
    for m in [AERIAL_SET] + GROUND_SETS:
        r = recall_at(db_emb[m], q_emb, [v[m] for v in q_cat])
        per_db.append({'set': m, 'kind': 'aerial' if m == AERIAL_SET else 'ground',
                       'run': None if m == AERIAL_SET else int(run_of(m)), 'size': len(db_cat[m]), **r})
    mean = lambda key, rows: round(float(np.mean([r[key] for r in rows])), 2)
    g_rows = [r for r in per_db if r['kind'] == 'ground']

    # ---- pooled ground database (all 12 training runs as one database) ----
    g_items = [(m, k) for m in GROUND_SETS for k in range(len(db_cat[m]))]
    g_emb = np.concatenate([db_emb[m] for m in GROUND_SETS])
    g_xy = np.array([[db_cat[m][k]['northing'], db_cat[m][k]['easting']] for m, k in g_items])
    g_offset = {}
    off = 0
    for m in GROUND_SETS:
        g_offset[m] = off
        off += len(db_cat[m])
    g_pos = [sorted(g_offset[m] + p for m in GROUND_SETS for p in v[m]) for v in q_cat]
    pooled = recall_at(g_emb, q_emb, g_pos)

    a_emb = db_emb[AERIAL_SET]
    a_xy = np.array([[v['northing'], v['easting']] for v in db_cat[AERIAL_SET].values()])
    _, g_nn = cKDTree(g_emb).query(q_emb, k=TOPK)
    a_d, a_nn = cKDTree(a_emb).query(q_emb, k=TOPK)
    g_top1_ok = np.array([g_nn[i, 0] in set(g_pos[i]) for i in range(len(q_cat))])
    a_top1_ok = np.array([a_nn[i, 0] in set(q_cat[i][AERIAL_SET]) for i in range(len(q_cat))])
    g_top1_m = np.linalg.norm(g_xy[g_nn[:, 0]] - qxy, axis=1)
    a_top1_m = np.linalg.norm(a_xy[a_nn[:, 0]] - qxy, axis=1)
    near_train, _ = cKDTree(g_xy).query(qxy)

    origin = np.floor(np.vstack([g_xy, qxy]).min(0) / 10) * 10
    loc = lambda xy: np.round(xy - origin, 1).tolist()   # [northing, easting] in metres from origin
    summary = {
        'note': 'campus_best.pth, embeddings from task.step (as core/eval.py). Success radius 100 m.',
        'per_db': per_db,
        'reported': {'aerial_r1': per_db[0]['r1'], 'ground_mean_r1': mean('r1', g_rows),
                     'all13_mean_r1': mean('r1', per_db)},
        'pooled_ground': pooled,
        'outcome': {  # top-1 within 100 m (true neighbour) for every test query
            'both': int((g_top1_ok & a_top1_ok).sum()), 'ground_only': int((g_top1_ok & ~a_top1_ok).sum()),
            'aerial_only': int((~g_top1_ok & a_top1_ok).sum()), 'neither': int((~g_top1_ok & ~a_top1_ok).sum())},
        'queries': {'ne': loc(qxy), 'nearest_train_m': np.round(near_train, 1).tolist(),
                    'ground_top1_m': np.round(g_top1_m, 1).tolist(), 'aerial_top1_m': np.round(a_top1_m, 1).tolist(),
                    'ground_ok': g_top1_ok.astype(int).tolist(), 'aerial_ok': a_top1_ok.astype(int).tolist()},
        'train_ground': {str(int(run_of(m))): loc(np.array([[v['northing'], v['easting']] for v in db_cat[m].values()]))
                         for m in GROUND_SETS},
    }
    json.dump(summary, open(f'{OUT}/summary.json', 'w'), separators=(',', ':'))
    print('per-db r1:', [(r['run'] or 'aerial', r['r1']) for r in per_db])
    print('pooled ground', pooled, '| outcome', summary['outcome'])
    print('nearest training ground scan: median %.1f m' % np.median(near_train))

    # ---- per page query ----
    meta = json.load(open('docs/metadata.json'))
    for entry in meta:
        qi = entry['query_idx']
        page_q = json.load(open(f'docs/queries/query_{qi}.json'))
        scale = page_q.get('pc_scale', QUERY_SCALE_FALLBACK)
        offset = np.array(page_q.get('pc_offset', [0, 0, 0]))
        q_pts = load_bin(q_cat[qi]['query'])
        to_m = lambda p: p * scale + offset
        rec = {'query_idx': qi, 'location': entry['location'], 'category': entry['category'],
               'query_file': q_cat[qi]['query'], 'pc_scale': scale, 'pc_scale_source': page_q.get('pc_scale_source', 'estimate'),
               'query_ne': loc(qxy[qi]), 'query_pts': np.round(to_m(q_pts), 2).tolist(),
               'nearest_train_m': round(float(near_train[qi]), 1), 'ground': [], 'aerial': [], 'per_run': []}
        pos = set(g_pos[qi])
        qd = np.linalg.norm(g_emb - q_emb[qi], axis=1)
        for rank, j in enumerate(g_nn[qi]):
            m, k = g_items[j]
            item = db_cat[m][k]
            pts = load_bin(item['query'], seed=1)
            s, yaw, t, overlap = align(pts, q_pts)
            aligned = to_m(s * pts @ rz(yaw).T + t)
            rec['ground'].append({
                'rank': rank + 1, 'run': int(run_of(m)), 'file': item['query'],
                'ne': loc(g_xy[j]), 'dist_m': round(float(np.linalg.norm(g_xy[j] - qxy[qi])), 1),
                'correct': bool(j in pos), 'emb_dist': round(float(qd[j]), 4),
                'align': {'yaw_deg': round(np.degrees(yaw) % 360, 1), 'scale_ratio': round(s, 3),
                          'overlap': round(overlap, 3)},
                'pts': np.round(aligned, 2).tolist()})
        for rank, j in enumerate(a_nn[qi]):
            rec['aerial'].append({'rank': rank + 1, 'ne': loc(a_xy[j]),
                                  'dist_m': round(float(np.linalg.norm(a_xy[j] - qxy[qi])), 1),
                                  'correct': bool(j in set(q_cat[qi][AERIAL_SET])), 'emb_dist': round(float(a_d[qi, rank]), 4)})
        for m in GROUND_SETS:
            d = np.linalg.norm(db_emb[m] - q_emb[qi], axis=1)
            j = int(np.argmin(d))
            xy = np.array([db_cat[m][j]['northing'], db_cat[m][j]['easting']])
            rec['per_run'].append({'run': int(run_of(m)), 'has_positive': len(q_cat[qi][m]) > 0,
                                   'correct': j in set(q_cat[qi][m]), 'dist_m': round(float(np.linalg.norm(xy - qxy[qi])), 1),
                                   'nearest_in_run_m': round(float(np.min(np.linalg.norm(
                                       np.array([[v['northing'], v['easting']] for v in db_cat[m].values()]) - qxy[qi], axis=1))), 1)})
        # alignment baseline: overlap of the same fit against a random far-away ground scan
        far = [j for j in range(len(g_items)) if np.linalg.norm(g_xy[j] - qxy[qi]) > 300]
        j = far[np.random.default_rng(qi).integers(len(far))]
        rec['random_far_overlap'] = round(align(load_bin(db_cat[g_items[j][0]][g_items[j][1]]['query'], seed=1), q_pts)[3], 3)
        rec['random_far_dist_m'] = round(float(np.linalg.norm(g_xy[j] - qxy[qi])), 1)
        json.dump(rec, open(f'{OUT}/query_{qi}.json', 'w'), separators=(',', ':'))
        print(f"query {qi}: ground top1 run {rec['ground'][0]['run']} {rec['ground'][0]['dist_m']} m "
              f"{'OK' if rec['ground'][0]['correct'] else 'x'} overlap {rec['ground'][0]['align']['overlap']} "
              f"(far {rec['random_far_overlap']}) | aerial {rec['aerial'][0]['dist_m']} m")


if __name__ == '__main__':
    main()
