import torch
import torch.nn.functional as F
import numpy as np
import pickle as pkl
import os
import json
import utm
from tqdm import tqdm

from utils import Config, Logger
from datasets import create_dataloaders
from tasks import create_task

def forward_step(model, data, step_idx):
    xs, pcd = data
    new_xs = []
    if model.backbone.fine_to_coarse:
        order = list(range(len(xs)))
    else:
        order = list(range(len(xs))[::-1])

    for i in order:
        x = model.backbone.up_conv0_lst[i](xs[i])
        for _, (conv, block) in enumerate(zip(model.backbone.up_convs_lst[i], model.backbone.up_blocks_lst[i])):
            x = conv(x)
            x = block(x)
        features = x.decomposed_features
        x = torch.nn.utils.rnn.pad_sequence(features, batch_first=True)
        x = x.permute(0, 2, 1)
        new_xs.append(x)

    diff_transformer = model.backbone.diff_transformer
    x = new_xs[0]
    xs_out = [torch.cat(new_xs, dim=2)]
    f_p = None
    for i in range(len(diff_transformer.q_size)):
        for j in range(diff_transformer.step_size):
            t = i * diff_transformer.step_size + j
            attn_layer = diff_transformer.attn_layers[t]
            if diff_transformer.time_dim < 1:
                t_embed = None
            else:
                t_embed = diff_transformer.time_mlp(torch.full([new_xs[0].shape[0]], t, device=new_xs[0].device))

            x = attn_layer(x, t_embed, f_p)

        xs_out.append(torch.cat([x] + new_xs[i + 1:], dim=2))

        if i != len(diff_transformer.q_size) - 1:
            x = torch.cat([x, new_xs[i + 1]], dim=2)
            
    target_xs = xs_out[step_idx]
    bs, c, n_pts = target_xs.shape
    fused_input = torch.zeros(bs, 256, n_pts, device=target_xs.device, dtype=target_xs.dtype)
    fused_input[:, step_idx*64 : (step_idx+1)*64] = target_xs
    
    x_fused = model.backbone.conv_fuse(fused_input)
    embeddings = model.pool.net_vlad(x_fused.permute(0, 2, 1))
    return embeddings

def downsample_pc(pc, n_points=1024):
    # pc is (N, 3)
    if len(pc) > n_points:
        idx = np.linspace(0, len(pc) - 1, n_points, dtype=int)
        return pc[idx]
    return pc

def project_pc_to_latlon(pc, center_northing, center_easting, scale=20.0, utm_zone=18, utm_band='N'):
    # pc is (N, 3) normalized in [-1, 1], scale by specified meters
    projected = []
    for pt in pc:
        dx, dy, dz = pt[0] * scale, pt[1] * scale, pt[2] * scale
        n = center_northing + dy
        e = center_easting + dx
        lat, lon = utm.to_latlon(e, n, utm_zone, utm_band)
        projected.append([lat, lon, dz])
    return projected

def main():
    cfg = Config.fromfile("./configs/campus_ours.py")
    cfg.work_dir = "./workspace/temp"
    cfg.resume_from = "./campus_best.pth"
    cfg.resume_items = ['model']
    cfg.mode = 'val'
    cfg.debug = False
    
    log = Logger(name='R3D_collect')
    task = create_task(cfg.task_type, cfg, log)
    if torch.cuda.is_available():
        task.cuda()
    task.load(cfg.resume_from)
    task.eval()
    
    (db_loader, _), (q_loader, _) = create_dataloaders(
        dataset_type=cfg.dataset_type,
        cfg=cfg,
        subset_types=('database', 'queries'),
        log=log,
        debug=cfg.debug
    )
    
    # Set subsets
    db_loader.dataset.set_subset(1)
    q_loader.dataset.set_subset(0)
    
    # Load metadata
    db_metadata = []
    for meta, data in db_loader:
        for idx in range(len(meta['idx'])):
            db_metadata.append({
                'idx': len(db_metadata),
                'query': meta['filename'][idx],
                'northing': meta['northing'][idx],
                'easting': meta['easting'][idx]
            })
            
    q_metadata = []
    for meta, data in q_loader:
        for idx in range(len(meta['idx'])):
            q_metadata.append({
                'idx': len(q_metadata),
                'query': meta['filename'][idx],
                'northing': meta['northing'][idx],
                'easting': meta['easting'][idx],
                'true_neighbors': q_loader.dataset.catalog[0][len(q_metadata)][1]
            })
            
    # Curated query indices mapped by location and category to visualizer demands
    query_metadata = {
        32: ("Central Plaza Area", "Stable Success"),
        1: ("Central Plaza Area", "Refinement Success"),
        17: ("Central Plaza Area", "Success to Failure"),
        0: ("Central Plaza Area", "Failure Case"),
        412: ("Southwest Campus Area", "Stable Success"),
        508: ("Southwest Campus Area", "Refinement Success"),
        425: ("Southwest Campus Area", "Success to Failure"),
        430: ("Southwest Campus Area", "Failure Case"),
        765: ("Western Roads", "Stable Success"),
        783: ("Western Roads", "Refinement Success"),
        761: ("Western Roads", "Success to Failure"),
        757: ("Western Roads", "Failure Case"),
        304: ("South Campus Area", "Stable Success"),
        278: ("South Campus Area", "Refinement Success"),
        211: ("South Campus Area", "Success to Failure"),
        186: ("South Campus Area", "Failure Case"),
        1022: ("Eastern Edge Roads", "Stable Success"),
        1021: ("Eastern Edge Roads", "Refinement Success"),
        1023: ("Eastern Edge Roads", "Success to Failure"),
        1035: ("Eastern Edge Roads", "Failure Case")
    }
    query_indices = list(query_metadata.keys())
    
    # Build embeddings for these steps
    db_embs = {1: [], 2: [], 3: []}
    q_embs = {1: [], 2: [], 3: []}
    
    db_loader.dataset.set_subset(1)
    for meta, data in tqdm(db_loader, desc="DB embeddings"):
        task.step(meta, data)
        pcd, raw_pcd = data['pcd'][0], data['raw_pcd'][0]
        with torch.no_grad():
            for step in [1, 2, 3]:
                embs = forward_step(task.model, (pcd, raw_pcd), step)
                if cfg.eval_cfg.normalize_embeddings:
                    embs = F.normalize(embs, p=2, dim=1)
                db_embs[step].append(embs.cpu().numpy())
                
    q_loader.dataset.set_subset(0)
    for meta, data in tqdm(q_loader, desc="Query embeddings"):
        task.step(meta, data)
        pcd, raw_pcd = data['pcd'][0], data['raw_pcd'][0]
        with torch.no_grad():
            for step in [1, 2, 3]:
                embs = forward_step(task.model, (pcd, raw_pcd), step)
                if cfg.eval_cfg.normalize_embeddings:
                    embs = F.normalize(embs, p=2, dim=1)
                q_embs[step].append(embs.cpu().numpy())
                
    for step in [1, 2, 3]:
        db_embs[step] = np.concatenate(db_embs[step], axis=0)
        q_embs[step] = np.concatenate(q_embs[step], axis=0)
        
    visualization_data = []
    
    for q_idx in query_indices:
        q_meta = q_metadata[q_idx]
        true_neighs = q_meta['true_neighbors']
        
        # Load and project query point cloud
        q_pc_raw = q_loader.dataset.load_pc(q_meta['query'])
        q_pc_ds = downsample_pc(q_pc_raw, n_points=1024)
        q_lat, q_lon = utm.to_latlon(q_meta['easting'], q_meta['northing'], 18, 'N')
        q_pc_global = project_pc_to_latlon(q_pc_ds, q_meta['northing'], q_meta['easting'], scale=20.0)
        
        query_entry = {
            'query_idx': q_idx,
            'query_file': q_meta['query'],
            'location': query_metadata[q_idx][0],
            'category': query_metadata[q_idx][1],
            'northing': q_meta['northing'],
            'easting': q_meta['easting'],
            'lat': q_lat,
            'lon': q_lon,
            'pc_local': q_pc_ds.tolist(),
            'pc_global': q_pc_global,
            'steps': {}
        }
        
        for step in [1, 2, 3]:
            q_emb = q_embs[step][q_idx]
            dists = np.linalg.norm(db_embs[step] - q_emb, axis=1)
            
            # Sort retrievals to find top items
            sorted_indices = np.argsort(dists)
            top1_idx = int(sorted_indices[0])
            is_correct = top1_idx in true_neighs
            
            db_item = db_metadata[top1_idx]
            db_pc_raw = db_loader.dataset.load_pc(db_item['query'])
            db_pc_ds = downsample_pc(db_pc_raw, n_points=1024)
            db_lat, db_lon = utm.to_latlon(db_item['easting'], db_item['northing'], 18, 'N')
            db_pc_global = project_pc_to_latlon(db_pc_ds, db_item['northing'], db_item['easting'], scale=100.0)
            
            dist_to_query = float(np.sqrt((db_item['northing'] - q_meta['northing'])**2 + 
                                         (db_item['easting'] - q_meta['easting'])**2))
            
            query_entry['steps'][str(step)] = {
                'retrieved_idx': top1_idx,
                'retrieved_file': db_item['query'],
                'northing': db_item['northing'],
                'easting': db_item['easting'],
                'lat': db_lat,
                'lon': db_lon,
                'dist_to_query_meters': dist_to_query,
                'is_correct': bool(is_correct),
                'pc_local': db_pc_ds.tolist(),
                'pc_global': db_pc_global
            }
            
        visualization_data.append(query_entry)
        print(f"Collected visualization data for Query {q_idx}")
        
    # Write to json file
    output_file = 'visualization_data.json'
    with open(output_file, 'w') as f:
        json.dump(visualization_data, f)
    print(f"Successfully wrote visualization data to {output_file}")

if __name__ == '__main__':
    main()
