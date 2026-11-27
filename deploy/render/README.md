# Deploying Invigil: API on Render (free), web on Vercel

```
Browser ─▶ Vercel (Next.js, /api/v1/* proxy, signs the client IP with PROXY_SECRET)
              │ HTTPS
              ▼
           Render web service `invigil-api` (image ghcr.io/inventixcity/invigil-api, region singapore)
              │
              ▼
           Supabase Postgres (session pooler)
```

Render never compiles Rust. The free plan has too few build minutes and too little memory for that.
GitHub Actions builds `backend/Dockerfile` and pushes the image to GHCR, and Render pulls the image.
Every step below uses the CLI or the API, because the link is slow. Nothing large is uploaded from
your machine.

## 0. One-time prerequisites

- `gh` (GitHub CLI), signed in: `gh auth status`
- `vercel` CLI: `npm i -g vercel`, then `vercel login`
- A Render API key: Render dashboard > Account settings > API keys
- A Supabase project. Use the **session pooler** connection string (Project > Connect > Session
  pooler, port **5432**). Render has no outbound IPv6, so the direct `db.<ref>.supabase.co` host
  does not work. The transaction pooler (port 6543) does not support prepared statements.

## 1. Secrets file

Create `.env.production` at the repository root. It is gitignored, so never commit it.

```bash
cat > .env.production <<EOF
RENDER_API_KEY=rnd_xxxxxxxxxxxxxxxx
DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
APP_ORIGIN=https://<your-project>.vercel.app
PROXY_SECRET=$(openssl rand -hex 32)
CODE_PEPPER=$(openssl rand -hex 32)
EXAM_LEASE_KEY=$(openssl rand -hex 32)
RESULT_SIGNING_KEY=$(openssl rand -base64 32)
MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)
SMTP_URL=smtps://<user>:<password>@smtp.example.com:465
EMAIL_FROM=Invigil <no-reply@your-domain>
EOF
```

`RESEND_API_KEY` can replace `SMTP_URL`. The optional entries are `AI_API_KEY`, `AI_BASE_URL`,
`AI_MODEL` (Gemini grading suggestions), `RENDER_OWNER_ID` (when your key sees more than one
workspace) and `RENDER_REGISTRY_CREDENTIAL_ID` (only for a private GHCR package).

**Keep `RESULT_SIGNING_KEY` stable.** Certificates that were already issued verify only against the
key that signed them.

## 2. Build the image (GitHub Actions)

Pushing to `main` under `backend/**` runs `.github/workflows/api-image.yml`, which pushes
`ghcr.io/inventixcity/invigil-api:latest` and `:<12-char sha>`. To run it by hand:

```bash
gh workflow run api-image.yml --ref main
gh run watch "$(gh run list --workflow api-image.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

The first build takes about 15 to 20 minutes. Later builds reuse the GitHub Actions cache.

Make the package public once, so Render can pull it without credentials. In the GitHub UI, go to
Packages > invigil-api > Package settings > Change visibility > Public. You can also use the API:

```bash
gh api -X PATCH /orgs/inventixcity/packages/container/invigil-api -f visibility=public
```

## 3. Create or update the Render service

```bash
bash deploy/render/deploy.sh            # deploys :latest
bash deploy/render/deploy.sh 1a2b3c4d5e6f  # or an exact sha tag
```

The script does the following:

1. Checks `.env.production` the way the API checks it at startup: key lengths, base64 sizes, an
   https origin and the pooler port. It stops before any network call if something is wrong.
2. Finds your Render workspace and looks up `invigil-api`.
3. Creates the service if it doesn't exist yet. It calls `POST /v1/services` with
   `runtime: image`, plan `free`, region `singapore`, health check `/healthz` and every env var.
   Creating the service also triggers the first deploy.
4. Otherwise it replaces the env vars (`PUT /v1/services/{id}/env-vars`), points the service at
   the image (`PATCH /v1/services/{id}`) and triggers a deploy
   (`POST /v1/services/{id}/deploys` with `imageUrl`).
5. Waits until the deploy is `live`, then prints the service URL and calls `/healthz`.

Migrations run at startup (`RUN_MIGRATIONS=true`). They are idempotent and lock against
concurrent runs.

The raw API calls are below, in case you'd rather run them by hand:

```bash
H="Authorization: Bearer $RENDER_API_KEY"
curl -s -H "$H" https://api.render.com/v1/owners                      # -> owner.id (tea-...)
curl -s -H "$H" -H 'Content-Type: application/json' -X POST https://api.render.com/v1/services -d '{
  "type": "web_service", "name": "invigil-api", "ownerId": "tea-...",
  "image": {"ownerId": "tea-...", "imagePath": "ghcr.io/inventixcity/invigil-api:latest"},
  "serviceDetails": {"runtime": "image", "plan": "free", "region": "singapore", "healthCheckPath": "/healthz"},
  "envVars": [{"key": "APP_ENV", "value": "production"}, ...]
}'
```

`render.yaml` describes the same service as a Blueprint. Dashboard > New > Blueprint applies it
and prompts for each `sync: false` secret. Use the Blueprint or the script, not both.

### Automatic deploys

Copy the deploy hook from Render > invigil-api > Settings > Deploy Hook, then:

```bash
gh secret set RENDER_DEPLOY_HOOK_URL --body 'https://api.render.com/deploy/srv-...?key=...'
```

After that, every image build deploys its exact sha tag.

## 4. Seed the demo accounts

The free plan has no shell and no one-off jobs, so run the seed from your machine against
Supabase. Passwords are Argon2id hashes with no server-side pepper, so a local run produces hashes
the deployed API accepts.

```bash
docker run --rm -e APP_ENV=development -e DATABASE_URL="$DATABASE_URL" \
  ghcr.io/inventixcity/invigil-api:latest seed-demo
# or, with the locally built image:  docker run --rm ... invigil-api:dev seed-demo
```

This command pulls a ~40 MB image. The seed creates `admin@invigil.app`, `examiner@invigil.app`,
`examiner2@invigil.app`, `candidate@invigil.app` and `candidate01..24@invigil.app`, all with the
password `Invigil#Demo2026`. It does nothing if the accounts already exist.

## 5. Keep it awake

Render free sleeps after 15 minutes idle, and waking takes 30 to 60 seconds. The `keepalive`
workflow pings the API every 10 minutes:

```bash
gh variable set API_HEALTH_URL --body 'https://invigil-api.onrender.com/healthz'
gh workflow run keepalive.yml   # one manual run to confirm
```

The free plan includes 750 instance hours a month, enough for one service running all the time.

## 6. Vercel (web)

Run these from the `web/` directory:

```bash
cd web
vercel link                                   # pick or create the project
vercel env add API_ORIGIN production          # paste https://invigil-api.onrender.com
vercel env add PROXY_SECRET production        # paste the SAME value as in .env.production
vercel env add NEXT_PUBLIC_API_ENABLED production   # paste: true
vercel --prod
```

Set `APP_ORIGIN` in `.env.production` to the final Vercel URL, and re-run `deploy.sh` if it
changed. The API's CSRF check accepts only that origin. Invite links use it too.

## 7. Smoke test

```bash
curl -fsS https://invigil-api.onrender.com/healthz
curl -fsS https://invigil-api.onrender.com/readyz           # also checks the database
API_URL=https://invigil-api.onrender.com node tests/e2e/exam-flow.mjs
```

The e2e run creates its own exam and candidate, using the seeded examiner accounts.
