# 📥 inbox · 图片自动发文章

把要识别的图片直接拖到这个文件夹里（**不要**放进子目录），等最多 3 分钟。

## 怎么用

1. 把 1 张或多张图片放进 `inbox/`，文件名建议 `01-xxx.png / 02-yyy.png` 控制顺序。
2. **一次放进去的所有图会合并成一篇文章**（cron 每 2 分钟扫一次 + 60 秒 quiet period）。
3. 几分钟后访问 https://miople.us 看新文章。

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

- 不要把 `inbox/processed/`、`inbox/failed/`、`inbox/.lock`、`inbox/ingest.log` 加进 git（已 gitignored）
- 不要在 cron 跑的同时手动 `npm run ingest`（有锁，会直接跳过）
- 不要往 inbox 顶层放非图片文件，它们会被忽略
