---
name: blog-ingest
description: Convert one or more uploaded images into a single Chinese-or-English blog post by extracting all readable text via OCR and merging it into a coherent markdown article. Use when given inbox images that need to be ingested as a blog post.
---

# Blog Ingest

## Workflow

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
5. Output exactly one JSON object matching the provided schema. No prose, no code fences, no explanations before or after the object.

## Constraints

- Do NOT call any tools, shell commands, file operations, or web fetches. This task is pure analysis of the provided images.
- If the images contain no readable text at all, set `content` to the empty string `""`. The runner will treat this as a failure and archive the images for review.
- Keep `content` in plain markdown only. No HTML, no embedded images, no script blocks.
- Do not include the frontmatter delimiters (`---`) in `content`; the runner adds frontmatter separately.
