# PMO 360 — Deployment & Update Guide

This is the runbook for getting PMO 360 onto a shared, always-on URL your
team can use, and for the **push-to-update** loop afterward.

- **Recommended target:** Azure Container Apps + Azure Database for
  PostgreSQL Flexible Server. Native to the Castillo Entra tenant, scales
  compute to near-zero between uses (~$15–20/mo all-in), free HTTPS.
- **Storage:** SharePoint document library (Microsoft Graph, app-only).
- **Updates:** merge to `main` → GitHub Actions builds + rolls out a new
  revision; DB migrations run automatically on container start.

There's also a cheaper **VM + Docker Compose** path at the bottom.

---

## 0. How the image works (single container)

The root `Dockerfile` builds **one** image that serves both the React SPA
(at `/`) and the FastAPI API (at `/api`) from the same origin. That means
one URL, one TLS cert, and **one** MSAL redirect URI — the simplest auth
story. On boot, the container's `entrypoint.sh` runs `prestart.py` (which
applies DB migrations — see §5) and then launches uvicorn.

You can sanity-check the single-origin serving locally **without Docker**:

```bash
cd frontend && npm run build            # produces frontend/dist
cd ../backend
# copy logos in like the Docker build does:
mkdir -p ../frontend/dist/assets/logo && cp -r assets/logo/* ../frontend/dist/assets/logo/
PMO360_STATIC_DIR=../frontend/dist uvicorn app:app --port 8055
# → http://localhost:8055 serves the SPA; /api/health works; /actions deep-links.
```

---

## 1. Prerequisites

- An **Azure subscription** with **Contributor** (or Owner) on a resource
  group. Your *Cloud Application Administrator* role manages app
  registrations but does **not** grant resource creation — see
  `docs/IT_REQUEST.md` if you need IT to provision this.
- Azure CLI (`az`) logged in: `az login`.
- A **production app registration** in Entra (or reuse the dev one). It needs:
  - A **SPA redirect URI** = your app's HTTPS URL (filled in §3 step 6).
  - **Expose an API** → scope `access_as_user` (you already did this on dev).
  - Graph permissions, admin-consented: `User.Read`, `User.Read.All`,
    `Calendars.Read`, `Mail.Send`, and a SharePoint permission (§6).
  - A **client secret** (for app-only SharePoint upload) → used as
    `AZURE_CLIENT_SECRET`.

---

## 2. Provision Azure resources (one time)

```bash
# Variables — edit these.
RG=rg-pmo360
LOC=eastus
ACR=pmo360acr                     # must be globally unique, lowercase
APP=pmo360
PG=pmo360-db                      # must be globally unique
PG_ADMIN=pmo
PG_PASS='<a-strong-password>'     # store in Key Vault, not here

az group create -n $RG -l $LOC

# Container registry (Basic is plenty).
az acr create -n $ACR -g $RG --sku Basic --admin-enabled false

# Postgres Flexible Server (Burstable B1ms — cheapest; ~$13/mo).
az postgres flexible-server create \
  -n $PG -g $RG -l $LOC \
  --tier Burstable --sku-name Standard_B1ms \
  --admin-user $PG_ADMIN --admin-password "$PG_PASS" \
  --version 16 --storage-size 32 \
  --public-access 0.0.0.0          # allow Azure services; lock down later
az postgres flexible-server db create -g $RG -s $PG -d pmo360

# Container Apps environment.
az extension add -n containerapp --upgrade
az containerapp env create -n pmo360-env -g $RG -l $LOC
```

---

## 3. First deploy

```bash
# Build the image in ACR (no local Docker needed). Pass the PUBLIC Vite vars.
az acr build -r $ACR -t pmo360:bootstrap \
  --build-arg VITE_API_BASE=/api \
  --build-arg VITE_AZURE_TENANT_ID=<tenant-id> \
  --build-arg VITE_AZURE_CLIENT_ID=<prod-client-id> \
  --build-arg VITE_AZURE_REDIRECT_URI=https://PLACEHOLDER \
  .

# Create the Container App (external ingress on port 8000).
az containerapp create \
  -n $APP -g $RG --environment pmo360-env \
  --image $ACR.azurecr.io/pmo360:bootstrap \
  --target-port 8000 --ingress external \
  --registry-server $ACR.azurecr.io --registry-identity system \
  --min-replicas 0 --max-replicas 2 \
  --secrets \
    db-url="postgresql://$PG_ADMIN:$PG_PASS@$PG.postgres.database.azure.com:5432/pmo360?sslmode=require" \
    openai-key="<openai-key>" \
    azure-client-secret="<app-client-secret>" \
  --env-vars \
    LOCAL_DEV_MODE=false \
    AUTH_REQUIRED=true \
    DATABASE_URL=secretref:db-url \
    OPENAI_API_KEY=secretref:openai-key \
    OPENAI_MODEL=gpt-5.4-mini \
    AZURE_TENANT_ID=<tenant-id> \
    AZURE_CLIENT_ID=<prod-client-id> \
    AZURE_CLIENT_SECRET=secretref:azure-client-secret \
    ADMIN_EMAILS=jbhaskar@castillope.com

# 5. Get the app's HTTPS URL:
az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv
# → pmo360.<hash>.<region>.azurecontainerapps.io
```

**6. Wire the redirect URI.** Add `https://<that-fqdn>` as a **SPA**
redirect URI on the prod app registration, and rebuild once so the SPA's
inlined `VITE_AZURE_REDIRECT_URI` matches (the GitHub workflow does this
going forward — set the `VITE_AZURE_REDIRECT_URI` repo variable to the
fqdn). Sign-in now works for everyone (HTTPS satisfies Microsoft's policy —
the thing that blocked the LAN IP).

> `--min-replicas 0` = scale-to-zero. First request after idle has a few-second
> cold start; fine for an internal tool. Set it to `1` if you'd rather pay
> ~$5/mo to keep it warm.

---

## 4. Push-to-update (the easy part)

`.github/workflows/deploy.yml` is already in the repo. After a one-time
setup it makes every merge to `main` deploy itself.

**One-time:** create a federated credential so GitHub can log into Azure
without stored secrets (OIDC), then set the repo's Actions secrets/variables:

```bash
# Give the deploy identity rights on the resource group + ACR.
az role assignment create --assignee <deploy-app-client-id> \
  --role Contributor --scope /subscriptions/<sub>/resourceGroups/$RG
az role assignment create --assignee <deploy-app-client-id> \
  --role AcrPush --scope $(az acr show -n $ACR --query id -o tsv)

# Federated credential: subject = repo:jayasurya23/pmo360:ref:refs/heads/main
az ad app federated-credential create --id <deploy-app-object-id> --parameters '{
  "name":"github-main","issuer":"https://token.actions.githubusercontent.com",
  "subject":"repo:jayasurya23/pmo360:ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
```

Then in **GitHub → Settings → Secrets and variables → Actions**:

| Secrets | Variables |
|---|---|
| `AZURE_CLIENT_ID` (deploy app) | `AZURE_RESOURCE_GROUP` = `rg-pmo360` |
| `AZURE_TENANT_ID` | `ACR_NAME` = `pmo360acr` |
| `AZURE_SUBSCRIPTION_ID` | `CONTAINER_APP_NAME` = `pmo360` |
| | `VITE_AZURE_TENANT_ID`, `VITE_AZURE_CLIENT_ID`, `VITE_AZURE_REDIRECT_URI` |

**From then on:** `git push` to `main` → Actions builds the image in ACR
(tagged with the commit SHA) → rolls out a new Container Apps revision.
Migrations run automatically (§5). No manual steps.

Config-only change (e.g. flip an env var)? `az containerapp update --set-env-vars …`
rolls a new revision with no rebuild.

---

## 5. Database migrations — automatic

`entrypoint.sh` runs `prestart.py` before the server starts:

- **Fresh DB** (no `alembic_version` table) → builds the full current schema
  with `create_all`, then `alembic stamp head`. (The Alembic baseline is
  empty, so a plain `upgrade head` from scratch would fail — `prestart`
  handles this.)
- **Existing DB** → `alembic upgrade head` applies any new migrations from
  this deploy.

So shipping a schema change = add the migration, merge to `main`. It applies
on rollout. A bad migration makes `prestart` exit non-zero, which fails the
revision and keeps the previous one serving.

---

## 6. SharePoint storage

The `SharePointBackend` uploads finalized PDFs/docx/xlsx via app-only Graph.
Activate it:

1. **Provision/choose a document library** — a "PMO 360" SharePoint site, or
   a library in an existing PM site. (IT, or you if you have site admin.)
2. **Grant the app access.** Least-privilege: add the Graph **application**
   permission `Sites.Selected` to the prod app reg + admin consent, then
   grant it to *just this site* (an admin runs once):
   ```bash
   # write access to one site only
   az rest --method POST \
     --uri "https://graph.microsoft.com/v1.0/sites/<site-id>/permissions" \
     --body '{"roles":["write"],"grantedToIdentities":[{"application":{"id":"<app-client-id>","displayName":"PMO 360"}}]}'
   ```
   (Broader alternative: `Sites.ReadWrite.All` + admin consent — simpler, more privilege.)
3. **Get the IDs:**
   ```bash
   cd backend && python scripts/sharepoint_ids.py https://castillope.sharepoint.com/sites/PMO360
   ```
   Drop `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` into the app's env.
4. Ensure `AZURE_CLIENT_SECRET` (app-only) is set and `LOCAL_DEV_MODE=false`.
5. **Test** the finalize→upload path end-to-end and confirm the file lands in
   the library. (This path is written but unproven against a live site — budget
   a little time to shake out auth/permission wrinkles on first run.)

---

## 7. Rollback

Every build is tagged with its git SHA, and Container Apps keeps revisions:

```bash
# list recent revisions
az containerapp revision list -n pmo360 -g rg-pmo360 -o table
# point traffic back at a known-good image
az containerapp update -n pmo360 -g rg-pmo360 \
  --image pmo360acr.azurecr.io/pmo360:<previous-sha>
```

Note: a code rollback does **not** auto-revert a DB migration. Keep migrations
additive/backward-compatible (add columns, don't drop) so the prior revision
keeps working against the newer schema.

---

## 8. Custom domain (later)

When IT is ready, map `pmo360.castillope.com`: add the CNAME + asuid TXT to
the `castillope.com` zone, then `az containerapp hostname add` +
`az containerapp ssl upload` (or a managed cert). Add the new HTTPS origin as
a second SPA redirect URI and update `VITE_AZURE_REDIRECT_URI`. No code change.

---

## Appendix — VM + Docker Compose (cheapest path)

If a managed DB's ~$13/mo is a blocker and you're OK owning a box:

```bash
# on an Ubuntu VM with Docker + compose installed
git clone https://github.com/jayasurya23/pmo360 && cd pmo360
cp backend/.env.production.example backend/.env   # fill it in
docker compose up -d --build                      # db + backend + frontend
```

Put **Cloudflare Tunnel** in front for free HTTPS at a tunnel URL (satisfies
the interim-HTTPS plan). Trade-off: you patch the OS and own Postgres backups
(the DB lives in the `pmo360_pgdata` volume — snapshot it). Updates =
`git pull && docker compose up -d --build`.

See `backend/.env.production.example` for the full variable reference.
