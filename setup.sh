#!/bin/bash
set -e

echo "=== Step 1: Creating Conda Environment 'crossloc' ==="
conda env create -f environment.yml -y || conda env update -f environment.yml

# Find Conda prefix path
CONDA_ACTIVE_ENV_PATH=$(conda info --base)/envs/crossloc

echo "=== Step 2: Compiling MinkowskiEngine ==="
cd MinkowskiEngine

# Clean previous build artifacts
$CONDA_ACTIVE_ENV_PATH/bin/python setup.py clean

# Recompile and install
# We use max jobs 4 to avoid overloading the system and specify the conda prefix BLAS include directories
CONDA_PREFIX=$CONDA_ACTIVE_ENV_PATH MAX_JOBS=4 \
$CONDA_ACTIVE_ENV_PATH/bin/python setup.py install \
  --blas_include_dirs=$CONDA_ACTIVE_ENV_PATH/include \
  --blas=openblas

echo "=== Installation completed successfully! ==="
echo "To activate the environment, run:"
echo "conda activate crossloc"
