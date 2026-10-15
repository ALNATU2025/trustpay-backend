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
- POST `/payments/funding/checkout` `{amount}` -> `{ transaction, balance, checkoutUrl }`. Live: open `checkoutUrl` (Monime hosted page: card, bank or mobile money); the transaction is Pending until the payment is confirmed by webhook. Sandbox: credited at once and `checkoutUrl` is null. Catalog `features.fundingMode` is `"checkout"` (live) or `"direct"` (sandbox).
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
- GET `/admin/transactions?q=&page=` -> `{ items: [Txn], page, hasMore }` all users
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
