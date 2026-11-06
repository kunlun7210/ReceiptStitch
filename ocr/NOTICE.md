# Local OCR components

These components load on the first image-recognition request or when preparing offline recognition. Images are processed on-device. Asset files are verified against `manifest.json` and cached locally.

- PaddleOCR.js 0.4.2 and PP-OCRv6-small detection / recognition models: Apache-2.0. https://github.com/PaddlePaddle/PaddleOCR
- ONNX Runtime Web 1.26.0: MIT. https://github.com/microsoft/onnxruntime
- OpenCV.js via @techstark/opencv-js: Apache-2.0. https://github.com/TechStark/opencv-js
- js-yaml: MIT. https://github.com/nodeca/js-yaml
- clipper-lib: Boost Software License. https://github.com/junmer/clipper-lib

License texts are included in `ocr/licenses/`. Model and runtime hashes are in `manifest.json`.

The runtime and models are vendored from the existing screenshot-cropper project's pinned OCR distribution without binary changes. The application performs no external model downloads. `node scripts/verify-assets.mjs` verifies the vendored assets before deployment.
