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

# 3. config.php, written here as you rather than by Moodle's installer: the
# installer runs as www-data and would need write access to src/, which on a
# native Linux bind mount means opening src/ up to every local user.
cat > src/config.php <<PHP
<?php  // Written by dev/moodle/setup.sh. Rewritten on every run.
unset(\$CFG);
global \$CFG;
\$CFG = new stdClass();
\$CFG->dbtype    = 'pgsql';
\$CFG->dblibrary = 'native';
\$CFG->dbhost    = 'moodle-db';
\$CFG->dbname    = 'moodle';
\$CFG->dbuser    = 'moodle';
\$CFG->dbpass    = 'moodle';
\$CFG->prefix    = 'mdl_';
\$CFG->dboptions = ['dbpersist' => 0, 'dbport' => '', 'dbsocket' => ''];
\$CFG->wwwroot   = '$WWWROOT';
\$CFG->dataroot  = '/var/www/moodledata';
\$CFG->admin     = 'admin';
\$CFG->directorypermissions = 02777;
require_once(__DIR__ . '/lib/setup.php');
PHP
chmod 644 src/config.php   # Apache (www-data) reads it; a private umask would hide it.

# 4. Install the database once. Moodle's tables are the marker.
installed="$(docker compose exec -T moodle-db psql -U moodle -d moodle -tAc "select to_regclass('mdl_config')")"
if [ -z "$installed" ]; then
  echo "Installing Moodle (a few minutes on first run) ..."
  php admin/cli/install_database.php \
    --agree-license --lang=en \
    --fullname="Ethyra Dev Moodle" --shortname=ethyradev \
    --adminuser=admin --adminpass="$ADMIN_PASS" \
    --adminemail=admin@example.com \
    --supportemail=admin@example.com
fi

# 5. Dev settings and the admin web service token (last line of output).
TOKEN="$(php /ethyra/configure.php | tail -n 1)"

cat <<EOF

Moodle is up.
  Site      $WWWROOT
  Admin     admin / $ADMIN_PASS
  Mail      http://localhost:9201
  Token     $TOKEN

Seed the fixtures with:  ./seed.sh
EOF
