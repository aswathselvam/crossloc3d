"""Heading of ground scans, so a ground scan can be placed on the aerial map.

Ground bins are stored in the sensor frame with unknown heading (query_scale.py). Two independent
estimates of the sensor->map rotation:

  track   direction of travel from the GPS track (frames are 1 Hz, named by timestamp):
          heading_i = atan2 of pos[i+1] - pos[i-1]; undefined while the robot stands still
  fit     search yaw, shift and scale so the scan's points (all above sensor height: walls,
          trees, poles) land on tall cells of the aerial height grid (visuals/umcp_dsm_2m.npz,
          built from visuals/trim_umcp_map.las). Uses no GPS heading at all.

If both are right, fit - track is the same constant (the sensor's mounting yaw) for every frame.
`calibrate` measures that offset; `pose` then uses track heading + offset.

Run: /home/screwdriver/anaconda3/envs/crossloc/bin/python ground_heading.py   (prints calibration stats)
"""
import json
import os
import pickle

import numpy as np

B = 'data/benchmark_datasets/'
DSM = 'visuals/umcp_dsm_2m.npz'
SCALE_M = 78.8          # median ground-bin scale (query_scale.py); exact only for frames with a bag fit
TALL_M = 6.0            # a cell is "tall" if its max height is this far above the local ground (sweep on bag frames)


class HeightGrid:
    def __init__(self, path=DSM):
        d = np.load(path)
        zmax, zmin = d['zmax'], d['zmin']
        self.x0, self.y0, self.cell = float(d['x0']), float(d['y0']), float(d['cell'])
        # local ground = lowest return within ~14 m (min filter), so nDSM = height above ground
        from scipy.ndimage import minimum_filter, maximum_filter
        zmin = np.where(np.isfinite(zmin), zmin, np.nanmax(zmin[np.isfinite(zmin)]))
        ground = minimum_filter(zmin, size=7)
        ndsm = np.where(np.isfinite(zmax), zmax - ground, 0)
        tall = ndsm > TALL_M
        self.tall = maximum_filter(tall.astype(np.uint8), size=3).astype(bool)   # 1-cell tolerance
        self.ny, self.nx = tall.shape

    def frac_tall(self, e, n):
        ix = ((e - self.x0) / self.cell).astype(np.int64)
        iy = ((n - self.y0) / self.cell).astype(np.int64)
        ok = (ix >= 0) & (ix < self.nx) & (iy >= 0) & (iy < self.ny)
        out = np.zeros(e.shape, bool)
        out[ok] = self.tall[iy[ok], ix[ok]]
        return out.mean(-1)


def track_headings(entries):
    """entries: list of dicts with 'query', 'northing', 'easting'. Returns {file: heading_rad or None}
    (heading = angle of travel direction from +east, counter-clockwise)."""
    runs = {}
    for v in entries:
        runs.setdefault(v['query'].split('/')[1], []).append(v)
    out = {}
    for frames in runs.values():
        frames.sort(key=lambda v: float(os.path.basename(v['query'])[:-4]))
        t = np.array([float(os.path.basename(v['query'])[:-4]) for v in frames])
        p = np.array([[v['easting'], v['northing']] for v in frames])
        for i, v in enumerate(frames):
            # widen a window (same recording, <= 6 s each side) until the robot has moved > 3 m
            heading = None
            for w in range(1, 7):
                idx = [j for j in range(max(0, i - w), min(len(frames), i + w + 1)) if abs(t[j] - t[i]) <= w + 0.5]
                seg = p[idx]
                if np.hypot(*(seg[-1] - seg[0])) > 3.0:
                    c = seg - seg.mean(0)
                    d = np.linalg.svd(c, full_matrices=False)[2][0]      # principal direction of the window
                    if d @ (seg[-1] - seg[0]) < 0:
                        d = -d
                    heading = float(np.arctan2(d[1], d[0]))
                    break
            out[v['query']] = heading
    return out


def rot(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s], [s, c]])


def place(pts_bin, yaw, gps_en, scale=SCALE_M, offset=(0.0, 0.0), shift=(0.0, 0.0)):
    """bin points -> (easting, northing): sensor frame scaled, rotated by yaw, put at the GPS position."""
    xy = pts_bin[:, :2] * scale + np.asarray(offset)[:2]
    return xy @ rot(yaw).T + np.asarray(gps_en) + np.asarray(shift)


def fit_yaw(grid, pts_bin, gps_en, scale=SCALE_M, offset=None, yaws=72, shifts=None, scales=(0.85, 1.0, 1.15)):
    """Yaw (and, without a known offset, shift and scale) maximising the share of points on tall cells.
    Returns (yaw, score, score_profile_over_yaw)."""
    pts = pts_bin[:, :2]
    if offset is not None:          # exact scale and centroid offset known (bag frames)
        shifts, scales, base = [(0.0, 0.0)], (1.0,), np.asarray(offset)[:2]
    else:
        shifts = shifts if shifts is not None else [(dx, dy) for dx in range(-24, 25, 6) for dy in range(-24, 25, 6)]
        base = np.zeros(2)
    ys = np.linspace(0, 2 * np.pi, yaws, endpoint=False)
    prof = np.zeros(yaws)
    for k, y in enumerate(ys):
        best = 0.0
        for s in scales:
            xy = (pts * scale * s + base) @ rot(y).T + np.asarray(gps_en)
            cand = xy[None] + np.asarray(shifts, float)[:, None]
            best = max(best, float(grid.frac_tall(cand[..., 0], cand[..., 1]).max()))
        prof[k] = best
    k = int(prof.argmax())
    return float(ys[k]), float(prof[k]), prof


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def circ_mean(a):
    return float(np.arctan2(np.sin(a).mean(), np.cos(a).mean()))


def all_entries():
    db = pickle.load(open(B + 'umd_evaluation_database.pickle', 'rb'))
    q = pickle.load(open(B + 'umd_evaluation_query.pickle', 'rb'))[0]
    ground = [v for m in range(2, 14) for v in db[m].values()]
    return q, ground


def calibrate(grid, n=300, seed=0, log=print):
    """Fit yaw per frame for bag frames (exact scale) and a sample of test queries; return offset stats."""
    q, ground = all_entries()
    head = track_headings(list(q) + ground)
    rows = []
    # bag frames: exact scale + offset (docs/trajectories, run 3)
    import glob
    for f in sorted(glob.glob('docs/trajectories/query_*.json')):
        t = json.load(open(f))
        h = head.get(t['query_file'])
        pts = np.fromfile(B + t['query_file']).reshape(-1, 3)[::4]
        y, sc, _ = fit_yaw(grid, pts, (t['easting'], t['northing']), scale=t['pc_scale'], offset=t['pc_offset'])
        rows.append({'kind': 'bag', 'file': t['query_file'], 'fit': y, 'score': sc, 'track': h})
    rng = np.random.default_rng(seed)
    for i in rng.choice(len(q), min(n, len(q)), replace=False):
        v = q[i]
        h = head.get(v['query'])
        pts = np.fromfile(B + v['query']).reshape(-1, 3)[::4]
        y, sc, prof = fit_yaw(grid, pts, (v['easting'], v['northing']))
        rows.append({'kind': 'query', 'idx': int(i), 'file': v['query'], 'fit': y, 'score': sc,
                     'peak_ratio': float(sc / np.median(prof)), 'track': h})
    ok = [r for r in rows if r['track'] is not None]
    for r in ok:
        r['delta'] = float(wrap(r['fit'] - r['track']))
    bag = np.array([r['delta'] for r in ok if r['kind'] == 'bag'])
    c = circ_mean(bag) if len(bag) else circ_mean(np.array([r['delta'] for r in ok]))
    for r in ok:
        r['err'] = float(wrap(r['delta'] - c))
    stats = {}
    for kind in ('bag', 'query'):
        e = np.abs([r['err'] for r in ok if r['kind'] == kind])
        if len(e):
            stats[kind] = {'n': int(len(e)), 'within_15deg': round(float((e < np.radians(15)).mean()), 3),
                           'within_30deg': round(float((e < np.radians(30)).mean()), 3),
                           'median_abs_deg': round(float(np.degrees(np.median(e))), 1)}
    stats['offset_deg'] = round(float(np.degrees(c)), 1)
    stats['no_track_heading'] = int(sum(r['track'] is None for r in rows))
    log(json.dumps(stats))
    return c, stats, rows


if __name__ == '__main__':
    grid = HeightGrid()
    print('tall cell share', round(float(grid.tall.mean()), 3))
    c, stats, rows = calibrate(grid, n=200)
    deltas = np.degrees([r['delta'] for r in rows if 'delta' in r and r['kind'] == 'bag'])
    print('bag deltas (deg):', np.round(np.sort(deltas), 0))
