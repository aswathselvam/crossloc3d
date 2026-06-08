import laspy
import numpy as np
import json
import os

def main():
    # 1. Dynamically calculate UTM crop bounds from query files
    print("Calculating rectangular bounds from visualization queries...")
    queries_dir = 'docs/queries'
    query_centers = []
    
    # Read query centers from docs/queries json files
    for filename in os.listdir(queries_dir):
        if filename.endswith('.json'):
            with open(os.path.join(queries_dir, filename), 'r') as f:
                q = json.load(f)
                qx = q['easting'] - 332100.0
                qy = q['northing'] - 4317500.0
                query_centers.append((qx, qy))
                for step in ['1', '2', '3']:
                    step_data = q['steps'][step]
                    rx = step_data['easting'] - 332100.0
                    ry = step_data['northing'] - 4317500.0
                    query_centers.append((rx, ry))
                    
    query_centers = np.array(query_centers)
    margin = 150.0
    min_x_centered = np.min(query_centers[:, 0]) - margin
    max_x_centered = np.max(query_centers[:, 0]) + margin
    min_y_centered = np.min(query_centers[:, 1]) - margin
    max_y_centered = np.max(query_centers[:, 1]) + margin
    
    # Convert back to absolute UTM coordinates for las filtering
    min_x_utm = min_x_centered + 332100.0
    max_x_utm = max_x_centered + 332100.0
    min_y_utm = min_y_centered + 4317500.0
    max_y_utm = max_y_centered + 4317500.0
    
    print(f"UTM Crop Box Bounds:")
    print(f"X (Easting): [{min_x_utm:.2f}, {max_x_utm:.2f}]")
    print(f"Y (Northing): [{min_y_utm:.2f}, {max_y_utm:.2f}]")
    
    # 2. Read LAS file
    print("Reading visuals/trim_umcp_map.las...")
    las = laspy.read('visuals/trim_umcp_map.las')
    total_points = len(las)
    print(f"Loaded {total_points} total points from LAS file.")
    
    # Extract absolute UTM coordinates
    x_abs = np.array(las.x, dtype=np.float32)
    y_abs = np.array(las.y, dtype=np.float32)
    
    # Filter points falling inside the rectangular crop box
    print("Applying rectangular crop box...")
    crop_mask = (x_abs >= min_x_utm) & (x_abs <= max_x_utm) & (y_abs >= min_y_utm) & (y_abs <= max_y_utm)
    cropped_indices = np.where(crop_mask)[0]
    cropped_count = len(cropped_indices)
    print(f"Points remaining after rectangular crop: {cropped_count} ({cropped_count/total_points*100:.2f}%)")
    
    # 3. Downsample the cropped points with a much denser factor (e.g. factor = 8 instead of 10)
    factor = 8
    downsampled_indices = cropped_indices[::factor]
    print(f"Downsampling cropped points by factor of {factor} to {len(downsampled_indices)} points (high density)...")
    
    x = np.array(las.x[downsampled_indices], dtype=np.float32)
    y = np.array(las.y[downsampled_indices], dtype=np.float32)
    z = np.array(las.z[downsampled_indices], dtype=np.float32)
    
    red = np.array(las.red[downsampled_indices], dtype=np.uint8)
    green = np.array(las.green[downsampled_indices], dtype=np.uint8)
    blue = np.array(las.blue[downsampled_indices], dtype=np.uint8)
    
    # Centered coordinates
    x_centered = x - 332100.0
    y_centered = y - 4317500.0
    
    # Save dense version (factor = 4) as binary file
    output_bin_file = 'docs/visuals/global_map_downsampled.bin'
    print(f"Saving dense binary cropped map to {output_bin_file}...")
    os.makedirs(os.path.dirname(output_bin_file), exist_ok=True)
    
    num_points = len(downsampled_indices)
    
    # Coordinates: flat float32 array [x1, y1, z1, x2, y2, z2, ...]
    coords = np.stack([x_centered, y_centered, z], axis=1).astype(np.float32)
    coords_bytes = coords.tobytes()
    
    # Colors: flat uint8 array [r1, g1, b1, r2, g2, b2, ...]
    colors = np.stack([red, green, blue], axis=1).astype(np.uint8)
    colors_bytes = colors.tobytes()
    
    # Build buffer
    out_buffer = bytearray(4 + len(coords_bytes) + len(colors_bytes))
    import struct
    struct.pack_into('<I', out_buffer, 0, num_points)
    out_buffer[4 : 4 + len(coords_bytes)] = coords_bytes
    out_buffer[4 + len(coords_bytes) :] = colors_bytes
    
    with open(output_bin_file, 'wb') as f:
        f.write(out_buffer)
    print(f"Successfully saved dense binary global map ({num_points} points).")
    
    # Save lightweight fallback json (using a larger factor like 30)
    fallback_factor = 30
    fallback_indices = cropped_indices[::fallback_factor]
    print(f"Saving lightweight fallback JSON (factor {fallback_factor}, {len(fallback_indices)} points)...")
    
    x_fb = np.array(las.x[fallback_indices], dtype=np.float32) - 332100.0
    y_fb = np.array(las.y[fallback_indices], dtype=np.float32) - 4317500.0
    z_fb = np.array(las.z[fallback_indices], dtype=np.float32)
    red_fb = np.array(las.red[fallback_indices], dtype=np.uint8)
    green_fb = np.array(las.green[fallback_indices], dtype=np.uint8)
    blue_fb = np.array(las.blue[fallback_indices], dtype=np.uint8)
    
    fallback_data = []
    for i in range(len(fallback_indices)):
        fallback_data.append([
            float(x_fb[i]),
            float(y_fb[i]),
            float(z_fb[i]),
            int(red_fb[i]),
            int(green_fb[i]),
            int(blue_fb[i])
        ])
        
    output_json_file = 'docs/visuals/global_map_downsampled.json'
    with open(output_json_file, 'w') as f:
        json.dump(fallback_data, f)
    print("Successfully saved fallback JSON.")

if __name__ == '__main__':
    main()
