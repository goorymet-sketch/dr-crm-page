# Digital Reach CRM — Company Intelligence & Sales Development

Extends the existing Digital Reach CRM page into a company-intelligence and sales-development workspace. It is **not** a new CRM: the same Firebase project, Firestore document, login account, records, posts and plans are preserved.

## Contents

- [Architecture](#architecture)
- [Data compatibility](#data-compatibility)
- [Company fields and Fit Score](#company-fields-and-fit-score)
- [Sector playbooks](#sector-playbooks)
- [Sales plans](#sales-plans)
- [Pipeline and follow-up center](#pipeline-and-follow-up-center)
- [Dashboard metrics](#dashboard-metrics)
- [Campaigns](#campaigns)
- [CSV import and export](#csv-import-and-export)
- [Running locally](#running-locally)
- [Tests](#tests)
- [Deployment](#deployment)

## Architecture

| File | Responsibility |
| --- | --- |
| `welcome.html` | Arabic RTL shell, 10 tabs, dialogs, responsive styles, Firebase compat SDK includes |
| `crm-core.js` | Pure business logic exposed as `window.CRMCore` (also `module.exports` for Node tests): constants, normalisation, Fit engine, metrics, follow-up buckets, playbooks, plan generation, CSV parsing/import planning |
| `app.js` | UI rendering and Firebase Auth/Firestore wiring; exposes `window.__DR_APP` for integration tests |
| `tests/core.test.js` | Business-logic tests (`node:test`) |
| `tests/ui.test.js` | jsdom integration tests with stubbed Firebase |

`crm-core.js` has no DOM or Firebase dependency, so the scoring, import and metric rules are testable in isolation.

## Data compatibility

- **Firebase project:** `digitalreach-crm` (unchanged).
- **Firestore document:** `crmData/main` (unchanged).
- **Local storage key:** `dr_crm_v1` (unchanged).
- **Allowed login:** `goory.met@gmail.com` (unchanged; authentication is not bypassed).
- **Existing records:** `companies`, `posts`, `plans` are read as-is. Unknown fields on companies and unknown top-level document keys are preserved.
- **Migration:** additive only. `normalizeDb` fills safe defaults (`replyStatus`, `opportunityType`, arrays, etc.) in memory and never deletes or overwrites existing values.
- **Legacy plans:** old plan objects are read through `normalizePlan`; old text is retained, and missing structured fields become empty arrays.

Back up from the **تنزيل → نسخة احتياطية كاملة** button before bulk changes.

## Company fields and Fit Score

New fields include: sector, country, employees, estimated annual revenue, opportunity type (`عميل محتمل` / `شريك محتمل`), observed opportunity/problem, sales angle, research summary and sources, last analysis date, analysis confidence, manual classification override, campaign, deal value/currency, probability, owner, contacts, meeting date, lost reason, activity log and stage history.

Revenue and employee figures are **never generated**. They are only displayed when entered or imported, and estimate fields are labelled as estimates. When data is missing, the result is marked **أولي / preliminary**.

### Components (default weights, editable)

| Component | Default weight |
| --- | --- |
| Service fit — ملاءمة الخدمة | 30 |
| Commercial potential — الإمكانية التجارية | 20 |
| Opportunity / problem — الفرصة أو المشكلة | 20 |
| Market fit — ملاءمة السوق | 15 |
| Access — سهولة الوصول | 15 |

Weights are normalised to whatever total is entered; setting all weights to zero restores the defaults. Components set manually are used as-is; missing components receive 0 rather than a guessed value, which keeps incomplete records out of HOT.

### Classification

| Score | Class |
| --- | --- |
| 80–100 | HOT |
| 60–79 | WARM |
| below 60 | COLD |

A manual classification override is stored separately and shown with a marker. Social links alone never create a high score. Legacy records keep their existing `fitScore` and are treated as `mode: legacy` / preliminary until re-scored with the five components (`fitMode: 'components'`).

## Sector playbooks

Built-in playbooks cover:

- **Tourism & travel** — booking follow-up, enquiry response, seasonal demand.
- **Real-estate brokers** — viewing scheduling, listing enquiries, lead response.
- **Marketing agencies** — defaults to **potential partner**, not end client, with a partnership angle.

Other sectors fall back to a neutral, data-driven playbook. Playbooks only shape wording and questions; they do not invent facts about a company.

## Sales plans

Each company has an independent plan at `db.plans[company.id]`. Plans are editable, savable, regenerable and isolated from each other.

Each plan contains:

1. Company/opportunity summary
2. Why the company was selected
3. Best service to sell
4. Sales angle
5. First-contact goal
6. Personalised opening message
7. Discovery questions
8. Presentation approach
9. Expected objections and responses
10. Call to action
11. 14-day follow-up plan (days 0, 2, 5, 8, 14)

Generated content is internal and contains no financial or result promises. Regenerating replaces that company's plan only, after confirmation.

## Pipeline and follow-up center

Stages: `جديد`, `تم التواصل`, `لا يوجد رد`, `رد العميل`, `مهتم`, `محوّل للإدارة`, `تم تحديد اجتماع`, `عرض سعر`, `تفاوض`, `تم الإغلاق`, `خسرنا`, `غير مناسب`.

Each stage change records history (`stageHistory`), an activity entry, a timestamp and a default probability (manual probability is preserved when set). Lost reason, deal value/currency, owner, last contact and next follow-up are stored per company.

The **مركز المتابعة** tab groups overdue, due today, upcoming, never contacted, replied-but-not-followed-up, forwarded-to-management and upcoming meetings. Every row opens the company or its plan. Overdue items also produce an in-app alert banner.

## Dashboard metrics

- Counts: companies, HOT/WARM/COLD, sectors, countries, open/won/lost/not-suitable deals.
- Values are grouped **by currency** and never summed across currencies.
- Funnel conversions use explicit numerators and denominators:
  - contact → interest
  - interest → quote
  - quote → won
  - win rate = won ÷ (won + lost)
- Rates show **«بيانات غير كافية»** when the denominator is zero, and small samples are flagged.
- Lost/not-suitable legacy records without stage history have an unknown previous position and are excluded from funnel counts; they are reported separately.
- Date range filters by company creation date and reports undated records excluded by the filter.
- Campaign and source tables use the same rules.

All metrics are descriptive, internal indicators — not forecasts or guarantees.

## Campaigns

A campaign is an optional field on each company. The campaign registry lives at `db.campaigns`. Renaming a campaign asks for confirmation and updates the associated company records after confirmation. Deleting a campaign that still has companies is blocked. Per-campaign tables show companies, contacted, replied, interested, quotes, won/lost and open value.

## CSV import and export

Import is two-phase:

1. **Analyze** — parse and classify rows without mutating data.
2. **Review** — the report shows new / updated / duplicate / needs-review counts and per-row changes.
3. **Apply** — only confirmed actions are written.

Rules:

- Arabic and English headers are supported for all new fields (see the help text in the upload tab).
- Import never deletes records.
- Empty incoming values never overwrite non-empty existing values.
- Matching uses normalised **name + phone**. Identical values = update blank fields only.
- Same name with a different phone, or a phone missing on one side = **needs review**, not automatic merge.
- Similar names without an exact name match are treated as different companies.
- Repeated rows inside the same file are flagged; the first occurrence is applied and later occurrences default to review/skip.
- Review items default to **skip**; nothing ambiguous is merged automatically.

Exports include companies (all new fields), posts, plans, a performance report, campaign performance and a full JSON backup.

## Firestore document-size safety

The compatibility layer still reads and writes the legacy `crmData/main` document. Before each client write, it measures the UTF-8 JSON payload and blocks cloud writes at a conservative 900 KiB threshold (Firestore's hard document limit is 1 MiB). A blocked write is clearly reported; the browser's local copy remains available.

This safeguard is not a sharded-storage migration. Moving companies and plans into subcollections requires a reversible migration and matching Firestore security-rule changes. This branch does not alter production data or security rules.

## Running locally

The page is static. Serve the folder with any static server, for example:

```bash
npx serve .
```

or open `welcome.html` through a local server (Firebase Auth requires an authorised domain; `localhost` is normally authorised).

Sign in with the allowed email and password. Data is written to Firestore `crmData/main` and mirrored to `localStorage`.

## Tests

```bash
npm ci
npm test
```

Individual suites:

```bash
npm run test:core
npm run test:ui
```

The 30 tests cover:

- unchanged login and boot, legacy data loading, no console errors
- add/edit persistence, no duplication, existing records never deleted
- two independent plans and plan isolation
- Fit components, missing-data handling, weights, classification boundaries, social-links rule
- sector playbooks and the agency-as-partner default
- stage history, activity log and probabilities
- Arabic and English CSV headers, update-only-blank rules, duplicate/similar-name handling
- same-file duplicates, including rows matching an existing company
- dashboard metrics, per-currency values, insufficient-data handling, date filters
- follow-up buckets
- legacy plan normalisation

UI tests use jsdom with a stubbed Firebase SDK and in-memory fixtures. They never write to the production Firestore project.

## Deployment

No deployment has been performed as part of this branch. Merging and publishing are separate, deliberate steps after reviewing the test results. When publishing, verify the Firebase authorised domains include the hosting domain and keep the existing Firestore document path unchanged.

## Security notes

- The Firebase web config is public by design; Firestore security rules must restrict writes to authorised accounts.
- The allowed-email check is a UI guard, not a substitute for Firestore rules.
- Import/backup files contain business data; store them securely.
