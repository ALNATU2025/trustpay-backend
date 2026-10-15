# TrustPay backend

Node.js + Express + MongoDB API for the TrustPay mobile app (Sierra Leone, Leones). Deploys to Render; data lives in MongoDB Atlas. The full request/response contract is in [`API.md`](API.md).

## What is real and what is sandbox

The code is complete for accounts, wallet, ledger, PIN and password security, idempotent payments, refunds, receipts, support chat, admin and POS settlement. **Money rails are not.** Banks, mobile money, SMS, bill vendors, card issuing and card acquiring are each behind one adapter in `src/providers/`. With `PROVIDER_MODE=sandbox` (default) those adapters are fake: they move no real money, send no SMS and issue fake cards. With `PROVIDER_MODE=live` they refuse to run until you implement them against a signed partner (a bank or switch, Orange Money / Afrimoney / Qmoney, an SMS gateway, EDSA and TV vendors, a card issuer and acquirer). Until then, treat any deployment as a test deployment.

Sandbox test hooks: bank accounts, mobile numbers and meters ending in `0000` are declined (the customer is refunded), accounts ending in `9999` give an unknown outcome (the payment stays Pending), electricity meters are 11 digits, mobile money approval code `000000` is declined.

## Run locally

```bash
cp .env.example .env      # fill JWT_SECRET, CARD_ENCRYPTION_KEY (openssl rand -hex 32), WEBHOOK_SECRET
npm install
npm run seed              # saves the catalog; creates the admin if ADMIN_* are set
npm run dev
npm run smoke             # end-to-end check of the running server (needs OTP_DEBUG=true)
npm test                  # unit + integration tests (in-memory MongoDB)
```

## Deploy on Render with MongoDB Atlas

1. **Atlas**: create a free M0 cluster, a database user, and under Network Access allow `0.0.0.0/0` (Render's free plan has no fixed IP). Copy the `mongodb+srv://...` string and put `/trustpay` before the `?`.
2. **Render**: New > Blueprint > pick this repo (it reads `render.yaml`). Set `MONGODB_URI`, `CARD_ENCRYPTION_KEY` (64 hex characters) and `ADMIN_EMAIL`, `ADMIN_PHONE`, `ADMIN_PASSWORD` (12+ characters). `JWT_SECRET` and `WEBHOOK_SECRET` are generated for you.
3. Open the service Shell and run `npm run seed` once. Then delete `ADMIN_PASSWORD` from the environment.
4. Check `https://<your-service>.onrender.com/api/health`, then run `BASE_URL=https://<your-service>.onrender.com npm run smoke`.
5. In the Flutter app build with `--dart-define=API_BASE_URL=https://<your-service>.onrender.com/api`.

Render's free web service sleeps after 15 minutes idle and takes up to a minute to wake; the app shows a "waking up the server" message and warms it at start. Use a paid instance for real customers. The POS settlement cron job (`npm run settle`, daily 16:00) needs a paid cron plan on Render.

## Going live checklist

- Implement the adapters in `src/providers/*.js` and set `PROVIDER_MODE=live`, `OTP_DEBUG=false`, and remove `ALLOW_SANDBOX_IN_PRODUCTION`.
- Replace the sandbox KYC (`/auth/identity`) with your identity provider, or set `KYC_MANUAL=true` so an admin approves each customer.
- Point your bank's deposit notifications at `POST /api/webhooks/funding` and your POS acquirer at `POST /api/webhooks/pos`. Sign the raw body with HMAC-SHA256 using `WEBHOOK_SECRET` and send it in `x-signature`.
- Restrict `CORS_ORIGINS` if you add a web client. Turn on Atlas backups and alerts.
- Run `npm run check` daily: it reports payments stuck Pending or flagged `needsReview` that must be reconciled with the partner.
- Review your regulator's requirements (Bank of Sierra Leone licensing, KYC/AML, data protection) before taking real customer money. This code does not make you compliant.

## How money stays correct

Every payment writes a Pending transaction first, debits the wallet with one atomic conditional update (a balance can never go below zero, even with parallel requests), calls the partner, then marks it Successful. If the partner clearly fails, the debit is refunded and a reversal row is written. If the answer is unknown the payment stays Pending and flagged for review. Credits (webhooks, refunds, settlements) carry unique keys, so a repeat can never credit twice. Money-moving requests accept an `Idempotency-Key`, so a retry after a dropped connection never charges twice. PINs and passwords are bcrypt-hashed; five wrong PINs lock payments for 30 minutes.


## Live money with Monime

Mobile money, bank and card are connected through Monime. Setup, environment variables, the webhook and testing steps are in [MONIME.md](MONIME.md).
