# A local Moodle to test against

The extension reads Canvas. Many schools, especially outside the US, run
Moodle instead. Before the extension can read Moodle, it needs a Moodle where
you are the admin and the coursework is known. `../README.md` sets up the same
thing for Canvas.

This is real Moodle (4.5 LTS, GPLv3), run from source. It is not a mock.

## Prerequisites

A container runtime: Docker Desktop, OrbStack or colima. Budget ~3 GB of disk:
a 1.3 GB PHP image, ~450 MB of Moodle source, Postgres and the volumes.
Measured at rest, the stack uses about **400 MB** of RAM.

## First run

```bash
cd dev/moodle
./setup.sh      # clone, start, install, configure (~2 min the first time)
./seed.sh       # courses from the two zips in ~/Downloads (~20 s)
```

`setup.sh` is also how you start it again later. Every step skips itself when
it is already done. To stop it without losing anything, run `docker compose stop`.

| | |
|---|---|
| Site | <http://localhost:9200> |
| Admin | `admin` / `Password1!` |
| Student | `student@example.com` / `password123` |
| Teacher | `teacher@example.com` / `password123` |
| Mail | <http://localhost:9201> (Mailpit: every email Moodle sends) |

The admin password differs from the others because the installer enforces
Moodle's password policy. `cli/configure.php` turns the policy off afterwards,
so seeded users get `password123` like the Canvas fixtures.

The site requires login (`forcelogin`) and hides the guest button, so every
page lands on the login screen, as on a school's Moodle.

## What is running

| Service | What it is |
|---|---|
| `moodle` | Apache + PHP 8.3 (`moodlehq/moodle-php-apache`, native arm64), serving `./src` |
| `moodle-cron` | `admin/cli/cron.php` every 60 s, the equivalent of Canvas's `canvas.job`. Without it, grade pushes, notifications and file conversions never run |
| `moodle-db` | Postgres 16 |
| `moodle-mail` | Mailpit, so outgoing mail succeeds instead of erroring |

Moodle is not baked into an image. It is the source tree in `src/`, cloned
shallow by `setup.sh` and gitignored. `src/config.php` is written by the
installer and marks the site as installed. To try another version, set
`MOODLE_BRANCH` (for example `MOODLE_500_STABLE`) on a fresh reset. Moodle 5.1+
moves the web root to `src/public`, so the volume mount would need to change too.

## Fixtures (`./seed.sh`)

The site is built from two zips of coursework: one teacher's classes and one
student's classes.

```bash
./seed.sh [teacher.zip] [student.zip]
# defaults: ~/Downloads/Teacher_Mr_Tremblay.zip ~/Downloads/Student_Jordan_Lee.zip
```

They are unzipped into `fixtures/` (gitignored), and `cli/seed.php` turns the
folders into courses, assignments and submissions:

```
Teacher_Mr_Tremblay/SCH3U_Chemistry_11_Period_1/03_Lab_2_.../Kaur_03.pdf
Student_Jordan_Lee/ENG4U_English_12/03_Handmaid_s_Tale_Theme_Essay/*_final.docx
```

- **Course** folder `CODE_Name[_Period_N]` becomes the course *Name (Period N)*,
  with the short name `CODE-PN` or `CODE`.
- **Assignment** folder `NN_Name` becomes one assignment. Its title comes from
  the handout if there is one, else from the document titles. The folder name
  is kept as the activity's ID number, which is how re-runs find it.
- **`Instructions_*` / `_Instructions_*`** is the teacher's handout. It is
  attached to the assignment, and its `Due:` line sets the due date (11:59 pm,
  Toronto time). Without a handout, the due date is the submission date.
- **Teacher zip:** each file is one student's submission. File names are
  inconsistent (`Kaur_03.pdf`, `AmeliaWilson_...`), so the student is whoever
  the document's first line names.
- **Student zip:** all files in an assignment folder (final, outline, rough
  work...) are one submission. The class's teacher is the document's second
  line. A class with the same teacher and course code as one of the teacher's
  joins that section. This is how Jordan ends up in Chemistry 11 (Period 1).
- Submissions are dated to the date on the documents, not to the day you seeded.
- Every document has the same header: name, teacher, course, date, title. PDFs
  are read with a small built-in decoder for ReportLab's format, so other
  generators' PDFs may need it extended.

With the current zips:

| Login | Classes |
|---|---|
| `teacher@example.com` (Mr. Tremblay) | Teaches Biology 11 (P5), Chemistry 11 (P1, P3), Grade 10 Science (P4), Physics 12 (P2): 10 assignments each, 5 students each (6 in Chem P1) |
| `student@example.com` (Jordan Lee) | Canadian History, English 12, Functions 11, Biology 11, Chemistry 11 (P1): 10 submissions each |

Both use the password `password123`. The other 29 people (classmates, and
Jordan's other four teachers) exist because Moodle needs a person behind every
submission and class. They use the `nologin` auth method, so nobody can log in
as them. Nothing is graded.

Re-running is safe. A second run changes no rows. To load different zips,
reset first (below); otherwise the old courses stay.

## The API

`setup.sh` prints a permanent **admin token** for the built-in mobile web
service (`moodle_mobile_app`, about 440 functions). It is made by a script, so
after a reset you just run `setup.sh` again. There is no token to recreate by
hand.

```bash
curl "http://localhost:9200/webservice/rest/server.php?wstoken=$TOKEN\
&wsfunction=core_webservice_get_site_info&moodlewsrestformat=json"
```

Any user can get their own token, to see the API from the student's side:

```bash
curl "http://localhost:9200/login/token.php?username=student@example.com\
&password=password123&service=moodle_mobile_app"
```

This works because `configure.php` grants `webservice/rest:use` to all logged-in
users. **A real school's Moodle usually does not**, and many disable web services
entirely, so the extension must not depend on tokens or REST.

## Reset

```bash
docker compose down -v      # wipes the database and moodledata
rm src/config.php           # so setup.sh installs again
./setup.sh && ./seed.sh
```

Add `rm -rf src` to re-clone the source as well, for example to pick up a
newer 4.5 weekly build.

## Known gaps

- **Single origin.** Moodle serves files from the site's own origin
  (`/pluginfile.php`, `/webservice/pluginfile.php`), so this setup covers the
  normal case. Sites that put files behind a CDN or a separate domain won't
  reproduce here.
- **One theme.** This is stock Boost. Schools re-theme Moodle heavily, more
  than Canvas, so a page that looks right here can differ on a real site.
- **No SSO.** Login is Moodle's own form. Real schools often sit behind
  SAML, OAuth or CAS.
- **`wwwroot` is fixed.** Moodle writes `http://localhost:9200` into its config
  and links. Changing the port means a reset, not just a compose edit.
