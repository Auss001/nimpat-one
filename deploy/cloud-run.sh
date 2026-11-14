#!/usr/bin/env bash
# Puts Nimpat One on Google Cloud Run. Safe to run again: existing items are kept.
#   PROJECT=my-project ./deploy/cloud-run.sh setup      first time: database, buckets, secrets, loads local data
#   PROJECT=my-project ./deploy/cloud-run.sh release    build and deploy the API, customer app and dashboard
#   PROJECT=my-project ./deploy/cloud-run.sh sql FILE   back up, then apply a data change such as deploy/data/*.sql
#   PROJECT=my-project ./deploy/cloud-run.sh backup     copy the whole database to the backups bucket now
#
# Database (owner, 14 November 2026): during testing the database runs on Neon's free plan (PostgreSQL, Frankfurt),
# so Google Cloud stays inside its free allowance. Its address is the Secret Manager secret
# nimpat-one-neon-database-url (the DIRECT address, without "-pooler"). DB=cloudsql switches every command back to the
# old Cloud SQL instance. A daily copy of the whole database goes to the backups bucket (kept 30 days).
# Secrets are created in Secret Manager and never printed or written to disk.
set -euo pipefail
# Git Bash on Windows: leave these arguments alone; everything else needs its normal path handling.
export MSYS2_ARG_CONV_EXCL="--args=;--add-volume-mount=;--set-env-vars=;--startup-probe=;--schedule=;--uri=;--add-cloudsql-instances=;--set-cloudsql-instances=;--command="

: "${PROJECT:?Set PROJECT}"
REGION="${REGION:-europe-west1}"
SQL_INSTANCE=nimpat-one-pg
SQL_TIER="${SQL_TIER:-db-f1-micro}"
DB="${DB:-neon}"
case "$DB" in neon) DB_SECRET=nimpat-one-neon-database-url ;; cloudsql) DB_SECRET=nimpat-one-database-url ;; *) echo "DB must be neon or cloudsql"; exit 1 ;; esac
BACKUPS="nimpat-one-backups-$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
REPO="$REGION-docker.pkg.dev/$PROJECT/nimpat-one"
SA="nimpat-one-api@$PROJECT.iam.gserviceaccount.com"
PHOTOS="nimpat-one-photos-$NUMBER"
PROOFS="nimpat-one-proofs-$NUMBER"
# Cloud Run addresses: always work, and the app and dashboard reach the API through them behind the scenes.
RUN_API_URL="https://nimpat-one-api-$NUMBER.$REGION.run.app"
RUN_APP_URL="https://nimpat-one-app-$NUMBER.$REGION.run.app"
RUN_ADMIN_URL="https://nimpat-one-admin-$NUMBER.$REGION.run.app"
# Public addresses customers and emails use. With PUBLIC_DOMAIN=nimpatgroup.com they become app., admin. and api.
# subdomains (their DNS and HTTPS certificates have worked since 7 Nov 2026).
# Defaults to nimpatgroup.com so every release keeps the proper addresses; PUBLIC_DOMAIN=none uses the run.app ones.
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-nimpatgroup.com}"
[ "$PUBLIC_DOMAIN" = none ] && PUBLIC_DOMAIN=""
if [ -n "$PUBLIC_DOMAIN" ]; then
  APP_URL="https://app.$PUBLIC_DOMAIN" ADMIN_URL="https://admin.$PUBLIC_DOMAIN" API_URL="https://api.$PUBLIC_DOMAIN"
else
  APP_URL="$RUN_APP_URL" ADMIN_URL="$RUN_ADMIN_URL" API_URL="$RUN_API_URL"
fi
# Both sets of addresses may call the API, so nothing breaks while people move over.
# The Android app runs at https://localhost and the iPhone app at capacitor://localhost.
CORS_LIST="$APP_URL,$ADMIN_URL,https://localhost,capacitor://localhost"
[ "$APP_URL" != "$RUN_APP_URL" ] && CORS_LIST="$CORS_LIST,$RUN_APP_URL,$RUN_ADMIN_URL"
gcloud config set project "$PROJECT" >/dev/null 2>&1

random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
secret() { # name, value on stdin; keeps an existing secret
  if gcloud secrets describe "$1" >/dev/null 2>&1; then cat >/dev/null; echo "secret $1 kept"
  else gcloud secrets create "$1" --replication-policy=automatic --data-file=- >/dev/null; echo "secret $1 created"; fi
}

setup() {
  echo "== services"
  gcloud services enable run.googleapis.com sqladmin.googleapis.com sql-component.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com

  echo "== image store"
  gcloud artifacts repositories describe nimpat-one --location="$REGION" >/dev/null 2>&1 || gcloud artifacts repositories create nimpat-one --repository-format=docker --location="$REGION"

  echo "== buckets"
  for b in "$PHOTOS" "$PROOFS"; do
    gcloud storage buckets describe "gs://$b" >/dev/null 2>&1 || gcloud storage buckets create "gs://$b" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  done
  [ -d uploads/public-photos ] && gcloud storage rsync uploads/public-photos "gs://$PHOTOS" --recursive

  echo "== service account"
  gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create nimpat-one-api --display-name="Nimpat One API"
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/cloudsql.client --condition=None >/dev/null
  for b in "$PHOTOS" "$PROOFS"; do
    gcloud storage buckets add-iam-policy-binding "gs://$b" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
  done

  echo "== database (this takes several minutes the first time)"
  gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1 || gcloud sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_17 --edition=ENTERPRISE --tier="$SQL_TIER" --region="$REGION" --storage-size=10GB --storage-auto-increase --backup-start-time=02:00 --deletion-protection
  gcloud sql databases describe nimpat_one --instance="$SQL_INSTANCE" >/dev/null 2>&1 || gcloud sql databases create nimpat_one --instance="$SQL_INSTANCE"

  echo "== secrets"
  if ! gcloud secrets describe nimpat-one-database-url >/dev/null 2>&1; then
    local pw; pw=$(random 24)
    gcloud sql users create nimpat_api --instance="$SQL_INSTANCE" --password="$pw" >/dev/null
    printf 'postgresql://nimpat_api:%s@localhost/nimpat_one?host=/cloudsql/%s:%s:%s&schema=public' "$pw" "$PROJECT" "$REGION" "$SQL_INSTANCE" | secret nimpat-one-database-url
    unset pw
  fi
  random 48 | secret nimpat-one-jwt-secret
  random 32 | secret nimpat-one-jobs-token
  # The API only accepts test keys. Replace this with your own test key in Secret Manager.
  printf 'sk_test_not_set_yet' | secret nimpat-one-paystack-secret
  # The API may read only the secrets it uses, one by one; never the whole project's.
  for s in nimpat-one-database-url nimpat-one-jwt-secret nimpat-one-jobs-token nimpat-one-paystack-secret; do
    gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  done
}

load_data() {
  echo "== loading local data"
  local tmp="nimpat-one-import-$NUMBER" user dump
  user=$(grep -m1 -oE '^DATABASE_URL=[^:]*://[^:]+' .env | sed 's#.*//##')
  dump=$(mktemp)
  docker exec nimpat-one-db pg_dump -U "$user" -d nimpat_one --no-owner --no-privileges | grep -vE '^(COMMENT ON EXTENSION|SET transaction_timeout)' > "$dump"
  gcloud storage buckets describe "gs://$tmp" >/dev/null 2>&1 || gcloud storage buckets create "gs://$tmp" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  local sql_sa; sql_sa=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(serviceAccountEmailAddress)')
  gcloud storage buckets add-iam-policy-binding "gs://$tmp" --member="serviceAccount:$sql_sa" --role=roles/storage.objectViewer >/dev/null
  gcloud storage cp "$dump" "gs://$tmp/data.sql"
  rm -f "$dump"
  gcloud sql import sql "$SQL_INSTANCE" "gs://$tmp/data.sql" --database=nimpat_one --user=nimpat_api --quiet
  gcloud storage rm --recursive "gs://$tmp"
  echo "data loaded; temporary copy deleted"
}

# psql against Neon in a throwaway container; the address comes from Secret Manager and is never printed.
neon_psql() { # extra psql arguments; a mounted folder is available at /d
  local dir="${NEON_DIR:-$PWD}"
  MSYS_NO_PATHCONV=1 docker run --rm -i -e DB="$(gcloud secrets versions access latest --secret="$DB_SECRET" | tr -d '\r\n')" -v "$(cd "$dir" && pwd -W 2>/dev/null || pwd):/d" postgres:18 sh -c 'psql "$DB" "$@"' psql "$@"
}

run_sql() { # file: a data change such as a price list, applied after a backup
  local file="${1:?Give the SQL file}" tmp="nimpat-one-import-$NUMBER"
  [ -f "$file" ] || { echo "No such file: $file"; exit 1; }
  if [ "$DB" = neon ]; then
    backup "before $(basename "$file")"
    echo "== applying $(basename "$file")"
    NEON_DIR="$(dirname "$file")" neon_psql -v ON_ERROR_STOP=1 --single-transaction -q -f "/d/$(basename "$file")"
    echo "applied"
    return
  fi
  echo "== backing up the database"
  gcloud sql backups create --instance="$SQL_INSTANCE" --description="before $(basename "$file")" --quiet
  echo "== applying $(basename "$file")"
  gcloud storage buckets describe "gs://$tmp" >/dev/null 2>&1 || gcloud storage buckets create "gs://$tmp" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  local sql_sa; sql_sa=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(serviceAccountEmailAddress)')
  gcloud storage buckets add-iam-policy-binding "gs://$tmp" --member="serviceAccount:$sql_sa" --role=roles/storage.objectViewer >/dev/null
  gcloud storage cp "$file" "gs://$tmp/change.sql"
  gcloud sql import sql "$SQL_INSTANCE" "gs://$tmp/change.sql" --database=nimpat_one --user=nimpat_api --quiet
  gcloud storage rm --recursive "gs://$tmp"
  echo "applied; temporary copy deleted"
}

report() { # query: a read-only SELECT; prints the result as CSV (nothing changes, so no backup)
  local query="${1:?Give a SELECT query}" tmp="nimpat-one-report-$NUMBER"
  case "$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//')" in select*|with*) ;; *) echo "Only SELECT queries"; exit 1 ;; esac
  if [ "$DB" = neon ]; then neon_psql -c "SET default_transaction_read_only = on" -c "\copy ($query) TO STDOUT WITH CSV HEADER"; return; fi
  gcloud storage buckets describe "gs://$tmp" >/dev/null 2>&1 || gcloud storage buckets create "gs://$tmp" --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null
  local sql_sa; sql_sa=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(serviceAccountEmailAddress)')
  gcloud storage buckets add-iam-policy-binding "gs://$tmp" --member="serviceAccount:$sql_sa" --role=roles/storage.objectAdmin >/dev/null
  gcloud sql export csv "$SQL_INSTANCE" "gs://$tmp/report.csv" --database=nimpat_one --query="$query" --quiet >/dev/null 2>&1
  gcloud storage cat "gs://$tmp/report.csv"
  gcloud storage rm --recursive "gs://$tmp" >/dev/null 2>&1
}

# The backup job: pg_dump of the whole database into gs://$BACKUPS (deleted after 30 days). Free at this size.
backup_job() {
  gcloud storage buckets describe "gs://$BACKUPS" >/dev/null 2>&1 || gcloud storage buckets create "gs://$BACKUPS" --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > "${TMPDIR:-/tmp}/nimpat-lifecycle.json"
  gcloud storage buckets update "gs://$BACKUPS" --lifecycle-file="${TMPDIR:-/tmp}/nimpat-lifecycle.json" >/dev/null
  rm -f "${TMPDIR:-/tmp}/nimpat-lifecycle.json"
  gcloud storage buckets add-iam-policy-binding "gs://$BACKUPS" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --condition=None >/dev/null
  gcloud secrets add-iam-policy-binding "$DB_SECRET" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  gcloud run jobs deploy nimpat-one-backup --image=docker.io/library/postgres:18 --region="$REGION" --service-account="$SA" \
    --set-secrets=DATABASE_URL="$DB_SECRET":latest --add-volume=name=backups,type=cloud-storage,bucket="$BACKUPS" --add-volume-mount=volume=backups,mount-path=/backups \
    --command=sh --args=-c,'f=/backups/$(date -u +%Y-%m-%d-%H%M).sql.gz; pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$f.part" && mv "$f.part" "$f" && ls -l "$f"' \
    --memory=512Mi --max-retries=1 --task-timeout=600 --quiet >/dev/null
}

backup() { # description: copies the whole database now, and waits
  echo "== backing up the database ($1)"
  if [ "$DB" = cloudsql ]; then gcloud sql backups create --instance="$SQL_INSTANCE" --description="$1" --quiet; return; fi
  backup_job
  gcloud run jobs execute nimpat-one-backup --region="$REGION" --wait --quiet >/dev/null && echo "backup saved in gs://$BACKUPS"
}

release() {
  local tag; tag=$(git rev-parse --short HEAD)-$(date +%H%M%S)
  gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1
  echo "== building"
  docker build -t "$REPO/api:$tag" .
  docker build -f deploy/web.Dockerfile --build-arg APP_DIR=app -t "$REPO/app:$tag" .
  docker build -f deploy/web.Dockerfile --build-arg APP_DIR=admin --build-arg VITE_APP_URL="$APP_URL" -t "$REPO/admin:$tag" .
  docker push -q "$REPO/api:$tag"; docker push -q "$REPO/app:$tag"; docker push -q "$REPO/admin:$tag"

  echo "== backing up and updating the database ($DB)"
  backup "before release $tag"
  local sqlflag="--set-cloudsql-instances=" addsql="--clear-cloudsql-instances"
  if [ "$DB" = cloudsql ]; then sqlflag="--set-cloudsql-instances=$PROJECT:$REGION:$SQL_INSTANCE"; addsql="--add-cloudsql-instances=$PROJECT:$REGION:$SQL_INSTANCE"; fi
  gcloud secrets add-iam-policy-binding "$DB_SECRET" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  gcloud run jobs deploy nimpat-one-migrate --image="$REPO/api:$tag" --region="$REGION" --service-account="$SA" \
    "$sqlflag" --set-secrets=DATABASE_URL="$DB_SECRET":latest \
    --command=./node_modules/.bin/prisma --args=migrate,deploy --memory=1Gi --max-retries=0 --task-timeout=300 --execute-now --wait --quiet

  # Email goes out through Resend once its key is in Secret Manager; until then it is only logged.
  local mail="MAIL_TRANSPORT=console" mail_secret=""
  if gcloud secrets describe nimpat-one-resend-api-key >/dev/null 2>&1; then
    mail="MAIL_TRANSPORT=resend|EMAIL_FROM=Nimpat One <no-reply@notify.nimpatgroup.com>"
    mail_secret=",RESEND_API_KEY=nimpat-one-resend-api-key:latest"
    gcloud secrets add-iam-policy-binding nimpat-one-resend-api-key --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  fi

  # Paystack: test unless the release is run with PAYSTACK_MODE=live. Each mode reads only its own secret,
  # and the API is given access to the live secret only when live is chosen.
  local pay_mode="${PAYSTACK_MODE:-test}" pay_secret=nimpat-one-paystack-secret
  if [ "$pay_mode" = live ]; then
    pay_secret=nimpat-one-paystack-live-secret
    gcloud secrets add-iam-policy-binding "$pay_secret" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  elif [ "$pay_mode" != test ]; then
    echo "PAYSTACK_MODE must be test or live"; exit 1
  fi
  echo "== Paystack mode: $pay_mode"

  echo "== deploying the API"
  gcloud run deploy nimpat-one-api --image="$REPO/api:$tag" --region="$REGION" --service-account="$SA" --allow-unauthenticated \
    "$addsql" --execution-environment=gen2 --memory=1Gi --cpu=1 --min-instances=0 --max-instances=5 --concurrency=40 --timeout=60 --cpu-boost \
    --add-volume=name=photos,type=cloud-storage,bucket="$PHOTOS" --add-volume-mount=volume=photos,mount-path=/data/photos \
    --add-volume=name=proofs,type=cloud-storage,bucket="$PROOFS" --add-volume-mount=volume=proofs,mount-path=/data/proofs \
    --set-env-vars="^|^NODE_ENV=production|TRUST_PROXY=true|JOBS_INPROCESS=false|PAYSTACK_MODE=$pay_mode|$mail|REQUIRE_VERIFIED_EMAIL_FOR_PAYMENT=false|PHOTO_STORAGE_DIR=/data/photos|PROOF_STORAGE_DIR=/data/proofs|APP_PUBLIC_URL=$APP_URL|ADMIN_PUBLIC_URL=$ADMIN_URL|PAYSTACK_CALLBACK_URL=$APP_URL/payments/callback|CORS_ORIGINS=$CORS_LIST|FCM_PROJECT_ID=$PROJECT" \
    --set-secrets="DATABASE_URL=$DB_SECRET:latest,JWT_ACCESS_SECRET=nimpat-one-jwt-secret:latest,JOBS_TOKEN=nimpat-one-jobs-token:latest,PAYSTACK_SECRET_KEY=$pay_secret:latest$mail_secret" \
    --startup-probe=httpGet.path=/health/ready,httpGet.port=8080,initialDelaySeconds=5,timeoutSeconds=5,periodSeconds=10,failureThreshold=12 --quiet

  echo "== deploying the customer app and dashboard"
  for s in app admin; do
    gcloud run deploy "nimpat-one-$s" --image="$REPO/$s:$tag" --region="$REGION" --allow-unauthenticated --memory=256Mi --cpu=1 --min-instances=0 --max-instances=5 --port=8080 \
      --set-env-vars="API_ORIGIN=$RUN_API_URL,API_HOST=nimpat-one-api-$NUMBER.$REGION.run.app" --quiet
  done

  echo "== scheduled jobs"
  local token; token=$(gcloud secrets versions access latest --secret=nimpat-one-jobs-token)
  job() { # name, schedule, path
    local verb=create; gcloud scheduler jobs describe "$1" --location="$REGION" >/dev/null 2>&1 && verb=update
    if [ "$verb" = create ]; then
      gcloud scheduler jobs create http "$1" --location="$REGION" --schedule="$2" --uri="$RUN_API_URL$3" --http-method=POST --headers="X-Job-Token=$token" --quiet >/dev/null
    else
      gcloud scheduler jobs update http "$1" --location="$REGION" --schedule="$2" --uri="$RUN_API_URL$3" --http-method=POST --update-headers="X-Job-Token=$token" --quiet >/dev/null
    fi
  }
  if [ "$DB" = neon ]; then
    job nimpat-one-expire '*/30 * * * *' /api/v1/internal/jobs/expire
    job nimpat-one-reconcile '15,45 * * * *' /api/v1/internal/jobs/reconcile-payments
  else
    job nimpat-one-expire '*/5 * * * *' /api/v1/internal/jobs/expire
    job nimpat-one-reconcile '*/15 * * * *' /api/v1/internal/jobs/reconcile-payments
  fi
  unset token
  # The daily copy of the whole database (03:00 Lagos time).
  if [ "$DB" = neon ]; then
    local runner="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/nimpat-one-backup:run"
    gcloud run jobs add-iam-policy-binding nimpat-one-backup --region="$REGION" --member="serviceAccount:$SA" --role=roles/run.invoker --quiet >/dev/null
    if gcloud scheduler jobs describe nimpat-one-backup --location="$REGION" >/dev/null 2>&1; then
      gcloud scheduler jobs update http nimpat-one-backup --location="$REGION" --schedule='0 2 * * *' --uri="$runner" --http-method=POST --oauth-service-account-email="$SA" --quiet >/dev/null
    else
      gcloud scheduler jobs create http nimpat-one-backup --location="$REGION" --schedule='0 2 * * *' --uri="$runner" --http-method=POST --oauth-service-account-email="$SA" --quiet >/dev/null
    fi
  fi

  echo "customer app: $APP_URL"
  echo "dashboard:    $ADMIN_URL"
  echo "api:          $API_URL"
}

case "${1:-}" in
  setup) setup; load_data ;;
  release) release ;;
  sql) run_sql "${2:-}" ;;
  report) report "${2:-}" ;;
  backup) backup "on request" ;;
  *) echo "Usage: PROJECT=... $0 setup|release|sql FILE|report \"SELECT ...\""; exit 1 ;;
esac
