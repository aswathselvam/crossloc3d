"""Which physical structures do a ground scan and the aerial data have in common?

Uses the umd_gps_3 frames (docs/trajectories/), whose exact metric scale and sensor->centroid
offset are known from the bag (query_scale.py), and the full-resolution aerial lidar
(visuals/trim_umcp_map.las, ~22 pts/m^2, with return numbers).

1. Aerial lidar -> 1 m grid: local ground, height above ground, and a class per elevated cell:
   vegetation if many returns are multi-return (laser passes through canopy), else building/solid.
2. Each ground scan is registered in 2D to the elevated aerial cells (yaw around the GPS-track
   heading, small shift), since a ground bin only keeps points above sensor height (walls, trunks,
   canopy, poles, vehicles), and those must sit under or on something elevated in the aerial view.
3. Ground points are grouped into structures (connected 1 m cells) and each structure is labelled
   by what the aerial lidar has at the same place: building, tree, or nothing (not seen from above).
4. The same is checked against the dataset's own aerial tile (4096 points over 200 m x 200 m):
   is the structure still represented there?

Writes docs/structures/summary.json and docs/structures/frame_<k>.json, and PNG figures to --fig-dir.
Run: /home/screwdriver/anaconda3/envs/crossloc/bin/python structure_overlap.py --las las_run3.npy
"""
import argparse
import glob
import json
import os
import pickle

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

import ground_heading as gh

B = 'data/benchmark_datasets/'
CELL = 1.0
ELEV_M = 2.0          # cell counts as elevated if its top is this far above local ground
VEG_FRAC = 0.25       # elevated cell is vegetation if this share of its elevated returns are multi-return
HALF = 100.0          # analysis window half-size around the sensor (m)


def build_grid(P):
    x, y, z, rn, nr = P[:, 0], P[:, 1], P[:, 2], P[:, 3], P[:, 4]
    x0, y0 = np.floor(x.min()), np.floor(y.min())
    ix, iy = ((x - x0) / CELL).astype(int), ((y - y0) / CELL).astype(int)
    nx, ny = ix.max() + 1, iy.max() + 1
    k = iy * nx + ix
    zmin = np.full(nx * ny, np.inf); np.minimum.at(zmin, k, z)
    zmax = np.full(nx * ny, -np.inf); np.maximum.at(zmax, k, z)
    zmin, zmax = zmin.reshape(ny, nx), zmax.reshape(ny, nx)
    filled = np.where(np.isfinite(zmin), zmin, np.nanmax(zmin[np.isfinite(zmin)]))
    ground = ndimage.minimum_filter(filled, size=25)                 # lowest return within ~12 m
    ground = ndimage.uniform_filter(ground, size=9)
    hag = np.where(np.isfinite(zmax), zmax - ground, 0.0)
    pt_h = z - ground[iy, ix]
    el = pt_h > ELEV_M
    multi = np.zeros(nx * ny); cnt = np.zeros(nx * ny)
    np.add.at(cnt, k[el], 1); np.add.at(multi, k[el], (nr[el] > 1).astype(float))
    vfrac = (multi / np.maximum(cnt, 1)).reshape(ny, nx)
    elev = hag > ELEV_M
    cls = np.zeros((ny, nx), np.int8)                                  # 0 ground, 1 building/solid, 2 vegetation
    cls[elev] = np.where(vfrac[elev] >= VEG_FRAC, 2, 1)
    # tidy: majority filter, drop tiny building specks (cars, single trees misread)
    for c in (1, 2):
        lab, n = ndimage.label(cls == c)
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
        small = np.isin(lab, np.flatnonzero(sizes < (6 if c == 1 else 3)) + 1)
        cls[small] = 0 if c == 2 else 2
    # building edges: walls give multi-return pulses, so roof borders read as vegetation; give a
    # "vegetation" cell next to a building, at about the roof height, back to the building
    bld = cls == 1
    roof = ndimage.maximum_filter(np.where(bld, hag, 0), size=5)
    edge = (cls == 2) & ndimage.binary_dilation(bld, iterations=2) & (np.abs(hag - roof) < 3)
    cls[edge] = 1
    return {'x0': x0, 'y0': y0, 'nx': nx, 'ny': ny, 'ground': ground, 'hag': hag, 'cls': cls}


def G_shift(G, gps):
    return {**G, 'x0': G['x0'] - gps[0], 'y0': G['y0'] - gps[1]}


def lookup(G, e, n, key):
    ix = np.clip(((e - G['x0']) / CELL).astype(int), 0, G['nx'] - 1)
    iy = np.clip(((n - G['y0']) / CELL).astype(int), 0, G['ny'] - 1)
    return G[key][iy, ix]


def register(G, xy_s, gps, yaw0):
    """2D yaw/shift so ground points fall on elevated aerial cells (1-cell tolerance)."""
    elev = ndimage.binary_dilation(G['cls'] > 0, iterations=1)
    def score(yaw, dx, dy):
        p = xy_s @ gh.rot(yaw).T + gps + (dx, dy)
        ix = ((p[:, 0] - G['x0']) / CELL).astype(int); iy = ((p[:, 1] - G['y0']) / CELL).astype(int)
        ok = (ix >= 0) & (ix < G['nx']) & (iy >= 0) & (iy < G['ny'])
        return float(elev[iy[ok], ix[ok]].sum() / len(p))
    best = (score(yaw0, 0, 0), yaw0, 0.0, 0.0)
    for yaw in yaw0 + np.radians(np.arange(-25, 26, 1.0)):
        for dx in np.arange(-6, 6.1, 1.0):
            for dy in np.arange(-6, 6.1, 1.0):
                s = score(yaw, dx, dy)
                if s > best[0]:
                    best = (s, yaw, dx, dy)
    s, yaw, dx, dy = best
    for yaw2 in yaw + np.radians(np.arange(-1, 1.01, 0.25)):     # refine
        for dx2 in dx + np.arange(-0.75, 0.76, 0.25):
            for dy2 in dy + np.arange(-0.75, 0.76, 0.25):
                s2 = score(yaw2, dx2, dy2)
                if s2 > best[0]:
                    best = (s2, yaw2, dx2, dy2)
    return best


def structures(p_en, z_rel, G, tile_xy, tile_cls, link=1.0, min_pts=25):
    """Ground points -> structures: connected components of the 3D radius graph (link m).
    Each structure gets a shape (wall / pole / blob from the spread of its points), the aerial class at
    its location (building / tree / nothing seen from above), and the dataset-tile points within 2 m."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    X = np.column_stack([p_en, z_rel])
    pairs = cKDTree(X).query_pairs(link, output_type='ndarray')
    A = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(X), len(X)))
    _, lab = connected_components(A, directed=False)
    near = np.zeros(len(p_en), np.int8)
    for dx in (0, -1, 1):
        for dy in (0, -1, 1):
            c = lookup(G, p_en[:, 0] + dx, p_en[:, 1] + dy, 'cls')
            near = np.where((near == 0) & (c > 0), c, near)
    tt = cKDTree(tile_xy)
    out = []
    for c in np.argsort(-np.bincount(lab)):
        m = lab == c
        if m.sum() < min_pts:
            break
        e = p_en[m]
        ev = np.sort(np.linalg.eigvalsh(np.cov(e.T)))[::-1] if m.sum() > 2 else np.array([0, 0])
        length = float(np.ptp(e @ np.linalg.eigh(np.cov(e.T))[1][:, -1])) if m.sum() > 2 else 0.0
        width = 4 * float(np.sqrt(max(ev[1], 0)))
        if length < 2.0 and width < 2.0:
            shape = 'pole / trunk'
        elif ev[0] > 15 * max(ev[1], 1e-6) and length > 4:
            shape = 'wall / facade'
        else:
            shape = 'blob (canopy, bush)'
        frac = np.bincount(near[m], minlength=3) / m.sum()
        above = ['nothing', 'building', 'tree'][int(np.argmax(frac[1:]) + 1)] if frac[1:].sum() >= 0.5 else 'nothing'
        hits = sorted(set(j for lst in tt.query_ball_point(e, 2.0) for j in lst))
        out.append({'id': len(out), 'n': int(m.sum()), 'shape': shape, 'aerial': above,
                    'aerial_share': round(float(frac[1:].sum()), 2),
                    'centroid': np.round(e.mean(0), 1).tolist(), 'length_m': round(length, 1), 'width_m': round(width, 1),
                    'height_m': round(float(np.percentile(z_rel[m], 95) - np.percentile(z_rel[m], 5)), 1),
                    'dist_m': round(float(np.linalg.norm(e.mean(0) - p_en.mean(0) * 0)), 1),
                    'tile_pts': len(hits), 'tile_pts_elevated': int(sum(tile_cls[j] > 0 for j in hits)),
                    'points': np.flatnonzero(m), 'tile_idx': hits})
    return out, near


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--las', required=True)
    ap.add_argument('--fig-dir', default=None)
    args = ap.parse_args()
    os.makedirs('docs/structures', exist_ok=True)
    P = np.load(args.las)
    G = build_grid(P)
    print('grid', G['cls'].shape, 'building %.2f tree %.2f' % ((G['cls'] == 1).mean(), (G['cls'] == 2).mean()), flush=True)

    q_cat = pickle.load(open(B + 'umd_evaluation_query.pickle', 'rb'))[0]
    db = pickle.load(open(B + 'umd_evaluation_database.pickle', 'rb'))
    ground_all = [v for m in range(2, 14) for v in db[m].values()]
    heads = gh.track_headings(list(q_cat) + ground_all)
    a_items = list(db[1].values())
    a_en = np.array([[v['easting'], v['northing']] for v in a_items]); a_tree = cKDTree(a_en)

    frames = sorted(glob.glob('docs/trajectories/query_*.json'), key=lambda f: int(f.split('_')[-1][:-5]))
    rows = []
    for k, f in enumerate(frames):
        t = json.load(open(f))
        h = heads.get(t['query_file'])
        if h is None:
            continue
        gps = np.array([t['easting'], t['northing']])
        pts = np.fromfile(B + t['query_file']).reshape(-1, 3) * t['pc_scale'] + np.array(t['pc_offset'])
        s, yaw, dx, dy = register(G, pts[:, :2], gps, h + np.radians(2.5))
        base = float(np.mean([register(G, pts[:, :2], gps, a)[0] for a in (h + np.pi / 2, h + np.pi)]))   # wrong-heading control
        p_en = pts[:, :2] @ gh.rot(yaw).T + gps + (dx, dy)
        z_rel = pts[:, 2]
        j = int(a_tree.query(gps)[1])
        tile = np.fromfile(B + a_items[j]['query']).reshape(-1, 3) * 100 + np.r_[a_en[j], 0]
        t_cls = lookup(G, tile[:, 0], tile[:, 1], 'cls')
        S, near = structures(p_en - gps, z_rel, G_shift(G, gps), tile[:, :2] - gps, t_cls)
        for st in S:
            st['centroid'] = [round(st['centroid'][0], 1), round(st['centroid'][1], 1)]
            st['dist_m'] = round(float(np.hypot(*st['centroid'])), 1)
        rec = {'frame': k, 'file': t['query_file'], 'gps': np.round(gps, 1).tolist(), 'yaw_deg': round(float(np.degrees(yaw)), 1),
               'track_yaw_deg': round(float(np.degrees(h)), 1), 'shift_m': [round(dx, 2), round(dy, 2)],
               'on_elevated': round(s, 3), 'on_elevated_wrong_heading': round(base, 3),
               'point_share': {'building': round(float((near == 1).mean()), 3), 'tree': round(float((near == 2).mean()), 3),
                               'none': round(float((near == 0).mean()), 3)},
               'tile': j, 'tile_offset_m': round(float(np.linalg.norm(a_en[j] - gps)), 1),
               'tile_share': {'ground': round(float((t_cls == 0).mean()), 3), 'building': round(float((t_cls == 1).mean()), 3),
                              'tree': round(float((t_cls == 2).mean()), 3)},
               'structures': [{k2: v for k2, v in st.items() if k2 not in ('points', 'tile_idx')} for st in S]}
        rows.append(rec)
        big = sorted(S, key=lambda st: -st['n'])[:6]
        print(f"frame {k}: on elevated {s:.2f} (wrong heading {base:.2f}) | yaw fit-track {np.degrees(gh.wrap(yaw - h)):.1f} | "
              + ', '.join(f"{st['shape'][:4]}/{st['aerial'][:4]} {st['n']}pts@{st['dist_m']:.0f}m->tile{st['tile_pts']}" for st in big), flush=True)
        if args.fig_dir and k % 6 == 0:
            figure(args.fig_dir, k, G, P, gps, p_en, near, S, tile, t_cls, rec)
        sid = np.full(len(p_en), -1)
        tid = np.full(len(tile), -1)
        for st in S:
            sid[st['points']] = st['id']
            tid[st['tile_idx']] = np.where(tid[st['tile_idx']] < 0, st['id'], tid[st['tile_idx']])
        json.dump({**rec, 'ground_pts': np.round(np.column_stack([p_en - gps, z_rel]), 1).tolist(), 'ground_near': near.tolist(),
                   'ground_struct': sid.tolist(), 'tile_pts': np.round(tile - np.r_[gps, 0], 1).tolist(),
                   'tile_cls': t_cls.tolist(), 'tile_struct': tid.tolist()},
                  open(f'docs/structures/frame_{k}.json', 'w'), separators=(',', ':'))

    allS = [st for r in rows for st in r['structures']]
    def grp(f):
        g = {}
        for st in allS:
            g.setdefault(f(st), []).append(st)
        return {k2: {'structures': len(v), 'ground_points': int(sum(x['n'] for x in v)),
                     'with_tile_support': round(float(np.mean([x['tile_pts_elevated'] >= 3 for x in v])), 3),
                     'median_tile_pts': float(np.median([x['tile_pts'] for x in v])),
                     'median_ground_pts': float(np.median([x['n'] for x in v]))} for k2, v in g.items()}
    summary = {'n_frames': len(rows),
               'on_elevated': round(float(np.median([r['on_elevated'] for r in rows])), 3),
               'on_elevated_wrong_heading': round(float(np.median([r['on_elevated_wrong_heading'] for r in rows])), 3),
               'by_shape': grp(lambda st: st['shape']), 'by_aerial': grp(lambda st: st['aerial']),
               'by_shape_aerial': grp(lambda st: f"{st['shape']} | {st['aerial']}")}
    json.dump(summary, open('docs/structures/summary.json', 'w'), indent=1)
    print(json.dumps(summary, indent=1))


def figure(out, k, G, P, gps, p_en, near, S, tile, t_cls, rec):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    os.makedirs(out, exist_ok=True)
    W = 50
    cols = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#000075', '#808000']
    top = [st for st in S if st['tile_pts'] > 0][:len(cols)]
    fig = plt.figure(figsize=(19, 9.2))
    gs = fig.add_gridspec(2, 3, height_ratios=[6.2, 2.2])
    ax = [fig.add_subplot(gs[0, i]) for i in range(3)]
    m = (np.abs(P[:, 0] - gps[0]) < 2 * W) & (np.abs(P[:, 1] - gps[1]) < 2 * W)
    Q = P[m][::2]
    cl = lookup(G, Q[:, 0], Q[:, 1], 'cls'); hg = Q[:, 2] - lookup(G, Q[:, 0], Q[:, 1], 'ground')
    base = np.array([[0.78, 0.78, 0.78], [0.93, 0.58, 0.25], [0.25, 0.62, 0.32]])[cl]
    shade = np.clip(0.6 + hg / 40, 0.6, 1.0)[:, None]
    ax[0].scatter(Q[:, 0] - gps[0], Q[:, 1] - gps[1], s=0.5, c=np.clip(base * shade, 0, 1), linewidths=0)
    ax[0].scatter(p_en[:, 0] - gps[0], p_en[:, 1] - gps[1], s=0.6, c='k', linewidths=0, alpha=0.6)
    ax[0].set_title('Aerial lidar, full resolution (orange building, green tree)\nwith the registered ground scan in black', fontsize=10)
    g = p_en - gps
    ax[1].scatter(g[:, 0], g[:, 1], s=1.5, c='#c8c8c8', linewidths=0)
    for st, c in zip(top, cols):
        e = g[st['points']]
        ax[1].scatter(e[:, 0], e[:, 1], s=2.5, c=c, linewidths=0)
        ax[1].annotate(str(st['id']), e.mean(0), fontsize=9, fontweight='bold', color=c, ha='center', va='center',
                       bbox=dict(boxstyle='round,pad=0.15', fc='white', ec=c, alpha=0.9))
    ax[1].set_title(f'Ground scan ({len(g)} points), north-up, structures numbered\nmedian point {np.median(np.linalg.norm(g, axis=1)):.0f} m from the robot', fontsize=10)
    t = tile[:, :2] - gps
    ax[2].scatter(t[:, 0], t[:, 1], s=2, c=np.array(['#d0d0d0', '#f3c39b', '#a9d4ae'])[t_cls], linewidths=0)
    for st, c in zip(top, cols):
        e = t[st['tile_idx']]
        ax[2].scatter(e[:, 0], e[:, 1], s=14, c=c, linewidths=0.4, edgecolors='k')
    ax[2].plot([-W, W, W, -W, -W], [-W, -W, W, W, -W], 'k--', lw=0.8)
    n_match = len(set(j for st in S for j in st['tile_idx']))
    ax[2].set_title(f"Dataset aerial tile (4096 points, centre {rec['tile_offset_m']:.0f} m away): {n_match} points lie within 2 m of\n"
                    f"a ground structure (coloured as in the middle panel); dashed box = middle panel", fontsize=10)
    for i, a in enumerate(ax):
        lim = 2 * W if i == 2 else W
        a.set_xlim(-lim, lim); a.set_ylim(-lim, lim); a.set_aspect('equal'); a.plot(0, 0, 'k^', ms=8)
        a.set_xlabel('east (m)'); a.set_ylabel('north (m)')
    axt = fig.add_subplot(gs[1, :]); axt.axis('off')
    rows = [[str(st['id']), st['shape'], st['aerial'], str(st['n']), f"{st['dist_m']:.0f} m", f"{st['length_m']:.0f} m",
             f"{st['height_m']:.1f} m", str(st['tile_pts'])] for st in top]
    tb = axt.table(cellText=rows, colLabels=['#', 'shape (ground scan)', 'aerial lidar above it', 'ground pts', 'from robot',
                                             'length', 'height span', 'tile pts within 2 m'], loc='center', cellLoc='center')
    tb.auto_set_font_size(False); tb.set_fontsize(9); tb.scale(1, 1.25)
    for r, (st, c) in enumerate(zip(top, cols), start=1):
        tb[r, 0].set_text_props(color='white', fontweight='bold'); tb[r, 0].set_facecolor(c)
    fig.suptitle(f"run 3, frame {k} (exact scale from the bag; heading fitted {rec['yaw_deg'] - rec['track_yaw_deg']:+.0f}° from the GPS track)", fontsize=12)
    fig.tight_layout()
    fig.savefig(f'{out}/structures_frame_{k}.png', dpi=100)
    plt.close(fig)


if __name__ == '__main__':
    main()
