<?php
// Dev-only site settings, applied after install. Safe to re-run.
//
// Run inside the container (setup.sh does this):
//   php /ethyra/configure.php

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/clilib.php');

// Seeded users get password123, like the Canvas fixtures. The installer
// enforces the policy on the admin password, so it can only be relaxed after.
set_config('passwordpolicy', 0);

// Every page goes to the login screen, like a school's Moodle. Without this,
// visitors get a public front page listing every course.
set_config('forcelogin', 1);
set_config('guestloginbutton', 0);

// The fixtures are Ontario courses: dates on the documents are Toronto time.
set_config('timezone', 'America/Toronto');

// Full debugging: a dev site should say what went wrong, not hide it.
set_config('debug', DEBUG_DEVELOPER);
set_config('debugdisplay', 1);

// Every outgoing email goes to Mailpit (http://localhost:9201).
set_config('smtphosts', 'moodle-mail:1025');
set_config('noreplyaddress', 'noreply@example.com');

// Web services with the REST protocol, plus the built-in mobile service.
// The mobile service is what most Moodle clients talk to, and it gives the
// admin token below a ready-made function list without hand-picking one.
set_config('enablewebservices', 1);
set_config('webserviceprotocols', 'rest');
set_config('enablemobilewebservice', 1);
$service = $DB->get_record('external_services', ['shortname' => MOODLE_OFFICIAL_MOBILE_SERVICE], '*', MUST_EXIST);
if (!$service->enabled) {
    $service->enabled = 1;
    $DB->update_record('external_services', $service);
}

// Let every logged-in user call REST with their own token (login/token.php),
// so you can see the API from a student's side. Off by default on a real
// Moodle, so the extension must not depend on it.
assign_capability('webservice/rest:use', CAP_ALLOW, $CFG->defaultuserroleid, context_system::instance()->id, true);

// One permanent admin token, reused on re-runs and printed as the last line
// for setup.sh to show. Unlike the local Canvas token, this one is recreated
// by a script after a reset, not by hand.
$admin = get_admin();
$token = $DB->get_record('external_tokens', [
    'userid' => $admin->id,
    'externalserviceid' => $service->id,
    'tokentype' => EXTERNAL_TOKEN_PERMANENT,
]);
if ($token) {
    $tokenvalue = $token->token;
} else {
    $tokenvalue = \core_external\util::generate_token(
        EXTERNAL_TOKEN_PERMANENT,
        $service,
        $admin->id,
        context_system::instance(),
        0,
        '',
        'Ethyra dev admin token'
    );
}

purge_caches();
cli_writeln($tokenvalue);
