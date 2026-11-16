// Free / Pro / Admin plan checks (PLANS.md). Self-contained like
// test-bugs.mjs: starts the app on a spare port with a throwaway data dir, a
// stand-in ElevenLabs and a test webhook secret, then checks
//   - book limit on every way a book is added, saves don't count, delete frees
//   - premium voice: Free refused, Pro metered and refused when used up,
//     failed upstream calls give minutes back, Admin unlimited
//   - Stripe webhook: signature, checkout -> Pro, replay ignored,
//     cancel -> Free, Admin untouched
//   - the browser (when CHROME is set): plan chip, meter, Plan sheet, limit
//     prompt, Payment Link with the account reference, welcome back, phone width
//
//   CHROME=/path/to/chrome node test-plans.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startCdn } from "./test-cdn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9390 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-plans-"));
const DB_PATH = join(DATA, "library.db");
const SECRET = "whsec_test_plans";
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);
const PDF = readFileSync(join(HERE, "multipage.pdf"));
const SHOTS = process.env.SHOTS || null;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// Stand-in ElevenLabs: answers audio, or fails when the text says so.
let upstreamCalls = 0;
const eleven = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamCalls++;
    const text = JSON.parse(body || "{}").text || "";
    if (text.includes("FAIL")) { res.writeHead(500); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  });
});
await new Promise((r) => eleven.listen(0, "127.0.0.1", r));
const ELEVEN = `http://127.0.0.1:${eleven.address().port}`;

const server = spawn(process.execPath, ["server.js"], {
  cwd: HERE,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH, NODE_ENV: "development", DATABASE_URL: process.env.DATABASE_URL || "", SUPABASE_URL: "",
    ELEVENLABS_API_KEY: "test", ELEVENLABS_API_BASE: ELEVEN,
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_LINK_MONTHLY: "https://buy.stripe.com/test_monthly",
    STRIPE_LINK_YEARLY: "https://buy.stripe.com/test_yearly",
    STRIPE_PORTAL_URL: "https://billing.stripe.com/p/login/test_portal",
    FREE_BOOK_LIMIT: "3", PRO_PREMIUM_MINUTES: "2",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (d) => { if (!/ExperimentalWarning|--trace-warnings/.test(String(d))) process.stderr.write(d); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/api/me`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
}

function client() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async req(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let json = null;
      try { json = await res.clone().json(); } catch (_) {}
      return { status: res.status, json, res };
    },
  };
}
const db = () => new DatabaseSync(DB_PATH);
// Postgres: ADMIN_DATABASE_URL (or DATABASE_URL), tables in schema reader.
async function sql(q, ...p) {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, ssl: process.env.PG_SSL === "off" ? false : { rejectUnauthorized: false } });
    await c.connect();
    try {
      await c.query("SET search_path = reader");
      let n = 0;
      return (await c.query(q.replace(/[?]/g, () => "$" + (++n)), p)).rows;
    } finally { await c.end(); }
  }
  const d = db(); try { return d.prepare(q).all(...p); } finally { d.close(); }
}
async function setPlan(id, plan) { await sql("UPDATE users SET plan = ? WHERE id = ?", plan, id); }
function upload(c, name = "Book.pdf") {
  const form = new FormData();
  form.append("file", new Blob([PDF], { type: "application/pdf" }), name);
  return c.req("/api/books", { method: "POST", body: form });
}
function filesOf(id) {
  const dir = join(DATA, "books", String(id));
  return existsSync(dir) ? readdirSync(dir).length : 0;
}
function signed(event, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { body, headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` } };
}
const anonC = client();
async function webhook(event, opts) {
  const { body, headers } = signed(event, opts);
  return anonC.req("/api/stripe/webhook", { method: "POST", body, headers });
}
const tts = (c, text) => c.req("/api/tts", { method: "POST", json: { text } });

let browser, cdn;
try {
  const stamp = Date.now().toString(36);
  const users = {};
  for (const n of ["free", "pro", "admin", "sharer"]) {
    users[n] = client();
    await users[n].req("/api/auth/register", { method: "POST", json: { username: `plan_${n}_${stamp}`, password: "password1" } });
    users[n].id = (await users[n].req("/api/me")).json.user.id;
  }
  const { free, pro, admin, sharer } = users;

  // ----- 1. defaults -----
  let r = await anonC.req("/api/plan");
  check("signed out: /api/plan 401", r.status === 401);
  r = await free.req("/api/plan");
  check("new account is Free with 0 of 3 books", r.json.plan === "free" && r.json.books.used === 0 && r.json.books.limit === 3, JSON.stringify(r.json));
  check("plan carries prices and Payment Links with the account reference", r.json.pro.priceMonthly === "$4.99" && r.json.checkout.monthly === `https://buy.stripe.com/test_monthly?client_reference_id=agr-${free.id}` && /client_reference_id=agr-/.test(r.json.checkout.yearly));

  // ----- 2. book limit -----
  for (let i = 1; i <= 3; i++) {
    r = await upload(free, `Free ${i}.pdf`);
    check(`free book ${i} of 3 added`, r.status === 200 && r.json.book);
  }
  const filesBefore = filesOf(free.id);
  r = await upload(free, "Free 4.pdf");
  check("4th upload refused: 402 plan_limit", r.status === 402 && r.json.code === "plan_limit", JSON.stringify(r.json));
  check("refused upload left no file on disk", filesOf(free.id) === filesBefore);
  r = await free.req("/api/books/uploads", { method: "POST", json: { filename: "x.pdf", size: 10 } });
  check("upload step 1 refused when full", r.status === 402 && r.json.code === "plan_limit");
  r = await free.req("/api/finder/add", { method: "POST", json: { id: "gutenberg:1342", title: "Pride" } });
  check("Find books add refused when full (before downloading)", r.status === 402 && r.json.code === "plan_limit");

  // ----- 3. saves don't count -----
  const shared = (await upload(sharer, "Shared.pdf")).json.book;
  await sharer.req(`/api/books/${shared.id}/visibility`, { method: "POST", json: { visibility: "public" } });
  r = await free.req(`/api/public-books/${shared.id}/save`, { method: "POST" });
  check("saving a public book works on a full free shelf", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.json)}`);
  r = await free.req("/api/plan");
  check("saved book doesn't count toward the limit", r.json.books.used === 3);

  // ----- 4. delete frees a slot -----
  const mine = (await free.req("/api/books")).json.books.filter((b) => b.owned);
  await free.req(`/api/books/${mine[0].id}`, { method: "DELETE" });
  r = await upload(free, "Free again.pdf");
  check("deleting a book frees a slot", r.status === 200);

  // ----- 5. premium voice on Free -----
  upstreamCalls = 0;
  r = await tts(free, "Hello there.");
  check("Free: premium voice 402 pro_required", r.status === 402 && r.json.code === "pro_required");
  check("Free: ElevenLabs never called", upstreamCalls === 0);

  // ----- 6/7. Pro metering (2 minutes = 1800 chars) -----
  await setPlan(pro.id, "pro");
  r = await tts(pro, "a".repeat(1000));
  check("Pro: premium voice plays", r.status === 200 && r.res.headers.get("content-type") === "audio/mpeg");
  r = await pro.req("/api/plan");
  check("Pro: usage shows on /api/plan", r.json.premium.usedMinutes === 2 && r.json.premium.leftMinutes === 0 && r.json.premium.limitMinutes === 2, JSON.stringify(r.json.premium));
  r = await tts(pro, "FAIL " + "b".repeat(700));
  check("failed ElevenLabs call: 5xx", r.status >= 500);
  const used = async () => Number(((await sql("SELECT chars FROM tts_usage WHERE user_id = ?", pro.id))[0] || {}).chars || 0);
  check("failed call gave its minutes back", (await used()) === 1000, String(await used()));
  r = await tts(pro, "c".repeat(700));
  check("Pro: still within minutes", r.status === 200 && (await used()) === 1700);
  upstreamCalls = 0;
  r = await tts(pro, "d".repeat(200));
  check("Pro: minutes used up -> 402 premium_minutes_used", r.status === 402 && r.json.code === "premium_minutes_used");
  check("used-up request never reached ElevenLabs", upstreamCalls === 0 && (await used()) === 1700);
  // parallel requests can't overspend
  await sql("UPDATE tts_usage SET chars = 1000 WHERE user_id = ?", pro.id);
  const par = await Promise.all([1, 2, 3, 4].map(() => tts(pro, "e".repeat(300))));
  check("parallel requests stop at the limit", par.filter((x) => x.status === 200).length === 2 && (await used()) === 1600, `${par.map((x) => x.status)} ${await used()}`);
  for (let i = 1; i <= 3; i++) await upload(pro, `Pro ${i}.pdf`);
  r = await upload(pro, "Pro 4.pdf");
  check("Pro: no book limit", r.status === 200);

  // ----- 8. Admin -----
  await setPlan(admin.id, "admin");
  for (let i = 1; i <= 4; i++) await upload(admin, `Admin ${i}.pdf`);
  r = await admin.req("/api/plan");
  check("Admin: 4 books, no limit", r.json.books.used === 4 && r.json.books.limit === null && r.json.premium.limitMinutes === null);
  r = await tts(admin, "f".repeat(1500));
  const r2 = await tts(admin, "g".repeat(1500));
  check("Admin: premium voice has no minute limit", r.status === 200 && r2.status === 200);

  // ----- 9. webhook signature -----
  const proFromStripe = users.free;
  const checkoutEvt = {
    id: `evt_checkout_${stamp}`, type: "checkout.session.completed",
    data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: `agr-${proFromStripe.id}`, customer: "cus_test1", subscription: "sub_test1" } },
  };
  r = await anonC.req("/api/stripe/webhook", { method: "POST", body: JSON.stringify(checkoutEvt), headers: { "Content-Type": "application/json" } });
  check("webhook without signature: 400", r.status === 400);
  r = await webhook(checkoutEvt, { secret: "whsec_wrong" });
  check("webhook with wrong secret: 400", r.status === 400);
  r = await webhook(checkoutEvt, { t: Math.floor(Date.now() / 1000) - 3600 });
  check("webhook signed an hour ago: 400", r.status === 400);
  check("bad webhooks changed nothing", (await proFromStripe.req("/api/plan")).json.plan === "free");

  // ----- 10. checkout -> Pro, replay ignored -----
  r = await webhook(checkoutEvt);
  check("signed checkout.session.completed: 200", r.status === 200 && r.json.received === true);
  r = await proFromStripe.req("/api/plan");
  check("checkout made the account Pro", r.json.plan === "pro" && r.json.books.limit === null);
  check("Pro sees Manage subscription link", r.json.portal === "https://billing.stripe.com/p/login/test_portal");
  await sql("UPDATE users SET plan = 'free' WHERE id = ?", proFromStripe.id);
  r = await webhook(checkoutEvt);
  check("replayed event id changes nothing", r.status === 200 && (await proFromStripe.req("/api/plan")).json.plan === "free");
  await sql("UPDATE users SET plan = 'pro' WHERE id = ?", proFromStripe.id);

  // ----- 11. subscription updates -----
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  r = await webhook({ id: `evt_upd_${stamp}`, type: "customer.subscription.updated", data: { object: { id: "sub_test1", customer: "cus_test1", status: "active", current_period_end: end } } });
  r = await proFromStripe.req("/api/plan");
  check("updated (active) keeps Pro and records renewal", r.json.plan === "pro" && r.json.renewsAt === end * 1000);
  await webhook({ id: `evt_pd_${stamp}`, type: "customer.subscription.updated", data: { object: { id: "sub_test1", customer: "cus_test1", status: "past_due" } } });
  check("past_due keeps Pro (Stripe is retrying the card)", (await proFromStripe.req("/api/plan")).json.plan === "pro");
  await webhook({ id: `evt_del_${stamp}`, type: "customer.subscription.deleted", data: { object: { id: "sub_test1", customer: "cus_test1", status: "canceled" } } });
  r = await proFromStripe.req("/api/plan");
  check("deleted puts the account back on Free", r.json.plan === "free" && r.json.status === "canceled");
  r = await webhook({ id: `evt_other_${stamp}`, type: "invoice.paid", data: { object: {} } });
  check("other event types are accepted and ignored", r.status === 200);

  // ----- 12. Admin untouched -----
  r = await webhook({ id: `evt_adm_${stamp}`, type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: `agr-${admin.id}`, customer: "cus_adm", subscription: "sub_adm" } } });
  await sql("UPDATE users SET stripe_subscription_id = 'sub_adm2', stripe_customer_id = 'cus_adm2' WHERE id = ?", admin.id);
  await webhook({ id: `evt_adm_del_${stamp}`, type: "customer.subscription.deleted", data: { object: { id: "sub_adm2", customer: "cus_adm2" } } });
  check("Stripe events never change Admin", (await admin.req("/api/plan")).json.plan === "admin");

  // ----- Browser -----
  if (!CHROME) {
    console.log("SKIP  browser checks (set CHROME)");
  } else {
    const { default: puppeteer } = await import("puppeteer-core");
    cdn = await startCdn(process.env.CDN_DIR);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ["--no-sandbox", "--disable-gpu", ...(cdn ? cdn.chromeArgs : [])] });
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const visible = (page, sel) => page.$eval(sel, (n) => !n.hidden && !n.closest("[hidden]") && !!(n.offsetWidth || n.offsetHeight)).catch(() => false);
    const text = (page, sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => "");
    const pageErrors = [];
    async function open(c, viewport, path = "/index.html") {
      const page = await browser.newPage();
      if (viewport) await page.setViewport(viewport);
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const [name, value] = c.cookie.split("=");
      await page.setCookie({ name, value, url: BASE });
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      await sleep(300);
      return page;
    }

    // A fresh free account with a full shelf.
    const fb = client();
    await fb.req("/api/auth/register", { method: "POST", json: { username: `plan_ui_${stamp}`, password: "password1" } });
    for (let i = 1; i <= 3; i++) await upload(fb, `Shelf ${i}.pdf`);
    const page = await open(fb, { width: 1280, height: 900 });
    check("top bar shows the Free chip", (await visible(page, "#planBtn")) && (await text(page, "#planBtn")) === "Free");
    check("library meter says the shelf is full", /3 of 3/.test(await text(page, "#planMeter")) && /Go Pro/.test(await text(page, "#planMeter")));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "1-library-free-desk.png") });
    await page.click("#planBtn");
    await sleep(400);
    check("Plan sheet opens from the chip", await page.$eval("#planDialog", (d) => d.open));
    check("sheet shows usage and both plans", /3 of 3 books/.test(await text(page, "#planUsage")) && (await visible(page, "#planCompare")) && /2 minutes of premium voice/.test(await text(page, "#planProMinutes")));
    const href = await page.$eval("#planBuyMonthly", (a) => a.href);
    check("Go Pro opens the Payment Link with this account's reference", /^https:\/\/buy\.stripe\.com\/test_monthly\?client_reference_id=agr-\d+$/.test(href), href);
    check("yearly option shown", (await visible(page, "#planBuyYearly")) && /\$39\.99/.test(await text(page, "#planBuyYearly")));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-plan-sheet-desk.png") });
    await page.click("#planClose");
    await sleep(200);

    // Hitting the limit from the app: upload a 4th book through the picker.
    const input = await page.$("#filePicker");
    const tmpPdf = join(DATA, "Fourth.pdf");
    (await import("node:fs")).writeFileSync(tmpPdf, PDF);
    await input.uploadFile(tmpPdf);
    await page.waitForFunction(() => document.getElementById("planDialog").open, { timeout: 8000 }).catch(() => {});
    check("limit hit: Plan sheet opens with the reason", (await page.$eval("#planDialog", (d) => d.open)) && /Free plan holds 3 books/.test(await text(page, "#planReason")));
    await page.close();

    // Premium voice from a Free account: pick it in the Voice sheet, press Play.
    const vp = await open(fb, { width: 1280, height: 900 });
    await vp.click(".book-card-open");
    const opened = await vp.waitForFunction(() => !document.getElementById("readerScreen").hidden && !document.getElementById("play").disabled, { timeout: 20000 }).then(() => true, () => false);
    if (opened) {
      await vp.evaluate(() => { const e = document.getElementById("engine"); e.value = "elevenlabs"; e.dispatchEvent(new Event("change", { bubbles: true })); });
      await vp.click("#play");
      await vp.waitForFunction(() => document.getElementById("planDialog").open, { timeout: 8000 }).catch(() => {});
      check("premium voice on Free: Play opens the Plan sheet saying it's Pro", /part of Pro/.test(await text(vp, "#planReason")), await text(vp, "#planReason"));
    } else check("book opened for the premium voice check", false);
    await vp.close();

    // Pro account: no meter, chip says Pro, manage link, no buy buttons.
    const pp = await open(pro, { width: 1280, height: 900 });
    check("Pro: chip says Pro, no meter", (await text(pp, "#planBtn")) === "Pro" && !(await visible(pp, "#planMeter")));
    await pp.click("#planBtn");
    await sleep(400);
    check("Pro: sheet shows minutes left and Manage link, no buy buttons", /minutes left/.test(await text(pp, "#planUsage")) && (await visible(pp, "#planManage")) && !(await visible(pp, "#planBuyMonthly")));
    await pp.close();

    const ap = await open(admin, { width: 1280, height: 900 });
    check("Admin: chip says Admin", (await text(ap, "#planBtn")) === "Admin");
    await ap.click("#planBtn");
    await sleep(400);
    check("Admin: sheet says everything, free", /Admin/.test(await text(ap, "#planName")) && /no limit/.test(await text(ap, "#planUsage")) && !(await visible(ap, "#planManage")));
    if (SHOTS) await ap.screenshot({ path: join(SHOTS, "3-plan-sheet-admin.png") });
    await ap.close();

    // Back from checkout: webhook lands a moment later.
    const up = client();
    await up.req("/api/auth/register", { method: "POST", json: { username: `plan_up_${stamp}`, password: "password1" } });
    const upId = (await up.req("/api/me")).json.user.id;
    const wp = await open(up, { width: 1280, height: 900 }, "/index.html?upgraded=1");
    await sleep(1200);
    check("back from checkout: says it's finishing", /Finishing your upgrade/.test(await text(wp, "#status")), await text(wp, "#status"));
    await webhook({ id: `evt_ui_${stamp}`, type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: `agr-${upId}`, customer: "cus_ui", subscription: "sub_ui" } } });
    await wp.waitForFunction(() => document.getElementById("planBtn").textContent === "Pro", { timeout: 8000 }).catch(() => {});
    check("after the webhook: welcome to Pro, chip updates", (await text(wp, "#planBtn")) === "Pro" && /Welcome to Pro/.test(await text(wp, "#status")));
    check("the ?upgraded flag is cleared from the address", !(await wp.evaluate(() => location.search)).includes("upgraded"));
    await wp.close();

    // Phone width.
    const phone = await open(fb, { width: 360, height: 780, isMobile: true, deviceScaleFactor: 2 });
    check("phone: plan chip visible", await visible(phone, "#planBtn"));
    const topbarOk = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("phone: library doesn't scroll sideways", topbarOk);
    await phone.click("#planBtn");
    await sleep(400);
    const fits = await phone.$eval("#planDialog", (d) => d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().right <= window.innerWidth + 1);
    check("phone: Plan sheet fits the width", fits);
    if (SHOTS) {
      await phone.screenshot({ path: join(SHOTS, "4-plan-sheet-phone.png") });
      await phone.click("#planClose");
      await sleep(200);
      await phone.screenshot({ path: join(SHOTS, "5-library-free-phone.png") });
    }
    await phone.close();

    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  }
} catch (e) {
  fail++;
  console.log("FAIL  test crashed:", e);
} finally {
  if (browser) await browser.close();
  if (cdn) cdn.close();
  server.kill();
  eleven.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
