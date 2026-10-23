#!/usr/bin/env bash
# First run and every run after: clone Moodle, start the stack, install if
# needed, apply dev settings, print the admin token. Each step skips itself
# when it is already done, so this is also how you start Moodle again.
set -euo pipefail
cd "$(dirname "$0")"

MOODLE_BRANCH="${MOODLE_BRANCH:-MOODLE_405_STABLE}"
WWWROOT="http://localhost:9200"
ADMIN_PASS='Password1!'

# 1. Moodle source. Shallow: the full history is several GB we never read.
if [ ! -f src/version.php ]; then
  echo "Cloning Moodle ($MOODLE_BRANCH) into src/ ..."
  git clone --depth 1 -b "$MOODLE_BRANCH" https://github.com/moodle/moodle.git src
fi

# 2. The stack. --wait returns once Postgres passes its healthcheck.
docker compose up -d --wait

# The named volume starts out root-owned; Apache runs as www-data.
docker compose exec -T moodle chown www-data:www-data /var/www/moodledata

php() { docker compose exec -T -u www-data moodle php "$@"; }

# 3. Install once. config.php is written into src/ and is the marker.
if [ ! -f src/config.php ]; then
  echo "Installing Moodle (a few minutes on first run) ..."
  php admin/cli/install.php \
    --non-interactive --agree-license \
    --lang=en \
    --wwwroot="$WWWROOT" \
    --dataroot=/var/www/moodledata \
    --dbtype=pgsql --dbhost=moodle-db --dbname=moodle \
    --dbuser=moodle --dbpass=moodle --prefix=mdl_ \
    --fullname="Ethyra Dev Moodle" --shortname=ethyradev \
    --adminuser=admin --adminpass="$ADMIN_PASS" \
    --adminemail=admin@example.com \
    --supportemail=admin@example.com
fi

# 4. Dev settings and the admin web service token (last line of output).
TOKEN="$(php /ethyra/configure.php | tail -n 1)"

cat <<EOF

Moodle is up.
  Site      $WWWROOT
  Admin     admin / $ADMIN_PASS
  Mail      http://localhost:9201
  Token     $TOKEN

Seed the fixtures with:  ./seed.sh
EOF
