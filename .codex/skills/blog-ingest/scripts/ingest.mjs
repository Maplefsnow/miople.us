#!/usr/bin/env node
// blog-ingest runner. Invoked by cron every 2 minutes.
// All shell / fs / git operations live here so that codex never decides what
// to execute. codex is called once per batch in read-only sandbox and only
// returns a structured JSON object.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKILL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
const INBOX = path.join(REPO_ROOT, 'inbox');
const POSTS = path.join(REPO_ROOT, 'src', 'content', 'posts');
const SCHEMA = path.join(SKILL_DIR, 'schema.json');
const LOCK = path.join(INBOX, '.lock');
const LOG = path.join(INBOX, 'ingest.log');
const TMP = path.join(INBOX, '.tmp');
const PROCESSED = path.join(INBOX, 'processed');
const FAILED = path.join(INBOX, 'failed');
const HOME = process.env.HOME || '/home/mio';
const SKILL_LINK = path.join(HOME, '.codex', 'skills', 'blog-ingest');

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tiff']);
const HEIC_EXTS = new Set(['.heic', '.heif']);
const QUIET_MS = 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const CODEX_TIMEOUT_MS = 5 * 60_000;
const HEIF_CONVERT_TIMEOUT_MS = 60_000;
// Defensive: codex may still try to write failure text into success-shaped
// responses despite SKILL.md. If title/content matches one of these, we treat
// it as a meta-failure and route to failed/ instead of publishing.
const META_FAILURE_PATTERNS = [
  /无法处理/, /无法识别/, /无法读取/, /无法分析/, /提取失败/, /识别失败/,
  /无可读文字/, /没有可读文字/, /未检测到/, /不受支持/, /沙箱(限制|不可用)/,
  /\bcannot (process|read|analyze|extract)\b/i,
  /\bfailed to (extract|process|read|analyze)\b/i,
  /\bunsupported (format|file)\b/i,
  /\bno (readable )?text\b/i,
  /\bsandbox (restriction|unavailable)\b/i,
];

process.env.HOME = HOME;
process.env.PATH = [process.env.PATH, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
process.chdir(REPO_ROOT);

for (const d of [INBOX, POSTS, TMP, PROCESSED, FAILED]) fs.mkdirSync(d, { recursive: true });

const log = (msg, batchId = '-') => {
  const line = `[${new Date().toISOString()}] [${batchId}] ${msg}\n`;
  fs.appendFileSync(LOG, line);
  if (process.stdout.isTTY) process.stdout.write(line);
};

function ensureSkillSymlink() {
  fs.mkdirSync(path.dirname(SKILL_LINK), { recursive: true });
  try {
    const st = fs.lstatSync(SKILL_LINK);
    if (st.isSymbolicLink() && fs.readlinkSync(SKILL_LINK) === SKILL_DIR) return;
    if (st.isSymbolicLink()) fs.unlinkSync(SKILL_LINK);
    else throw new Error(`${SKILL_LINK} exists and is not a symlink; refuse to overwrite`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (!/refuse to overwrite/.test(e.message)) throw e;
      throw e;
    }
  }
  fs.symlinkSync(SKILL_DIR, SKILL_LINK);
}

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      log(`stale lock (${Math.round((Date.now() - st.mtimeMs) / 1000)}s old), removing`);
      fs.unlinkSync(LOCK);
      return acquireLock();
    }
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK); } catch {}
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function tryPushPending() {
  const status = sh('git', ['status', '--porcelain']);
  if (status.stdout.trim()) {
    log(`working tree dirty before scan; skipping pending-push: ${status.stdout.trim().split('\n')[0]}`);
    return;
  }
  const ahead = sh('git', ['rev-list', '--count', '@{u}..HEAD']);
  const n = parseInt(ahead.stdout.trim() || '0', 10);
  if (!n) return;
  log(`pushing ${n} pending commit(s) from previous run`);
  const push = sh('git', ['push', 'origin', 'main']);
  if (push.code !== 0) log(`pending push failed: ${push.stderr.trim().split('\n').slice(-1)[0]}`);
  else log(`pending push ok`);
}

function naturalCmp(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function listBatch() {
  const entries = fs.readdirSync(INBOX, { withFileTypes: true });
  const now = Date.now();
  const imgs = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMG_EXTS.has(ext)) continue;
    const full = path.join(INBOX, e.name);
    const st = fs.statSync(full);
    if (now - st.mtimeMs < QUIET_MS) {
      log(`skip ${e.name}: not quiet (${Math.round((now - st.mtimeMs) / 1000)}s < ${QUIET_MS / 1000}s)`);
      continue;
    }
    imgs.push({ name: e.name, path: full, mtime: st.mtimeMs });
  }
  imgs.sort((a, b) => naturalCmp(a.name, b.name));
  return imgs;
}

function batchId(imgs) {
  const h = createHash('sha256');
  for (const f of imgs) h.update(fs.readFileSync(f.path));
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${ts}-${h.digest('hex').slice(0, 8)}`;
}

function prepareImages(imgs, batch) {
  const needsConvert = imgs.some((f) => HEIC_EXTS.has(path.extname(f.name).toLowerCase()));
  if (needsConvert) {
    const which = spawnSync('which', ['heif-convert'], { encoding: 'utf8' });
    if (which.status !== 0) {
      throw new Error('heif-convert not on PATH; install libheif-examples to handle HEIC/HEIF');
    }
  }
  const tmpBatchDir = path.join(TMP, batch);
  if (needsConvert) fs.mkdirSync(tmpBatchDir, { recursive: true });
  const prepared = [];
  for (const f of imgs) {
    const ext = path.extname(f.name).toLowerCase();
    if (!HEIC_EXTS.has(ext)) {
      prepared.push({ name: f.name, codexPath: f.path, originalPath: f.path });
      continue;
    }
    const jpegName = f.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
    const jpegPath = path.join(tmpBatchDir, jpegName);
    const r = spawnSync('heif-convert', ['-q', '90', f.path, jpegPath], {
      encoding: 'utf8', timeout: HEIF_CONVERT_TIMEOUT_MS,
    });
    if (r.status !== 0 || !fs.existsSync(jpegPath)) {
      throw new Error(
        `heif-convert failed for ${f.name}: ${(r.stderr || r.stdout || 'no output').trim().split('\n').slice(-1)[0]}`
      );
    }
    log(`heif-convert ${f.name} → .tmp/${batch}/${jpegName}`, batch);
    prepared.push({ name: f.name, codexPath: jpegPath, originalPath: f.path });
  }
  return prepared;
}

function cleanupTmpBatch(batch) {
  const dir = path.join(TMP, batch);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function callCodex(prepared, batch) {
  const outPath = path.join(TMP, `${batch}.json`);
  try { fs.unlinkSync(outPath); } catch {}
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--output-schema', SCHEMA,
    '--output-last-message', outPath,
    '--color', 'never',
  ];
  for (const f of prepared) { args.push('-i', f.codexPath); }
  args.push('--');
  args.push(
    '请使用 blog-ingest skill 把这些图片的可读文字按顺序整理并合并成一篇博客文章。' +
    '严格按 schema 输出 JSON。如果任何原因导致无法 OCR（图中无文字 / 模糊 / 不支持 / 沙箱限制 / 其他），' +
    '必须返回 error 对象，禁止把失败说明写进 success 形态的 content 字段。'
  );
  const r = spawnSync('codex', args, {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: CODEX_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', outPath, error: r.error };
}

function parseAndValidate(outPath) {
  if (!fs.existsSync(outPath)) throw new Error('codex produced no output file');
  const raw = fs.readFileSync(outPath, 'utf8').trim();
  if (!raw) throw new Error('codex output is empty');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`cannot parse JSON: ${e.message}`);
    obj = JSON.parse(m[0]);
  }
  if (typeof obj === 'object' && obj && typeof obj.error === 'string' && obj.error) {
    const reason = obj.error + (obj.detail ? ': ' + obj.detail : '');
    throw new Error(`codex returned error: ${reason}`);
  }
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('title empty');
  if (obj.lang !== 'zh' && obj.lang !== 'en') throw new Error(`bad lang: ${obj.lang}`);
  if (!Array.isArray(obj.tags) || obj.tags.length < 1) throw new Error('tags missing');
  if (typeof obj.content !== 'string') throw new Error('content not string');
  if (!obj.content.trim()) throw new Error('content empty (no_text)');
  for (const field of [obj.title, obj.content, obj.description]) {
    if (typeof field !== 'string') continue;
    for (const pat of META_FAILURE_PATTERNS) {
      if (pat.test(field)) {
        throw new Error(`suspected meta-failure: matches /${pat.source}/`);
      }
    }
  }
  return obj;
}

function yamlQuote(s) {
  if (/^[一-鿿\w \-]+$/.test(s) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) && !/:\s/.test(s)) return s;
  return JSON.stringify(s);
}

function buildFrontmatter(result) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const pubDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const tags = '[' + result.tags.map(yamlQuote).join(', ') + ']';
  const lines = ['---'];
  lines.push(`title: ${yamlQuote(result.title)}`);
  if (result.description && result.description.trim()) {
    lines.push(`description: ${yamlQuote(result.description)}`);
  }
  lines.push(`pubDate: ${pubDate}`);
  lines.push(`lang: ${result.lang}`);
  lines.push(`tags: ${tags}`);
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function writePost(batch, result) {
  const file = path.join(POSTS, `${batch}.md`);
  const body = buildFrontmatter(result) + result.content.trimEnd() + '\n';
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function archiveImages(prepared, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of prepared) {
    const target = path.join(destDir, f.name);
    fs.renameSync(f.originalPath, target);
  }
}

function commitAndPush(batch, result, n) {
  const add = sh('git', ['add', POSTS]);
  if (add.code !== 0) return { ok: false, where: 'add', msg: add.stderr.trim() };
  const titleLine = result.title.replace(/\s+/g, ' ').slice(0, 60);
  const msg = `ingest: ${titleLine} (${n} image${n > 1 ? 's' : ''})\n\nbatch: ${batch}`;
  const commit = sh('git', ['commit', '-m', msg]);
  if (commit.code !== 0) return { ok: false, where: 'commit', msg: commit.stderr.trim() };
  const push = sh('git', ['push', 'origin', 'main']);
  if (push.code !== 0) return { ok: false, where: 'push', msg: push.stderr.trim() };
  return { ok: true };
}

async function main() {
  ensureSkillSymlink();

  if (!acquireLock()) {
    log('another ingest is running, exit');
    return 0;
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  try {
    tryPushPending();
    const imgs = listBatch();
    if (imgs.length === 0) { log('no batch ready'); return 0; }

    const batch = batchId(imgs);
    log(`batch ${batch}: ${imgs.length} image(s): ${imgs.map(i => i.name).join(', ')}`, batch);

    let prepared;
    try { prepared = prepareImages(imgs, batch); }
    catch (e) {
      log(`prepare failed: ${e.message}`, batch);
      cleanupTmpBatch(batch);
      return failBatch(imgs.map((f) => ({ name: f.name, originalPath: f.path })), batch, `prepare: ${e.message}`);
    }

    const cx = callCodex(prepared, batch);
    if (cx.error) {
      log(`codex spawn error: ${cx.error.message}`, batch);
      cleanupTmpBatch(batch);
      return failBatch(prepared, batch, `spawn: ${cx.error.message}\nstdout:\n${cx.stdout}\nstderr:\n${cx.stderr}`);
    }
    if (cx.code !== 0) {
      log(`codex exit ${cx.code}`, batch);
      cleanupTmpBatch(batch);
      return failBatch(prepared, batch, `exit ${cx.code}\nstdout:\n${cx.stdout}\nstderr:\n${cx.stderr}`);
    }

    let result;
    try { result = parseAndValidate(cx.outPath); }
    catch (e) {
      log(`validation failed: ${e.message}`, batch);
      let raw = ''; try { raw = fs.readFileSync(cx.outPath, 'utf8'); } catch {}
      cleanupTmpBatch(batch);
      return failBatch(prepared, batch, `validate: ${e.message}\nraw:\n${raw}\nstderr:\n${cx.stderr}`);
    }

    const file = writePost(batch, result);
    log(`wrote ${path.relative(REPO_ROOT, file)} (title="${result.title}", lang=${result.lang}, tags=${result.tags.join('/')})`, batch);

    archiveImages(prepared, path.join(PROCESSED, batch));
    log(`archived ${prepared.length} image(s) to processed/${batch}`, batch);

    const git = commitAndPush(batch, result, prepared.length);
    if (!git.ok) {
      log(`git ${git.where} failed: ${(git.msg || '').split('\n').slice(-1)[0]}`, batch);
      log(`md kept in working tree; next run will retry push`, batch);
    } else {
      log(`committed + pushed`, batch);
    }
    try { fs.unlinkSync(cx.outPath); } catch {}
    cleanupTmpBatch(batch);
    return 0;
  } catch (e) {
    log(`fatal: ${e.stack || e.message}`);
    return 1;
  }
}

function failBatch(prepared, batch, detail) {
  const dest = path.join(FAILED, batch);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of prepared) {
      const src = f.originalPath;
      if (!src || !fs.existsSync(src)) continue;
      try { fs.renameSync(src, path.join(dest, f.name)); } catch (e) { log(`failed to move ${f.name}: ${e.message}`, batch); }
    }
    fs.writeFileSync(path.join(dest, 'error.log'), detail + '\n', 'utf8');
    log(`moved to failed/${batch}`, batch);
  } catch (e) {
    log(`fail-archive error: ${e.message}`, batch);
  }
  return 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  log(`unhandled: ${e.stack || e.message}`);
  process.exit(1);
});
