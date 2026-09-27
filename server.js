// Baby Log — tiny Express server.
// Stores every entry in ONE JSON document. No database.
//
// Storage is chosen automatically:
//   * GIST_ID + GITHUB_TOKEN set  -> the JSON lives in a private GitHub Gist
//                                    (free, survives Render restarts/sleeps)
//   * otherwise                   -> a local file at DATA_DIR/items.json
//                                    (use with a Render persistent disk, or for local dev)

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE = process.env.GIST_FILE || 'items.json';
const useGist = Boolean(GIST_ID && GITHUB_TOKEN);

// ---------- storage ----------

function github(method, body) {
  return fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'baby-log',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readStore() {
  if (useGist) {
    const res = await github('GET');
    if (!res.ok) throw new Error(`GitHub returned ${res.status} while reading the gist`);
    const gist = await res.json();
    const file = gist.files && gist.files[GIST_FILE];
    if (!file) return [];
    let content = file.content;
    if (file.truncated) content = await (await fetch(file.raw_url)).text();
    return content && content.trim() ? JSON.parse(content) : [];
  }
  if (!fs.existsSync(DATA_FILE)) return [];
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  return content.trim() ? JSON.parse(content) : [];
}

async function writeStore(json) {
  if (useGist) {
    const res = await github('PATCH', { files: { [GIST_FILE]: { content: json } } });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} while saving the gist`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DATA_FILE); // atomic swap, so a crash never leaves half a file
}

let items = [];
let chain = Promise.resolve();

// Writes run one after another; each one saves the latest full list.
function persist() {
  const p = chain.then(() => writeStore(JSON.stringify(items)));
  chain = p.catch(() => {});
  return p;
}

// ---------- validation ----------

function cleanActivity(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'milk') {
    const ml = Math.round(Number(a.ml));
    if (!Number.isFinite(ml) || ml <= 0 || ml > 2000) return null;
    if (!['created', 'finished', 'left'].includes(a.status)) return null;
    return { type: 'milk', ml, status: a.status };
  }
  if (a.type === 'diaper') {
    if (!['poop', 'pee'].includes(a.kind)) return null;
    return { type: 'diaper', kind: a.kind };
  }
  if (a.type === 'burp') return { type: 'burp' };
  if (a.type === 'bath') return { type: 'bath' };
  return null;
}

const sorted = () => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---------- app ----------

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, storage: useGist ? 'gist' : 'file' }));

app.get('/api/items', (req, res) => res.json({ items: sorted() }));

async function commit(res, extra = {}, status = 200) {
  try {
    await persist();
    res.status(status).json({ ...extra, items: sorted() });
  } catch (err) {
    console.error('Save failed:', err.message);
    setTimeout(() => persist().catch((e) => console.error('Retry failed:', e.message)), 10000);
    res.status(502).json({ error: 'Storage is not responding. The entry is kept and saving will retry.' });
  }
}

// Add: date & time is "now", or a past time the person picked.
// It is set once here and can never be changed afterwards.
function cleanTime(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  if (t.getTime() > Date.now() + 5 * 60 * 1000) return null; // no future entries (5 min grace for clock drift)
  if (t.getFullYear() < 2000) return null;
  return t.toISOString();
}

app.post('/api/items', (req, res) => {
  const activity = cleanActivity(req.body && req.body.activity);
  if (!activity) return res.status(400).json({ error: 'That activity is not valid.' });
  const createdAt = cleanTime(req.body && req.body.createdAt);
  if (!createdAt) return res.status(400).json({ error: 'Pick a date and time that is not in the future.' });
  const item = { id: crypto.randomUUID(), createdAt, activity };
  items.push(item);
  commit(res, { item }, 201);
});

// Update: only the activity can change, never the date & time.
app.patch('/api/items/:id', (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'That entry no longer exists.' });
  const activity = cleanActivity(req.body && req.body.activity);
  if (!activity) return res.status(400).json({ error: 'That activity is not valid.' });
  item.activity = activity;
  commit(res);
});

app.delete('/api/items/:id', (req, res) => {
  const before = items.length;
  items = items.filter((i) => i.id !== req.params.id);
  if (items.length === before) return res.status(404).json({ error: 'That entry no longer exists.' });
  commit(res);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- start ----------

(async () => {
  try {
    const loaded = await readStore();
    items = Array.isArray(loaded) ? loaded : [];
  } catch (err) {
    // Refuse to start rather than risk overwriting real data with an empty list.
    console.error('Could not load saved entries:', err.message);
    process.exit(1);
  }
  const server = app.listen(PORT, () =>
    console.log(`Baby Log on port ${PORT} — ${items.length} entries — storage: ${useGist ? 'GitHub Gist' : DATA_FILE}`)
  );
  // Render sends SIGTERM before redeploys: finish any pending save first.
  process.on('SIGTERM', () => {
    server.close();
    chain.finally(() => process.exit(0));
  });
})();
