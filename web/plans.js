// Free, Pro and Admin plans. See PLANS.md.
//
// Free: FREE_BOOK_LIMIT books of your own, no premium (ElevenLabs) voice.
// Pro: unlimited books, PRO_PREMIUM_MINUTES of premium voice a month.
// Admin: no limits. Set by hand in the database, never changed by Stripe.
//
// Payments: Stripe Payment Links + a signed webhook, so the server holds no
// Stripe secret key, only the webhook signing secret.

const crypto = require("node:crypto");
const { query, queryOne } = require("./db");

const CHARS_PER_MINUTE = 900; // ~150 spoken words
const PLAN_NAMES = ["free", "pro", "admin"];

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function limits(plan) {
  if (plan === "admin") return { books: null, premiumChars: null };
  if (plan === "pro") return { books: null, premiumChars: numEnv("PRO_PREMIUM_MINUTES", 30) * CHARS_PER_MINUTE };
  return { books: numEnv("FREE_BOOK_LIMIT", 10), premiumChars: 0 };
}

function month(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

async function userPlan(userId) {
  const row = await queryOne("SELECT plan FROM users WHERE id = ?", [userId]);
  return row && PLAN_NAMES.includes(row.plan) ? row.plan : "free";
}

async function bookCount(userId) {
  const row = await queryOne("SELECT COUNT(*) AS n FROM books WHERE user_id = ?", [userId]);
  return Number(row ? row.n : 0);
}

async function premiumCharsUsed(userId) {
  const row = await queryOne("SELECT chars FROM tts_usage WHERE user_id = ? AND month = ?", [userId, month()]);
  return Number(row ? row.chars : 0);
}

function checkoutLinks(userId) {
  const ref = `agr-${userId}`;
  const withRef = (url) => {
    if (!url) return null;
    try {
      const u = new URL(url);
      u.searchParams.set("client_reference_id", ref);
      return u.toString();
    } catch (_) {
      return null;
    }
  };
  return {
    monthly: withRef(process.env.STRIPE_LINK_MONTHLY),
    yearly: withRef(process.env.STRIPE_LINK_YEARLY),
    portal: process.env.STRIPE_PORTAL_URL || null,
  };
}

// Everything the Plan sheet needs.
async function planSummary(userId) {
  const row = await queryOne(
    "SELECT plan, plan_status, plan_renews_at FROM users WHERE id = ?",
    [userId]
  );
  const plan = row && PLAN_NAMES.includes(row.plan) ? row.plan : "free";
  const lim = limits(plan);
  const used = await premiumCharsUsed(userId);
  const links = checkoutLinks(userId);
  return {
    plan,
    status: (row && row.plan_status) || null,
    renewsAt: (row && row.plan_renews_at) || null,
    books: { used: await bookCount(userId), limit: lim.books },
    premium: {
      usedMinutes: Math.ceil(used / CHARS_PER_MINUTE),
      limitMinutes: lim.premiumChars === null ? null : Math.round(lim.premiumChars / CHARS_PER_MINUTE),
      leftMinutes: lim.premiumChars === null ? null : Math.max(0, Math.floor((lim.premiumChars - used) / CHARS_PER_MINUTE)),
    },
    pro: {
      priceMonthly: process.env.PRO_PRICE_MONTHLY || "$4.99",
      priceYearly: process.env.PRO_PRICE_YEARLY || "$39.99",
      premiumMinutes: numEnv("PRO_PREMIUM_MINUTES", 30),
      freeBookLimit: numEnv("FREE_BOOK_LIMIT", 10),
    },
    checkout: links.monthly || links.yearly ? { monthly: links.monthly, yearly: links.yearly } : null,
    portal: links.portal,
  };
}

class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 402;
  }
}

// Throws PlanError when the account can't add another book of its own.
async function assertCanAddBook(userId) {
  const lim = limits(await userPlan(userId));
  if (lim.books === null) return;
  if ((await bookCount(userId)) >= lim.books) {
    throw new PlanError(
      "plan_limit",
      `The Free plan holds ${lim.books} books of your own. Delete one, or go Pro for unlimited books.`
    );
  }
}

// Reserve premium-voice characters before calling ElevenLabs. Returns a
// release() that gives them back if the call fails. The conditional UPDATE
// makes the check and the spend one step, so parallel requests can't
// overspend.
async function reservePremium(userId, chars) {
  const plan = await userPlan(userId);
  const lim = limits(plan);
  if (lim.premiumChars === 0) {
    throw new PlanError("pro_required", "The premium voice is part of Pro. Pick the Natural voice, or go Pro.");
  }
  const m = month();
  await query(
    "INSERT INTO tts_usage (user_id, month, chars) VALUES (?, ?, 0) ON CONFLICT (user_id, month) DO NOTHING",
    [userId, m]
  );
  const rows = lim.premiumChars === null
    ? await query("UPDATE tts_usage SET chars = chars + ? WHERE user_id = ? AND month = ? RETURNING chars", [chars, userId, m])
    : await query(
        "UPDATE tts_usage SET chars = chars + ? WHERE user_id = ? AND month = ? AND chars + ? <= ? RETURNING chars",
        [chars, userId, m, chars, lim.premiumChars]
      );
  if (!rows.length) {
    throw new PlanError(
      "premium_minutes_used",
      "You've used this month's premium voice minutes. The Natural voice is still free, and minutes refill on the 1st."
    );
  }
  let released = false;
  return async function release() {
    if (released) return;
    released = true;
    await query(
      "UPDATE tts_usage SET chars = CASE WHEN chars >= ? THEN chars - ? ELSE 0 END WHERE user_id = ? AND month = ?",
      [chars, chars, userId, m]
    );
  };
}

// ----- Stripe webhook -----

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. Signed payload is
// "<t>.<raw body>" with HMAC-SHA256 and the endpoint's signing secret.
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

function refUserId(ref) {
  const m = /^agr-(\d+)$/.exec(String(ref || ""));
  return m ? Number(m[1]) : null;
}

// Apply one verified Stripe event. Returns a short note for the log.
async function applyStripeEvent(event) {
  if (!event || typeof event.id !== "string" || !event.type) return "ignored: malformed";
  const seen = await query(
    "INSERT INTO stripe_events (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
    [event.id, Date.now()]
  );
  if (!seen.length) return "ignored: already applied";
  try {
    return await applyOnce(event);
  } catch (e) {
    // Let Stripe's retry try again.
    await query("DELETE FROM stripe_events WHERE id = ?", [event.id]).catch(() => {});
    throw e;
  }
}

async function applyOnce(event) {
  const obj = (event.data && event.data.object) || {};

  if (event.type === "checkout.session.completed") {
    const userId = refUserId(obj.client_reference_id);
    if (!userId) return "ignored: no account reference";
    if (obj.mode && obj.mode !== "subscription") return "ignored: not a subscription";
    if (obj.payment_status && !["paid", "no_payment_required"].includes(obj.payment_status)) return "ignored: unpaid";
    const updated = await query(
      `UPDATE users SET plan = 'pro', plan_status = 'active', stripe_customer_id = ?, stripe_subscription_id = ?
       WHERE id = ? AND plan <> 'admin' RETURNING id`,
      [obj.customer || null, obj.subscription || null, userId]
    );
    return updated.length ? `pro: user ${userId}` : `ignored: user ${userId} missing or admin`;
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted" || event.type === "customer.subscription.created") {
    const status = event.type === "customer.subscription.deleted" ? "canceled" : String(obj.status || "");
    const plan = PRO_STATUSES.has(status) ? "pro" : "free";
    const renews = obj.current_period_end || (obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].current_period_end) || null;
    const updated = await query(
      `UPDATE users SET plan = ?, plan_status = ?, plan_renews_at = ?
       WHERE plan <> 'admin' AND (stripe_subscription_id = ? OR (stripe_subscription_id IS NULL AND stripe_customer_id = ?))
       RETURNING id`,
      [plan, status, renews ? Number(renews) * 1000 : null, obj.id || "", obj.customer || ""]
    );
    return updated.length ? `${plan} (${status}): user ${updated[0].id}` : "ignored: no matching account";
  }

  return `ignored: ${event.type}`;
}

module.exports = {
  CHARS_PER_MINUTE,
  PlanError,
  limits,
  planSummary,
  assertCanAddBook,
  reservePremium,
  verifyStripeSignature,
  applyStripeEvent,
};
