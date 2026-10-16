# TrustPay API contract (v1)

Base URL: `https://<render-service>.onrender.com/api`. JSON in, JSON out.
Auth: `Authorization: Bearer <jwt>` unless marked **public**.
Money: JSON numbers in Leones (SLE), max 2 decimals. Store as integer minor units (Le x 100) in MongoDB, convert at the API edge.
Errors: HTTP 4xx/5xx with `{ "message": "Human readable text", "code": "OPTIONAL_CODE" }`. 401 = missing/expired token, 403 = forbidden/suspended, 422 = validation, 402 = insufficient balance (`code: "INSUFFICIENT_FUNDS"`), 423 = wrong PIN / locked (`code: "BAD_PIN"`, `code: "PIN_LOCKED"`).
Dates: ISO 8601 UTC strings.

## Shared shapes

User:
```
{ id, firstName, lastName, fullName, email, phone, accountNumber, businessName, address,
  tier: "Tier 1 · Basic" | "Tier 2 · Verified" | "Tier 3 · Premium", role: "user"|"admin"|"support",
  status: "active"|"suspended"|"pending_kyc", onboardingStep: "phone"|"identity"|"pin"|"done",
  hasPin: boolean, balance: number, createdAt }
```
Txn:
```
{ id, reference, kind: "transfer"|"funding"|"bill"|"airtime"|"data"|"tv"|"internet"|"card"|"pos"|"mobile_money",
  direction: "debit"|"credit", title, meta, amount (signed: debit negative), fee, status: "Successful"|"Pending"|"Failed",
  createdAt, receipt: { eyebrow, statusLine, bannerLabel, amount, rows: [[label, value], ...] } , token?: "1234 5678 ..." }
```
Payment responses: `{ transaction: Txn, balance: number }` (balance = new available balance).

## Auth / onboarding
- POST `/auth/register` **public** `{firstName,lastName,email,phone,password}` -> 201 `{ token, user }` (user.onboardingStep = "phone"). Sends an SMS OTP. In dev (`OTP_DEBUG=true`) the response also has `devOtp`.
- POST `/auth/otp/send` (auth) -> `{ message }`; POST `/auth/otp/verify` `{code}` -> `{ user }` (step -> "identity")
- POST `/auth/identity` `{legalName,dob (ISO),idType: "NIN"|"Passport"|"Driver’s licence"|"Voter ID", idNumber, address}` -> `{ user }` (step -> "pin"; idNumber stored hashed + last4)
- POST `/auth/pin` `{pin: 4 digits}` -> `{ user }` (step -> "done", tier -> Tier 2)
- POST `/auth/login` **public** `{identifier (email or phone), password}` -> `{ token, user }`. Lockout after 5 failures for 15 min.
- POST `/auth/forgot` **public** `{identifier}` -> `{ message, devCode? }` (always 200, no account enumeration)
- POST `/auth/forgot/verify` **public** `{identifier, code}` -> `{ resetToken }`
- POST `/auth/reset` **public** `{resetToken, password}` -> `{ message }`

## Me
- GET `/me` -> `{ user }`
- PATCH `/me` `{firstName?,lastName?,email?,address?,businessName?}` -> `{ user }`
- POST `/me/password` `{currentPassword,newPassword}` -> `{ message }`
- POST `/me/pin` `{currentPin,newPin}` -> `{ message }`
- POST `/me/pin/verify` `{pin}` -> `{ ok: true }`
- GET `/wallet` -> `{ balance, accountNumber, accountName }`

## Catalog (public) GET `/catalog`
```
{ banks: [string], mobileMoney: [string], networks: [string],
  electricity: [{name, subtitle}], tv: [{name, subtitle}], internet: [{name, subtitle}],
  dataPlans: [{id,size,days,price}], tvPackages: [{id,name,detail,price}], internetPackages: [{id,name,detail,price}],
  fees: { transfer, mobileMoneySend, bill, cardIssuance, physicalCard, terminalDeposit, terminalDelivery, cardFundingPercent },
  terminal: { categories:[string], districts:[string] },
  topics: [string],
  support: { phone, email, hours } }
```

## Lookups (auth)
- POST `/lookup/bank` `{bank, accountNumber}` -> `{ accountName }` or 404
- POST `/lookup/meter` `{provider, meter}` -> `{ customerName, address }` or 404
- POST `/lookup/user` `{accountNumber}` -> `{ fullName, accountNumber }` or 404 (TrustPay user; phone also accepted via `phone`)
- POST `/lookup/wallet` `{provider, number}` -> `{ holderName }` or 404

## Payments (auth, all take `pin` except where noted)
- POST `/payments/transfer/bank` `{bank, accountNumber, accountName, amount, note?, pin, saveRecipient?}`
- POST `/payments/transfer/user` `{accountNumber, amount, note?, pin}` (instant, credits recipient, both ledgers)
- POST `/payments/mobile-money/send` `{provider, number, amount, pin}`
- POST `/payments/mobile-money/add` `{provider, number, amount, code (6 digits)}` (credit)
- POST `/payments/funding/card` `{amount, cardLast4, brand}` — card capture is done by a payment provider, never send raw PAN; sandbox credits immediately (credit)
- POST `/payments/bills` `{category: "electricity"|"tv"|"internet", provider, prepaid: bool, meter, customer, amount, phone, pin}` -> txn has `token` for prepaid electricity
- POST `/payments/airtime` `{network, phone, amount, pin}`
- POST `/payments/data` `{network, phone, planId, pin}`
- POST `/payments/subscription` `{category: "tv"|"internet", provider, accountNumber, packageId, phone, pin}`
- POST `/payments/funding/checkout` `{amount}` -> `{ transaction, balance, checkoutUrl }`. Live: open `checkoutUrl` (Monime hosted page, card only); the transaction is Pending until the payment is confirmed by webhook. Sandbox: credited at once and `checkoutUrl` is null. Catalog `features.fundingMode` is `"checkout"` (live) or `"direct"` (sandbox).
- POST `/payments/funding/momo-code` `{provider, number, amount}` -> `{ transaction, balance, ussdCode, expiresAt }`. Live: a Monime Payment Code locked to that wallet number; the customer dials `ussdCode` and approves; the transaction stays Pending until Monime confirms (webhook / reconcile). Sandbox: credited at once, `ussdCode` null.
- POST `/pos/charges` `{amount, number (customer wallet, 9 digits), provider?, note?}` + `Idempotency-Key` -> 201 `{ charge: {id, reference, amount, status: Pending|Paid|Expired|Failed, ussdCode, expiresAt, customerPhone, note, failureReason} }`. Phone POS: no terminal needed. Live: Monime payment code locked to the customer's number; sandbox: Paid at once.
- GET `/pos/charges` -> `{ items: [charge] }` (latest 20); GET `/pos/charges/:id` -> `{ charge }` (asks Monime while Pending, so the app can poll). When a charge is paid it becomes a POS payment (kind `momo`, terminal `PHONE`) and is paid out by the daily settlement.
- GET `/pos/code` -> `{ code (6 digits, permanent, created on first call), businessName, qr: "trustpay://pay/<code>" }` for the merchant to show/print.
- POST `/lookup/merchant` `{code}` -> `{ name, code }` or 404
- POST `/payments/pos/pay` `{code, amount, note?, pin}` + `Idempotency-Key` -> PaymentResult. Instant wallet-to-wallet payment to the merchant (customer txn `pos_pay_out`, merchant txn `pos_pay_in`); not part of the daily settlement because the merchant is credited at once.
- GET `/pos/settlement-account` -> `{ account: {bank, accountName, accountNumber (masked), payToBank} | null }`
- POST `/pos/settlement-account` `{bank, accountNumber, payToBank?, pin}` -> `{ account }` links a bank account after a name enquiry with the bank. POST `/pos/settlement-account/target` `{payToBank, pin}`; POST `/pos/settlement-account/unlink` `{pin}`. `/pos/overview` also returns `settlementAccount` and `merchantCode` for the POS dashboard.
- Daily `npm run settle`: credits the merchant wallet as before, then if `payToBank` is on, sends the net (minus the normal bank transfer fee) to the linked account via the bank provider (once per settlement; on failure the money stays in the wallet).
- **Tiers** (limits editable by admin): Tier 1 Le 100/day and Le 500 balance; Tier 2 Le 500/day and Le 1,000 balance; Tier 3 unlimited. New accounts wait for admin approval (`KYC_MANUAL=true`, default) and start at Tier 1. Over the daily limit -> 403 `DAILY_LIMIT`; a top-up or incoming payment over the balance cap -> 403 `BALANCE_LIMIT`.
- GET `/me/tier` -> `{ tier, limits:{daily,balance}, usedToday, nextTier, all, pendingRequest, lastRejection }`
- POST `/me/documents` `{kind: "address_proof"|"business_document", mime: image/jpeg|image/png|application/pdf, data: base64 (3 MB max)}` -> 201 `{ document:{id} }`
- POST `/me/tier-requests` `{tier, documentId, address? (tier 2), legalName?, businessNumber? (tier 3)}` -> 201. Shows up in Admin > Approvals as `tier_<id>` (with `documentId`).
- Admin: GET `/admin/documents/:id` -> `{mime, data(base64)}`; GET `/admin/tiers` -> `{limits, counts}`; PATCH `/admin/tiers` `{"Tier 1 · Basic": {daily, balance}}` (Leones, `null` = unlimited); decision on `tier_<id>` approves/rejects; PATCH `/admin/users/:id {tier}` sets a tier directly.
- **Duplicate check**: the same payment (route, amount, target) within 2 minutes -> 409 `DUPLICATE_SUSPECTED`; the app asks and retries with header `X-Confirm-Duplicate: 1`. Top-ups are exempt.
- **Notifications.** GET `/notifications?page=` -> `{ items:[{id,type,title,body,read,createdAt}], unread, page, hasMore }`; GET `/notifications/unread` -> `{ unread, latest }` (the app polls this); POST `/notifications/read` `{ids?}|{all:true}`; POST `/me/devices` `{token}` (FCM push token). Staff: GET/POST `/me/notification-prefs` (`signup, funding, payment, approval, alert` true/false).
- Admin: POST `/admin/notifications` `{audience: all|tier|merchants|user, tier?, userId?, kind: update|maintenance|approval|feature|message, title, body?}` -> `{ sent }`; GET `/admin/notifications` -> sent history.
- Who is notified: admins on new signup, account/upgrade/POS approval requests, wallet top-ups, payments/transfers and failed payouts; customers on welcome, money received, wallet funded, approval decisions, replies from support, failed payments and admin messages. Phone push needs `FCM_SERVICE_ACCOUNT_JSON`; without it everything still shows in the in-app inbox.
- POST `/webhooks/monime` **public** Monime events (`payout.*`, `payment.*`, `checkout_session.*`); the server re-reads the resource from Monime before changing any balance. See MONIME.md.
- POST `/webhooks/funding` **public, HMAC** header `x-signature` = hex HMAC-SHA256 of the raw body with `WEBHOOK_SECRET`; body `{accountNumber, amount, reference, sender?}` -> credits the account once per `reference` (idempotent).

Saved recipients: GET `/recipients` -> `{items:[{id,bank,accountNumber,accountName}]}`.

## Transactions (auth)
- GET `/transactions?service=all|transfer|bill|airtime|funding&status=&q=&page=1&limit=20&from=&to=` -> `{ items: [Txn], page, hasMore }` (current user only)
- GET `/transactions/:id` -> `{ transaction: Txn }`

## Cards (auth)
Card: `{ id, type: "virtual"|"physical", last4, expiry, holder, balance, frozen, status, issuancePaid, createdAt }`
- GET `/cards` -> `{ virtual: Card|null, physical: [Card] }`
- POST `/cards/virtual` `{amount, pin}` -> `{ card, transaction, balance }` (fee from config; one virtual card per user)
- POST `/cards/virtual/details` `{pin}` -> `{ number, cvv, expiry }` (PAN + CVV decrypted server side, only after PIN)
- POST `/cards/virtual/freeze` `{frozen: bool}` -> `{ card }`
- POST `/cards/virtual/fund` `{amount, pin}` -> `{ card, transaction, balance }`
- POST `/cards/physical` `{name, phone, address, city, state, pin}` -> `{ request: {id, reference, status}, transaction, balance }`

## POS (auth)
- GET `/pos/overview` -> `{ businessName, terminal: null | {id, code, serial, status: "active"|"disabled", lastSync, location, connection, battery}, today: {collected, count}, nextSettlement: null | {id, reference, net, gross, fees, count, scheduledFor, status}, recent: [{id,title,subtitle,amount,kind,createdAt}], request: null | {id,reference,status,createdAt} }`
- GET `/pos/settlements/next` -> `{ settlement: {id, reference, net, gross, fees, count, scheduledFor, status, destination, payments:[{reference,title,subtitle,amount}]} | null, rolledOver: {amount,count} }`
- POST `/pos/terminal/toggle` `{enabled: bool}` -> `{ terminal }`
- POST `/pos/terminal/request` `{businessName, category, address, city, state, contact, pin}` -> `{ request: {id, reference, status, createdAt, expectedFrom, expectedTo}, transaction, balance }` (charges deposit + delivery)
- POST `/webhooks/pos` **HMAC** `{terminalCode, amount, kind: "card"|"transfer", payer?, reference}` records a POS payment (so settlements have data).

## Support (auth)
- POST `/support/tickets` `{topic, message}` -> `{ ticket: {id, reference, topic, status, createdAt} }`
- GET `/support/tickets` -> `{ items: [ticket + lastMessage] }`
- GET `/support/tickets/:id` -> `{ ticket, messages: [{id, from: "user"|"agent", text, createdAt}] }`
- POST `/support/tickets/:id/messages` `{text}` -> `{ message }`
- GET `/support/chat` -> `{ ticket, messages }` the user's open live-chat ticket (creates one with a greeting from "agent" if none)
- POST `/support/chat` `{text}` -> `{ message }` (adds to the chat ticket)

## Admin (role admin or support; every route checks role server side)
- GET `/admin/stats` -> `{ totalUsers, activeToday, pendingApprovals, openTickets, volumeToday, volumeYesterday, changePct, week: [{label:"Mon", value}] }` (value in Leones; last 7 days)
- GET `/admin/users?q=&page=` -> `{ items: [{id, name, phone, tier, status}], page, hasMore }`
- PATCH `/admin/users/:id` `{status: "active"|"suspended"}` -> `{ user }` (admin only)
- GET `/admin/transactions?service=all|transfer|bill|airtime|funding&status=&direction=&user=<id>&review=1&q=&from=&to=&page=` -> `{ items: [Txn + userId, owner, ownerAccount, reference, subtype, provider, failureReason, needsReview], page, hasMore }` all users
- GET `/admin/users/:id` -> `{ user: {id,name,phone,email,tier,status,role,balance,kycStatus,accountNumber,lastLoginAt,createdAt,locked}, recent: [Txn], hasTerminal }`
- POST `/admin/users/:id/unlock` -> `{ user }` clears a PIN lock (admin only)
- POST `/admin/users/:id/funding` `{type: "credit"|"debit", amount, reason (5-200 chars), key (8-80 chars)}` -> `{ transaction, balance, duplicate }` (admin only). Manual adjustment: idempotent per admin+key, debit never overdraws (400), cannot target yourself or staff, audit-logged (`audit:funding.credit|debit`), shows as "Manual credit/debit" in the customer's history.
- GET `/admin/pos/overview` -> `{ activeTerminals, pendingRequests, paymentsCount, paymentsVolume, payoutsProcessing(+Count), payoutsPaid(+Count) }`
- GET `/admin/pos/terminals|payments|settlements?owner=<userId>&status=&q=&page=` -> `{ items, page, hasMore }` (settlements = merchant payouts)
- GET `/admin/approvals` -> `{ items: [{id, type: "kyc"|"pos"|"limit", title, detail, createdAt}] }`
- POST `/admin/approvals/:id/decision` `{approve: bool, reason?}` -> `{ ok: true }`
- GET `/admin/tickets`, POST `/admin/tickets/:id/reply` `{text}`, POST `/admin/tickets/:id/close`

## Additional routes (implemented)
- POST `/lookup/customer` `{category: "tv"|"internet", provider, number}` -> `{ customerName }`
- POST `/me/limit-request` `{reason?}` -> 201 `{ message }` (creates a "limit" approval for admins)
- DELETE `/recipients/:id` -> `{ ok: true }`
- GET `/pos/settlements/:id` -> `{ settlement }` (a paid settlement with its payments)
- Admin approval ids are prefixed by kind: `lim_<id>`, `pos_<id>`, `kyc_<id>`.
- Payments: send header `Idempotency-Key` (8-80 chars) on every money-moving POST. A repeat returns the first response; a different body with the same key is 409 `IDEMPOTENCY_KEY_REUSED`; a payment still running is 409 `IN_PROGRESS`.
- Error codes the app reacts to: `BAD_PIN` and `PIN_LOCKED` (423), `INSUFFICIENT_FUNDS` (402), `ONBOARDING_INCOMPLETE` / `SUSPENDED` (403), `OTP_*` (422), `RATE_LIMITED` (429), `PAYMENT_FAILED` (502, money already returned), `PROVIDER_NOT_CONFIGURED` (503).
- Pending payments: when a partner's answer is unknown the transaction is returned with `status: "Pending"` (HTTP 200) and the money stays held until it is confirmed.

## Health
- GET `/health` **public** -> `{ ok: true, uptime }`

## Seeding
`npm run seed` upserts the `Config` document (banks, providers, plans, packages, fees, support details) and, if `ADMIN_PHONE`/`ADMIN_PASSWORD`/`ADMIN_EMAIL` are set, creates the first admin user. Seeding never creates fake customers or transactions.
- POST `/auth/phone/change` (auth, phone not yet verified) `{phone}` -> `{ user }` and sends a new code to the new number. 409 PHONE_TAKEN if another account has it.
