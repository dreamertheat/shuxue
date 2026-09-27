# Baby Log

A tiny shared log for milk, diaper changes and burps. Works on any phone, made for iPhone.
Everyone who opens the link sees the same list (it refreshes every 15 seconds).

No database: all entries live in one JSON document, stored either in a private
GitHub Gist (free) or in a file on a Render persistent disk (paid).

## Run it on your computer

```bash
npm install
npm start
# open http://localhost:3000
```

Locally, entries are saved to `data/items.json`.

## Where the data is kept

| Setup | Cost | Keeps data? |
|---|---|---|
| Render Free + GitHub Gist (`GIST_ID`, `GITHUB_TOKEN`) | Free | Yes |
| Render Starter + persistent disk (`DATA_DIR=/var/data`) | Paid | Yes |
| Render Free, nothing set | Free | **No** — wiped whenever the free server sleeps (after 15 idle minutes) or redeploys |

## Deploy to Render

See the step-by-step guide in the chat, or in short:

1. Push this folder to a GitHub repo.
2. Create a secret gist at https://gist.github.com with one file named `items.json` containing `[]`.
   The gist ID is the long code at the end of its URL.
3. Create a GitHub token (Settings → Developer settings → Personal access tokens → Tokens (classic))
   with only the `gist` scope.
4. On Render: New → Web Service → pick the repo.
   Build command `npm install`, start command `npm start`, instance type Free.
   Add environment variables `GIST_ID` and `GITHUB_TOKEN`.
5. Deploy, open the `.onrender.com` link, and on iPhone use Share → Add to Home Screen.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/items` | |
| POST | `/api/items` | `{ "activity": {...} }` — date & time are set by the server |
| PATCH | `/api/items/:id` | `{ "activity": {...} }` — only the activity changes |
| DELETE | `/api/items/:id` | |

Activities: `{ "type": "milk", "ml": 120, "status": "created" | "finished" | "left" }`,
`{ "type": "diaper", "kind": "poop" | "pee" }`, `{ "type": "burp" }`.
