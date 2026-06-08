# 📥 inbox · 图片自动发文章

把要识别的图片直接拖到这个文件夹里（**不要**放进子目录），等最多 3 分钟。

## 怎么用

1. 把 1 张或多张图片放进 `inbox/`，文件名建议 `01-xxx.png / 02-yyy.png` 控制顺序。
2. **一次放进去的所有图会合并成一篇文章**。
3. 几分钟后访问 https://miople.us 看新文章。

## 时序

- cron 每 2 分钟扫一次（`*/2 * * * *`）
- 每张图必须**静默 60 秒**（mtime 比当前早 60s）才会被算进 batch。没满 60s 的会在日志写 `skip xxx: not quiet`，下一轮再看。这是为了防止你还在拖文件就被扫描截断。
- 所以最坏情况：你拖完最后一张图后，最多再过 ≈3 分钟（120s cron 周期 + 60s quiet）才开始处理。
- 处理本身大约 10 秒；commit + push 后 GitHub Pages 部署约 1-2 分钟。

## 支持的格式

JPG / JPEG / PNG / WEBP / GIF / BMP / TIFF 直接送 codex。

**HEIC / HEIF**：需要系统装 `libheif-examples` 提供 `heif-convert`，否则该 batch 会失败到 `failed/`。少数 iPhone HEIC 因为 libheif 1.17.6 的辅助图层限制（`Too many auxiliary image references`）无法解码 —— 这类图在 iPhone 上"导出 → 最兼容（JPEG）"再上传即可。

## 看跑得怎么样

- 全部日志：`inbox/ingest.log`
- 处理成功的原图：`inbox/processed/<batch-id>/`
- 处理失败的原图 + 错误日志：`inbox/failed/<batch-id>/error.log`

## 手动跑一次

```sh
npm run ingest
```

## 重新处理失败的批次

把 `inbox/failed/<batch-id>/` 里的图片移回 `inbox/`（不要带子目录），下一轮 cron 就会重跑。

## 不要做的事

- 不要把 `inbox/processed/`、`inbox/failed/`、`inbox/.tmp/`、`inbox/.lock`、`inbox/ingest.log` 加进 git（已 gitignored）
- 不要在 cron 跑的同时手动 `npm run ingest`（有锁，会直接跳过）
- 不要往 inbox 顶层放非图片文件，它们会被忽略
