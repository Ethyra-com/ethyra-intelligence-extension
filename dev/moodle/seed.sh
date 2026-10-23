#!/usr/bin/env bash
# Build the site from a teacher's zip and a student's zip. See cli/seed.php.
#   ./seed.sh [teacher.zip] [student.zip]
# Defaults are the two zips in ~/Downloads. Their contents are unzipped into
# fixtures/ (gitignored), which the containers see as /fixtures.
set -euo pipefail
cd "$(dirname "$0")"

TEACHER_ZIP="${1:-$HOME/Downloads/Teacher_Mr_Tremblay.zip}"
STUDENT_ZIP="${2:-$HOME/Downloads/Student_Jordan_Lee.zip}"

# Empty the folder rather than delete it: a running container's bind mount
# would keep pointing at the deleted directory.
mkdir -p fixtures
find fixtures -mindepth 1 -delete
unzip -q "$TEACHER_ZIP" -d fixtures
unzip -q "$STUDENT_ZIP" -d fixtures
rm -rf fixtures/__MACOSX

# Recreates the containers if the fixtures mount is new; otherwise a no-op.
docker compose up -d --wait >/dev/null 2>&1
docker compose exec -T -u www-data moodle php /ethyra/seed.php
