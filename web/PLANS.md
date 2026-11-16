# Free, Pro and Admin plans

Every account has a plan. Free is the default; Pro is a Stripe subscription;
Admin is set by hand in the database (James and his wife) and is never
changed by Stripe.

| | Free | Pro | Admin |
|---|---|---|---|
| Books of your own (uploads, scans, Find books adds) | 10 | unlimited | unlimited |
| Books saved from the public library | unlimited | unlimited | unlimited |
| Natural (Pocket) and device voices | yes | yes | yes |
| Premium (ElevenLabs) voice | no | `PRO_PREMIUM_MINUTES` a month (default 30) | unlimited |
| Find books, public library, bookmarks, Scan pages | yes | yes | yes |

Premium minutes are counted in characters: one minute is 900 characters
(about 150 words). Usage is kept per calendar month (UTC) in `tts_usage`.
A request is reserved before ElevenLabs is called, so two tabs can't spend
the same minutes twice; a failed upstream call gives its characters back.

## Why ElevenLabs is the Pro feature

It's the only feature that costs money per use (about $0.10 a minute on the
Creator plan with the turbo v2.5 model). Storage and the Pocket voice server
are flat costs, so Free keeps them, limited to 10 books so storage stays small.

## Files

- `plans.js` - plan limits, `planFor(userId)`, book-limit check, premium
  minute reservation, Stripe webhook handling and signature check.
- `server.js` - gates on the four ways a book is created (`POST /api/books`,
  `/api/books/uploads`, `/api/books/uploads/complete`, `/api/finder/add`) and
  on `/api/tts`; `GET /api/plan`; `POST /api/stripe/webhook` (raw body).
- `db.js` - new columns and tables for SQLite.
- `supabase/migrations/20261116000000_plans.sql` - the same for Postgres.
- `public/app.js`, `public/index.html`, `public/styles.css` - plan chip in
  the top bar, Plan sheet, book counter, "See plans" on limit errors,
  welcome after checkout.
- `test-plans.mjs` - `npm run test:plans`.

## Data

- `users.plan` `'free' | 'pro' | 'admin'` (default `'free'`),
  `users.stripe_customer_id`, `users.stripe_subscription_id`,
  `users.plan_status` (Stripe subscription status), `users.plan_renews_at` (ms).
- `tts_usage (user_id, month 'YYYY-MM', chars)`.
- `stripe_events (id, received_at)` so a webhook retried by Stripe is applied once.

## Payments (no Stripe secret key on the server)

Checkout uses two Stripe Payment Links (monthly, yearly). The app opens them
with `?client_reference_id=agr-<userId>`. Stripe sends
`checkout.session.completed` to `/api/stripe/webhook`, which sets the account
to Pro and stores the customer and subscription ids.
`customer.subscription.updated` / `.deleted` keep the plan in step: active,
trialing or past_due stay Pro; canceled, unpaid, incomplete_expired go back to
Free. Admin rows are never touched. Managing or cancelling uses Stripe's
customer portal login link. The webhook signature is checked with
`STRIPE_WEBHOOK_SECRET` (HMAC-SHA256, 5 minute tolerance).

Environment:

- `STRIPE_WEBHOOK_SECRET` - from the webhook endpoint.
- `STRIPE_LINK_MONTHLY`, `STRIPE_LINK_YEARLY` - Payment Link URLs.
- `STRIPE_PORTAL_URL` - customer portal login link.
- `PRO_PRICE_MONTHLY`, `PRO_PRICE_YEARLY` - labels shown in the app (default `$4.99`, `$39.99`).
- `PRO_PREMIUM_MINUTES` - default 30. `FREE_BOOK_LIMIT` - default 10.

Without the links, the Plan sheet says upgrades aren't open yet. All of this
starts in Stripe test mode; switching to live means new links, a new webhook
secret and James's go-ahead.

## Admin accounts

```sql
update reader.users set plan = 'admin' where username in ('carpenterjames88', '<wife>');
```

Run against existing accounts only, so nobody can claim admin by registering
a name later.

## Acceptance criteria

1. A new account is on Free; `GET /api/plan` says Free, 0 of 10 books.
2. A Free account can add 10 books of its own; the 11th upload, scan or
   Find books add is refused with 402 `plan_limit` before any file is stored
   (the local upload leaves no file on disk).
3. Saving a public book doesn't count toward the 10.
4. Deleting a book frees a slot.
5. A Free account calling `/api/tts` gets 402 `pro_required` and ElevenLabs is
   never called.
6. A Pro account can use premium voice until the month's minutes run out,
   then gets 402 `premium_minutes_used`; usage shows on `GET /api/plan`.
7. A failed ElevenLabs call doesn't use up minutes.
8. Admin has no book limit and no minute limit.
9. A webhook with a bad or missing signature is refused (400) and changes nothing.
10. `checkout.session.completed` with `client_reference_id=agr-<id>` makes that
    account Pro; replaying the same event id changes nothing more.
11. `customer.subscription.deleted` puts the account back on Free;
    `updated` with status `active` keeps Pro.
12. Stripe events never change an Admin account.
13. The top bar shows the plan; the Plan sheet shows books used, premium
    minutes left, and upgrade buttons that open the Payment Link with the
    account's reference (or "not open yet" when links aren't set).
14. Hitting a limit in the app shows the reason and a way to the Plan sheet.
15. After checkout (`?upgraded=1`) the app says welcome and shows Pro once
    the webhook lands.
16. Phone width: Plan sheet fits, no sideways scroll.
17. Existing test suites still pass.
