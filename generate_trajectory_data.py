import torch
import torch.nn.functional as F
import numpy as np
import pickle as pkl
import os
import json
import utm
from tqdm import tqdm
from scipy.spatial import cKDTree

from utils import Config, Logger
from datasets import create_dataloaders
from tasks import create_task
from collect_visualization_data import forward_step, downsample_pc, project_pc_to_latlon

def main():
    cfg = Config.fromfile("./configs/campus_ours.py")
    cfg.work_dir = "./workspace/temp"
    cfg.resume_from = "./campus_best.pth"
    cfg.resume_items = ['model']
    cfg.mode = 'val'
    cfg.debug = False
    
    log = Logger(name='R3D_traj_gen')
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
    
    # Load all training query metadata from pickle to identify indices and metadata
    training_pickle_path = 'data/benchmark_datasets/training_queries_umd_4096.pickle'
    with open(training_pickle_path, 'rb') as f:
        train_catalog = pkl.load(f)
    
    # Find all queries in bag3 and sort them by timestamp
    bag3_queries = []
    for k, q_item in train_catalog.items():
        if isinstance(q_item, dict) and 'umd_gps_3' in q_item.get('query', ''):
            bag3_queries.append((k, q_item))
    
    # Sort by query filename (which naturally sorts by timestamp)
    bag3_queries = sorted(bag3_queries, key=lambda x: x[1]['query'])
    print(f"Found {len(bag3_queries)} queries in umd_gps_3.")
    
    # Load DB metadata
    db_loader.dataset.set_subset(1)
    db_metadata = []
    for meta, data in db_loader:
        for idx in range(len(meta['idx'])):
            db_metadata.append({
                'idx': len(db_metadata),
                'query': meta['filename'][idx],
                'northing': meta['northing'][idx],
                'easting': meta['easting'][idx]
            })
            
    # Compute DB embeddings
    db_embs = {1: [], 2: [], 3: []}
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
    for step in [1, 2, 3]:
        db_embs[step] = np.concatenate(db_embs[step], axis=0)

    # Helper: load a point cloud from training catalog and prepare it as a
    # single-element batch using the db_loader's collate pipeline. The
    # db_loader and q_loader share the same data_root_dir and the same eval
    # transforms (ToTensor only), so we can use either one.
    dataset = db_loader.dataset          # EvalDataset instance
    data_root_dir = dataset.data_root_dir
    transform = dataset.transform        # Compose([ToTensor])
    collate_fn = db_loader.collate_fn    # handles quantization etc.

    def load_query_batch(q_item, key):
        """Load a training-catalog query as a collated single-element batch."""
        filename = q_item['query']
        pcd = np.fromfile(os.path.join(data_root_dir, filename), dtype=np.float64)
        pcd = pcd.reshape((-1, 3)).astype(np.float32)
        meta_single = {
            'idx': key,
            'filename': filename,
            'northing': q_item['northing'],
            'easting': q_item['easting'],
        }
        data_single = {'pcd': pcd}
        if transform:
            data_single = transform(data_single)   # numpy -> tensor
        return collate_fn([(meta_single, data_single)])

    # Directory to store individual trajectory queries
    os.makedirs('docs/trajectories', exist_ok=True)
    
    trajectory_metadata = []
    
    for traj_idx, (k, q_item) in enumerate(tqdm(bag3_queries, desc="Processing Trajectory")):
        # Load and project query point cloud (for visualization JSON)
        q_pc_raw = np.fromfile(
            os.path.join(data_root_dir, q_item['query']), dtype=np.float64
        ).reshape((-1, 3))
        q_pc_ds = downsample_pc(q_pc_raw, n_points=1024)
        q_lat, q_lon = utm.to_latlon(q_item['easting'], q_item['northing'], 18, 'N')
        q_pc_global = project_pc_to_latlon(q_pc_ds, q_item['northing'], q_item['easting'], scale=20.0)
        
        # Load query data batch for model forward pass
        q_meta_batch, q_data_batch = load_query_batch(q_item, k)
        task.step(q_meta_batch, q_data_batch)
        q_pcd_batch = q_data_batch['pcd'][0]
        q_raw_pcd_batch = q_data_batch['raw_pcd'][0]
        
        # Compute query embeddings for steps 1, 2, 3
        q_step_embs = {}
        with torch.no_grad():
            for step in [1, 2, 3]:
                embs = forward_step(task.model, (q_pcd_batch, q_raw_pcd_batch), step)
                if cfg.eval_cfg.normalize_embeddings:
                    embs = F.normalize(embs, p=2, dim=1)
                q_step_embs[step] = embs.cpu().numpy()[0]
        
        query_entry = {
            'trajectory_idx': traj_idx,
            'query_idx': k,
            'query_file': q_item['query'],
            'northing': q_item['northing'],
            'easting': q_item['easting'],
            'lat': q_lat,
            'lon': q_lon,
            'pc_local': q_pc_ds.tolist(),
            'pc_global': q_pc_global,
            'steps': {}
        }
        
        # Track if the final step (Step 3) is correct
        final_is_correct = False
        
        for step in [1, 2, 3]:
            q_emb = q_step_embs[step]
            dists = np.linalg.norm(db_embs[step] - q_emb, axis=1)
            sorted_indices = np.argsort(dists)
            top1_idx = int(sorted_indices[0])
            
            # Positives in catalog for this training query
            positives = q_item['positives']
            is_correct = top1_idx in positives
            if step == 3:
                final_is_correct = is_correct
            
            db_item = db_metadata[top1_idx]
            db_pc_raw = dataset.load_pc(db_item['query'])
            db_pc_ds = downsample_pc(db_pc_raw, n_points=1024)
            db_lat, db_lon = utm.to_latlon(db_item['easting'], db_item['northing'], 18, 'N')
            db_pc_global = project_pc_to_latlon(db_pc_ds, db_item['northing'], db_item['easting'], scale=100.0)
            
            dist_to_query = float(np.sqrt((db_item['northing'] - q_item['northing'])**2 + 
                                         (db_item['easting'] - q_item['easting'])**2))
            
            # Re-evaluate the top-1 retrieved item with Grad-CAM
            db_item_data = dataset[top1_idx]
            db_meta_batch, db_data_batch = collate_fn([db_item_data])
            task.step(db_meta_batch, db_data_batch)
            db_pcd_batch = db_data_batch['pcd'][0]
            db_raw_pcd_batch = db_data_batch['raw_pcd'][0]
            db_emb_cam, cam, coords_list = forward_step(task.model, (db_pcd_batch, db_raw_pcd_batch), step, return_gradcam=True, query_emb=torch.tensor(q_emb, device=next(task.model.parameters()).device).unsqueeze(0))

            # Continuous coordinates for the 3 scales
            coords_2_cont = coords_list[0] * 0.4
            coords_1_cont = coords_list[1] * 0.12
            coords_0_cont = coords_list[2] * 0.05
            
            N2 = len(coords_2_cont)
            N1 = len(coords_1_cont)
            N0 = len(coords_0_cont)
            
            cam_2 = cam[0 : N2]
            cam_1 = cam[N2 : N2+N1]
            cam_0 = cam[N2+N1 : N2+N1+N0]
            
            # Map points to nearest voxel at each scale
            tree_2 = cKDTree(coords_2_cont)
            _, idxs_2 = tree_2.query(db_pc_ds, k=1)
            weights_2 = cam_2[idxs_2]
            
            tree_1 = cKDTree(coords_1_cont)
            _, idxs_1 = tree_1.query(db_pc_ds, k=1)
            weights_1 = cam_1[idxs_1]
            
            tree_0 = cKDTree(coords_0_cont)
            _, idxs_0 = tree_0.query(db_pc_ds, k=1)
            weights_0 = cam_0[idxs_0]
            
            # Fuse/average weights across scales
            point_weights = (weights_2 + weights_1 + weights_0) / 3.0
            if np.max(point_weights) > 0:
                point_weights = point_weights - np.min(point_weights)
                point_weights = point_weights / np.max(point_weights)

            # Re-evaluate the query point cloud with Grad-CAM
            db_emb_step = db_embs[step][top1_idx]
            db_emb_tensor = torch.tensor(db_emb_step, device=next(task.model.parameters()).device).unsqueeze(0)
            q_emb_cam, q_cam, q_coords_list = forward_step(task.model, (q_pcd_batch, q_raw_pcd_batch), step, return_gradcam=True, query_emb=db_emb_tensor)

            # Continuous coordinates for the 3 scales for query
            q_coords_2_cont = q_coords_list[0] * 0.4
            q_coords_1_cont = q_coords_list[1] * 0.12
            q_coords_0_cont = q_coords_list[2] * 0.05
            
            q_N2 = len(q_coords_2_cont)
            q_N1 = len(q_coords_1_cont)
            q_N0 = len(q_coords_0_cont)
            
            q_cam_2 = q_cam[0 : q_N2]
            q_cam_1 = q_cam[q_N2 : q_N2+q_N1]
            q_cam_0 = q_cam[q_N2+q_N1 : q_N2+q_N1+q_N0]
            
            # Map query points to nearest voxel at each scale
            q_tree_2 = cKDTree(q_coords_2_cont)
            _, q_idxs_2 = q_tree_2.query(q_pc_ds, k=1)
            q_weights_2 = q_cam_2[q_idxs_2]
            
            q_tree_1 = cKDTree(q_coords_1_cont)
            _, q_idxs_1 = q_tree_1.query(q_pc_ds, k=1)
            q_weights_1 = q_cam_1[q_idxs_1]
            
            q_tree_0 = cKDTree(q_coords_0_cont)
            _, q_idxs_0 = q_tree_0.query(q_pc_ds, k=1)
            q_weights_0 = q_cam_0[q_idxs_0]
            
            # Fuse/average query weights across scales
            q_point_weights = (q_weights_2 + q_weights_1 + q_weights_0) / 3.0
            if np.max(q_point_weights) > 0:
                q_point_weights = q_point_weights - np.min(q_point_weights)
                q_point_weights = q_point_weights / np.max(q_point_weights)
            
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
                'pc_global': db_pc_global,
                'attention_heatmap': point_weights.tolist(),
                'query_attention_heatmap': q_point_weights.tolist()
            }
            
        # Write individual query JSON
        with open(f"docs/trajectories/query_{traj_idx}.json", "w") as f_q:
            json.dump(query_entry, f_q)
            
        # Add to trajectory metadata
        filename = q_item['query'].split('/')[-1]
        timestamp = filename.split('.')[0]
        trajectory_metadata.append({
            'trajectory_idx': traj_idx,
            'query_idx': k,
            'filename': filename,
            'timestamp': int(timestamp),
            'northing': q_item['northing'],
            'easting': q_item['easting'],
            'lat': q_lat,
            'lon': q_lon,
            'is_correct': final_is_correct
        })
        
    # Write metadata json file
    with open('docs/trajectory_metadata.json', 'w') as f_meta:
        json.dump(trajectory_metadata, f_meta)
    print("Successfully generated docs/trajectory_metadata.json and individual query details.")

if __name__ == '__main__':
    main()
