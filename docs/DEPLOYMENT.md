# Deploying Nimpat One API to Google Cloud Run

Nothing here has been run against a real Google Cloud project yet. The
commands are a starting template; confirm project ids, region and naming with
the account owner first.

## Architecture

```
Customer web / mobile / admin  ──HTTPS──►  Cloud Run service  nimpat-one-api-<env>
                                              │  (stateless, scales 0..N, port 8080)
                                              ├─► Cloud SQL for PostgreSQL (unix socket, private)
                                              ├─► Secret Manager (DB URL, JWT secret, Paystack keys, jobs token)
                                              └─► Paystack API (test mode)
Paystack ──webhook──► POST /api/v1/payments/webhooks/paystack
Cloud Scheduler ──X-Job-Token──► POST /api/v1/internal/jobs/expire            (every 1 min)
                               ► POST /api/v1/internal/jobs/reconcile-payments (every 5 min)
Cloud Run Job  nimpat-one-api-migrate-<env>  →  prisma migrate deploy (before each release)
```

## One-time setup (per environment)

```bash
PROJECT=your-gcp-project
REGION=europe-west1          # choose the region agreed with Nimpat Group
ENV=staging

gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com

gcloud artifacts repositories create nimpat-one --repository-format=docker --location=$REGION

# PostgreSQL 17 on Cloud SQL (size to taste; enable backups + PITR)
gcloud sql instances create nimpat-one-pg --database-version=POSTGRES_17 --region=$REGION \
  --tier=db-custom-1-3840 --backup-start-time=02:00 --enable-point-in-time-recovery
gcloud sql databases create nimpat_one --instance=nimpat-one-pg
gcloud sql users create nimpat_api --instance=nimpat-one-pg --password='<generate>'

# Runtime service account with least privilege
gcloud iam service-accounts create nimpat-one-api
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member=serviceAccount:nimpat-one-api@$PROJECT.iam.gserviceaccount.com --role=$ROLE
done
```

### Secrets (never in source control)

| Secret | Value |
|---|---|
| `nimpat-one-$ENV-database-url` | `postgresql://nimpat_api:<pw>@localhost/nimpat_one?host=/cloudsql/$PROJECT:$REGION:nimpat-one-pg&schema=public` |
| `nimpat-one-$ENV-jwt-secret` | 48+ random bytes, base64url |
| `nimpat-one-$ENV-paystack-secret` | Paystack **test** secret key `sk_test_…` |
| `nimpat-one-$ENV-paystack-public` | Paystack **test** public key `pk_test_…` |
| `nimpat-one-$ENV-jobs-token` | 32+ random characters |

```bash
printf '%s' "$VALUE" | gcloud secrets create nimpat-one-$ENV-jwt-secret --data-file=-
```

The API refuses to start with a live Paystack key (`sk_live_…`) or with the
development placeholder JWT secret / jobs token when `NODE_ENV=production`.

## Release

```bash
gcloud builds submit --config deploy/cloudbuild.yaml --substitutions=_REGION=$REGION,_ENV=$ENV
```

Cloud Build builds the image, pushes it, runs `prisma migrate deploy` as a
Cloud Run Job, then deploys the service. Migrations are additive by policy;
destructive schema changes need a two-step (expand → migrate data → contract)
release.

Seeding reference data (divisions, roles, permissions, loyalty rules) in a new
environment: run `prisma/seed.ts` once through a Cloud Run Job with
`SEED_SAMPLE_DATA=false` and real admin credentials from Secret Manager.
**Never** set `SEED_SAMPLE_DATA=true` outside local development (the seed
refuses to when `NODE_ENV=production`).

## Scheduled jobs

```bash
URL=$(gcloud run services describe nimpat-one-api-$ENV --region=$REGION --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret=nimpat-one-$ENV-jobs-token)
gcloud scheduler jobs create http nimpat-one-expire-$ENV --location=$REGION --schedule='* * * * *' \
  --uri="$URL/api/v1/internal/jobs/expire" --http-method=POST --headers="X-Job-Token=$TOKEN"
gcloud scheduler jobs create http nimpat-one-reconcile-$ENV --location=$REGION --schedule='*/5 * * * *' \
  --uri="$URL/api/v1/internal/jobs/reconcile-payments" --http-method=POST --headers="X-Job-Token=$TOKEN"
```

## Paystack webhook

In the Paystack dashboard (test mode) → Settings → API Keys & Webhooks, set the
webhook URL to `https://<api-domain>/api/v1/payments/webhooks/paystack`.
Optionally restrict to Paystack's published IPs with
`PAYSTACK_WEBHOOK_IP_ALLOWLIST` (comma-separated); signatures are always
verified regardless.

## Health checks

* Liveness: `GET /health/live`
* Readiness: `GET /health/ready` (checks the database)

Configure a Cloud Run startup probe on `/health/ready`.

## Custom domain

Map `api.nimpatgroup.com` (or the agreed host) with a Cloud Run domain mapping or
a global external HTTPS load balancer. DNS for nimpatgroup.com is managed
separately (GO54 / Hostinger); coordinate the record change with the owner.
