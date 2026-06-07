import laspy
import numpy as np
import json

def main():
    print("Reading visuals/trim_umcp_map.las...")
    las = laspy.read('visuals/trim_umcp_map.las')
    total_points = len(las)
    print(f"Loaded {total_points} points.")
    
    # Downsample by factor of 41 to get ~1.2M points (another 2x more points)
    factor = 41
    indices = np.arange(0, total_points, factor)
    
    print(f"Downsampling to {len(indices)} points...")
    x = np.array(las.x[indices], dtype=np.float32)
    y = np.array(las.y[indices], dtype=np.float32)
    z = np.array(las.z[indices], dtype=np.float32)
    
    red = np.array(las.red[indices], dtype=np.uint8)
    green = np.array(las.green[indices], dtype=np.uint8)
    blue = np.array(las.blue[indices], dtype=np.uint8)
    
    # Center coordinates around (332100, 4317500)
    x_centered = x - 332100.0
    y_centered = y - 4317500.0
    
    data = []
    for i in range(len(indices)):
        data.append([
            float(x_centered[i]),
            float(y_centered[i]),
            float(z[i]),
            int(red[i]),
            int(green[i]),
            int(blue[i])
        ])
        
    output_file = 'visuals/global_map_downsampled.json'
    print(f"Saving to {output_file}...")
    with open(output_file, 'w') as f:
        json.dump(data, f)
    print("Successfully saved downsampled global map.")

if __name__ == '__main__':
    main()
