# 遮图 · 开发与验证

## 本地与离线

本工具只有静态网页，无图片上传接口、远程识别服务或统计脚本。识别组件默认从 jsDelivr 下载，线路不可用或过慢时自动换源，GitHub Pages 作为备用；图片仅送入当前浏览器的专用 Worker。下载请求不携带图片、识别文字、Cookie 或页面来源。

支持 gzip 解压的浏览器首次下载约 39.2 MB，解压后仍为原来的 79.7 MB 完整组件，并未更换模型或量化。两个模型与 AI 去水印项目相同：9,891,840 字节文字检测模型和 21,319,680 字节文字识别模型，总计 31,211,520 字节。9.9 MB 是其中一个模型的大小。

压缩包和解压后的原始文件均校验 SHA-256，最多同时下载两个组件。下载过程中实时显示百分比、MB 和进度条。jsDelivr 使用固定提交地址；默认域名不可用时尝试其 Fastly / Gcore 线路，然后回退至 Pages。本地预览也默认 jsDelivr，页面显示实际使用的线路；`?source=origin` 仅用于指定当前站点文件进行开发测试。

缓存仍以原始文件地址保存。读取时校验组件，已有缓存匹配时直接复用；发现损坏或不匹配的组件时，仅重新获取该项。站点清单暂时不可用时可使用已保存的清单。若同一浏览器曾缓存同一 GitHub Pages 域名下 AI 去水印项目的相同模型和运行组件，会校验后复用；不会读取或修改旧项目图片。若旧模型、WASM 和 Worker 四项都在缓存，只需再下载约 3.5 MB。实际复用量取决于设备保留的缓存。

准备完成后可断网重开并识别、拼图、导出。Safari 清理站点数据、系统回收缓存或首次使用另一个浏览器时需要重新下载。可在“使用说明”中提前准备离线识别。不支持 gzip 解压时使用原始组件；原 WebAssembly 两段合并的兼容路径保留。

## 预览、部署与回归

公开版本号使用两段自然数：v1.1、v1.2、v1.3……，不使用三段版本号。

`dist/` 可直接作为 HTTPS 静态站点部署，不需要构建或运行服务器端程序。模型与运行组件沿用已有截图智能裁剪项目中的固定版本，包含第三方许可文本；第三方组件沿用固定版本。组件清单及 SHA-256 见 `dist/ocr/manifest.json`。

开发预览：运行 `npm run serve` 后，打开 [http://127.0.0.1:48721/](http://127.0.0.1:48721/)。该地址仅在运行预览服务的 Mac 上可用。本机测试服务器的 `/fixtures/` 路由仅用于读取测试素材，生产部署中不存在该服务器和路由。项目和部署目录均不含用户素材或已生成的金融截图。

测试：安装 `package.json` 中的开发依赖，设置 `SAMPLE_DIR` 指向含 `1.PNG` 到 `10.PNG` 对应素材的目录，然后运行 `npm run test:samples` 和 `npm run test:browser`。`BROWSER=webkit` 可测 WebKit。测试产物写入项目相邻的 `qa/`，不会打进站点。Chrome 测试使用已安装的 Google Chrome。

下载路径验证：`node tests/downloads.cjs` 使用本地文件模拟 CDN 响应，验证 jsDelivr 默认优先、备用线路、损坏文件拒绝、Pages 回退、旧缓存复用和原始组件兼容路径，各路径实际识别并导出相同结果；这不代替 CDN 上线后的实网下载验证。`BENCHMARK_ONLY=1 node tests/downloads.cjs` 在相同 5 MB/s 总带宽上限下比较旧版和新版的首下载入与导出。重新生成压缩包运行 `node scripts/build-ocr-transport.mjs`，发布时须先上传清单 `cdnRevision` 指定的组件提交。

提前下载与方向验证：`node tests/preload-stitch.cjs`，以及 `BROWSER=webkit node tests/preload-stitch.cjs`。验证无照片预下载、错误重试、缓存状态、5 组横向与竖向 PNG、敏感数字覆盖、上下交换、方向保存和离线识别。测试使用 `?source=origin` 隔离网络波动。组件已准备在独立的 `ocr-assets` 分支，页面发布分支仍为 `gh-pages`；实网下载测试另行记录。

检查页手势验证：`node tests/editor-gestures.cjs`，以及 `BROWSER=webkit node tests/editor-gestures.cjs`。检查整图适配、放大后滑动条、双指拖动、单指框选、取消手势、底部可见性及实际 PNG 导出。Chrome 使用真实触屏事件，WebKit 使用 PointerEvent 验证手势状态和实际鼠标拖动验证滑动条；不代替实体 iPhone 测试。

单张流程验证：`node tests/single-image.cjs`，以及 `BROWSER=webkit node tests/single-image.cjs`。验证单张真实识别与原尺寸下载、无水印时的原图像素保留、样式不影响单张、追加到同一拼图、自定义单张输出和识别失败后的人工确认。

自由分组与八种样式：`node tests/collage-groups.cjs`，以及 `BROWSER=webkit node tests/collage-groups.cjs`。实测横排、竖排、固定版式及手动两张配对的 PNG 导出，并检查分组、空位和手动遮挡。

边界回归：`node tests/reliability.cjs`，以及 `BROWSER=webkit node tests/reliability.cjs`。覆盖损坏文件的分组保护、补框后旧图不能保存、缩放遮挡边缘、分享替代流程、损坏缓存修复及缓存启动失败。

参考：[PaddleOCR.js 官方 SDK](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md)、[WebKit 主屏幕 Web App 说明](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)。

较早版本的验证记录见 [VALIDATION.md](VALIDATION.md)。
