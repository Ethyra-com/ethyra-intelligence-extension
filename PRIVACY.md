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
  name. The endpoints that return other students' data are reachable by anyone
  Canvas has made a teacher, TA or course designer — so if you hold any of those
  roles, the limit cannot come from what Canvas permits and has to come from the
  extension. It does: a course you teach or assist in is **skipped before a
  single submission is fetched**, and you are told which courses were skipped
  and why. Only courses you are taking are read.
- **No course materials library.** Course files, pages, modules, announcements,
  discussions, quizzes and the syllabus are not collected.
- **No browsing history.** Nothing of the extension is placed in any web page
  until you click its toolbar icon, and then only in the one tab you had open.
  It is not present on the pages you visit, so there is nothing there to watch
  them. Once placed, it reads Canvas's own API and nothing else.

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

**Your coursework is sent to an AI service to be analysed.** That is what the
product does, and it is the most important sentence in this document.

This table lists the services that receive your work **today**, verified against
the code rather than against the design. Azure Document Intelligence was listed
here and has been removed: the dependency and its configuration exist, but
nothing in the backend calls it, so no coursework reaches it. The practical
consequence is that a scanned or photographed page yields no text and is not
analysed. Adding OCR means adding a row back to this table, and a paragraph here,
in the same change.

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
- **Delete an upload** from the Ethyra Intelligence web app. This removes your
  submitted files from storage, and the analysis built on them — the levels,
  the quoted evidence and the assignment records — so your profile rewinds to
  what the remaining uploads support.

  `[TODO: two things currently survive that deletion and this bullet must say so
  before publication, or be made true by changing the backend. (a) The extracted
  text of each document is stored keyed on its content hash, deliberately shared
  across all users so a common worksheet is read once; it carries no user id and
  the delete endpoint does not touch it. (b) The cached model responses over that
  text, and the profile narrative, likewise survive. See app/models/canvas.py
  Extraction, app/models/analysis.py AgentCache and ProfileNarrative. Deciding
  between "disclose it" and "delete it" is a product decision, not a wording
  one.]`
- **Uninstall** to remove all locally stored data.

## Retention

`[TODO: state the retention period for uploaded coursework and for derived
analysis.`

`As of 2026-09-17 the answer the code gives is "indefinitely": there is no
expiry, no scheduled purge and no blob lifecycle policy anywhere in the backend
repository — nothing is removed except by the delete endpoint above, which a
person has to call. Deletion through that endpoint is immediate and synchronous,
not scheduled.`

`So this section has two honest endings and they are not interchangeable: state
that coursework is kept until the student deletes it, or implement a retention
period first and state that. Do not write a period the backend does not enforce —
a stated 12 months with no mechanism behind it is worse than an honest
"indefinitely", because it is checkable and wrong.`

`If a lifecycle policy was set by hand in the Azure portal, it is not in the
repository and cannot be reviewed here; put it in infrastructure-as-code before
relying on it in this document.]`

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
| `activeTab` | access to the single tab you have open when you click the extension's icon, and to no other |
| `scripting` | to place the export code in that tab at that moment — it is not placed in advance, and not in any other tab |
| `declarativeNetRequest` | to allow your own submitted files to be fetched from Canvas's file host |
| `*://*.instructure.com/*` | to reach Canvas's API |
| `*://*.canvas-user-content.com/*` | where Canvas actually stores submitted files — reaching it is not optional for an extension whose purpose is exporting them |
| `https://api.ethyra.com/*` | to sign in and upload |

The extension requests **no** permission to download files, show notifications,
or read your tabs. It holds no standing permission over any site other than
Canvas and Ethyra: `activeTab` is granted by your click, covers one tab, and
lapses when that tab navigates.

Self-hosted Canvas instances live on ordinary school domains rather than on
`instructure.com`, and `activeTab` is how the extension works on them without
holding a permission over every site on the web in order to reach a handful.

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
