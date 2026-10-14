pg_dump --format=custom --file=/var/backups/zipy-$(date +%F).dump \
  "$DATABASE_URL"
