'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../crm-core.js');

/* ------------------------------------------------------------------ *
 * 1. Legacy data compatibility
 * ------------------------------------------------------------------ */

test('legacy records load unchanged with safe defaults and unknown fields preserved', () => {
  const legacy = {
    companies: [{
      id: 'legacy1',
      name: 'شركة قديمة',
      stage: 'مهتم',
      phone: '0501234567',
      industry: 'سياحة',
      fitScore: 72,
      notes: 'بيانات قديمة',
      created: '2025-01-02',
      customField: 'keep-me'
    }],
    posts: [{ id: 'p1', title: 'منشور قديم' }],
    plans: { legacy1: { text: 'خطة قديمة' } },
    exoticTop: { a: 1 }
  };

  const db = C.normalizeDb(legacy);
  assert.equal(db.companies.length, 1);
  assert.equal(db.posts.length, 1);
  assert.equal(db.plans.legacy1.text, 'خطة قديمة');
  assert.deepEqual(db.exoticTop, { a: 1 }, 'unknown top-level keys must survive');

  const c = db.companies[0];
  assert.equal(c.id, 'legacy1');
  assert.equal(c.name, 'شركة قديمة');
  assert.equal(c.stage, 'مهتم');
  assert.equal(c.fitScore, 72);
  assert.equal(c.customField, 'keep-me', 'unknown company fields must survive');
  assert.equal(c.replyStatus, 'لم يتم التواصل');
  assert.equal(c.opportunityType, 'عميل محتمل');
  assert.deepEqual(c.activities, []);
  assert.deepEqual(c.stageHistory, []);
  assert.deepEqual(c.contacts, []);
  assert.deepEqual(c.researchSources, []);

  const fit = C.computeFit(c);
  assert.equal(fit.mode, 'legacy');
  assert.equal(fit.score, 72);
  assert.equal(fit.classification, 'WARM');
  assert.equal(fit.preliminary, true);
});

test('fitMode components never falls back to a stale legacy score', () => {
  const c = {
    fitScore: 95,
    fitMode: 'components',
    fitBreakdown: { service: 50, commercial: 50, opportunity: 50, market: 50, access: 50 }
  };
  const fit = C.computeFit(c);
  assert.equal(fit.mode, 'components');
  assert.equal(fit.score, 50);
  assert.equal(fit.classification, 'COLD');
});

/* ------------------------------------------------------------------ *
 * 2. Fit score components / classification / weights
 * ------------------------------------------------------------------ */

test('classification boundaries match the specification', () => {
  assert.equal(C.classify(100), 'HOT');
  assert.equal(C.classify(80), 'HOT');
  assert.equal(C.classify(79), 'WARM');
  assert.equal(C.classify(60), 'WARM');
  assert.equal(C.classify(59.9), 'COLD');
  assert.equal(C.classify(0), 'COLD');
  assert.equal(C.classify('x'), '');
});

test('all five components at 100 produce 100/HOT and are not preliminary', () => {
  const c = {
    name: 'شركة كاملة',
    sector: 'السياحة والسفر',
    country: 'السعودية',
    contact: 'أحمد',
    phone: '0500000000',
    observedOpportunity: 'متابعة الحجوزات',
    fitMode: 'components',
    fitBreakdown: { service: 100, commercial: 100, opportunity: 100, market: 100, access: 100 }
  };
  const fit = C.computeFit(c);
  assert.equal(fit.mode, 'components');
  assert.equal(fit.score, 100);
  assert.equal(fit.classification, 'HOT');
  assert.equal(fit.preliminary, false);
  assert.equal(fit.manualCount, 5);
  assert.equal(fit.missing.length, 0);
  assert.equal(fit.confidence, 'مرتفع');
  assert.equal(fit.components.length, 5);
});

test('missing data can never accidentally produce a high score', () => {
  const c = {
    name: 'شركة ناقصة',
    sector: 'السياحة والسفر',
    fitMode: 'components',
    fitBreakdown: { service: 100, commercial: 50 }
  };
  const fit = C.computeFit(c);
  assert.equal(fit.score, 40);
  assert.equal(fit.classification, 'COLD');
  assert.equal(fit.preliminary, true);
  assert.ok(fit.missing.includes('وجود فرصة أو مشكلة ملحوظة'));
  assert.ok(fit.notes.some((n) => n.includes('حقول ناقصة')));
});

test('editable weights change the weighted score but normalize to the entered total', () => {
  const weights = { service: 10, commercial: 10, opportunity: 10, market: 10, access: 10 };
  const nw = C.normalizeWeights(weights);
  assert.equal(nw.total, 50);
  const c = {
    fitMode: 'components',
    fitBreakdown: { service: 100, commercial: 100, opportunity: 100, market: 100, access: 100 }
  };
  assert.equal(C.computeFit(c, weights).score, 100);

  const zero = C.normalizeWeights({ service: 0, commercial: 0, opportunity: 0, market: 0, access: 0 });
  assert.deepEqual(zero.weights, C.DEFAULT_FIT_WEIGHTS);
  assert.equal(zero.total, 100);
});

test('social links alone do not grant a high fit score', () => {
  const c = {
    name: 'شركة سوشيال',
    facebook: 'https://facebook.com/x',
    instagram: 'https://instagram.com/x',
    linkedin: 'https://linkedin.com/company/x',
    fitMode: 'components'
  };
  const fit = C.computeFit(c);
  assert.ok(fit.score < 60);
  assert.equal(fit.classification, 'COLD');
  assert.ok(fit.notes.some((n) => n.includes('فرصة أو مشكلة')));
});

/* ------------------------------------------------------------------ *
 * 3. Sector playbooks and independent plans
 * ------------------------------------------------------------------ */

test('sector playbooks differ and marketing agencies default to partner', () => {
  assert.equal(C.sectorModel('وكالات التسويق').defaultType, 'شريك محتمل');
  assert.equal(C.sectorModel('السياحة والسفر').defaultType, 'عميل محتمل');
  assert.equal(C.sectorModel('العقارات والوسطاء العقاريون').defaultType, 'عميل محتمل');
  assert.ok(C.sectorModel('السياحة والسفر').angle.includes('الحجز'));
  assert.ok(C.sectorModel('العقارات والوسطاء العقاريون').angle.includes('المعاينة'));
  assert.ok(C.sectorModel('وكالات التسويق').angle.includes('شراكة'));

  const agency = C.normalizeCompany({ name: 'وكالة', industry: 'تسويق وإعلان' });
  assert.equal(agency.sector, 'وكالات التسويق');
  assert.equal(agency.opportunityType, 'شريك محتمل');
});

test('each company gets an independent plan with the 11 mandated sections and 14-day follow-up', () => {
  const a = { id: 'c1', name: 'شركة أ', sector: 'السياحة والسفر', country: 'السعودية', contact: 'خالد' };
  const b = { id: 'c2', name: 'وكالة ب', sector: 'وكالات التسويق', country: 'الإمارات', contact: 'سارة' };

  const pa = C.generateSalesPlan(a);
  const pb = C.generateSalesPlan(b);

  assert.equal(pa.companyId, 'c1');
  assert.equal(pb.companyId, 'c2');
  assert.notEqual(pa.openingMessage, pb.openingMessage);
  assert.equal(pb.opportunityType, 'شريك محتمل');
  assert.deepEqual(pa.followUp.map((f) => f.day), [0, 2, 5, 8, 14]);
  assert.deepEqual(pb.followUp.map((f) => f.day), [0, 2, 5, 8, 14]);

  const required = ['1)', '2)', '3)', '4)', '5)', '6)', '7)', '8)', '9)', '10)', '11)'];
  required.forEach((marker) => assert.ok(pa.text.includes(marker), `missing section ${marker}`));
  assert.ok(pa.text.includes('خطة متابعة 14 يومًا'));
  assert.ok(!/نضمن لك|نعدك بزيادة|نتائج مضمونة/.test(pa.text));

  const plans = { c1: pa, c2: pb };
  const snapshotB = JSON.stringify(plans.c2);
  plans.c1.cta = 'تعديل خطة الشركة الأولى فقط';
  assert.equal(JSON.stringify(plans.c2), snapshotB, 'editing one plan must not touch another');
  assert.notEqual(plans.c1.text, plans.c2.text);

  const normalized = C.normalizePlan(plans.c1);
  assert.equal(normalized.cta, 'تعديل خطة الشركة الأولى فقط');
  assert.equal(normalized.followUp.length, 5);
});

test('generated plans never invent revenue or employee facts', () => {
  const c = { id: 'x', name: 'شركة بلا بيانات', sector: 'أخرى' };
  const plan = C.generateSalesPlan(c);
  assert.ok(!plan.companySummary.includes('عدد الموظفين'));
  assert.ok(plan.whySelected.includes('لم تُسجل فرصة'));
  assert.ok(plan.disclaimer.includes('لا تتضمن وعودًا'));
});

/* ------------------------------------------------------------------ *
 * 4. Pipeline / stage changes
 * ------------------------------------------------------------------ */

test('stage changes are recorded with history, activity and probability', () => {
  const c = C.normalizeCompany({ id: 's1', name: 'مراحل', stage: 'جديد' });
  const changed = C.recordStageChange(c, 'مهتم', '2026-01-01T00:00:00.000Z');
  assert.equal(changed, true);
  assert.equal(c.stage, 'مهتم');
  assert.equal(c.stageHistory.length, 1);
  assert.equal(c.stageHistory[0].fromStage, 'جديد');
  assert.equal(c.stageHistory[0].toStage, 'مهتم');
  assert.equal(c.probability, 45);
  assert.ok(c.activities.some((a) => a.type === 'تغيير المرحلة'));

  assert.equal(C.recordStageChange(c, 'مهتم'), false, 'no duplicate history entry');

  C.recordStageChange(c, 'تم الإغلاق', '2026-02-01T00:00:00.000Z');
  assert.ok(c.closedAt);
  assert.equal(C.isOpenStage(c.stage), false);
  assert.equal(C.isClosedStage(c.stage), true);
});

/* ------------------------------------------------------------------ *
 * 5. CSV parsing / import rules
 * ------------------------------------------------------------------ */

test('Arabic and English CSV headers both map correctly', () => {
  const arabic = '\uFEFF' + [
    'الشركة,الرقم,المسؤول,القطاع,الدولة,درجة الملاءمة,ثقة تقييم الملاءمة,نوع الفرصة,حالة الرد,موعد المتابعة,الحملة,زاوية البيع,ملخص البحث,مصادر البحث',
    '"شركة, الكبير",0501111111,محمد,السياحة والسفر,السعودية,85,مرتفع,عميل محتمل,رد العميل,2026-03-01,حملة أ,متابعة الحجوزات,ملخص,مصدر | https://x.test'
  ].join('\r\n');

  const rows = C.parseCSV(arabic);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'شركة, الكبير', 'quoted comma must stay in one field');

  const map = C.mapCompanyHeaders(rows[0]);
  assert.equal(map.name, 0);
  assert.equal(map.phone, 1);
  assert.equal(map.sector, 3);
  assert.equal(map.country, 4);
  assert.equal(map.fitScore, 5);
  assert.equal(map.fitConfidence, 6);
  assert.equal(map.opportunityType, 7);
  assert.equal(map.replyStatus, 8);
  assert.equal(map.followUpDate, 9);
  assert.equal(map.campaign, 10);
  assert.equal(map.salesAngle, 11);
  assert.equal(map.researchSummary, 12);
  assert.equal(map.researchSource, 13);

  const plan = C.buildImportPlan(rows, []);
  assert.equal(plan.error, '');
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.items[0].data.name, 'شركة, الكبير');
  assert.equal(plan.items[0].data.fitScore, 85);
  assert.equal(plan.items[0].data.campaign, 'حملة أ');
  assert.equal(plan.items[0].data.followUpDate, '2026-03-01');

  const english = [
    'name,phone,sector,country,fit_score,fit_confidence,opportunity_type,reply_status,follow_up_date,campaign,research_summary,sales_angle',
    'Alpha Co,0502222222,Real Estate,UAE,70,Medium,عميل محتمل,مهتم,2026-04-01,Campaign B,summary,angle'
  ].join('\n');
  const enRows = C.parseCSV(english);
  const enMap = C.mapCompanyHeaders(enRows[0]);
  assert.equal(enMap.name, 0);
  assert.equal(enMap.fitScore, 4);
  assert.equal(enMap.campaign, 9);
  assert.equal(C.buildImportPlan(enRows, []).items[0].data.name, 'Alpha Co');
});

test('import never deletes, never overwrites non-empty values, and updates only blank fields', () => {
  const existing = C.normalizeCompany({
    id: 'e1',
    name: 'شركة النور',
    phone: '0501111111',
    contact: 'قديم',
    notes: '',
    sector: 'السياحة والسفر'
  });
  const db = { companies: [existing], posts: [], plans: {} };

  const csv = [
    'الشركة,الرقم,المسؤول,ملاحظات,القطاع',
    'شركة النور,0501111111,جديد,ملاحظة جديدة,تجارة إلكترونية'
  ].join('\n');
  const rows = C.parseCSV(csv);
  const plan = C.buildImportPlan(rows, db.companies);

  assert.equal(plan.counts.update, 1);
  assert.equal(plan.items[0].action, 'update');
  assert.equal(plan.items[0].changes.contact, undefined, 'non-empty value must not be overwritten');
  assert.equal(plan.items[0].changes.notes, 'ملاحظة جديدة');
  assert.equal(plan.items[0].changes.sector, undefined);
  assert.equal(db.companies.length, 1, 'analysis must not mutate data');

  const report = C.applyImport(db, plan, ['update']);
  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);
  assert.equal(db.companies.length, 1, 'no duplicate created');
  assert.equal(db.companies[0].id, 'e1');
  assert.equal(db.companies[0].contact, 'قديم');
  assert.equal(db.companies[0].notes, 'ملاحظة جديدة');
  assert.ok(db.companies[0].activities.some((a) => a.type === 'تحديث من استيراد'));
});

test('same name with different or missing phone is sent to review, not merged', () => {
  const companies = [
    C.normalizeCompany({ id: 'a', name: 'شركة الأفق', phone: '0501111111' }),
    C.normalizeCompany({ id: 'b', name: 'شركة الأفق', phone: '0509999999' })
  ];

  const diffPhone = C.parseCSV(['الشركة,الرقم', 'شركة الأفق,0502222222'].join('\n'));
  const p1 = C.buildImportPlan(diffPhone, companies);
  assert.equal(p1.counts.review, 1);
  assert.equal(p1.items[0].action, 'review');

  const noPhone = C.parseCSV(['الشركة,الرقم', 'شركة الأفق,'].join('\n'));
  const p2 = C.buildImportPlan(noPhone, companies);
  assert.equal(p2.counts.review, 1);
  assert.equal(p2.items[0].action, 'review');

  const db = { companies: companies.slice(), posts: [], plans: {} };
  const report = C.applyImport(db, p2, ['skip']);
  assert.equal(report.created, 0);
  assert.equal(db.companies.length, 2, 'review items default to skip — no silent merge');
});

test('similar names are treated as different entities unless name and phone match', () => {
  const companies = [C.normalizeCompany({ id: 'a', name: 'شركة النور', phone: '0501111111' })];
  const rows = C.parseCSV(['الشركة,الرقم', 'شركة النور الحديثة,0501111111'].join('\n'));
  const plan = C.buildImportPlan(rows, companies);
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.items[0].action, 'new');
});

test('duplicate rows inside the same file are flagged for review', () => {
  const rows = C.parseCSV([
    'الشركة,الرقم',
    'شركة مكررة,0503333333',
    'شركة مكررة,0503333333'
  ].join('\n'));
  const plan = C.buildImportPlan(rows, []);
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.counts.review, 1);
  assert.equal(plan.items[1].action, 'review');
  assert.ok(plan.items[1].reason.includes('مكرر داخل نفس الملف'));
});

test('duplicate rows matching an existing company update once and review the repeat', () => {
  const existing = C.normalizeCompany({ id: 'e1', name: 'شركة النور', phone: '0501111111', notes: '' });
  const rows = C.parseCSV([
    'الشركة,الرقم,ملاحظات',
    'شركة النور,0501111111,ملاحظة أولى',
    'شركة النور,0501111111,ملاحظة ثانية'
  ].join('\n'));
  const plan = C.buildImportPlan(rows, [existing]);
  assert.equal(plan.counts.update, 1);
  assert.equal(plan.counts.review, 1);
  assert.equal(plan.items[0].action, 'update');
  assert.equal(plan.items[1].action, 'review');
  assert.equal(plan.items[1].matchId, 'e1');
  assert.ok(plan.items[1].reason.includes('مكرر داخل نفس الملف'));

  const db = { companies: [existing], posts: [], plans: {} };
  const report = C.applyImport(db, plan, ['update', 'skip']);
  assert.equal(report.updated, 1);
  assert.equal(db.companies.length, 1);
  assert.equal(db.companies[0].notes, 'ملاحظة أولى', 'the repeated row never overwrites');
});

test('import requires a company name column and reports the problem', () => {
  const rows = C.parseCSV(['الرقم,المسؤول', '050,شخص'].join('\n'));
  const plan = C.buildImportPlan(rows, []);
  assert.ok(plan.error.includes('اسم الشركة'));
  assert.equal(plan.items.length, 0);
});

/* ------------------------------------------------------------------ *
 * 6. Dashboard metrics on isolated test data
 * ------------------------------------------------------------------ */

function makeCompany(overrides) {
  return C.normalizeCompany(Object.assign({
    id: C.uid(),
    name: 'شركة اختبار',
    createdAt: '2026-01-10T10:00:00.000Z',
    created: '2026-01-10',
    sector: 'السياحة والسفر',
    country: 'السعودية',
    source: 'انستجرام',
    stage: 'جديد',
    fitMode: 'components',
    fitBreakdown: { service: 100, commercial: 100, opportunity: 100, market: 100, access: 100 }
  }, overrides || {}));
}

test('dashboard metrics separate open/closed/lost and group value by currency', () => {
  const companies = [
    makeCompany({ id: 'a', stage: 'تم التواصل' }),
    makeCompany({ id: 'b', stage: 'مهتم', campaign: 'حملة أ', replyStatus: 'رد العميل' }),
    makeCompany({ id: 'c', stage: 'عرض سعر', value: 1000, currency: 'SAR' }),
    makeCompany({ id: 'd', stage: 'تم الإغلاق', value: 5000, currency: 'SAR', campaign: 'حملة أ' }),
    makeCompany({ id: 'e', stage: 'خسرنا', value: 2000, currency: 'SAR', campaign: 'حملة أ', activities: [{ type: 'مكالمة', note: 'تواصل' }] }),
    makeCompany({ id: 'f', stage: 'غير مناسب' }),
    makeCompany({ id: 'g', stage: 'جديد', value: 300, currency: 'AED' })
  ];

  const m = C.dashboardMetrics(companies, {});
  assert.equal(m.total, 7);
  assert.equal(m.classified.HOT, 7);

  assert.equal(m.funnel.contacted, 4, 'a,b,c,d contacted');
  assert.equal(m.funnel.interested, 3, 'b,c,d interested');
  assert.equal(m.funnel.quote, 2, 'c,d reached quote');
  assert.equal(m.funnel.won, 1);
  assert.equal(m.unknownFunnel, 2, 'old lost/not-suitable records without stage history are unknown');

  assert.equal(m.conversions.contactToInterest.numerator, 3);
  assert.equal(m.conversions.contactToInterest.denominator, 4);
  assert.equal(m.conversions.contactToInterest.rate, 75);
  assert.equal(m.conversions.interestToQuote.rate, 66.7);
  assert.equal(m.conversions.quoteToWon.rate, 50);
  assert.equal(m.conversions.winRate.numerator, 1);
  assert.equal(m.conversions.winRate.denominator, 2);
  assert.equal(m.conversions.winRate.rate, 50);

  assert.equal(m.openDeals, 4);
  assert.equal(m.wonDeals, 1);
  assert.equal(m.lostDeals, 1);
  assert.equal(m.notSuitable, 1);

  assert.deepEqual(m.openValue, { SAR: 1000, AED: 300 });
  assert.deepEqual(m.wonValue, { SAR: 5000 });
  assert.deepEqual(m.lostValue, { SAR: 2000 });
  assert.equal(m.openValueList.length, 2, 'currencies are never summed together');
  assert.ok(m.openValueList.some((x) => x.label === 'SAR 1,000'));
  assert.ok(m.openValueList.some((x) => x.label === 'AED 300'));

  const camp = m.campaigns.find((x) => x.name === 'حملة أ');
  assert.ok(camp);
  assert.equal(camp.total, 3);
  assert.equal(camp.contacted, 2, 'lost record with unknown history not counted as contacted');
  assert.equal(camp.replied, 1);
  assert.equal(camp.interested, 2);
  assert.equal(camp.quotes, 1);
  assert.equal(camp.won, 1);
  assert.equal(camp.lost, 1);
  assert.equal(camp.unknownFunnel, 1);
});

test('conversion rates with zero denominators report insufficient data', () => {
  const m = C.dashboardMetrics([], {});
  assert.equal(m.total, 0);
  assert.equal(m.conversions.contactToInterest.available, false);
  assert.equal(m.conversions.contactToInterest.rate, null);
  assert.equal(m.conversions.interestToQuote.available, false);
  assert.equal(m.conversions.winRate.available, false);

  const onlyNew = C.dashboardMetrics([makeCompany({ stage: 'جديد' })], {});
  assert.equal(onlyNew.conversions.contactToInterest.available, false);
  assert.equal(onlyNew.conversions.contactToInterest.denominator, 0);
});

test('date range filters by creation date and reports excluded undated records', () => {
  const companies = [
    makeCompany({ id: 'jan', createdAt: '2026-01-10T00:00:00.000Z', created: '2026-01-10' }),
    makeCompany({ id: 'feb', createdAt: '2026-02-10T00:00:00.000Z', created: '2026-02-10' }),
    makeCompany({ id: 'undated', createdAt: '', created: '' })
  ];
  const m = C.dashboardMetrics(companies, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(m.total, 1);
  assert.equal(m.excludedUndated, 2);
});

test('small samples are flagged rather than presented as stable rates', () => {
  const companies = [
    makeCompany({ stage: 'تم التواصل' }),
    makeCompany({ stage: 'مهتم' })
  ];
  const m = C.dashboardMetrics(companies, {});
  assert.equal(m.conversions.contactToInterest.available, true);
  assert.equal(m.conversions.contactToInterest.smallSample, true);
});

/* ------------------------------------------------------------------ *
 * 7. Follow-up buckets
 * ------------------------------------------------------------------ */

test('follow-up center buckets overdue, today, upcoming, never contacted, replies, forwarded and meetings', () => {
  const today = '2026-02-10';
  const companies = [
    makeCompany({ id: 'overdue', stage: 'تم التواصل', followUpDate: '2026-02-01' }),
    makeCompany({ id: 'today', stage: 'تم التواصل', followUpDate: '2026-02-10' }),
    makeCompany({ id: 'upcoming', stage: 'مهتم', followUpDate: '2026-02-20' }),
    makeCompany({ id: 'never', stage: 'جديد', replyStatus: 'لم يتم التواصل', activities: [] }),
    makeCompany({ id: 'replied', stage: 'رد العميل', replyStatus: 'رد العميل', followUpDate: '' }),
    makeCompany({ id: 'forwarded', stage: 'محوّل للإدارة', replyStatus: 'محوّل للإدارة' }),
    makeCompany({ id: 'meeting', stage: 'تم تحديد اجتماع', meetingDate: '2026-02-15' }),
    makeCompany({ id: 'closed', stage: 'تم الإغلاق', followUpDate: '2026-01-01' })
  ];

  const b = C.followupBuckets(companies, today);
  assert.deepEqual(b.overdue.map((c) => c.id), ['overdue'], 'closed deals never appear overdue');
  assert.deepEqual(b.dueToday.map((c) => c.id), ['today']);
  assert.deepEqual(b.upcoming.map((c) => c.id), ['upcoming']);
  assert.ok(b.neverContacted.some((c) => c.id === 'never'));
  assert.ok(b.repliedNotFollowed.some((c) => c.id === 'replied'));
  assert.ok(b.forwarded.some((c) => c.id === 'forwarded'));
  assert.ok(b.meetings.some((c) => c.id === 'meeting'));
  assert.ok(!b.overdue.some((c) => c.id === 'closed'));
});

/* ------------------------------------------------------------------ *
 * 8. Plan normalisation keeps data safe
 * ------------------------------------------------------------------ */

test('normalizePlan tolerates legacy and partial plan objects', () => {
  const p = C.normalizePlan({ text: 'قديمة', discoveryQuestions: 'س1\nس2', objections: ['اعتراض'] });
  assert.equal(p.version, 2);
  assert.deepEqual(p.discoveryQuestions, ['س1', 'س2']);
  assert.deepEqual(p.objections, [{ objection: 'اعتراض', response: '' }]);
  assert.deepEqual(p.followUp, []);
  assert.equal(p.text, 'قديمة');
});
