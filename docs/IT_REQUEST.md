# PMO 360 — IT / Admin Request Brief

One-page ask for standing up **PMO 360** (an internal meeting-management web
app for the PM team) in production. Everything below is scoped to a single
internal tool used by a handful of project managers. Grouped so you can hand
off the parts that need elevated access.

App registration (Entra): **PMO 360**, client id `5c274f14-d34d-4cb2-960c-51efbd76a6fb`
(dev). A separate prod registration is fine too — say which you prefer.

---

## 1. Azure subscription access (to host it)
- A **resource group** in an Azure subscription with **Contributor** rights
  for me (or you provision the resources below and hand me the names).
- Resources are small/cheap (~$15–20/month total):
  - Azure **Container Apps** environment + one container app
  - Azure **Container Registry** (Basic)
  - Azure **Database for PostgreSQL** Flexible Server (Burstable B1ms)

If a subscription isn't available to me, please create the resource group +
those three resources and share the names; I'll do the rest.

## 2. Entra app registration permissions (admin consent)
On the PMO 360 app registration, please **grant admin consent** for these
Microsoft Graph **delegated** permissions (used on behalf of the signed-in PM):
- `User.Read`, `User.Read.All` *(already consented on dev)*
- `Calendars.Read` — read the PM's own upcoming meetings
- `Mail.Send` — send minutes/agendas from the PM's own mailbox

And one **application** permission for server-side document storage (§3):
- `Sites.Selected` *(preferred, least-privilege)* — then grant the app
  **write** access to only the one SharePoint site below. Or, if simpler on
  your end, `Sites.ReadWrite.All`.

Also: please add a **client secret** to the app reg (I'll store it as a
managed secret — it's used only for app-only SharePoint upload).

## 3. SharePoint document library (where finalized docs are stored)
- A SharePoint **site + document library** for PMO 360 output (finalized
  meeting-minutes PDFs, action logs, agendas). Either a dedicated "PMO 360"
  site or a library in an existing PM site — your call.
- After it exists, grant the app reg **write** access to that site (the
  `Sites.Selected` grant above). I'll fetch the site/drive IDs myself with a
  read-only script.

## 4. DNS (optional, can come later)
- Not blocking launch — we'll go live on the platform's default HTTPS URL
  (`https://pmo360.<hash>.<region>.azurecontainerapps.io`).
- When convenient: a CNAME for **`pmo360.castillope.com`** → the container
  app, plus the `asuid.pmo360` TXT record Azure asks for, so we can move to
  the friendly domain. (One DNS change; no app downtime.)

---

## What I do NOT need
- No access to anyone's mailbox or calendar at the tenant level — the app
  only ever acts as the signed-in PM, via the delegated permissions above.
- No write access to other SharePoint sites — `Sites.Selected` is scoped to
  the one library in §3.
- No production secrets shared over email — I'll set them directly in the
  Azure secret store / Key Vault.

## Fastest path
Most blocking item is **§1 (subscription/RBAC)** and **§2 admin consent**.
If you grant those two, I can stand up the rest and we wire SharePoint (§3)
as a fast follow.
