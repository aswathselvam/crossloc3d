"""Region-level explanation of why a query retrieved a database submap.

Both point clouds are over-segmented into compact 3D regions (SLIC-style k-means on
metric xyz, with height up-weighted so ground and vertical structures separate).
The retrieval score is then decomposed *exactly* into region-pair contributions:

  NetVLAD sums per-point residuals, VLAD = sum_i r_i, so a region's VLAD block is the
  sum over its points. Everything after the sum (intra/global L2 norms, hidden1,
  BatchNorm scale, context gates, final L2 norm) is a fixed linear map once its
  normalizers/gates are taken from the full cloud. Hence

      e = sum_R u_R + u_bias      and      score = <e_q, e_r> = sum_{R,R'} <u_R, u'_R'> + bias terms

  where u_bias is the BatchNorm shift (it belongs to no region). The script verifies
  that the decomposition reproduces the model's own score.

Fields added to each step of docs/queries/*.json and docs/trajectories/query_*.json:
  query_region_ids / region_ids : region id per displayed point (1024 each)
  query_region_contrib / region_contrib : each region's total contribution (sums to the score)
  region_pairs  : top pairs [q_region, r_region, contribution, share_of_score]
  region_score  : {"score", "region_pairs_sum", "bias_terms"}

Usage:
  python region_attribution.py --analyze     # validation stats only, writes nothing
  python region_attribution.py               # update JSON files in place
"""
import argparse
import glob
import json
import os

import numpy as np
import torch
import torch.nn.functional as F

from collect_visualization_data import forward_step, downsample_pc
from datasets import create_dataloaders
from tasks import create_task
from utils import Config, Logger

QUERY_SCALE_M = 78.8  # median ground-scan scale (query_scale.py); k-means labels are scale-invariant
DB_SCALE_M = 100.0
K_QUERY = 12        # regions over a ~160 m ground scan
K_DB = 24           # ~30-40 m regions over a 200 m aerial submap
Z_WEIGHT = 3.0      # up-weight height so ground / walls / canopy separate
N_PAIRS = 10


def load_model():
    cfg = Config.fromfile('./configs/campus_ours.py')
    cfg.work_dir = './workspace/temp'
    cfg.resume_from = './campus_best.pth'
    cfg.resume_items = ['model']
    cfg.mode = 'val'
    cfg.debug = False
    log = Logger(name='R3D_regions')
    task = create_task(cfg.task_type, cfg, log)
    if torch.cuda.is_available():
        task.cuda()
    task.load(cfg.resume_from)
    task.eval()
    db_loader, _ = create_dataloaders(dataset_type=cfg.dataset_type, cfg=cfg,
                                      subset_types='database', log=log, debug=False)
    return cfg, task, db_loader


def kmeans(X, k, seed=0, iters=50):
    """k-means++ init + Lloyd iterations (deterministic)."""
    rng = np.random.default_rng(seed)
    k = min(k, len(X))
    centers = [X[rng.integers(len(X))]]
    for _ in range(1, k):
        d = np.min(((X[:, None] - np.array(centers)[None]) ** 2).sum(-1), axis=1)
        centers.append(X[rng.choice(len(X), p=d / d.sum())])
    C = np.array(centers)
    for _ in range(iters):
        lab = ((X[:, None] - C[None]) ** 2).sum(-1).argmin(1)
        newC = np.array([X[lab == j].mean(0) if np.any(lab == j) else C[j] for j in range(k)])
        if np.allclose(newC, C):
            break
        C = newC
    lab = ((X[:, None] - C[None]) ** 2).sum(-1).argmin(1)
    # relabel to 0..m-1 without gaps
    _, lab = np.unique(lab, return_inverse=True)
    return lab


def segment(pc_ds, scale_m, k):
    X = pc_ds * scale_m
    X = X * np.array([1.0, 1.0, Z_WEIGHT])
    return kmeans(X, k)


def forward_full(model, data):
    """Like collect_visualization_data.forward_step, but with every refinement step fused (Ours3DFPN.forward),
    so the embedding equals the one core/eval.py ranks with. Returns (emb, point features, coords, strides)."""
    xs, _ = data
    bb = model.backbone
    order = list(range(len(xs))) if bb.fine_to_coarse else list(range(len(xs)))[::-1]
    new_xs, coords_list, strides = [], [], []
    for i in order:
        x = bb.up_conv0_lst[i](xs[i])
        for conv, block in zip(bb.up_convs_lst[i], bb.up_blocks_lst[i]):
            x = block(conv(x))
        coords_list.append(x.decomposed_coordinates[0].cpu().numpy())
        strides.append(int(x.tensor_stride[0]))
        new_xs.append(torch.nn.utils.rnn.pad_sequence(x.decomposed_features, batch_first=True).permute(0, 2, 1))
    x_fused = bb.conv_fuse(bb.diff_transformer(new_xs, None))
    emb = model.pool.net_vlad(x_fused.permute(0, 2, 1))
    return emb, x_fused[0], coords_list, strides


def region_embeddings(task, cfg, db_loader, filename, step, scale_m, k):
    """Return dict with display points, region ids, per-region embedding parts u_R, bias part, full embedding."""
    dataset = db_loader.dataset
    raw = np.fromfile(os.path.join(dataset.data_root_dir, filename), dtype=np.float64).reshape(-1, 3)
    data = {'pcd': raw.astype(np.float32)}
    if dataset.transform:
        data = dataset.transform(data)
    meta_b, data_b = db_loader.collate_fn([({'idx': 0, 'filename': filename}, data)])
    task.step(meta_b, data_b)
    model = task.model
    with torch.no_grad():
        if step is None:   # full model (all refinement steps fused), i.e. the evaluation embedding
            emb_ref, x_fused, coords_list, strides = forward_full(model, (data_b['pcd'][0], data_b['raw_pcd'][0]))
        else:
            emb_ref, x_fused, coords_list, strides = forward_step(
                model, (data_b['pcd'][0], data_b['raw_pcd'][0]), step, return_point_features=True)

        # Network points -> regions (via nearest displayed point, voxel centers in normalized coords)
        pc_ds = downsample_pc(raw, n_points=1024)
        labels_ds = segment(pc_ds, scale_m, k)
        n_scales = len(coords_list)
        order = list(range(n_scales)) if model.backbone.fine_to_coarse else list(range(n_scales))[::-1]
        q_sizes = cfg.model_cfg.quantization_size
        centers = np.concatenate([(c.astype(np.float32) + s / 2.0) * q_sizes[o]
                                  for c, s, o in zip(coords_list, strides, order)])
        nn_ds = torch.cdist(torch.from_numpy(centers), torch.from_numpy(pc_ds).float()).argmin(1).numpy()
        labels_net = labels_ds[nn_ds]
        assert len(labels_net) == x_fused.shape[1]

        # ---- NetVLAD, decomposed (mirrors NetVLADLoupe.forward in eval mode) ----
        nv = model.pool.net_vlad
        x = x_fused.t()                                   # (N, D)
        act = x @ nv.cluster_weights                      # (N, K)
        act = nv.bn1(act) if nv.add_batch_norm else act + nv.cluster_biases
        act = torch.softmax(act, dim=-1)                  # alpha_ik
        # per-point residual blocks summed per region: V_R[d, k] = sum_{i in R} alpha_ik (x_id - c_dk)
        c2 = nv.cluster_weights2[0]                       # (D, K)
        lab_t = torch.from_numpy(labels_net).to(x.device)
        n_regions = int(labels_ds.max()) + 1
        V_R = []
        mass = torch.tensor([(lab_t == r).sum().item() for r in range(n_regions)],
                            dtype=x.dtype, device=x.device) / len(lab_t)
        for r in range(n_regions):
            m = lab_t == r
            if m.sum() == 0:
                V_R.append(torch.zeros_like(c2))
                continue
            a = act[m]                                    # (n, K)
            V_R.append(x[m].t() @ a - c2 * a.sum(0, keepdim=True))
        V_R = torch.stack(V_R)                            # (R, D, K)
        V = V_R.sum(0)                                    # full VLAD (D, K)
        intra = V.norm(dim=0, keepdim=True).clamp_min(1e-12)       # F.normalize(dim=1) on (bs, D, K)
        Vn = V / intra
        glob_n = Vn.reshape(-1).norm().clamp_min(1e-12)
        def head_linear(Vblock):  # fixed-normalizer linear map from a VLAD block to pre-BN space
            return (Vblock / intra).reshape(-1) / glob_n @ nv.hidden1_weights
        z_R = torch.stack([head_linear(V_R[r]) for r in range(n_regions)])   # (R, out)
        z = z_R.sum(0)
        bn = nv.bn2
        s = bn.weight / torch.sqrt(bn.running_var + bn.eps)
        b = bn.bias - bn.running_mean * s
        y = s * z + b
        if nv.gating:
            g = nv.context_gating
            gates = y @ g.gating_weights
            gates = g.bn1(gates.unsqueeze(0))[0] if g.add_batch_norm else gates + g.gating_biases
            gates = torch.sigmoid(gates)
        else:
            gates = torch.ones_like(y)
        e = y * gates
        assert torch.allclose(e, emb_ref[0], atol=1e-4, rtol=1e-3), \
            f'decomposition mismatch: {float((e - emb_ref[0]).abs().max()):.2e}'
        norm = e.norm() if cfg.eval_cfg.normalize_embeddings else torch.tensor(1.0, device=e.device)
        # BatchNorm shift belongs to no region; share it out by point mass so the parts still sum to e.
        u_bias = (gates * b) / norm
        u_R = (gates * s * z_R) / norm + mass[:, None] * u_bias[None]   # (R, out)
        e_final = e / norm
    return {'pc_ds': pc_ds, 'labels': labels_ds, 'u_R': u_R.cpu().numpy(),
            'u_bias': u_bias.cpu().numpy(), 'e': e_final.cpu().numpy()}


def attribute(q, r):
    C = q['u_R'] @ r['u_R'].T                         # (Rq, Rr) region-pair contributions (sum == score)
    bias = 0.0                                        # shift already distributed by point mass
    score = float(q['e'] @ r['e'])
    assert abs(C.sum() + bias - score) < 1e-3, (C.sum() + bias, score)
    flat = np.argsort(-C, axis=None)[:N_PAIRS]
    pairs = [[int(i // C.shape[1]), int(i % C.shape[1]), float(C.flat[i]),
              float(C.flat[i] / score) if score else 0.0] for i in flat]
    return C, pairs, score, bias


def centroid_xy(pc_ds, labels, scale_m, off=(0.0, 0.0)):
    return np.array([pc_ds[labels == j, :2].mean(0) * scale_m + np.array(off) for j in range(labels.max() + 1)])


def process_file(path, task, cfg, db_loader, analyze, stats):
    with open(path) as f:
        entry = json.load(f)
    for step_key, st in entry['steps'].items():
        step = int(step_key)
        q = region_embeddings(task, cfg, db_loader, entry['query_file'], step, QUERY_SCALE_M, K_QUERY)
        r = region_embeddings(task, cfg, db_loader, st['retrieved_file'], step, DB_SCALE_M, K_DB)
        assert np.allclose(q['pc_ds'], np.array(entry['pc_local']), atol=1e-5)
        assert np.allclose(r['pc_ds'], np.array(st['pc_local']), atol=1e-5)
        C, pairs, score, bias = attribute(q, r)

        # Validation: is the top pair's retrieved region where the query actually is (GPS)?
        off = (entry['easting'] - st['easting'], entry['northing'] - st['northing'])
        # query in meters around the sensor (pc_scale / pc_offset from query_scale.py)
        q_scale = entry.get('pc_scale', QUERY_SCALE_M)
        q_off = entry.get('pc_offset', [0.0, 0.0, 0.0])
        qc = centroid_xy(q['pc_ds'], q['labels'], q_scale, (off[0] + q_off[0], off[1] + q_off[1]))
        rc = centroid_xy(r['pc_ds'], r['labels'], DB_SCALE_M)
        top_d = [float(np.linalg.norm(qc[i] - rc[j])) for i, j, _, _ in pairs[:3]]
        # Baseline: distance from query regions to all retrieved regions
        all_d = np.linalg.norm(qc[:, None] - rc[None], axis=2).ravel()
        r_contrib = C.sum(0)
        q_center = np.array(off)
        r_dist = np.linalg.norm(rc - q_center, axis=1)
        stats.append({'correct': st['is_correct'], 'inside': max(abs(off[0]), abs(off[1])) < DB_SCALE_M,
                      'top_d': top_d, 'all_d_med': float(np.median(all_d)),
                      'r_rank_nearest': int((np.argsort(-r_contrib) == r_dist.argmin()).nonzero()[0][0]),
                      'n_r': len(rc), 'bias_share': bias / score if score else 0.0,
                      'top1_share': pairs[0][3], 'top3_share': sum(p[3] for p in pairs[:3]), 'step': step})

        if not analyze:
            st['query_region_ids'] = q['labels'].tolist()
            st['region_ids'] = r['labels'].tolist()
            st['query_region_contrib'] = [round(float(v), 5) for v in C.sum(1)]
            st['region_contrib'] = [round(float(v), 5) for v in C.sum(0)]
            st['region_pairs'] = [[i, j, round(c, 5), round(sh, 4)] for i, j, c, sh in pairs]
            # full (query regions x retrieved regions) contribution matrix; sums to the score
            st['region_matrix'] = [[round(float(v), 6) for v in row] for row in C]
            st['region_score'] = {'score': round(score, 5), 'region_pairs_sum': round(float(C.sum()), 5),
                                  'bias_terms': round(bias, 5)}
    if not analyze:
        with open(path, 'w') as f:
            json.dump(entry, f)


def summarize(name, stats):
    for label, sel in [('correct', [s for s in stats if s['correct']]),
                       ('incorrect', [s for s in stats if not s['correct']])]:
        if not sel:
            continue
        print(f'[{name}] {label}: {len(sel)} pairs | top-1 pair share of score {np.median([s["top1_share"] for s in sel]) * 100:.1f}% '
              f'| top-3 {np.median([s["top3_share"] for s in sel]) * 100:.1f}% | bias terms {np.median([s["bias_share"] for s in sel]) * 100:.1f}%')
        ins = [s for s in sel if s['inside']]
        if ins:
            print(f'[{name}]   query inside submap ({len(ins)}): top-3 pair centroid distance median '
                  f'{np.median(np.concatenate([s["top_d"] for s in ins])):.1f} m vs any-pair median {np.median([s["all_d_med"] for s in ins]):.1f} m; '
                  f'retrieved region under the query ranks #{np.median([s["r_rank_nearest"] + 1 for s in ins]):.0f} of ~{np.median([s["n_r"] for s in ins]):.0f} by contribution')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--analyze', action='store_true', help='print validation stats; do not write files')
    ap.add_argument('--only', choices=['queries', 'trajectories'])
    args = ap.parse_args()
    cfg, task, db_loader = load_model()
    sets = {'queries': sorted(glob.glob('docs/queries/query_*.json')),
            'trajectories': sorted(glob.glob('docs/trajectories/query_*.json'))}
    for name, files in sets.items():
        if args.only and name != args.only:
            continue
        stats = []
        for i, path in enumerate(files):
            process_file(path, task, cfg, db_loader, args.analyze, stats)
            print(f'[{name}] {i + 1}/{len(files)} {path}', flush=True)
        summarize(name, stats)


if __name__ == '__main__':
    main()
