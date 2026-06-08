import json
import numpy as np
import os

def main():
    viz_data_file = 'visualization_data.json'
    if not os.path.exists(viz_data_file):
        viz_data_file = 'docs/visualization_data.json'
    
    with open(viz_data_file, 'r') as f:
        viz_data = json.load(f)
    
    # 1. Split visualization_data.json for On-Demand Query Loading
    print("Splitting visualization_data.json into metadata and individual queries...")
    metadata = []
    queries_dir = 'docs/queries'
    os.makedirs(queries_dir, exist_ok=True)
    
    # Extract centered UTM coordinates for all query/retrieved centers to define the rectangular crop box
    query_centers = []
    
    for idx, q in enumerate(viz_data):
        # Save lightweight metadata for dropdown initialization
        metadata.append({
            'index': idx,
            'query_idx': q['query_idx'],
            'location': q['location'],
            'category': q['category']
        })
        
        # Save individual query details to its own file
        query_file_path = os.path.join(queries_dir, f"query_{q['query_idx']}.json")
        with open(query_file_path, 'w') as f_q:
            json.dump(q, f_q)
            
        # Add centers for cropping bounds
        qx = q['easting'] - 332100.0
        qy = q['northing'] - 4317500.0
        query_centers.append((qx, qy))
        
        for step in ['1', '2', '3']:
            step_data = q['steps'][step]
            rx = step_data['easting'] - 332100.0
            ry = step_data['northing'] - 4317500.0
            query_centers.append((rx, ry))
            
    # Save the metadata list
    with open('docs/metadata.json', 'w') as f_meta:
        json.dump(metadata, f_meta)
    print(f"Saved metadata.json and {len(viz_data)} query JSON files in docs/queries/.")
            
    print("Query splitting completed successfully.")

if __name__ == '__main__':
    main()
