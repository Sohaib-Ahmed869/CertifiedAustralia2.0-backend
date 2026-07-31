# Certified Australia v2 — Backend API

Node.js/Express REST API powering the Certified Australia RPL (Recognised Prior Learning) portal.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js (CommonJS)
- **Database:** MongoDB via Mongoose (38 models)
- **Auth:** JWT + MFA (speakeasy TOTP)
- **Payments:** Square SDK + webhooks
- **File Storage:** Google Drive (service account)
- **Accounting:** Xero OAuth2 integration
- **Email:** SMTP (nodemailer)
- **AI:** OpenAI (chatbot intent classification + KB embeddings)
- **Real-time:** Socket.IO (notifications, chat, permissions)

## Getting Started

```bash
npm install
cp .env.example .env   # Configure environment variables
npm run dev             # Start with nodemon (port 5000)
```

## Scripts

```bash
npm run dev                          # Development server with hot reload
npm start                            # Production start
node scripts/seed-users.js           # Create test users (admin/ceo/agent/rto/support)
node scripts/reset-and-import.js     # Reset DB + import industries/qualifications
node scripts/backfill-app-source.js  # Backfill marketing source attribution on applications
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | JWT signing secret |
| `JWT_EXPIRES_IN` | Token expiry (default: 7d) |
| `SQUARE_ENV` | Square environment (sandbox/production) |
| `SQUARE_ACCESS_TOKEN` | Square API token |
| `SQUARE_LOCATION_ID` | Square location ID |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhook signature key (from the Square subscription) |
| `SQUARE_WEBHOOK_URL` | Exact notification URL registered in Square, used for signature verification |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to Google service account JSON |
| `GOOGLE_DRIVE_FOLDER_ID` | Root Drive folder for uploads |
| `XERO_CLIENT_ID` | Xero OAuth2 client ID |
| `XERO_CLIENT_SECRET` | Xero OAuth2 client secret |
| `XERO_REDIRECT_URI` | Xero OAuth2 callback URL |
| `OPENAI_API_KEY` | OpenAI API key (chatbot + embeddings) |
| `APP_BASE_URL` | Frontend base URL (used to build links in emails) |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | Sender email address |

## Project Structure

```
src/
  config/         # RBAC permissions, app config
  controllers/    # Route handlers
  middleware/     # Auth, upload, rate limiting
  models/         # Mongoose schemas (38 models)
  routes/         # Express route definitions
  services/       # Business logic layer
  utils/          # Helpers, error classes
scripts/          # DB seed & migration scripts
postman/          # API testing collection
```

## Architecture

- **Pattern:** Controllers → Services → Models with two-layer CRUD factory
- **CRUD Factory:** `commonCrud.js` provides `list/getById/create/update/remove` with pagination, population, and search
- **Auth:** JWT with MFA support; `protect` + `authorize(...roles)` middleware
- **RBAC:** Granular permission keys with per-user overrides; `requirePermission()` middleware
- **User Model:** Base User with Student discriminator (single collection)
- **Application Lifecycle:** 19 statuses from `LeadCaptured` to `Delivered`

## API Routes

All routes under `/api/`:

| Path | Description |
|------|-------------|
| `/auth` | Registration, login, MFA, password management |
| `/users` | User CRUD + RBAC management |
| `/applications` | Application lifecycle, notes, status transitions |
| `/payments` | Payment processing, plans, Square integration |
| `/ceo-dashboard` | Executive analytics, weekly scorecard, cashflow |
| `/tickets` | Support ticket system |
| `/notifications` | In-portal notifications |
| `/chat` | Real-time messaging (Socket.IO) |
| `/chatbot` | AI assistant (intent classification + KB) |
| `/documents` | Document upload/management |
| `/document-feedback` | RTO/admin document feedback workflow |
| `/xero` | Xero OAuth + invoice sync |
| `/email-templates` | Email template management |
| `/campaigns` | Marketing campaign management |

## Key Features

- **19-Stage Application Lifecycle** with automated status transitions
- **Square Payment Integration** with webhook verification
- **Google Drive** per-application folder management
- **Xero Accounting** sync with invoice/credit note support
- **AI Chatbot** with regex + LLM intent classification and KB retrieval
- **Weekly Scorecard** with dynamic targets per week
- **Marketing Attribution** tracking from registration through all applications
- **Document Feedback** workflow between RTO, admin, and student
- **Real-time Notifications** via Socket.IO with email fallback
