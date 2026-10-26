<?php
// Builds the site from two folders of real-looking coursework (seed.sh unzips
// them into /fixtures):
//
//   Teacher_<Name>/<CODE_Course_Name_Period_N>/<NN_Assignment>/<files>
//       One teacher's classes. Each file is one student's submission; the
//       student is whoever the document's first line names, since the file
//       names are inconsistent (Kaur_03.pdf, AmeliaWilson_..., C_t_Harper_...).
//   Student_<First_Last>/<CODE_Course_Name>/<NN_Assignment>/<files>
//       One student's classes. Every file in an assignment folder is part of
//       one submission (final, rough work, outline...). Each class's teacher
//       is the document's second line.
//
// In both, a file named Instructions_* or _Instructions_* is the teacher's
// handout: it is attached to the assignment, and its "Due:" line sets the due
// date. Every document starts with the same header: name, teacher, course,
// date, title.
//
// Only the teacher and the student can log in. Their classmates and other
// teachers exist because Moodle needs a person behind every submission and
// class, but they use the nologin auth method.
//
// Run inside the container (seed.sh does this):
//   php /ethyra/seed.php
//
// Built on Moodle's own test data generators. Every step looks for what it
// would create and skips if it is there, so re-running adds nothing.

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/testing/classes/util.php');
require_once($CFG->dirroot . '/mod/assign/locallib.php');

const FIXTURES = '/fixtures';
const PASSWORD = 'password123';

$gen = testing_util::get_data_generator();
$admin = get_admin();
as_user($admin);

// --- Reading the documents ---------------------------------------------------

/** Plain text of a .docx or .pdf, one line per paragraph or text line. */
function doc_text(string $path): string {
    if (str_ends_with($path, '.docx')) {
        $zip = new ZipArchive();
        $zip->open($path);
        $xml = $zip->getFromName('word/document.xml');
        $zip->close();
        $xml = str_replace(['</w:p>', '<w:tab/>'], ["\n", "\t"], $xml);
        return html_entity_decode(strip_tags($xml), ENT_QUOTES | ENT_XML1, 'UTF-8');
    }
    // The PDFs are ReportLab output: content streams are ASCII85 then Flate,
    // and each line of text is one (string) Tj. Enough to read the header.
    $pdf = file_get_contents($path);
    preg_match_all('/stream\r?\n(.*?)endstream/s', $pdf, $streams);
    $lines = [];
    foreach ($streams[1] as $stream) {
        $data = @gzuncompress(ascii85_decode($stream));
        if ($data === false) {
            continue;
        }
        preg_match_all('/\(((?:\\\\.|[^\\\\)])*)\)\s*Tj/s', $data, $strings);
        foreach ($strings[1] as $s) {
            $s = preg_replace_callback('/\\\\([0-7]{1,3}|.)/s', fn($m) =>
                ctype_digit($m[1]) ? chr(octdec($m[1])) : $m[1], $s);
            $lines[] = mb_convert_encoding($s, 'UTF-8', 'Windows-1252');
        }
    }
    return implode("\n", $lines);
}

function ascii85_decode(string $in): string {
    $in = preg_replace('/\s+/', '', $in);
    $in = preg_replace('/^<~|~>$/', '', $in);
    $out = '';
    $tuple = [];
    for ($i = 0, $n = strlen($in); $i < $n; $i++) {
        if ($in[$i] === 'z' && !$tuple) {
            $out .= "\0\0\0\0";
            continue;
        }
        $tuple[] = ord($in[$i]) - 33;
        if (count($tuple) === 5) {
            $value = 0;
            foreach ($tuple as $digit) {
                $value = $value * 85 + $digit;
            }
            $out .= pack('N', $value);
            $tuple = [];
        }
    }
    if ($tuple) {
        $pad = 5 - count($tuple);
        $tuple = array_pad($tuple, 5, 84);
        $value = 0;
        foreach ($tuple as $digit) {
            $value = $value * 85 + $digit;
        }
        $out .= substr(pack('N', $value), 0, 4 - $pad);
    }
    return $out;
}

/** The shared header: name, teacher, course, date, title. */
function header_of(string $path): array {
    $lines = array_values(array_filter(array_map('trim', explode("\n", doc_text($path))), 'strlen'));
    if (count($lines) < 5) {
        throw new moodle_exception("No header in $path");
    }
    return [
        'name' => $lines[0],
        'teacher' => $lines[1],
        'course' => $lines[2],
        'date' => local_time($lines[3], '15:00'),
        'title' => $lines[4],
    ];
}

/** A date from a document ("September 04, 2026") at a time of day, in the site's timezone. */
function local_time(string $date, string $time): int {
    try {
        return (new DateTime("$date $time", core_date::get_server_timezone_object()))->getTimestamp();
    } catch (Exception $e) {
        return time();
    }
}

function is_instructions(string $path): bool {
    return (bool) preg_match('/^_?Instructions_/', basename($path));
}

/** Title and due date from an instructions handout, if the folder has one. */
function instructions_of(array $files): ?array {
    foreach ($files as $file) {
        if (is_instructions($file)) {
            $text = doc_text($file);
            $first = trim(strtok($text, "\n"));
            preg_match('/Due:\s*\w+,\s*(.+?\d{4})/', $text, $due);
            return [
                'path' => $file,
                // The title line can wrap, leaving "X -" or "X - Assignment".
                'title' => preg_replace('/\s*-\s*(Assignment(\s+Instructions)?)?$/', '', $first),
                'due' => isset($due[1]) ? local_time($due[1], '23:59') : null,
            ];
        }
    }
    return null;
}

/** Folder name to a readable name: 03_Handmaid_s_Tale_Theme_Essay -> Handmaid's Tale Theme Essay. */
function folder_title(string $folder): string {
    $name = preg_replace('/^\d+_/', '', $folder);
    $name = preg_replace('/_s_/', "'s ", $name);
    return str_replace('_', ' ', $name);
}

/**
 * The assignment's name: the handout's title, else the document title closest
 * to the folder name. Documents in one folder can be titled "Rough Work" or
 * "... - Outline", so the closest match, not the first, is the assignment.
 */
function assignment_title(string $folder, ?array $instructions, array $headers): string {
    if ($instructions) {
        return $instructions['title'];
    }
    $target = folder_title($folder);
    $best = $target;
    $bestscore = -1;
    foreach (array_unique(array_column($headers, 'title')) as $title) {
        similar_text(strtolower($title), strtolower($target), $score);
        if ($score > $bestscore) {
            [$best, $bestscore] = [$title, $score];
        }
    }
    return $best;
}

/** SCH3U_Chemistry_11_Period_1 -> [SCH3U, Chemistry 11 (Period 1)]. */
function course_names(string $folder): array {
    [$code, $rest] = explode('_', $folder, 2);
    $name = str_replace('_', ' ', $rest);
    $name = preg_replace('/ Period (\d+)$/', ' (Period $1)', $name);
    return [$code, $name];
}

function files_in(string $dir): array {
    $files = glob("$dir/*.{pdf,docx}", GLOB_BRACE);
    sort($files);
    return $files;
}

function subdirs(string $dir): array {
    $dirs = array_filter(glob("$dir/*"), 'is_dir');
    sort($dirs);
    return $dirs;
}

/** An ASCII login from a display name: Harper Côté -> harper.cote@example.com. */
function email_for(string $name): string {
    $ascii = strtolower(iconv('UTF-8', 'ASCII//TRANSLIT', $name));
    $ascii = preg_replace('/^(mr|mrs|ms|dr)\.?\s+/', '', $ascii);
    return trim(preg_replace('/[^a-z0-9]+/', '.', $ascii), '.') . '@example.com';
}

/** "Mr. Tremblay" -> [Mr., Tremblay]; "Harper Côté" -> [Harper, Côté]. */
function split_name(string $name): array {
    $parts = explode(' ', $name, 2);
    return [$parts[0], $parts[1] ?? ''];
}

// --- Find-or-create helpers --------------------------------------------------

function as_user(stdClass $user): void {
    // Moodle caches roles and enrolments on the user object ($USER->access,
    // $USER->enrol), so reusing one would miss anything granted earlier in
    // this run. A fresh record each time, and a clean accesslib, avoid that.
    accesslib_clear_all_caches(false);
    \core\session\manager::set_user(core_user::get_user($user->id, '*', MUST_EXIST));
}

/** Username is the email. $canlogin false gives the nologin auth method. */
function user(string $displayname, bool $canlogin = false, ?string $email = null): stdClass {
    global $DB, $gen;
    $email = $email ?? email_for($displayname);
    if ($user = $DB->get_record('user', ['username' => $email, 'deleted' => 0])) {
        return $user;
    }
    [$first, $last] = split_name($displayname);
    return $gen->create_user([
        'username' => $email,
        'email' => $email,
        'password' => PASSWORD,
        'firstname' => $first,
        'lastname' => $last,
        'auth' => $canlogin ? 'manual' : 'nologin',
    ]);
}

function course(string $shortname, string $fullname): stdClass {
    global $DB, $gen;
    if ($course = $DB->get_record('course', ['shortname' => $shortname])) {
        return $course;
    }
    return $gen->create_course([
        'shortname' => $shortname,
        'fullname' => $fullname,
        'summary' => '',
        'startdate' => strtotime('2026-09-01'),
        'enddate' => strtotime('2027-01-29'),
        'numsections' => 1,
    ]);
}

function enrol(stdClass $user, stdClass $course, string $role): void {
    global $gen;
    $gen->enrol_user($user->id, $course->id, $role);
}

function draft_files(array $paths): int {
    global $USER;
    $itemid = file_get_unused_draft_itemid();
    $fs = get_file_storage();
    foreach ($paths as $path) {
        $fs->create_file_from_pathname([
            'contextid' => context_user::instance($USER->id)->id,
            'component' => 'user',
            'filearea' => 'draft',
            'itemid' => $itemid,
            'filepath' => '/',
            'filename' => basename($path),
        ], $path);
    }
    return $itemid;
}

/**
 * Find an assignment by its folder name (kept as the activity's ID number) or
 * create it with the instructions attached. Matching on the folder, not the
 * title, lets the student's copy of a shared class find the teacher's
 * assignment even when the two folders title it differently.
 * File uploads only, as in the source folders.
 */
function assignment(stdClass $course, string $folder, string $name, ?array $instructions, int $due): assign {
    global $DB, $gen;
    $existing = $DB->get_record('course_modules', ['course' => $course->id, 'idnumber' => $folder]);
    $instance = $existing ? $DB->get_record('assign', ['id' => $existing->instance]) : null;
    if (!$instance) {
        $intro = $instructions
            ? '<p>Instructions are attached.</p>'
            : '<p>Submit your work as a PDF or Word document.</p>';
        $instance = $gen->create_module('assign', [
            'course' => $course->id,
            'section' => 1,
            'idnumber' => $folder,
            'name' => $name,
            'intro' => $intro,
            'introformat' => FORMAT_HTML,
            'introattachments' => $instructions ? draft_files([$instructions['path']]) : 0,
            'duedate' => $due,
            'allowsubmissionsfromdate' => 0,
            'submissiondrafts' => 0,
            'assignsubmission_onlinetext_enabled' => 0,
            'assignsubmission_file_enabled' => 1,
            'assignsubmission_file_maxfiles' => 10,
            'assignsubmission_file_maxsizebytes' => 0,
            'assignfeedback_comments_enabled' => 1,
            'attemptreopenmethod' => 'manual',
            'maxattempts' => 1,
            'grade' => 100,
        ]);
    }
    $cm = get_coursemodule_from_instance('assign', $instance->id, $course->id, false, MUST_EXIST);
    $cm = get_fast_modinfo($course->id)->get_cm($cm->id);
    return new assign(context_module::instance($cm->id), $cm, $cm->get_course());
}

/**
 * Submit the files as the student, unless already submitted. The submission
 * is then dated to the date on the documents, not to today.
 */
function submit(assign $assign, stdClass $student, array $paths, int $when): void {
    global $DB;
    $latest = $assign->get_user_submission($student->id, false);
    if ($latest && $latest->status === ASSIGN_SUBMISSION_STATUS_SUBMITTED) {
        return;
    }
    as_user($student);
    $notices = [];
    $assign->save_submission((object) [
        'userid' => $student->id,
        'files_filemanager' => draft_files($paths),
    ], $notices);
    as_user(get_admin());
    if ($notices) {
        throw new moodle_exception('Submission refused: ' . implode('; ', $notices));
    }
    $submission = $assign->get_user_submission($student->id, false);
    $DB->update_record('assign_submission', (object) [
        'id' => $submission->id,
        'timecreated' => $when,
        'timemodified' => $when,
        'timestarted' => $when,
    ]);
}

// --- Find the two folders ----------------------------------------------------

$teacherdirs = glob(FIXTURES . '/Teacher_*', GLOB_ONLYDIR);
$studentdirs = glob(FIXTURES . '/Student_*', GLOB_ONLYDIR);
if (count($teacherdirs) !== 1 || count($studentdirs) !== 1) {
    cli_error('Expected exactly one Teacher_* and one Student_* folder in ' . FIXTURES
        . '. Run ./seed.sh with the two zips.');
}

// --- The teacher's classes ---------------------------------------------------

$teachername = str_replace('_', ' ', preg_replace('/^Teacher_/', '', basename($teacherdirs[0])));
$teachername = preg_replace('/^(Mr|Mrs|Ms|Dr) /', '$1. ', $teachername);
$teacher = user($teachername, true, 'teacher@example.com');
$teachercourses = [];   // Course code => first matching course, for the student to join.
$summary = [];

foreach (subdirs($teacherdirs[0]) as $coursedir) {
    [$code, $fullname] = course_names(basename($coursedir));
    $shortname = preg_match('/\(Period (\d+)\)/', $fullname, $m) ? "$code-P$m[1]" : $code;
    $course = course($shortname, $fullname);
    enrol($teacher, $course, 'editingteacher');
    $teachercourses[$code] = $teachercourses[$code] ?? $course;
    $count = 0;

    foreach (subdirs($coursedir) as $assigndir) {
        $files = files_in($assigndir);
        $work = array_values(array_filter($files, fn($f) => !is_instructions($f)));
        $headers = array_map('header_of', $work);
        $instructions = instructions_of($files);
        $due = $instructions['due'] ?? max(array_column($headers, 'date'));
        $folder = basename($assigndir);
        $assign = assignment($course, $folder, assignment_title($folder, $instructions, $headers),
            $instructions, $due);

        foreach ($work as $i => $file) {
            $student = user($headers[$i]['name']);
            enrol($student, $course, 'student');
            submit($assign, $student, [$file], $headers[$i]['date']);
            $count++;
        }
    }
    $summary[] = sprintf('  %-34s %s, %d submissions', $fullname, $teachername, $count);
}

// --- The student's classes ---------------------------------------------------

$studentname = str_replace('_', ' ', preg_replace('/^Student_/', '', basename($studentdirs[0])));
$student = user($studentname, true, 'student@example.com');
$studentsummary = [];

foreach (subdirs($studentdirs[0]) as $coursedir) {
    [$code, $fullname] = course_names(basename($coursedir));
    $assigndirs = subdirs($coursedir);
    $first = array_values(array_filter(files_in($assigndirs[0]), fn($f) => !is_instructions($f)));
    $theirteacher = header_of($first[0])['teacher'];

    // A class with the same teacher and course code is the teacher's own
    // section: join it rather than make a duplicate.
    if ($theirteacher === $teachername && isset($teachercourses[$code])) {
        $course = $teachercourses[$code];
    } else {
        $course = course($code, $fullname);
        enrol(user($theirteacher), $course, 'editingteacher');
    }
    enrol($student, $course, 'student');
    $count = 0;

    foreach ($assigndirs as $assigndir) {
        $files = files_in($assigndir);
        $work = array_values(array_filter($files, fn($f) => !is_instructions($f)));
        $instructions = instructions_of($files);
        $headers = array_map('header_of', $work);
        $dates = array_column($headers, 'date') ?: [time()];
        $folder = basename($assigndir);
        $assign = assignment($course, $folder, assignment_title($folder, $instructions, $headers),
            $instructions, $instructions['due'] ?? max($dates));
        if ($work) {
            submit($assign, $student, $work, max($dates));
            $count++;
        }
    }
    $studentsummary[] = sprintf('  %-34s %s, %d submitted', $course->fullname, $theirteacher, $count);
}

// --- Summary -----------------------------------------------------------------

purge_caches();
$url = $CFG->wwwroot;
$teacheremail = $teacher->email;
$studentemail = $student->email;
cli_writeln("\nSeeded. Log in at $url/login/ (password for both: " . PASSWORD . ")\n");
cli_writeln("Teacher  $teacheremail");
cli_writeln(implode("\n", $summary));
cli_writeln("\nStudent  $studentemail");
cli_writeln(implode("\n", $studentsummary));
