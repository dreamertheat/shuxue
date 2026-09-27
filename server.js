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
let storageError = null; // set when the last save failed, cleared when one succeeds

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Every change runs one at a time: apply it to a copy, save the copy,
// and only then make it live. If saving fails, nothing changes, so what
// people see in the app is always what is actually stored.
function mutate(change) {
  const run = chain.then(async () => {
    const next = structuredClone(items);
    const result = change(next);
    try {
      await writeStore(JSON.stringify(next));
    } catch (err) {
      storageError = err.message;
      console.error('Save failed:', err.message);
      throw new HttpError(502, `Not saved: ${err.message}.`);
    }
    storageError = null;
    items = next;
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

// ---------- validation ----------

function cleanActivity(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'milk') {
    const ml = Math.round(Number(a.ml));
    if (!Number.isFinite(ml) || ml <= 0 || ml > 2000) return null;
    if (!['created', 'finished', 'left', 'consumed'].includes(a.status)) return null;
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

const onRenderWithoutStorage = !useGist && process.env.RENDER && !process.env.DATA_DIR;

function storageWarning() {
  if (storageError) {
    const hint = useGist ? ' Check that GITHUB_TOKEN on Render has the "gist" scope.' : '';
    return `Entries are NOT being saved (${storageError}).${hint}`;
  }
  if (onRenderWithoutStorage) {
    return 'Storage is not set up (GIST_ID / GITHUB_TOKEN missing). Entries will be lost when the server sleeps.';
  }
  return null;
}

app.get('/health', (req, res) =>
  res.json({ ok: !storageWarning(), storage: useGist ? 'gist' : 'file', saving: !storageError, warning: storageWarning() })
);

app.get('/api/items', (req, res) => res.json({ items: sorted(), warning: storageWarning() }));

async function respond(res, change, status = 200) {
  try {
    const extra = (await mutate(change)) || {};
    res.status(status).json({ ...extra, items: sorted(), warning: storageWarning() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, warning: storageWarning() });
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
  respond(res, (list) => { list.push(item); return { item }; }, 201);
});

// Update: only the activity can change, never the date & time.
app.patch('/api/items/:id', (req, res) => {
  const activity = cleanActivity(req.body && req.body.activity);
  if (!activity) return res.status(400).json({ error: 'That activity is not valid.' });
  respond(res, (list) => {
    const item = list.find((i) => i.id === req.params.id);
    if (!item) throw new HttpError(404, 'That entry no longer exists.');
    item.activity = activity;
  });
});

app.delete('/api/items/:id', (req, res) => {
  respond(res, (list) => {
    const index = list.findIndex((i) => i.id === req.params.id);
    if (index === -1) throw new HttpError(404, 'That entry no longer exists.');
    list.splice(index, 1);
  });
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
  // Prove on startup that saving works, so a bad token shows up right away
  // (in the logs, on /health and as a banner in the app) instead of silently.
  if (useGist) {
    try {
      await writeStore(JSON.stringify(items));
      console.log('Gist is readable and writable.');
    } catch (err) {
      storageError = err.message;
      console.error('Gist is readable but NOT writable:', err.message);
    }
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
