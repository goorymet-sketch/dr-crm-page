'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const core = require('../crm-core.js');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'welcome.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const ALLOWED = 'goory.met@gmail.com';

/* Legacy production-shaped fixture. It is never written to Firestore: the
   SDK is stubbed and everything stays in this jsdom window. */
const LEGACY = {
  companies: [
    {
      id: 'legacy1',
      name: 'شركة الواحة للسفر',
      industry: 'سياحة وسفر',
      sector: 'السياحة والسفر',
      country: 'السعودية',
      contact: 'أحمد',
      phone: '966501111111',
      stage: 'مهتم',
      replyStatus: 'رد العميل',
      fitScore: 72,
      source: 'انستجرام',
      notes: 'ملاحظات قديمة',
      created: '2026-01-05',
      followUpDate: '2026-01-01',
      activities: [{ id: 'a1', type: 'مكالمة', note: 'اتصال أول', date: '2026-01-06', at: '2026-01-06T10:00:00.000Z' }]
    },
    {
      id: 'legacy2',
      name: 'وكالة نبض التسويق',
      industry: 'تسويق وإعلان',
      sector: 'وكالات التسويق',
      country: 'الإمارات',
      contact: 'سارة',
      phone: '971501111111',
      stage: 'جديد',
      fitScore: 55,
      source: 'جوجل ماب',
      created: '2026-01-07'
    }
  ],
  posts: [
    {
      id: 'post1',
      platform: 'فيسبوك',
      page: 'شركة الواحة للسفر',
      title: 'عرض عمرة',
      likes: '10',
      commentsCount: '2',
      comments: 'سعر كام؟',
      link: 'https://example.test/post',
      date: '2026-01-08'
    }
  ],
  plans: {
    legacy1: {
      text: 'خطة محفوظة قديمة',
      updated: '2026-01-01',
      discoveryQuestions: ['سؤال قديم'],
      followUp: [{ day: 0, action: 'إجراء قديم' }]
    }
  }
};

async function boot(options) {
  options = options || {};
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));

  const dom = new JSDOM(HTML, {
    runScripts: 'outside-only',
    url: 'https://localhost.test/',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  const alerts = [];
  window.console.error = (...args) => errors.push('console.error: ' + args.map(String).join(' '));
  window.console.warn = () => {};
  window.alert = (m) => alerts.push(String(m));
  window.confirm = () => true;
  window.prompt = () => null;
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};

  if (window.HTMLDialogElement && window.HTMLDialogElement.prototype) {
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  }

  window.localStorage.setItem('dr_crm_v1', JSON.stringify(options.legacy || LEGACY));

  const cloudSaves = [];
  const docStub = {
    get: async () => ({ exists: false, data: () => ({}) }),
    set: async (payload) => { cloudSaves.push(payload); return true; }
  };
  const firestoreFn = function () {
    return { collection: () => ({ doc: () => docStub }) };
  };
  firestoreFn.FieldValue = { serverTimestamp: () => 'SERVER_TS' };

  window.firebase = {
    initializeApp: () => {},
    auth: () => ({
      onAuthStateChanged: (cb) => { window.setTimeout(() => cb({ email: options.email || ALLOWED }), 0); },
      signInWithEmailAndPassword: () => Promise.resolve(),
      signOut: () => Promise.resolve()
    }),
    firestore: firestoreFn
  };

  window.CRMCore = core;
  window.eval(APP);

  await new Promise((resolve) => window.setTimeout(resolve, 60));

  return { dom, window, document: window.document, app: window.__DR_APP, errors, alerts, cloudSaves };
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function setField(window, form, name, value) {
  const el = form.elements.namedItem(name);
  assert.ok(el, `form field ${name} should exist`);
  el.value = value;
  return el;
}

test('app boots, authenticates, loads legacy data and renders without console errors', async () => {
  const ctx = await boot();
  const { document, window, app } = ctx;

  assert.ok(app, 'window.__DR_APP should be exposed');
  assert.equal(document.body.classList.contains('auth-locked'), false, 'CRM unlocks after auth');
  assert.equal(document.getElementById('nav').querySelectorAll('button[data-tab]').length, 10);
  assert.equal(document.querySelectorAll('#tbC tr').length, 2, 'legacy companies rendered');
  assert.ok(document.getElementById('stats').textContent.includes('إجمالي الشركات'));
  assert.ok(document.getElementById('dashCards').textContent.includes('HOT'));
  assert.ok(document.getElementById('followStats').textContent.length > 0);

  const db = app.getDb();
  assert.equal(db.companies.length, 2);
  assert.equal(db.companies[0].name, 'شركة الواحة للسفر');
  assert.equal(db.companies[0].fitScore, 72);
  assert.equal(db.companies[0].activities.length, 1);
  assert.equal(db.posts.length, 1);
  assert.equal(db.plans.legacy1.text, 'خطة محفوظة قديمة');
  assert.equal(db.companies[0].replyStatus, 'رد العميل');
  assert.deepEqual(db.companies[0].contacts, []);

  assert.equal(ctx.errors.length, 0, 'no console/jsdom errors: ' + ctx.errors.join(' | '));
  window.close();
});

test('add and edit a company persists the new fields without duplicating it', async () => {
  const ctx = await boot();
  const { document, window, app } = ctx;

  app.openCompanyForm(null);
  const form = document.getElementById('companyForm');
  assert.ok(form);
  assert.ok(document.getElementById('companyDlg').hasAttribute('open'));

  setField(window, form, 'name', 'شركة اختبار جديدة');
  setField(window, form, 'sector', 'السياحة والسفر');
  setField(window, form, 'country', 'السعودية');
  setField(window, form, 'contact', 'محمد');
  setField(window, form, 'contactRole', 'مدير');
  setField(window, form, 'phone', '0500000000');
  setField(window, form, 'observedOpportunity', 'متابعة استفسارات الحجوزات');
  setField(window, form, 'problem', 'تسرّب الحجوزات غير المكتملة');
  setField(window, form, 'salesAngle', 'تنظيم مسار المتابعة');
  setField(window, form, 'campaign', 'حملة الاختبار');
  setField(window, form, 'fitService', '100');
  setField(window, form, 'fitCommercial', '100');
  setField(window, form, 'fitOpportunity', '100');
  setField(window, form, 'fitMarket', '100');
  setField(window, form, 'fitAccess', '100');

  submit(window, form);

  const db = app.getDb();
  assert.equal(db.companies.length, 3, 'new company added once');
  const created = db.companies.find((c) => c.name === 'شركة اختبار جديدة');
  assert.ok(created);
  assert.equal(created.contact, 'محمد');
  assert.equal(created.campaign, 'حملة الاختبار');
  assert.equal(created.fitMode, 'components');
  assert.equal(created.fitScore, 100);
  assert.equal(created.stage, 'جديد');
  assert.equal(created.replyStatus, 'لم يتم التواصل');
  assert.equal(created.fitBreakdown.service, 100);
  assert.ok(created.activities.some((a) => a.type === 'إنشاء الشركة'));

  app.openCompanyForm(created.id);
  const editForm = document.getElementById('companyForm');
  setField(window, editForm, 'contact', 'محمد المعدل');
  setField(window, editForm, 'stage', 'مهتم');
  submit(window, editForm);

  const db2 = app.getDb();
  assert.equal(db2.companies.length, 3, 'editing must not duplicate');
  const edited = db2.companies.find((c) => c.id === created.id);
  assert.equal(edited.contact, 'محمد المعدل');
  assert.equal(edited.stage, 'مهتم');
  assert.equal(edited.stageHistory.length, 1, 'stage change recorded');
  assert.ok(edited.probability > 0);

  const stored = JSON.parse(window.localStorage.getItem('dr_crm_v1'));
  const storedCompany = stored.companies.find((c) => c.id === created.id);
  assert.ok(storedCompany, 'new fields persisted to local storage (and cloud payload)');
  assert.equal(storedCompany.fitBreakdown.opportunity, 100);

  assert.equal(ctx.errors.length, 0, ctx.errors.join(' | '));
  window.close();
});

test('two companies keep two independent sales plans', async () => {
  const ctx = await boot();
  const { document, window, app } = ctx;

  app.openPlanFor('legacy2');
  app.generatePlan();
  app.savePlan();
  const planBText = app.getDb().plans.legacy2.text;
  assert.ok(planBText.includes('وكالة نبض التسويق'));

  app.openPlanFor('legacy1');
  app.generatePlan();
  app.savePlan();
  assert.ok(app.getDb().plans.legacy1);

  document.getElementById('planCta').value = 'CTA معدل لشركة الواحة فقط';
  document.getElementById('planCta').dispatchEvent(new window.Event('input', { bubbles: true }));
  app.savePlan();

  const db = app.getDb();
  assert.equal(db.plans.legacy1.cta, 'CTA معدل لشركة الواحة فقط');
  assert.equal(db.plans.legacy2.text, planBText, 'editing one plan must not touch the other');
  assert.notEqual(db.plans.legacy1.text, db.plans.legacy2.text);
  assert.deepEqual(Array.from(db.plans.legacy1.followUp).map((f) => f.day), [0, 2, 5, 8, 14]);
  assert.ok(db.plans.legacy1.text.includes('11) خطة متابعة 14 يومًا'));

  assert.equal(ctx.errors.length, 0, ctx.errors.join(' | '));
  window.close();
});

test('profile opens with fit breakdown and records an activity and stage change', async () => {
  const ctx = await boot();
  const { document, window, app } = ctx;

  app.openProfile('legacy1');
  assert.ok(document.getElementById('profileDlg').hasAttribute('open'));
  assert.equal(document.getElementById('profileName').textContent, 'شركة الواحة للسفر');
  assert.ok(document.getElementById('profileFit').textContent.includes('/ 100'));
  assert.ok(document.getElementById('profileSummary').textContent.includes('السياحة والسفر'));
  assert.ok(document.getElementById('profileResearch').innerHTML.includes('الفرصة الملحوظة'));

  document.getElementById('activityNote').value = 'تم إرسال رسالة واتساب';
  document.getElementById('activityType').value = 'واتساب';
  document.getElementById('addActivity').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  let company = app.getDb().companies.find((c) => c.id === 'legacy1');
  assert.ok(company.activities.some((a) => a.note === 'تم إرسال رسالة واتساب'));

  document.getElementById('profileFollowUp').value = '2026-02-01';
  document.getElementById('profileMeetingDate').value = '2026-02-05';
  document.getElementById('profileLostReason').value = 'توقيت غير مناسب';
  document.getElementById('saveProfileMeta').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  company = app.getDb().companies.find((c) => c.id === 'legacy1');
  assert.equal(company.followUpDate, '2026-02-01');
  assert.equal(company.meetingDate, '2026-02-05');
  assert.equal(company.lostReason, 'توقيت غير مناسب');

  document.getElementById('closeProfile').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const select = document.querySelector('[data-stg="legacy1"]');
  assert.ok(select);
  select.value = 'عرض سعر';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  const moved = app.getDb().companies.find((c) => c.id === 'legacy1');
  assert.equal(moved.stage, 'عرض سعر');
  assert.ok(moved.stageHistory.length >= 1);
  assert.equal(moved.stageHistory[moved.stageHistory.length - 1].toStage, 'عرض سعر');

  assert.equal(ctx.errors.length, 0, ctx.errors.join(' | '));
  window.close();
});

test('dashboard shows insufficient data instead of misleading rates on empty test data', async () => {
  const ctx = await boot();
  const { document, window, app } = ctx;

  app.setDb({ companies: [], posts: [], plans: {}, campaigns: [], settings: {} });
  const conversions = document.getElementById('dashConversions').textContent;
  assert.ok(conversions.includes('بيانات غير كافية'));
  assert.ok(document.getElementById('dashCards').textContent.includes('0'));

  app.setDb({ companies: LEGACY.companies, posts: [], plans: {}, campaigns: [], settings: {} });
  assert.ok(document.getElementById('dashCards').textContent.includes('HOT'));

  assert.equal(ctx.errors.length, 0, ctx.errors.join(' | '));
  window.close();
});

test('existing records are never deleted by add/edit/plan/stage flows', async () => {
  const ctx = await boot();
  const { window, app, document } = ctx;

  const before = app.getDb();
  const ids = before.companies.map((c) => c.id).sort();
  const postIds = before.posts.map((p) => p.id).sort();

  app.openCompanyForm(null);
  const form = document.getElementById('companyForm');
  setField(window, form, 'name', 'شركة إضافية');
  submit(window, form);

  app.openPlanFor('legacy2');
  app.generatePlan();
  app.savePlan();

  const select = document.querySelector('[data-stg="legacy2"]');
  select.value = 'تم التواصل';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  const after = app.getDb();
  const afterIds = after.companies.map((c) => c.id);
  ids.forEach((id) => assert.ok(afterIds.includes(id), `legacy company ${id} preserved`));
  assert.deepEqual(after.posts.map((p) => p.id).sort(), postIds, 'posts preserved');
  assert.ok(after.plans.legacy1.text, 'legacy plan preserved');

  assert.equal(ctx.errors.length, 0, ctx.errors.join(' | '));
  window.close();
});
