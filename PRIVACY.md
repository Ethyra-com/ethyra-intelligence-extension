# Privacy Policy — Ethyra Intelligence: Canvas Export

**Last updated:** 2026-09-17
**Applies to:** the Ethyra Intelligence Canvas Export browser extension, version 0.1.0

> **This differs fundamentally from the extension this one is forked from.**
> `canvas-course-downloader` sends nothing anywhere — it saves files to your own
> computer. This extension **transmits your coursework to Ethyra's servers**,
> because analysing it is the entire point. If that is not what you want, this is
> the wrong tool and the upstream project is the right one.

> **Before publication:** the placeholders marked `[TODO]` below are business
> facts, not technical ones, and this document must not be published with any of
> them still in it.

---

## What this extension reads from Canvas

When you click **Export**, and only then, it reads the following from the Canvas
site you are signed in to, for every course you are actively enrolled in:

**Your work**

- files you submitted to an assignment, including earlier attempts
- text you typed directly into Canvas as a submission
- the name of each assignment and the course it belongs to

**What was asked of you**

- each assignment's instructions, as the instructor wrote them
- the rubric attached to an assignment, if there is one
- files the instructor attached to those instructions
- the assignment's due date, and when you submitted

**About the course**

- course name, course code and term
- your own name, as Canvas records it

## What it does not read

This is a deliberately short list of things the extension could easily collect
and does not. These are not filtered out after the fact — they are never
requested from Canvas at all, which is the only version of this claim that
cannot be undone by a bug.

- **No grades.** Not your score, not your letter grade, not the points an
  assignment was worth.
- **No instructor feedback.** Comments left on your submissions are not read.
- **No rubric marks.** How an instructor scored you against each criterion is
  not read.
- **No class statistics.** The class average and median that Canvas will happily
  return are not requested.
- **Nothing about anyone else.** No other student's work, submissions, grades or
  name. The extension only ever calls Canvas endpoints scoped to your own
  account; the endpoints that return other students' data require instructor
  permissions this extension never asks for and could not use.
- **No course materials library.** Course files, pages, modules, announcements,
  discussions, quizzes and the syllabus are not collected.
- **No browsing history.** The extension activates only on Canvas pages, and
  only reads Canvas's own API.

## Where it goes, and who can see it

Everything collected is packaged into a single archive and uploaded to Ethyra
Intelligence, where it is analysed against the ACT College and Career Readiness
Standards to produce your learning profile.

Your coursework is processed by the following services, all operated by Ethyra
or by Microsoft on Ethyra's behalf:

| Service | What it receives | Why |
|---|---|---|
| Ethyra Intelligence API | the archive | to parse and store it |
| Microsoft Azure Blob Storage | your submitted files | storage |
| Microsoft Azure AI Foundry | the **text** of your work and your assignment instructions | the analysis itself |
| Microsoft Azure Document Intelligence | scanned or photographed pages only | to read text from images |

**Your coursework is sent to an AI service to be analysed.** That is what the
product does, and it is the most important sentence in this document.

Your data is **not** sold, rented, or shared with advertisers, data brokers, or
any party not listed above. It is not used to train third-party AI models.
`[TODO: confirm and state the contractual position on model training with the
Azure AI Foundry agreement in force.]`

## What the extension stores on your computer

- **An Ethyra sign-in token**, in the browser's extension storage, so you do not
  have to sign in every time. Removed when you sign out.
- **The status of an export in progress**, discarded when it finishes.

It stores no Canvas credentials. It never sees your Canvas password and never
asks for a Canvas API token — it uses the session you are already signed in to,
in the page itself.

## Your control

- **Nothing happens until you click Export.** Installing the extension, or
  opening Canvas with it installed, transmits nothing.
- **Sign out** from the extension popup to remove the stored token.
- **Delete an upload** from the Ethyra Intelligence web app. Deleting removes
  both the stored files and the records derived from them.
- **Uninstall** to remove all locally stored data.

## Retention

`[TODO: state the retention period for uploaded coursework and for derived
analysis, and whether deletion is immediate or on a schedule. Do not publish a
period that the backend does not actually enforce.]`

## Student data and FERPA

Coursework, assignment instructions and course enrolment are education records.
Where this extension is used by a student under 18, or under an agreement with a
school or district, that data is subject to FERPA and to any applicable state
student-privacy law.

`[TODO: state the legal entity, the role it acts in — school official under
FERPA's exception, or direct-to-student consumer relationship — and the process
for a parent or school to request deletion. These differ materially and the
answer determines what this section must say.]`

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | to keep you signed in between exports |
| `activeTab` | to read your coursework from the Canvas tab, only when you click Export |
| `declarativeNetRequest` | to allow your own submitted files to be fetched from Canvas's file host |
| `*://*.instructure.com/*` | to reach Canvas's API |
| `*://*.canvas-user-content.com/*` (optional) | where Canvas actually stores submitted files; requested when first needed, and declining only means some files are skipped |

The extension requests **no** permission to download files, show notifications,
read your tabs, or run on non-Canvas sites.

## Changes to this policy

Material changes will be reflected in the version number above. Continued use
after a change constitutes acceptance.

## Contact

`[TODO: privacy contact address, and the postal address of the legal entity.]`

## Open source

This extension is a fork of
[canvas-course-downloader](https://github.com/jasp-nerd/canvas-course-downloader)
(MIT). See `NOTICE` for what was changed. The source of this fork is available
so that every claim above can be checked against the code rather than taken on
trust.
