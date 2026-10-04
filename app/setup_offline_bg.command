#!/bin/zsh
# Installs optional offline background removal and face detection dependencies.
# The server uses these packages and models for Passport and smart placement.
# Install offline background removal for Ellashop.
cd "$(dirname "$0")/.." || exit 1
if [[ ! -x app/.venv/bin/python3 ]]; then
  python3 -m venv app/.venv || exit 1
fi
app/.venv/bin/python3 -m pip install -r app/requirements.txt || exit 1
if [[ ! -f app/models/face_detection_yunet_2023mar.onnx ]]; then
  mkdir -p app/models || exit 1
  curl -fL --retry 2 -o app/models/face_detection_yunet_2023mar.onnx \
    https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx || {
      rm -f app/models/face_detection_yunet_2023mar.onnx
      echo "Could not download the YuNet face model. Check your connection and run setup again." >&2
      exit 1
    }
fi
echo "Done, restart Ellashop"
