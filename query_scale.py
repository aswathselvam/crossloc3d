"""Attach the true metric scale of each ground query to the website JSONs.

How CS-Campus3D bins are normalized (verified against raw data, see below):
  * Aerial database bins: centroid-centred, half-extent ~100 m -> x100 is correct
    (3D fit against visuals/trim_umcp_map.las at the CSV easting/northing).
  * Ground query bins: the FULL Velodyne frame (points above roughly sensor height,
    no range crop), centred on its point centroid and divided by half of its own
    largest XY extent. The scale therefore differs per frame (49-101 m in umd_gps_3,
    median ~82 m) and the CSV coordinate (robot GPS) is the sensor position, not the
    centroid. Verified against /velodyne_points in umd_gps_3.bag.

For frames whose bag is available the exact scale and sensor->centroid offset are
fitted against the raw scan (scaled ICP; residual ~0 m). Otherwise the scale falls back to the median of the bag
frames, and the vertical offset is recovered from the bin itself (the lowest kept
point sits at sensor height, z = 0). The horizontal offset is unknown -> 0.

Writes per query JSON: pc_scale (m), pc_offset ([x, y, z] m, sensor frame: point in
meters relative to the GPS position = pc_local * pc_scale + pc_offset), pc_scale_source
('bag' | 'estimate'), and regenerates pc_global ([lat, lon, z]) with them.

Usage (crossloc env, needs rosbag for the bag part):
    python query_scale.py [--bag umd_gps_3.bag]
"""
import argparse
import glob
import json
import os

import numpy as np
import utm

DATA_ROOT = 'data/benchmark_datasets/'
JSON_GLOBS = ['docs/queries/query_*.json', 'docs/trajectories/query_*.json']
UTM_ZONE, UTM_BAND = 18, 'N'


def load_bin(rel):
    return np.fromfile(os.path.join(DATA_ROOT, rel), dtype=np.float64).reshape(-1, 3)


def bag_scans(bag_path):
    """{unix second: [raw xyz scans in that second]} from /velodyne_points."""
    import rosbag
    import sensor_msgs.point_cloud2 as pc2
    out = {}
    with rosbag.Bag(bag_path) as bag:
        for _, msg, _ in bag.read_messages(topics=['/velodyne_points']):
            p = np.array(list(pc2.read_points(msg, field_names=('x', 'y', 'z'), skip_nans=True)))
            out.setdefault(int(msg.header.stamp.to_sec()), []).append(p)
    return out


def fit_to_scan(q, raw, iters=40):
    """Find scale s and offset c with q * s + c on the raw scan (scaled ICP).

    Initialised from the bin recipe (points above the sensor, centroid-centred, divided
    by half the largest XY extent), then refined; returns (s, c, median residual m).
    """
    from scipy.spatial import cKDTree
    above = raw[raw[:, 2] > 0]
    s, c = np.ptp(above[:, :2], 0).max() / 2, above.mean(0)
    tree = cKDTree(raw)
    for _ in range(iters):
        dist, idx = tree.query(q * s + c)
        keep = dist <= np.percentile(dist, 80)
        x, y = q[keep], raw[idx[keep]]
        xm, ym = x.mean(0), y.mean(0)
        s = ((x - xm) * (y - ym)).sum() / ((x - xm) ** 2).sum()
        c = ym - s * xm
    return float(s), c, float(np.median(tree.query(q * s + c)[0]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bag', default='umd_gps_3.bag')
    args = ap.parse_args()

    paths = sorted(sum((glob.glob(g) for g in JSON_GLOBS), []))
    entries = []
    for path in paths:
        with open(path) as f:
            d = json.load(f)
        rel = d['query_file']
        run = rel.split('/')[1].replace('umcp_lidar5_ground_', '')
        ts = int(os.path.splitext(os.path.basename(rel))[0])
        entries.append((path, d, run, ts, load_bin(rel)))

    # Exact fits for frames whose raw scan is in the bag, keyed by (run, timestamp).
    exact = {}
    if os.path.exists(args.bag):
        bag_run = os.path.splitext(os.path.basename(args.bag))[0]  # e.g. umd_gps_3
        scans = bag_scans(args.bag)
        for path, d, run, ts, q in entries:
            if run == bag_run and ts in scans and (run, ts) not in exact:
                s, c, res = min((fit_to_scan(q, raw) for raw in scans[ts]), key=lambda r: r[2])
                # height of the lowest kept point relative to the sensor
                exact[(run, ts)] = (s, c, res, q[:, 2].min() * s + c[2])
        res = [r[2] for r in exact.values()]
        print(f'{args.bag}: fitted {len(exact)} frames, residual median {np.median(res):.3f} m, max {np.max(res):.3f} m')

    # Fallback calibrated on the exact fits: median scale, and the median height of the
    # lowest kept point relative to the sensor (the bin filter keeps a little below z = 0).
    if exact:
        default_scale = float(np.median([r[0] for r in exact.values()]))
        low = float(np.median([r[3] for r in exact.values()]))
    else:
        default_scale, low = 82.0, -1.4
    print(f'fallback: scale {default_scale:.1f} m, lowest point {low:.2f} m below sensor')

    for path, d, run, ts, bin_pc in entries:
        if (run, ts) in exact:
            scale, c = exact[(run, ts)][:2]
            # Bin * scale + c = raw scan in the sensor frame (sensor at the GPS position).
            offset = [float(v) for v in c]
            source = 'bag'
        else:
            scale = default_scale
            offset = [0.0, 0.0, float(low - bin_pc[:, 2].min() * scale)]
            source = 'estimate'

        pc = np.asarray(d['pc_local']) * scale + np.asarray(offset)
        lat, lon = utm.to_latlon(d['easting'] + pc[:, 0], d['northing'] + pc[:, 1], UTM_ZONE, UTM_BAND)
        d['pc_global'] = [[float(a), float(b), float(z)] for a, b, z in zip(lat, lon, pc[:, 2])]
        d['pc_scale'] = round(scale, 3)
        d['pc_offset'] = [round(v, 3) for v in offset]
        d['pc_scale_source'] = source
        with open(path, 'w') as f:
            json.dump(d, f)
        print(f'{path}: {source} scale {scale:.1f} m offset {np.round(offset, 1).tolist()}')


if __name__ == '__main__':
    main()
