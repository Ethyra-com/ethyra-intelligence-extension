# Chrome Web Store submission

What the Chrome Web Store requires to publish this extension, with ready-to-paste
answers for the dashboard. Researched against Google's developer docs on
2026-09-29. Items marked **(unverified)** weren't stated on an official page;
confirm them in the dashboard.

## Blockers: fix before submitting

| # | Blocker | Why | Rejection code |
|---|---|---|---|
| 1 | ✅ **Done** (`view-consent` in the popup; the worker refuses without it). **Consent screen inside the extension**, before sign-up or sign-in, so it comes before any data is collected (credentials as well as coursework) | Disclosure "must not be located only in a privacy policy, terms of service, or similar document" and "must occur within the Product's user interface", with an explicit agree action. **Timing:** the [disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements) page says "prior to installation", but the [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) (Q10) says disclosures in the store description or install page "do not satisfy this requirement". Our reading is that the in-extension screen, shown before any data is collected, is what counts. So there is no separate pre-install consent step, but the listing description should still state what data is collected, and must match the Privacy practices answers shown on the listing. The sign-up checkbox alone didn't cover existing users who sign in, which is why the consent screen is separate. Its links to `ethyra.com/terms` and `/privacy` are already the URLs `LEGAL.md` targets. | Purple Nickel |
| 2 | ✅ **Done**: `scripts/package.mjs` strips them from the store zip. **Remove the dev hosts** from `manifest.json` `host_permissions`: `http://localhost:8001/*` and `https://intelligence-backend-…azurewebsites.net/*` | Every host must be justifiable in production | Purple Potassium |
| 3 | ✅ **Done.** **Publish `LEGAL.md` on the website** at `ethyra.com/privacy` and `/terms`. The privacy URL must load without signing in. | Required whenever an extension handles user data | Purple Lithium |
| 4 | ✅ **Done.** `icons/` is Ethyra's artwork. Store images are `screenshots/ethyra-*.png`; the other files in `screenshots/` are upstream's and must not be uploaded. | The listing must match the product | Yellow Zinc / impersonation |
| 5 | **Increase `manifest.json` `version` on every upload** | The store rejects an upload whose version isn't higher than the one before it. The first upload can be any version, and staying in `0.x` is allowed. Separately, `wiring.test.mjs` fails any version outside `0.x` while `LEGAL.md` still contains `[TODO]` placeholders (it has none today). | none |
| 6 | ✅ **Done.** The manifest (`name`, `description`, `action.default_title`) and the popup now use "Ethyra Canvas Export", matching `LEGAL.md`. | The listing, the extension and the policy must describe the same product | Yellow Zinc |
| 7 | **Create a reviewer test account** (see [Test instructions](#test-instructions)) | Reviewers who can't sign in or reach Canvas reject the item as not working | Yellow Magnesium |

Sources:
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)
- [Permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions)
- [Troubleshooting codes](https://developer.chrome.com/docs/webstore/troubleshooting)

### What the consent screen must contain
It must be the popup's first screen, shown before the sign-up and sign-in forms, because those forms already collect authentication data: email, password and name, and a refresh token is stored afterwards. It must require a deliberate action such as ticking a box and pressing "Agree". Existing users who are already signed in must also see it before their next export. It should say, in plain words:
- that signing in sends your email and password to Ethyra, and keeps a sign-in token in the extension;
- what the extension reads: your submissions, typed answers, assignment instructions, rubrics, instructor-attached files, due and submission dates, your own grades, course names and your name, for every course where you are a student;
- that this is uploaded to Ethyra and analyzed by AI;
- what it doesn't read;
- links to the privacy policy and terms.

## Developer account

- **Registration.** There is a one-time fee, about US$5; the amount isn't on the official page **(unverified)**. The account email can't be changed later, so use a dedicated address. [Register](https://developer.chrome.com/docs/webstore/register)
- **Account setup.** Publisher name and verified contact email. A physical address is required only if the extension sells anything. [Set up](https://developer.chrome.com/docs/webstore/set-up-account)
- **2-Step Verification.** Mandatory before publishing or updating. [2SV](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)
- **Trader declaration (EU DSA).** Every publisher declares trader or non-trader status. You are a trader if you publish on the store for purposes related to your trade, business, craft or profession. Being a company doesn't settle it on its own; what counts is why you publish there. This extension exists to bring users into Ethyra's product, so Ethyra will most likely be a trader, but confirm that against Google's definition before declaring. A trader must provide a legal name, address, phone number and email, and Google may ask for verification documents. **These contact details are shown publicly on the listing.** [Trader disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure), [FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)
- **Team access.** Add teammates to the publisher with a role (Viewer, Item Manager, Editor or Admin). [Publishers](https://developer.chrome.com/docs/webstore/group-publishers)
- **Item limit.** A new publisher starts with a default limit of 2 published extensions; themes don't count. The limit is per publisher, and you can request an increase. Most requests get an immediate decision; others take a few days. Requests can be denied for low user engagement on existing extensions, or if the account hasn't yet met Google's tenure and activity requirements. [Item limits](https://developer.chrome.com/docs/webstore/publish)

## Privacy practices tab

[Reference](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

**Single purpose**

> Exports a student's own Canvas coursework — their submissions, the assignment
> instructions and rubrics they were given, and their own grades — to Ethyra,
> where it is analyzed to build their learning profile against the
> ACT College and Career Readiness Standards.

**Permission justifications**

| Permission | Justification |
|---|---|
| `activeTab` | Grants access only to the Canvas tab the user has open when they click the toolbar icon. The extension declares no content scripts; this is how it runs on schools' self-hosted Canvas domains without requesting access to every site. |
| `scripting` | Injects the export code into that one tab after the user clicks, because Canvas's API must be called from inside the user's signed-in Canvas page. |
| `storage` | Keeps the user signed in to Ethyra between exports (refresh token) and tracks the status of an export in progress. |
| `declarativeNetRequest` | Adds a CORS response header on `canvas-user-content.com`, where Canvas serves submitted files, so the user's own submission files can be read and uploaded. One static rule, no request inspection. |
| `*://*.instructure.com/*` | Canvas's hosted domain; the extension reads the user's own coursework through Canvas's API. |
| `*://*.canvas-user-content.com/*` | Where Canvas stores submitted files; required to export them. |
| `https://api.ethyra.com/*` | Ethyra's API, for sign-in and uploading the export. |

**Remote code:** No, I am not using remote code. All JavaScript ships in the package; only JSON goes to and from the API.

**Data usage.** The category names below should be checked against the dashboard **(unverified)**.

| Category | Tick? | Why |
|---|---|---|
| Personally identifiable information | ✅ | Name, email address |
| Authentication information | ✅ | Ethyra password at sign-in; stored refresh token |
| Website content | ✅ | Coursework, instructions, rubrics, grades read from Canvas |
| Health, Financial and payment, Personal communications, Location, Web history, User activity | ❌ | Not collected. Instructor comments aren't read, and the extension doesn't run on other pages. |

**Certifications.** Tick all three:
- no selling or transferring data outside approved uses;
- no use unrelated to the single purpose;
- no creditworthiness or lending use.

**Privacy policy URL:** `https://ethyra.com/privacy`

## Store listing

[Listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [images](https://developer.chrome.com/docs/webstore/images)

| Item | Requirement | Status |
|---|---|---|
| Summary | 132 characters max; taken from the manifest `description` | Done: 112 characters |
| Description | Required. No keyword stuffing (same keyword more than 5 times). | To write |
| Store icon | 128×128 PNG: 96×96 artwork with 16 px transparent padding, and included in the ZIP | Done: `icons/icon-128.png` |
| Screenshots | 1–5, 1280×800 or 640×400, full bleed | Done: `screenshots/ethyra-store-1…5-*.png` |
| Small promo tile | 440×280, **required** | Done: `screenshots/ethyra-promo-tile-440x280.png` |
| Marquee tile | 1400×560, optional | None; skip it (the existing `chrome-marquee-1400x560.png` is upstream's) |
| Category | Education **(check exact list)** | |
| Language | English | |
| Homepage and support URL | Optional, but give a support contact (hello@ethyra.com) | |

**Naming and trademarks.** "Canvas" and "ACT" may describe what the extension works with:
- Don't lead the name with "Canvas" and don't use Instructure or ACT logos.
- Put this line in the description: *"Not affiliated with or endorsed by Instructure or ACT, Inc."*

[Policy](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property)

## Code review expectations

- **Minified libraries are allowed; obfuscation is not.** The package ships one third-party library: `client-zip.min.js`, client-zip v2.5.0 (MIT, https://github.com/Touffy/client-zip), an unmodified minified build. `turndown.min.js` is in the repo but loaded by nothing, so `scripts/package.mjs` leaves it out. Name the library and version in the test instructions to speed up review. [Code readability](https://developer.chrome.com/docs/webstore/program-policies/code-readability)
- **No remotely hosted code.** Nothing loads JS or WASM from outside the package: the only script loads are the popup's `<script src="popup.js">`, the worker's `importScripts("./auth.js")` and `chrome.scripting.executeScript` of packaged files; there is no `eval`, `new Function` or WebAssembly. Checked 2026-09-29; keep it that way. [Remote code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

## Test instructions

The dashboard's Test instructions tab takes credentials for reviewers. Provide:
- an Ethyra test account (email and password), created in production;
- a Canvas account with at least one course containing a submission, for example a free Canvas account on `canvas.instructure.com` with a seeded course;
- steps: open the Canvas course list → click the Ethyra icon → agree → sign in → Export → open the web app to see the result.

## Review

[Review process](https://developer.chrome.com/docs/webstore/review-process)
- **Timing:** usually a few days; up to a few weeks. New publishers and new extensions get extra scrutiny. Contact support after 3 weeks.
- **Outcomes:** approved (you then have 30 days to publish if you chose deferred publishing), rejected (with an email and an appeal option), or a warning with a deadline to fix.
- **Visibility:** Public, Unlisted (install by link only), or Private (named testers or Google Groups). An **Unlisted** first release is a low-risk way to pilot with students. [Distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- **Terms of service:** the store doesn't require one. Ours is published anyway (`LEGAL.md`).
