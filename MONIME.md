# Connecting TrustPay to Monime (mobile money, bank, card)

TrustPay uses [Monime](https://docs.monime.io) (API version `caph.2025-08-23`) for real money movement in Sierra Leone.

| What the customer does | Monime feature | TrustPay endpoint |
| --- | --- | --- |
| Send to a bank account | Payout (`destination.type = bank`) + Provider KYC name check | `POST /api/payments/transfer/bank` |
| Send to a mobile-money wallet (Orange Money, Afrimoney) | Payout (`destination.type = momo`) + Provider KYC | `POST /api/payments/mobile-money/send` |
| Add money with a card or mobile money (bank is switched off on the checkout page) | Hosted Checkout Session | `POST /api/payments/funding/checkout` |
| Money arrives / payout finishes | Webhook + Get Payout / Get Checkout Session | `POST /api/webhooks/monime` |

Card numbers never touch TrustPay: the customer pays on Monime's hosted page.

## 1. Get your Monime credentials

1. Create an account at <https://my.monime.io> and a **Space**. Copy the Space id (`spc-...`).
2. Create a **Personal Access Token** (Dashboard > Personal access tokens). `mon_test_...` tokens are for testing, `mon_...` for live money. A test token only works with test data and a live token only with live data.
3. Fund your Space's main financial account. **Payouts are paid out of this balance**, so top it up before customers send money (Internal transfers or a Checkout payment into the Space).

## 2. Environment variables (Render > trustpay-backend > Environment)

| Variable | Value |
| --- | --- |
| `PROVIDER_MODE` | `live` (use `sandbox` to keep fake money) |
| `MONIME_ACCESS_TOKEN` | your token |
| `MONIME_SPACE_ID` | `spc-...` |
| `MONIME_WEBHOOK_SECRET` | a random 32-256 character string you choose: `openssl rand -hex 32` |
| `PUBLIC_URL` | `https://trustpay-backend-zkiv.onrender.com` (used for the checkout return page) |
| `OTP_DEBUG` | `false` (required in live mode) |
| `ALLOW_SANDBOX_IN_PRODUCTION` | remove it |

Optional: `MONIME_PAYOUT_ACCOUNT_ID` (pay out of a specific financial account), `MONIME_COUNTRY` (default `SL`), `MONIME_VERSION`.

`PROVIDER_MODE=live` only switches banks, mobile money and card top-ups to Monime. SMS codes, airtime, electricity/TV/internet bills and card *issuing* still need their own partners; until you add them those actions answer "This service is not available yet" and the customer is not charged.

## 3. Register the webhook

Create it once in the Monime dashboard, or with the API:

```bash
curl -X POST https://api.monime.io/v1/webhooks \
  -H "Authorization: Bearer $MONIME_ACCESS_TOKEN" \
  -H "Monime-Space-Id: $MONIME_SPACE_ID" \
  -H "Monime-Version: caph.2025-08-23" \
  -H "Idempotency-Key: trustpay-webhook-1" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TrustPay",
    "url": "https://trustpay-backend-zkiv.onrender.com/api/webhooks/monime",
    "apiRelease": "caph",
    "events": ["payout.completed", "payout.failed", "payment.completed",
               "checkout_session.completed", "checkout_session.cancelled", "checkout_session.expired"],
    "verificationMethod": { "type": "HS256", "secret": "<the same value as MONIME_WEBHOOK_SECRET>" }
  }'
```

**How webhooks are trusted.** Monime's public docs do not name the signature header, so TrustPay does not rely on it for safety. A webhook is only a hint: the server re-reads the payout / checkout session / payment from Monime with its own token and acts on that answer. A forged webhook therefore cannot credit or refund anyone. If a recognised signature header is present it is also checked (HMAC-SHA256 of the body, or an HS256 JWT) and a wrong one is rejected with 401.

## 4. Sync the bank and wallet names

```bash
npm run monime:sync            # prints the banks and wallets Monime supports for SL
npm run monime:sync -- --apply # saves exactly those names into the app catalog
```

Run it once after going live so the app only offers providers that work. Names in the catalog are matched to Monime provider ids (`m17`, `slb004`, ...) automatically.

## 5. Safety net: reconcile

Payouts finish asynchronously. TrustPay waits about 6 seconds for the answer; if the payout is still running the transaction stays **Pending** and the webhook completes or refunds it. If a webhook is ever missed, run

```bash
npm run reconcile
```

or schedule it every 5 minutes as a Render Cron Job (`render.yaml` has one ready). It asks Monime for the real state of everything still Pending and refunds failed payouts / credits completed top-ups. Safe to run repeatedly.

## 6. Test before real money

1. Use a `mon_test_` token with `PROVIDER_MODE=live` first.
2. Add money online for a small amount, finish the payment on the Monime page, and confirm the balance rises and one `Account funding` row appears.
3. Send a small amount to a wallet you control; confirm it shows Pending, then Successful.
4. Watch `npm run check` for transactions flagged `needsReview`.

## Things to know

- Amounts are Leones in the app and minor units (Le x 100) in Monime and MongoDB: no conversion needed. Only `SLE` is used.
- Wallet numbers are stored as 8 national digits and sent to Monime as `232` + the 8 digits.
- Some banks may not support name checks; the app then asks the customer to double-check the number (`unverified`).
- Monime charges its own fees to your Space. TrustPay's own fees (`fees` in the catalog) are separate; check that they cover Monime's.
- Holding customer funds and moving money normally needs approval from the Bank of Sierra Leone. Confirm what your Monime agreement covers.

## Super admin

`SUPER_ADMIN_IDS` (comma-separated Mongo `_id`s, default `6ad0e47586522f7476ca3775`) always get the `admin` role on their next request, which opens every admin and support feature. The id must belong to an existing user; register that account first. Or run `npm run make-admin -- <userId|phone> admin`.

## Where top-up money goes

- **Mobile money** top-ups use a Payment Code (`POST /v1/payment-codes`, one-time, 15 minutes, locked to the customer's wallet number and provider). Collected funds are settled into `MONIME_FUNDING_ACCOUNT_ID` if you set it, otherwise into the space's **main financial account** (Monime's documented default).
- **Card** top-ups use a hosted checkout session and settle into your space's default account (the docs do not offer a choice there).
- TrustPay's wallet balance is a ledger in MongoDB. The real money sits in your Monime account, and bank / mobile money payouts are paid out of it. Keep it funded.
- Confirm in the Monime dashboard (Financial accounts) which account receives the money after your first live top-up.
