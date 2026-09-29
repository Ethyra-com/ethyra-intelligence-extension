<!--
  FOR THE WEBSITE DEVELOPER

  This file holds two documents. Publish each top-level (#) section as its own page:

    # Ethyra Privacy Policy    ->  https://ethyra.com/privacy
    # Ethyra Terms of Service  ->  https://ethyra.com/terms

  - The privacy page URL is the one entered in the Chrome Web Store listing. It must be
    public and load without signing in.
  - Keep the "Last updated" line on each page.
  - These are separate from the grading product's /privacy-policy and /terms-of-service.
    Do not merge them.

  FOR ENGINEERS

  Identical copies of this file live in ethyra-intelligence-backend/LEGAL.md (the master)
  and ethyra-intelligence-extension/LEGAL.md. Edit the backend copy, then copy it over.
  The extension's ethyra/wiring.test.mjs checks its copy against the extension code.
-->

# Ethyra Privacy Policy

**Last updated:** September 29, 2026

This Privacy Policy explains how Ethyra ("Ethyra," "we," "us") handles your information when you use Ethyra's student product. That means the Ethyra web app, where you see your learning profile, and the **Ethyra — Canvas Export** browser extension (the "Extension"). Together we call them the "Service."

Ethyra reads coursework you have already completed and maps it against the ACT College and Career Readiness Standards to build your learning profile. To do that, it has to read your work. This policy explains what we collect, where it goes, and how to remove it.

Ethyra's grading product for teachers has its own [Privacy Policy](https://ethyra.com/privacy-policy).

## Who This Policy Is For

The Service is for individual students. You sign up yourself and bring your own coursework. We have no agreement with your school or district about your use of the Service. We are not acting on its behalf, and we do not share your information with it.

## Consent

By creating an account, installing the Extension, or otherwise using the Service, you agree to this Privacy Policy and to our [Terms of Service](https://ethyra.com/terms).

## Information We Collect

### Account Information

- Email address and password. Your password is handled by our authentication provider, and we never see or store it.
- First and last name, if you provide them
- The date and time you accepted our Terms of Service

### Coursework You Export With the Extension

The Extension does nothing until you open it on a Canvas page and click **Export**. Installing it, or visiting Canvas with it installed, sends nothing.

When you click **Export**, the Extension reads the following from the Canvas site you are signed in to. It covers every course where you are enrolled **as a student**, both current and completed.

**Your work**

- Files you submitted to an assignment, including earlier attempts
- Text you typed directly into Canvas as a submission
- The name of each assignment and the course it belongs to

**What was asked of you**

- Each assignment's instructions, as your instructor wrote them
- The rubric attached to an assignment, if there is one
- Files your instructor attached to those instructions
- The assignment's due date and when you submitted it
- Your own grade on each gradebook item: score, letter grade and points possible. This includes items where you turned nothing in, such as participation. Grades are sent only for courses where you turned in at least one piece of work.

**About the course and you**

- Course name, course code and term
- Your name, as Canvas records it

As each course is read, its files are uploaded directly to Ethyra's secure storage. Files you already sent in an earlier export are recognized and not sent again.

### What the Extension Does Not Read

The items below are never requested from Canvas. They are not collected and filtered out afterwards; the Extension simply never asks for them.

- **Instructor feedback.** Comments left on your submissions are not read.
- **Rubric marks.** How your instructor scored you against each rubric criterion is not read.
- **Class statistics.** Class averages, medians and similar figures are not read.
- **Anything about other students.** The Extension does not read other students' work, grades or names. If you are a teacher, TA or designer in a course, that course is skipped before anything in it is read, and the Extension tells you which courses were skipped.
- **Course materials.** Course files, pages, modules, announcements, discussions, quizzes and the syllabus are not collected.
- **Your Canvas password.** The Extension never sees or asks for your Canvas password or a Canvas access token. It uses the Canvas session you are already signed in to.
- **Your browsing.** The Extension is not present on the pages you visit. It runs only in the tab you have open when you click its icon, and there it reads only Canvas.

### Files You Upload in the Web App

You can also upload files directly in the web app, such as a course export or individual documents. When you upload a course export, the web app reads it in your browser and sends us only your coursework and its structure. The original export file itself is not stored.

### Information We Create

From your coursework, the Service generates:

- The subjects and grade level of your courses, inferred from their content
- Proficiency levels for each ACT standard, with the reasoning behind them
- Short quotations from your work, used as evidence for those levels
- Written summaries of your profile and of each class
- Estimated ACT score bands, calculated from those proficiency levels
- Reports you can download

### Information Collected Automatically

- **IP address.** It is used briefly to limit repeated sign-in and sign-up attempts, and is not stored in our database. Our hosting and monitoring providers may record it in their request logs.
- **Error and performance diagnostics.** Our production logs record errors only. We deliberately do not log the names of your files, your courses or your email address in normal operation.

We do **not** use analytics, advertising or session-recording tools in the web app or the Extension.

## How We Use Your Information

We use your information to:

- Create and secure your account
- Analyze your coursework against the ACT College and Career Readiness Standards
- Show you your learning profile, class summaries and reports
- Avoid re-sending or re-processing files you have already added
- Keep the Service working, fix problems and prevent abuse

We use your information only to provide the Service to you.

### How AI Is Used

Ethyra uses AI models to analyze your coursework. The information processed includes the text of your work, your assignment instructions, the text of files your instructor attached, and the names of files, assignments and courses.

Your grades are not shared with AI models. They are displayed alongside your work in the app but are excluded from analysis. We do not include your name in the information sent for analysis. However, we do not remove names or other personal details that already appear in your work or file names.

AI processing is performed by our cloud provider on Ethyra's behalf. Your coursework is not submitted to any public AI service and is never shown to other users.

### What We Do Not Do

- We do **not** sell your personal information
- We do **not** show you ads or use your information for advertising
- We do **not** share your information with your school, colleges, employers or data brokers
- We do **not** use your coursework to train AI models, and our AI provider does not use it to train theirs
- We do **not** use your information for any purpose unrelated to the Service

## How We Share Information

We share your information only with service providers that help us operate the Service, such as cloud hosting and storage, AI processing, authentication, and error monitoring. These providers process your information on our behalf and only to provide their services to us.

We may also disclose information if the law requires it, to protect the safety or rights of any person, or as part of a merger or acquisition. In an acquisition, this policy would continue to apply to your information.

## Cookies and Browser Storage

**Web app**

- `ethyra_intelligence_refresh_token`: a secure, HTTP-only cookie that keeps you signed in for up to 30 days
- A local setting that remembers your light or dark theme
- A temporary setting that returns you to the right page after you sign in, cleared when you close the tab

**Extension**

- A sign-in token, in the Extension's own browser storage, so you do not have to sign in for every export. Only the Extension can read it. It is removed when you sign out.
- The status of an export while it runs, discarded when the export finishes or you close the browser

The Extension stores no Canvas credentials and none of your coursework. We do not use advertising or tracking cookies.

## Extension Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab` | Access to the one tab you have open when you click the Extension's icon, and no other |
| `scripting` | To run the export in that tab when you click, and not before |
| `storage` | To keep you signed in between exports |
| `declarativeNetRequest` | To allow your own submitted files to be downloaded from the servers where Canvas stores them |
| Access to `instructure.com` | To read your coursework through Canvas's API |
| Access to `canvas-user-content.com` | Where Canvas stores submitted files |
| Access to `api.ethyra.com` | To sign you in and upload your coursework |

The Extension does not ask for permission to read your tabs or browsing history, download files to your computer, or show notifications. It has no ongoing access to any site except Canvas and Ethyra. If your school hosts Canvas on its own domain, the Extension works there only through the one-tab `activeTab` access you grant by clicking its icon.

## Data Retention and Deletion

We keep your account and coursework until you delete it or ask us to delete it. We do not delete it automatically after a set period, because your learning profile is built from all of your coursework over time.

- **Deleting your account.** Email [hello@ethyra.com](mailto:hello@ethyra.com) from the address on your account. Within 30 days, we will delete your account, your uploaded files, your course and assignment records, and everything generated from them.
- **The Extension.** Signing out removes its stored sign-in token. Uninstalling it removes everything it stores in your browser.

**Processing caches.** So that identical documents are not processed twice, we keep a cache of text extracted from documents and of AI responses. The cache is indexed by a fingerprint of the content, not by your account. These entries do not contain your account ID, but they can contain text from your work, and they may remain after your account is deleted. Copies in backups and service-provider logs are removed on those systems' own schedules.

## Your Rights and Choices

You can ask us to:

- **Access** the information we hold about you
- **Correct** information that is inaccurate
- **Delete** your information, as described above
- **Receive a copy** of your coursework and analysis

To make any of these requests, email [hello@ethyra.com](mailto:hello@ethyra.com). We will respond within 30 days. We may need to confirm that the request comes from the account holder.

## Children and Teens

You must be at least 13 years old to use the Service. If you are under 18, you must have permission from a parent or guardian. We do not knowingly collect personal information from children under 13, and if we learn that we have, we will delete it.

A parent or guardian who believes their child has used the Service can email [hello@ethyra.com](mailto:hello@ethyra.com) to review or delete the child's information.

## Data Security

We protect your information with safeguards including:

- Encryption in transit (TLS) for all connections
- Encryption at rest for stored files and databases
- Access controls that keep each student's data separate from every other student's
- Upload links that expire quickly and can only add files to your own storage
- Production logging limited to errors, so student files and names are not written to logs

If a breach affects your information, we will notify you as required by law.

## Chrome Web Store User Data Policy

The use of information received through the Extension adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. We use that information only for the Extension's single purpose: exporting your own coursework to Ethyra for analysis. We do not transfer or sell it for any other purpose. No person at Ethyra reads it unless you ask us to, it is needed for security, or the law requires it.

## Changes to This Privacy Policy

We may update this policy from time to time. We will post the new version on this page and update the "Last updated" date. If we change what the Extension reads or where it sends it, we will update this policy before the new version of the Extension is released. If a change materially expands what we collect or how we use it, we will tell you before it applies to you, and we may ask you to review and accept the updated policy before you continue using the Service.

## Contact Us

Questions about this policy or your information: [hello@ethyra.com](mailto:hello@ethyra.com).

---

# Ethyra Terms of Service

**Last updated:** September 29, 2026

These Terms of Service ("Terms") govern your use of Ethyra's student product: the Ethyra web app and the **Ethyra — Canvas Export** browser extension (the "Extension"), which together we call the "Service." The Service is provided by Ethyra ("Ethyra," "we," "us").

By creating an account, installing the Extension, or using the Service, you agree to these Terms and to our [Privacy Policy](https://ethyra.com/privacy). If you do not agree, do not use the Service.

Ethyra's grading product for teachers has its own [Terms of Service](https://ethyra.com/terms-of-service).

## 1. What the Service Does

Ethyra analyzes coursework you have already completed, using AI, against the ACT College and Career Readiness Standards. It gives you a learning profile showing where your work demonstrates each skill, with quotations from your work as evidence. The Extension exports your own coursework from Canvas into the Service.

## 2. Eligibility

You must be at least 13 years old to use the Service. If you are under 18, you may use the Service only with permission from a parent or guardian, who agrees to these Terms on your behalf.

The Service is for individual students using it for themselves. It is not offered to schools, and you may not use it to collect or analyze anyone else's coursework.

## 3. Your Account

You must give accurate information when you sign up. Keep your password confidential. You are responsible for activity under your account. Tell us promptly at [hello@ethyra.com](mailto:hello@ethyra.com) if you believe someone else has accessed it.

## 4. Your Coursework

**You own your work.** You keep all rights in the coursework you export or upload. We do not claim ownership of it.

**Permission you give us.** You give Ethyra a limited license to store, copy, process and display your coursework, including sending it to AI service providers as described in our Privacy Policy. This license exists only so we can provide the Service to you. It ends when your content is deleted, except for the processing caches described in our Privacy Policy.

**What you may add.** You may export or upload only:

- Your own work
- Materials your instructors gave you as part of your coursework, such as instructions, rubrics and attached files

You confirm that you have the right to do so. Instructor materials are used only to understand what an assignment asked of you, and are never shown to anyone other than you. You may not upload another student's work or information.

**Your school's rules.** You are responsible for making sure your use of the Service follows your school's policies and any Canvas terms that apply to you.

## 5. AI Output and Academic Use

The Service uses AI, and AI can be wrong. Proficiency levels, summaries and reports are estimates based on the work you provide. They are not grades, official test scores or professional assessments. Read the evidence behind a result rather than relying on the result alone.

The Service is a tool for understanding your own learning. Do not use it to break your school's academic integrity rules.

## 6. ACT Disclaimer

ACT® is a registered trademark of ACT, Inc. Ethyra is not affiliated with, sponsored by or endorsed by ACT, Inc. The ACT College and Career Readiness Standards are © ACT, Inc. and are used as a reference for describing skills.

The Service may show estimated ACT score bands and a projected composite range. These are calculated from your classwork, not from any test you took. They have not been validated against real ACT results, and they are **not** a prediction or guarantee of any score you will receive on the ACT test or any other test. The Service is not an official ACT product and does not produce official ACT scores.

## 7. The Extension

**License.** We grant you a personal, non-exclusive, non-transferable, revocable license to install and use the Extension to export your own coursework to Ethyra. You need an Ethyra account to use it.

**Your own account only.** You may use the Extension only with your own Canvas account, and only to export your own coursework. It reads Canvas through your own signed-in session, so it can see only what Canvas already shows you.

**Canvas.** Canvas is a product of Instructure, Inc. Ethyra is not affiliated with, sponsored by or endorsed by Instructure. The Extension depends on how Canvas works. If Canvas changes, or your school configures it differently, some coursework may not be exported, or the Extension may stop working until we update it.

## 8. Acceptable Use

You agree not to:

- Access, export or upload anyone else's coursework or data
- Share your account or use someone else's
- Try to access other users' data or get around security or usage limits
- Interfere with or overload the Service
- Upload malware, unlawful content, or content you do not have the right to upload
- Scrape, copy, reverse engineer or resell the Service, except where the law or an open-source license allows it
- Use the Service in violation of any law

## 9. Fees

The Service is currently free. If we introduce paid plans or usage limits, we will tell you before they apply to you. We will never charge you without your agreement.

## 10. Our Property

Apart from your content and open-source components, the Service belongs to Ethyra and its licensors and is protected by intellectual property laws. This includes its software, design and analysis methods.

We grant you a limited, non-exclusive, non-transferable, revocable license to use the Service for your own personal, non-commercial educational purposes. You may keep and share the reports the Service generates for you.

## 11. Ending Your Use

You may stop using the Service at any time. You can uninstall the Extension, and you can ask us to delete your account at [hello@ethyra.com](mailto:hello@ethyra.com). Our Privacy Policy describes what then happens to your data.

We may suspend or close your account if you break these Terms, if the law requires it, or if we stop offering the Service. Where reasonable, we will tell you first and give you a chance to get a copy of your data.

## 12. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE." TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY AND NON-INFRINGEMENT. WE DO NOT GUARANTEE THAT THE SERVICE WILL BE UNINTERRUPTED OR ERROR-FREE, THAT AI OUTPUT WILL BE ACCURATE, OR THAT THE EXTENSION WILL COLLECT EVERY ITEM FROM CANVAS.

## 13. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, ETHYRA WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS OR OPPORTUNITIES, ARISING FROM YOUR USE OF THE SERVICE. THIS INCLUDES ANY ACADEMIC, ADMISSIONS OR TESTING DECISION MADE USING THE SERVICE'S OUTPUT.

OUR TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE IS LIMITED TO THE GREATER OF THE AMOUNT YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM, OR $50.

## 14. Indemnification

To the extent permitted by law, you agree to indemnify Ethyra and its officers, employees and agents against claims arising from content you upload or from your breach of these Terms.

## 15. Governing Law and Disputes

These Terms are governed by the laws of the State of Delaware.

Before starting a formal proceeding, you and Ethyra agree to try to resolve any dispute informally for at least 30 days, starting with an email to [hello@ethyra.com](mailto:hello@ethyra.com). If the dispute is not resolved, it will be settled by binding individual arbitration under the rules of the American Arbitration Association. There will be no class actions or class arbitrations. Either party may instead bring an individual claim in small-claims court.

Nothing in this section limits rights that cannot be waived by law, including the rights of minors.

## 16. Changes to These Terms

We may update these Terms from time to time. We will post the new version on this page and update the "Last updated" date. For material changes, we will tell you before they apply to you, and we may ask you to review and accept the updated Terms before you continue using the Service. If you keep using the Service after changes take effect, you accept the updated Terms.

## 17. Contact Us

Questions about these Terms: [hello@ethyra.com](mailto:hello@ethyra.com).
