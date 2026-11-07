#!/usr/bin/env bash
# Puts Nimpat One on Google Cloud Run. Safe to run again: existing items are kept.
#   PROJECT=my-project ./deploy/cloud-run.sh setup      first time: database, buckets, secrets, loads local data
#   PROJECT=my-project ./deploy/cloud-run.sh release    build and deploy the API, customer app and dashboard
#   PROJECT=my-project ./deploy/cloud-run.sh sql FILE   back up, then apply a data change such as deploy/data/*.sql
# Secrets are created in Secret Manager and never printed or written to disk.
set -euo pipefail
# Git Bash on Windows: leave these arguments alone; everything else needs its normal path handling.
export MSYS2_ARG_CONV_EXCL="--add-volume-mount=;--set-env-vars=;--startup-probe=;--schedule=;--uri=;--add-cloudsql-instances=;--set-cloudsql-instances=;--command="

: "${PROJECT:?Set PROJECT}"
REGION="${REGION:-europe-west1}"
SQL_INSTANCE=nimpat-one-pg
SQL_TIER="${SQL_TIER:-db-f1-micro}"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
REPO="$REGION-docker.pkg.dev/$PROJECT/nimpat-one"
SA="nimpat-one-api@$PROJECT.iam.gserviceaccount.com"
PHOTOS="nimpat-one-photos-$NUMBER"
PROOFS="nimpat-one-proofs-$NUMBER"
API_URL="https://nimpat-one-api-$NUMBER.$REGION.run.app"
APP_URL="https://nimpat-one-app-$NUMBER.$REGION.run.app"
ADMIN_URL="https://nimpat-one-admin-$NUMBER.$REGION.run.app"
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
  for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
  done
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

run_sql() { # file: a data change such as a price list, applied after a backup
  local file="${1:?Give the SQL file}" tmp="nimpat-one-import-$NUMBER"
  [ -f "$file" ] || { echo "No such file: $file"; exit 1; }
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

release() {
  local tag; tag=$(git rev-parse --short HEAD)-$(date +%H%M%S)
  gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1
  echo "== building"
  docker build -t "$REPO/api:$tag" .
  docker build -f deploy/web.Dockerfile --build-arg APP_DIR=app -t "$REPO/app:$tag" .
  docker build -f deploy/web.Dockerfile --build-arg APP_DIR=admin --build-arg VITE_APP_URL="$APP_URL" -t "$REPO/admin:$tag" .
  docker push -q "$REPO/api:$tag"; docker push -q "$REPO/app:$tag"; docker push -q "$REPO/admin:$tag"

  echo "== backing up and updating the database"
  gcloud sql backups create --instance="$SQL_INSTANCE" --description="before release $tag" --quiet
  gcloud run jobs deploy nimpat-one-migrate --image="$REPO/api:$tag" --region="$REGION" --service-account="$SA" \
    --set-cloudsql-instances="$PROJECT:$REGION:$SQL_INSTANCE" --set-secrets=DATABASE_URL=nimpat-one-database-url:latest \
    --command=./node_modules/.bin/prisma --args=migrate,deploy --memory=1Gi --max-retries=0 --task-timeout=300 --execute-now --wait --quiet

  echo "== deploying the API"
  gcloud run deploy nimpat-one-api --image="$REPO/api:$tag" --region="$REGION" --service-account="$SA" --allow-unauthenticated \
    --add-cloudsql-instances="$PROJECT:$REGION:$SQL_INSTANCE" --execution-environment=gen2 --memory=1Gi --cpu=1 --min-instances=0 --max-instances=5 --concurrency=40 --timeout=60 --cpu-boost \
    --add-volume=name=photos,type=cloud-storage,bucket="$PHOTOS" --add-volume-mount=volume=photos,mount-path=/data/photos \
    --add-volume=name=proofs,type=cloud-storage,bucket="$PROOFS" --add-volume-mount=volume=proofs,mount-path=/data/proofs \
    --set-env-vars="^|^NODE_ENV=production|TRUST_PROXY=true|JOBS_INPROCESS=false|MAIL_TRANSPORT=console|REQUIRE_VERIFIED_EMAIL_FOR_PAYMENT=false|PHOTO_STORAGE_DIR=/data/photos|PROOF_STORAGE_DIR=/data/proofs|APP_PUBLIC_URL=$APP_URL|ADMIN_PUBLIC_URL=$ADMIN_URL|PAYSTACK_CALLBACK_URL=$APP_URL/payments/callback|CORS_ORIGINS=$APP_URL,$ADMIN_URL" \
    --set-secrets=DATABASE_URL=nimpat-one-database-url:latest,JWT_ACCESS_SECRET=nimpat-one-jwt-secret:latest,JOBS_TOKEN=nimpat-one-jobs-token:latest,PAYSTACK_SECRET_KEY=nimpat-one-paystack-secret:latest \
    --startup-probe=httpGet.path=/health/ready,httpGet.port=8080,initialDelaySeconds=5,timeoutSeconds=5,periodSeconds=10,failureThreshold=12 --quiet

  echo "== deploying the customer app and dashboard"
  for s in app admin; do
    gcloud run deploy "nimpat-one-$s" --image="$REPO/$s:$tag" --region="$REGION" --allow-unauthenticated --memory=256Mi --cpu=1 --min-instances=0 --max-instances=5 --port=8080 \
      --set-env-vars="API_ORIGIN=$API_URL,API_HOST=nimpat-one-api-$NUMBER.$REGION.run.app" --quiet
  done

  echo "== scheduled jobs"
  local token; token=$(gcloud secrets versions access latest --secret=nimpat-one-jobs-token)
  job() { # name, schedule, path
    local verb=create; gcloud scheduler jobs describe "$1" --location="$REGION" >/dev/null 2>&1 && verb=update
    if [ "$verb" = create ]; then
      gcloud scheduler jobs create http "$1" --location="$REGION" --schedule="$2" --uri="$API_URL$3" --http-method=POST --headers="X-Job-Token=$token" --quiet >/dev/null
    else
      gcloud scheduler jobs update http "$1" --location="$REGION" --schedule="$2" --uri="$API_URL$3" --http-method=POST --update-headers="X-Job-Token=$token" --quiet >/dev/null
    fi
  }
  job nimpat-one-expire '*/5 * * * *' /api/v1/internal/jobs/expire
  job nimpat-one-reconcile '*/15 * * * *' /api/v1/internal/jobs/reconcile-payments
  unset token

  echo "customer app: $APP_URL"
  echo "dashboard:    $ADMIN_URL"
  echo "api:          $API_URL"
}

case "${1:-}" in
  setup) setup; load_data ;;
  release) release ;;
  sql) run_sql "${2:-}" ;;
  *) echo "Usage: PROJECT=... $0 setup|release|sql FILE"; exit 1 ;;
esac
