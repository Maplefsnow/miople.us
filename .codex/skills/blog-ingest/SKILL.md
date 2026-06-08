---
name: blog-ingest
description: Convert one or more uploaded images into a single Chinese-or-English blog post by extracting all readable text via OCR and merging it into a coherent markdown article. Use when given inbox images that need to be ingested as a blog post.
---

# Blog Ingest

## Workflow (success path)

1. You will receive 1 to N images as vision input. Treat them as one logical document, in the order presented.
2. For each image, extract all readable text in natural reading order.
3. Merge the text from all images into a single coherent markdown article:
   - Preserve paragraph and list structure where visible
   - Use level-2 headings (`##`) to separate content from different images only when topics clearly differ
   - Do NOT embed image references or `![](...)` tags
   - Do NOT invent content that is not present in the images
4. Infer metadata for the merged article:
   - `title`: a concise title (≤30 characters preferred) drawn from the content
   - `lang`: `"zh"` if the dominant language is Chinese, otherwise `"en"`
   - `tags`: 3-5 short topical tags in the same language as the article
   - `description`: one-sentence summary, ≤120 characters
5. Output exactly one JSON object. All seven keys (`title`, `lang`, `tags`, `description`, `content`, `error`, `detail`) MUST be present. Set unused keys to `null`. No prose, no code fences, no explanations before or after the object.

## Success vs failure — discriminate via the `error` key

The runner inspects `error` first:

- **Success**: set `error: null` and `detail: null`. Fill `title`, `lang`, `tags`, `description`, `content` with real OCR-derived content.
- **Failure**: set `error` to one of the codes below, optionally fill `detail` with a short string, and set `title / lang / tags / description / content` to `null`. The runner will archive the images to `failed/` and NOT publish anything.

`error` codes:

- `"no_text"` — the image(s) contain no readable text at all (blank, photo of a scene, decoration, etc.).
- `"unreadable"` — there is text but it is too blurry, cropped, occluded, or low-resolution to read with confidence.
- `"unsupported"` — the image format, color space, or content prevents you from analyzing it (corrupted file, unsupported codec, etc.). Include a short `detail` string.
- `"other"` — any other reason you cannot produce real article content. Include a `detail` string.

Example success response:

```json
{"title":"清晨散步","lang":"zh","tags":["散步","清晨","花园"],"description":"一个清晨在花园里散步的小记。","content":"今天清晨在花园里走了一圈……","error":null,"detail":null}
```

Example failure response:

```json
{"title":null,"lang":null,"tags":null,"description":null,"content":null,"error":"no_text","detail":null}
```

```json
{"title":null,"lang":null,"tags":null,"description":null,"content":null,"error":"unsupported","detail":"image could not be analyzed"}
```

## Hard constraints

- Do NOT call any tools, shell commands, file operations, or web fetches. This task is pure analysis of the provided images.
- Do NOT write a success-shaped object that explains a failure inside `content`, `title`, or `description`. Failure must use the `error` key with the success fields set to `null`.
- Keep `content` in plain markdown only. No HTML, no embedded images, no script blocks.
- Do not include the frontmatter delimiters (`---`) in `content`; the runner adds frontmatter separately.
