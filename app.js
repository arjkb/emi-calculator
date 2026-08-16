'use strict';

/* ==========================================================================
   PART 1 – CALCULATION ENGINE

   Pure functions, no DOM access. Everything here can be driven from the
   browser console for testing.

   All money is held as integer paise. Rates are given as an annual
   percentage and converted with the Indian lending convention: the monthly
   rate is the nominal annual rate divided by 12 (9% p.a. -> 0.75%/month),
   never the twelfth root of the effective rate.
   ========================================================================== */

var MAX_MONTHS = 1200; // 100 years; a runaway simulation trips this

function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

function toRupees(paise) {
  return paise / 100;
}

/**
 * Instalments are whole rupees. Rounding *up* rather than to nearest is
 * deliberate: rounding down leaves a residual of a few paise a month that
 * spills into a 241st instalment on a 240-month loan. Rounding up keeps the
 * loan inside its stated tenure and lets the final instalment come in
 * slightly light, which is how lenders present it.
 */
function roundToRupee(paise) {
  return Math.ceil(paise / 100 - 1e-6) * 100;
}

function monthlyRate(annualPercent) {
  return annualPercent / 12 / 100;
}

/**
 * The instalment that amortises `balance` over exactly `months` at `r`.
 * EMI = P.r.(1+r)^n / ((1+r)^n - 1)
 */
function emiFor(balance, r, months) {
  if (months <= 0 || balance <= 0) return 0;
  if (r === 0) return roundToRupee(balance / months);
  var factor = Math.pow(1 + r, months);
  return roundToRupee((balance * r * factor) / (factor - 1));
}

/**
 * How many instalments of `emi` clear `balance` at `r`.
 * n = -ln(1 - B.r/EMI) / ln(1+r)
 * Returns Infinity when the instalment never covers the interest.
 */
function monthsFor(balance, r, emi) {
  if (balance <= 0) return 0;
  if (emi <= 0) return Infinity;
  if (r === 0) return Math.ceil(balance / emi);
  if (emi <= balance * r) return Infinity;
  var n = -Math.log(1 - (balance * r) / emi) / Math.log(1 + r);
  return Math.ceil(n - 1e-9);
}

/**
 * Unroll scenario rules into a flat list of month-keyed events, so the
 * simulator never needs a notion of recurrence.
 *
 * Rule shapes (amounts in paise, like everything else in the engine):
 *   { kind: 'recurring', amount, everyK, startMonth, endType, endValue }
 *       endType: 'forever' | 'count' | 'until'
 *   { kind: 'oneoff', month, amount, mode }     mode: 'tenure' | 'emi'
 *   { kind: 'rate', month, rate, mode }         mode: 'keep' | 'recompute'
 *
 * Months are relative to the as-of point (1 = the first projected month);
 * `offset` shifts them onto the schedule's absolute month numbering.
 */
function expandRules(rules, offset, horizon) {
  offset = offset || 0;
  horizon = horizon || MAX_MONTHS;
  var events = [];

  rules.forEach(function (rule) {
    if (rule.kind === 'recurring') {
      var every = Math.max(1, Math.round(rule.everyK || 1));
      var month = Math.max(1, Math.round(rule.startMonth || 1));
      var fired = 0;
      while (month <= horizon) {
        if (rule.endType === 'count' && fired >= rule.endValue) break;
        if (rule.endType === 'until' && month > rule.endValue) break;
        events.push({
          month: month + offset,
          type: 'prepay',
          amount: rule.amount,
          // An "extra payment" that lowers the EMI defeats its own purpose,
          // so recurring extras are always tenure-reducing.
          mode: 'tenure',
          source: rule.id
        });
        month += every;
        fired += 1;
      }
    } else if (rule.kind === 'oneoff') {
      events.push({
        month: Math.max(1, Math.round(rule.month)) + offset,
        type: 'prepay',
        amount: rule.amount,
        mode: rule.mode || 'tenure',
        source: rule.id
      });
    } else if (rule.kind === 'rate') {
      events.push({
        month: Math.max(1, Math.round(rule.month)) + offset,
        type: 'rate',
        rate: rule.rate,
        mode: rule.mode || 'keep',
        source: rule.id
      });
    }
  });

  return events;
}

/**
 * The single simulation primitive. Takes a starting balance and an
 * instalment, so it serves every curve in the app: the original trajectory
 * runs from the sanctioned amount at startMonth 0, each scenario runs from
 * today's outstanding at startMonth k.
 *
 * Returns { rows, totalInterest, totalPaid, totalExtra, months, lastMonth,
 *           finalEmi, error }.
 */
function buildSchedule(opts) {
  var balance = opts.balance;
  var r = monthlyRate(opts.annualRate);
  var emi = opts.emi;
  var startMonth = opts.startMonth || 0;
  var events = opts.events || [];

  var byMonth = {};
  events.forEach(function (ev) {
    (byMonth[ev.month] = byMonth[ev.month] || []).push(ev);
  });

  var rows = [];
  var totalInterest = 0;
  var totalPaid = 0;
  var totalExtra = 0;
  var month = startMonth;

  if (balance <= 0) {
    return { rows: rows, totalInterest: 0, totalPaid: 0, totalExtra: 0,
             months: 0, lastMonth: startMonth, finalEmi: emi, error: null };
  }

  while (balance > 0) {
    if (rows.length >= MAX_MONTHS) {
      return { rows: rows, error: 'This loan does not close within 100 years. Check the EMI and rate.' };
    }
    month += 1;
    var due = byMonth[month] || [];

    // 1. Rate resets take effect at the start of the month.
    for (var i = 0; i < due.length; i++) {
      if (due[i].type !== 'rate') continue;
      var newR = monthlyRate(due[i].rate);
      if (due[i].mode === 'recompute') {
        // Keep the payoff date implied by the old rate; move the EMI instead.
        var remaining = monthsFor(balance, r, emi);
        if (remaining !== Infinity) emi = emiFor(balance, newR, remaining);
      }
      r = newR;
    }

    // 2. The instalment.
    var interest = Math.round(balance * r);
    if (emi <= interest) {
      return {
        rows: rows,
        error: 'An EMI of ' + formatINR(toRupees(emi)) + ' does not cover the ' +
               formatINR(toRupees(interest)) + ' of interest due in month ' + month +
               '. The balance would grow forever.'
      };
    }

    var opening = balance;
    var payoff = balance + interest;
    var paid, principal;
    if (emi >= payoff) {
      // Final instalment: it absorbs the residual rather than overpaying.
      paid = payoff;
      principal = balance;
    } else {
      paid = emi;
      principal = emi - interest;
    }
    balance -= principal;

    // 3. Prepayments land at the end of the month.
    var prepaid = 0;
    for (var j = 0; j < due.length; j++) {
      if (due[j].type !== 'prepay' || balance <= 0) continue;
      // The last occurrence of a recurring rule routinely overshoots; clamp
      // it to the payoff amount rather than treating it as an error.
      var amount = Math.min(due[j].amount, balance);
      if (amount <= 0) continue;
      var balanceBefore = balance;
      balance -= amount;
      prepaid += amount;
      if (due[j].mode === 'emi' && balance > 0) {
        // Hold the payoff date, lower the instalment.
        var keepMonths = monthsFor(balanceBefore, r, emi);
        if (keepMonths !== Infinity) emi = emiFor(balance, r, keepMonths);
      }
    }

    totalInterest += interest;
    totalPaid += paid + prepaid;
    totalExtra += prepaid;

    rows.push({
      month: month,
      openingBalance: opening,
      emi: paid,
      interest: interest,
      principal: principal,
      prepayment: prepaid,
      closingBalance: balance
    });
  }

  return {
    rows: rows,
    totalInterest: totalInterest,
    totalPaid: totalPaid,
    totalExtra: totalExtra,
    months: rows.length,
    lastMonth: month,
    finalEmi: emi,
    error: null
  };
}

/** Closing balance at absolute month k, for the scheduled-vs-actual gap. */
function balanceAtMonth(rows, k) {
  if (!rows.length) return 0;
  if (k < rows[0].month) return rows[0].openingBalance;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].month === k) return rows[i].closingBalance;
  }
  return 0; // past the payoff
}

/** Scenario measured against the do-nothing baseline. */
function compare(scenario, baseline) {
  var extra = scenario.totalExtra - baseline.totalExtra;
  var saved = baseline.totalInterest - scenario.totalInterest;
  return {
    monthsSaved: baseline.months - scenario.months,
    interestSaved: saved,
    extraPaid: extra,
    // What each extra rupee buys back in interest. Makes a 5k plan and a
    // 15k plan comparable instead of "more is obviously better".
    savedPerRupee: extra > 0 ? saved / extra : null
  };
}

/* ==========================================================================
   PART 2 – DOM LAYER
   ========================================================================== */

var rupeeFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0
});

function formatINR(rupees) {
  if (!isFinite(rupees)) return '–';
  return rupeeFormatter.format(rupees);
}

function formatPaise(paise) {
  return formatINR(toRupees(paise));
}

function formatMonths(n) {
  if (!isFinite(n)) return '–';
  var sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  var y = Math.floor(n / 12);
  var m = n % 12;
  if (y && m) return sign + y + 'y ' + m + 'm';
  if (y) return sign + y + 'y';
  return sign + m + 'm';
}

function $(id) {
  return document.getElementById(id);
}

function parseNum(value, fallback) {
  var n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

/* ---- rupee fields with live grouping ---------------------------------- */

// Amount fields are type="text" rather than type="number" so they can carry
// commas as you type: a number input rejects them outright, and rupee figures
// in lakhs are close to unreadable without the Indian 2-2-3 grouping.

var MAX_AMOUNT_DIGITS = 12;

function digitsOf(value) {
  return String(value).replace(/\D/g, '').slice(0, MAX_AMOUNT_DIGITS).replace(/^0+(?=\d)/, '');
}

/** '4200000' -> '42,00,000' */
function groupIndian(digits) {
  return digits === '' ? '' : Number(digits).toLocaleString('en-IN');
}

/** Value of an amount field in whole rupees; null when the field is empty. */
function parseAmount(value) {
  var digits = digitsOf(value);
  return digits === '' ? null : Number(digits);
}

/**
 * Regroup the field in place, keeping the caret against the same digit rather
 * than letting inserted commas push it around.
 */
function formatAmountField(el) {
  var caret = el.selectionStart;
  var digitsBeforeCaret = String(el.value).slice(0, caret).replace(/\D/g, '').length;
  var formatted = groupIndian(digitsOf(el.value));
  if (formatted === el.value) return;
  el.value = formatted;

  var pos = 0, seen = 0;
  while (pos < formatted.length && seen < digitsBeforeCaret) {
    if (/\d/.test(formatted.charAt(pos))) seen++;
    pos++;
  }
  try { el.setSelectionRange(pos, pos); } catch (e) { /* field not focused */ }
}

/* ---- state ---------------------------------------------------------- */

var nextId = 1;
function makeId() {
  return 'i' + nextId++;
}

var state = {
  original: {
    principal: 5000000,
    rate: 8.5,
    years: 20,
    months: 0,
    startDate: '2021-06-01',
    emiPaid: null // null = use the contractual EMI
  },
  current: {
    isFresh: false,
    asOfDate: todayISO(),
    outstanding: null, // blank = track the scheduled balance; see buildModel
    rate: 8.5,
    emi: null // null = carry the original EMI forward
  },
  // Loan-level, not scenario-level – see buildModel.
  rateChanges: [],
  scenarios: [
    { id: 'baseline', name: 'Do nothing', rules: [] }
  ],
  scheduleScenario: 'baseline',
  scheduleView: 'yearly'
};

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

/* ---- derived model --------------------------------------------------- */

function monthsBetween(fromISO, toISO) {
  var a = new Date(fromISO + 'T00:00:00');
  var b = new Date(toISO + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  var n = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return Math.max(0, n);
}

function monthLabel(startISO, monthNumber) {
  var d = new Date(startISO + 'T00:00:00');
  if (isNaN(d)) return 'Month ' + monthNumber;
  d.setMonth(d.getMonth() + monthNumber);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** The UI holds rule amounts in rupees; the engine wants paise. */
function rulesToPaise(rules) {
  return rules.map(function (rule) {
    if (rule.kind === 'rate') return rule;
    var copy = Object.assign({}, rule);
    copy.amount = toPaise(rule.amount);
    return copy;
  });
}

/**
 * Everything the renderers need, computed from state in one place.
 */
function buildModel() {
  var o = state.original;
  var c = state.current;

  var principal = toPaise(o.principal);
  var tenure = Math.round(o.years * 12 + o.months);
  var r = monthlyRate(o.rate);

  var contractualEmi = emiFor(principal, r, tenure);
  var paidEmi = o.emiPaid == null ? contractualEmi : toPaise(o.emiPaid);

  var contractual = buildSchedule({
    balance: principal, annualRate: o.rate, emi: contractualEmi, startMonth: 0
  });
  var original = buildSchedule({
    balance: principal, annualRate: o.rate, emi: paidEmi, startMonth: 0
  });

  var asOfMonth = c.isFresh ? 0 : monthsBetween(o.startDate, c.asOfDate);
  var scheduledBalance = original.error ? 0 : balanceAtMonth(original.rows, asOfMonth);

  // Left blank, the outstanding tracks the scheduled balance – so the page
  // opens on a loan that is exactly on schedule, and editing the sanctioned
  // amount moves it rather than stranding a figure from the old loan and
  // announcing that you are wildly behind.
  var outstandingIsAuto = !c.isFresh && c.outstanding == null;
  var outstanding = c.isFresh ? principal
                  : outstandingIsAuto ? scheduledBalance
                  : toPaise(c.outstanding);

  var currentRate = c.isFresh ? o.rate : c.rate;
  var currentEmi = c.emi == null ? paidEmi : toPaise(c.emi);
  var aheadBy = scheduledBalance - outstanding;

  // Rate resets belong to the loan, not to a payoff strategy: they happen
  // whatever you do. Applying them to every scenario keeps the comparison
  // like-for-like instead of relying on you to repeat the rule on each card.
  var rateEvents = expandRules(state.rateChanges.map(function (rc) {
    return { kind: 'rate', id: rc.id, month: rc.month, rate: rc.rate, mode: rc.mode };
  }), asOfMonth, MAX_MONTHS);

  var results = state.scenarios.map(function (sc) {
    var events = expandRules(rulesToPaise(sc.rules), asOfMonth, MAX_MONTHS).concat(rateEvents);
    var run = buildSchedule({
      balance: outstanding,
      annualRate: currentRate,
      emi: currentEmi,
      startMonth: asOfMonth,
      events: events
    });
    return { scenario: sc, run: run };
  });

  var baseline = results[0].run;
  results.forEach(function (res) {
    res.delta = res.run.error || baseline.error ? null : compare(res.run, baseline);
  });

  return {
    principal: principal,
    tenure: tenure,
    contractualEmi: contractualEmi,
    paidEmi: paidEmi,
    contractual: contractual,
    original: original,
    asOfMonth: asOfMonth,
    outstanding: outstanding,
    currentRate: currentRate,
    currentEmi: currentEmi,
    remainingAtCurrentEmi: monthsFor(outstanding, monthlyRate(currentRate), currentEmi),
    scheduledBalance: scheduledBalance,
    outstandingIsAuto: outstandingIsAuto,
    exceedsPrincipal: outstanding > principal,
    aheadBy: aheadBy,
    results: results,
    startDate: o.startDate
  };
}

/* ---- input panels ---------------------------------------------------- */

// Fields holding rupee amounts, which get live comma grouping.
var AMOUNT_FIELDS = ['orig-principal', 'orig-emi', 'cur-outstanding', 'cur-emi'];

// A number input sanitises anything that is not a valid floating-point number
// to the empty string – "5 ", " 5", "5." and "5a" all read back as "". Coercing
// that to 0 would silently recalculate the loan at 0% p.a. or a zero tenure, so
// a blank reading on these fields means "keep the last good value" instead.
// Amount fields are excluded: there, blank legitimately means "use the default".
var KEEP_ON_BLANK = ['orig-rate', 'orig-years', 'orig-months', 'cur-rate',
                     'orig-start', 'cur-date'];

function bindInputs() {
  var map = [
    ['orig-principal', function (v) { state.original.principal = parseAmount(v) || 0; }],
    ['orig-rate', function (v) { state.original.rate = parseNum(v, 0); }],
    ['orig-years', function (v) { state.original.years = parseNum(v, 0); }],
    ['orig-months', function (v) { state.original.months = parseNum(v, 0); }],
    ['orig-start', function (v) { state.original.startDate = v; }],
    ['orig-emi', function (v) { state.original.emiPaid = parseAmount(v); }],
    ['cur-date', function (v) { state.current.asOfDate = v; }],
    ['cur-outstanding', function (v) { state.current.outstanding = parseAmount(v); }],
    ['cur-rate', function (v) { state.current.rate = parseNum(v, 0); }],
    ['cur-emi', function (v) { state.current.emi = parseAmount(v); }]
  ];

  map.forEach(function (pair) {
    var el = $(pair[0]);
    var isAmount = AMOUNT_FIELDS.indexOf(pair[0]) !== -1;
    var keepOnBlank = KEEP_ON_BLANK.indexOf(pair[0]) !== -1;

    el.addEventListener('input', function () {
      if (isAmount) formatAmountField(el);
      if (keepOnBlank && el.value === '') return;
      pair[1](el.value);
      render();
    });

    // Leaving a field mid-edit shouldn't strand a blank box over a live value.
    if (keepOnBlank) {
      el.addEventListener('blur', function () {
        if (el.value === '') fillInputs();
      });
    }
  });

  $('is-fresh').addEventListener('change', function () {
    state.current.isFresh = this.checked;
    render();
  });

  $('schedule-scenario').addEventListener('change', function () {
    state.scheduleScenario = this.value;
    render();
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name="schedule-view"]'), function (el) {
    el.addEventListener('change', function () {
      state.scheduleView = this.value;
      render();
    });
  });

  $('add-scenario').addEventListener('click', function () {
    state.scenarios.push({
      id: makeId(),
      name: 'Scenario ' + state.scenarios.length,
      rules: [defaultRule('recurring')]
    });
    renderAll();
  });
}

function fillInputs() {
  var o = state.original, c = state.current;
  $('orig-principal').value = groupIndian(String(o.principal));
  $('orig-rate').value = o.rate;
  $('orig-years').value = o.years;
  $('orig-months').value = o.months;
  $('orig-start').value = o.startDate;
  $('orig-emi').value = o.emiPaid == null ? '' : groupIndian(String(o.emiPaid));
  $('cur-date').value = c.asOfDate;
  $('cur-outstanding').value = c.outstanding == null ? '' : groupIndian(String(c.outstanding));
  $('cur-rate').value = c.rate;
  $('cur-emi').value = c.emi == null ? '' : groupIndian(String(c.emi));
  $('is-fresh').checked = c.isFresh;
}

/* ---- scenario editor -------------------------------------------------- */

function defaultRateChange() {
  return { id: makeId(), month: 12, rate: state.current.rate + 0.5, mode: 'keep' };
}

function defaultRule(kind) {
  if (kind === 'oneoff') {
    return { id: makeId(), kind: 'oneoff', month: 1, amount: 100000, mode: 'tenure' };
  }
  return {
    id: makeId(), kind: 'recurring', amount: 5000, everyK: 1,
    startMonth: 1, endType: 'forever', endValue: 12
  };
}

function findScenario(id) {
  for (var i = 0; i < state.scenarios.length; i++) {
    if (state.scenarios[i].id === id) return state.scenarios[i];
  }
  return null;
}

function findRule(scenario, id) {
  for (var i = 0; i < scenario.rules.length; i++) {
    if (scenario.rules[i].id === id) return scenario.rules[i];
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function num(value, field, cls) {
  return '<input class="' + (cls || 'num') + '" type="number" data-field="' + field +
         '" value="' + escapeHtml(value) + '">';
}

/** Rupee input inside a rule row – text, so it can carry commas as you type. */
function money(value, field) {
  return '<input class="num wide money" type="text" inputmode="numeric" autocomplete="off"' +
         ' data-field="' + field + '" value="' + escapeHtml(groupIndian(String(value))) + '">';
}

function select(value, field, options) {
  var html = '<select data-field="' + field + '">';
  options.forEach(function (opt) {
    html += '<option value="' + opt[0] + '"' + (opt[0] === value ? ' selected' : '') +
            '>' + escapeHtml(opt[1]) + '</option>';
  });
  return html + '</select>';
}

function ruleHtml(rule, index) {
  var body = '';

  if (rule.kind === 'recurring') {
    body =
      'Pay an extra ' + money(rule.amount, 'amount') +
      ' every ' + num(rule.everyK, 'everyK') + ' month(s),' +
      ' starting month ' + num(rule.startMonth, 'startMonth') + ', ' +
      select(rule.endType, 'endType', [
        ['forever', 'until the loan closes'],
        ['count', 'for a number of payments'],
        ['until', 'until a given month']
      ]);
    if (rule.endType === 'count') {
      body += ' ' + num(rule.endValue, 'endValue') + ' payment(s)';
    } else if (rule.endType === 'until') {
      body += ' month ' + num(rule.endValue, 'endValue');
    }
  } else {
    body =
      'Prepay ' + money(rule.amount, 'amount') +
      ' in month ' + num(rule.month, 'month') + ', ' +
      select(rule.mode, 'mode', [
        ['tenure', 'shortening the tenure'],
        ['emi', 'lowering the EMI']
      ]);
  }

  return '<li class="rule" data-rid="' + rule.id + '">' +
    '<div class="rule-body">' + body + '</div>' +
    '<button class="icon" data-action="remove-rule" title="Remove this rule">&times;</button>' +
    '</li>';
}

function rateChangeHtml(rc) {
  return '<li class="rule" data-rid="' + rc.id + '">' +
    '<div class="rule-body">' +
      'Rate changes to ' + num(rc.rate, 'rate') + '% p.a. in month ' +
      num(rc.month, 'month') + ', ' +
      select(rc.mode, 'mode', [
        ['keep', 'keeping the EMI (tenure moves)'],
        ['recompute', 'recomputing the EMI (tenure holds)']
      ]) +
    '</div>' +
    '<button class="icon" data-action="remove-rate" title="Remove this rate change">&times;</button>' +
  '</li>';
}

function renderRateChanges(model) {
  $('rate-change-list').innerHTML = state.rateChanges.map(rateChangeHtml).join('');
  $('rate-change-note').textContent = state.rateChanges.length
    ? 'Applied to every scenario, so the comparison stays like-for-like.'
    : 'None. Add one to model a floating-rate reset – it applies to every scenario.';
}

function bindRateChanges() {
  var list = $('rate-change-list');

  $('add-rate-change').addEventListener('click', function () {
    state.rateChanges.push(defaultRateChange());
    renderAll();
  });

  list.addEventListener('click', function (ev) {
    var button = ev.target.closest('button[data-action="remove-rate"]');
    if (!button) return;
    var rid = button.closest('.rule').dataset.rid;
    state.rateChanges = state.rateChanges.filter(function (rc) { return rc.id !== rid; });
    renderAll();
  });

  var apply = function (el) {
    var field = el.dataset.field;
    if (!field) return false;
    var rid = el.closest('.rule').dataset.rid;
    var rc = state.rateChanges.filter(function (x) { return x.id === rid; })[0];
    if (!rc) return false;
    if (el.tagName !== 'SELECT' && el.value === '') return false; // see KEEP_ON_BLANK
    rc[field] = el.tagName === 'SELECT' ? el.value : parseNum(el.value, 0);
    return true;
  };

  // Neither field changes which controls are shown, so a results-only
  // re-render is enough and the field being edited keeps focus.
  list.addEventListener('input', function (ev) {
    if (apply(ev.target)) render();
  });
  list.addEventListener('change', function (ev) {
    if (ev.target.tagName === 'SELECT' && apply(ev.target)) render();
  });

  list.addEventListener('focusout', function (ev) {
    var el = ev.target;
    if (!el.dataset || !el.dataset.field || el.value !== '') return;
    var ruleEl = el.closest('.rule');
    if (!ruleEl) return;
    var rc = state.rateChanges.filter(function (x) { return x.id === ruleEl.dataset.rid; })[0];
    if (rc) restoreFieldValue(el, rc[el.dataset.field]);
  });
}

function scenarioHtml(sc, model, index) {
  var res = model.results[index];
  var isBaseline = sc.id === 'baseline';

  var summary;
  if (res.run.error) {
    summary = '<span class="bad">' + escapeHtml(res.run.error) + '</span>';
  } else {
    summary = 'Closes ' + monthLabel(model.startDate, res.run.lastMonth) +
              ' · ' + formatPaise(res.run.totalInterest) + ' interest from here';
    if (res.delta && res.delta.monthsSaved > 0) {
      summary += ' · <span class="good">' + formatMonths(res.delta.monthsSaved) + ' sooner</span>';
    }
  }

  var rules = sc.rules.length
    ? '<ul class="rules">' + sc.rules.map(ruleHtml).join('') + '</ul>'
    : '<p class="muted">No extra payments – the loan carrying on exactly as it is. ' +
      'Every other scenario is measured against this one.</p>';

  // The baseline defines what "saved" means, so it must not take extra
  // payments: adding one would silently re-baseline every other row. A rate
  // reset is not a choice you make, so it stays available here.
  var addRule = isBaseline ? '' : '<div class="add-rule">' +
    '<button data-action="add-recurring">+ Recurring extra</button>' +
    '<button data-action="add-oneoff">+ One-off prepayment</button>' +
  '</div>';

  return '<article class="scenario" data-sid="' + sc.id + '">' +
    '<header>' +
      '<span class="swatch" style="background:' + colorFor(index) + '"></span>' +
      (isBaseline
        ? '<strong>' + escapeHtml(sc.name) + '</strong>'
        : '<input class="scenario-name" data-field="name" value="' + escapeHtml(sc.name) + '">') +
      '<span class="spacer"></span>' +
      '<button data-action="duplicate">Duplicate</button>' +
      (isBaseline ? '' : '<button data-action="remove-scenario">Remove</button>') +
    '</header>' +
    '<p class="scenario-summary">' + summary + '</p>' +
    rules +
    addRule +
  '</article>';
}

function renderScenarios(model) {
  $('scenario-list').innerHTML = state.scenarios.map(function (sc, i) {
    return scenarioHtml(sc, model, i);
  }).join('');
}

function bindScenarioList() {
  var list = $('scenario-list');

  // Structural changes rebuild the list; value edits only re-render results,
  // so typing does not steal focus from the field being typed into.
  list.addEventListener('click', function (ev) {
    var button = ev.target.closest('button');
    if (!button) return;
    var action = button.dataset.action;
    if (!action) return;

    var scEl = button.closest('.scenario');
    var sc = findScenario(scEl.dataset.sid);
    if (!sc) return;

    var isBaseline = sc.id === 'baseline';
    if (action === 'add-recurring' && !isBaseline) sc.rules.push(defaultRule('recurring'));
    else if (action === 'add-oneoff' && !isBaseline) sc.rules.push(defaultRule('oneoff'));
    else if (action === 'remove-rule') {
      var rid = button.closest('.rule').dataset.rid;
      sc.rules = sc.rules.filter(function (r) { return r.id !== rid; });
    } else if (action === 'remove-scenario') {
      state.scenarios = state.scenarios.filter(function (s) { return s.id !== sc.id; });
      if (state.scheduleScenario === sc.id) state.scheduleScenario = 'baseline';
    } else if (action === 'duplicate') {
      var copy = {
        id: makeId(),
        name: sc.name === 'Do nothing' ? 'Scenario ' + state.scenarios.length : sc.name + ' (copy)',
        rules: sc.rules.map(function (r) {
          var clone = Object.assign({}, r);
          clone.id = makeId();
          return clone;
        })
      };
      if (!copy.rules.length) copy.rules.push(defaultRule('recurring'));
      state.scenarios.push(copy);
    }
    renderAll();
  });

  list.addEventListener('input', function (ev) {
    if (!applyFieldEdit(ev.target)) return;
    render();
  });

  // Selects change which inputs are relevant, so they need a rebuild.
  list.addEventListener('change', function (ev) {
    if (ev.target.tagName !== 'SELECT') return;
    if (!applyFieldEdit(ev.target)) return;
    renderAll();
  });

  list.addEventListener('focusout', function (ev) {
    var el = ev.target;
    if (!el.dataset || !el.dataset.field || el.value !== '') return;
    var scEl = el.closest('.scenario');
    var ruleEl = el.closest('.rule');
    if (!scEl || !ruleEl) return;
    var sc = findScenario(scEl.dataset.sid);
    var rule = sc && findRule(sc, ruleEl.dataset.rid);
    if (rule) restoreFieldValue(el, rule[el.dataset.field]);
  });
}

/** Put a live value back into a field the user left blank. */
function restoreFieldValue(el, value) {
  if (value == null) return;
  el.value = el.classList.contains('money') ? groupIndian(String(value)) : value;
}

function applyFieldEdit(el) {
  var field = el.dataset.field;
  if (!field) return false;
  var scEl = el.closest('.scenario');
  var sc = findScenario(scEl.dataset.sid);
  if (!sc) return false;

  if (field === 'name') {
    sc.name = el.value;
    return true;
  }

  var ruleEl = el.closest('.rule');
  if (!ruleEl) return false;
  var rule = findRule(sc, ruleEl.dataset.rid);
  if (!rule) return false;

  if (el.tagName === 'SELECT') {
    rule[field] = el.value;
  } else if (el.classList.contains('money')) {
    formatAmountField(el);
    rule[field] = parseAmount(el.value) || 0;
  } else {
    if (el.value === '') return false; // see KEEP_ON_BLANK
    rule[field] = parseNum(el.value, 0);
  }
  return true;
}

/* ---- summary panels --------------------------------------------------- */

function renderSummary(model) {
  var contractualClose = model.contractual.error
    ? '–' : monthLabel(model.startDate, model.contractual.lastMonth);

  var derived = 'Contractual EMI <strong>' + formatPaise(model.contractualEmi) + '</strong>' +
                ' – closes ' + contractualClose + '.';
  if (model.paidEmi > model.contractualEmi && !model.original.error) {
    derived += ' Paying ' + formatPaise(model.paidEmi) + ' instead closes it ' +
               monthLabel(model.startDate, model.original.lastMonth) + '.';
  }
  $('orig-derived').innerHTML = derived;
  if (state.original.emiPaid == null) {
    $('orig-emi').placeholder = groupIndian(String(toRupees(model.contractualEmi)));
  }

  $('panel-current').classList.toggle('disabled', state.current.isFresh);
  if (state.current.emi == null) {
    $('cur-emi').placeholder = groupIndian(String(toRupees(model.paidEmi)));
  }
  // The placeholder tracks the sanctioned amount, so changing the loan moves
  // the assumed outstanding with it.
  $('cur-outstanding').placeholder = groupIndian(String(Math.round(toRupees(model.scheduledBalance))));

  var remaining = model.remainingAtCurrentEmi;
  $('cur-derived').innerHTML = state.current.isFresh
    ? 'Projecting from disbursal.'
    : '<strong>' + model.asOfMonth + '</strong> EMIs paid so far. At ' +
      formatPaise(model.currentEmi) + ' a month this balance takes ' +
      '<strong>' + formatMonths(remaining) + '</strong> more to clear.';

  var headline = $('panel-headline');
  if (state.current.isFresh) {
    headline.hidden = true;
    return;
  }
  headline.hidden = false;
  var ahead = model.aheadBy;
  var scheduled = 'The original schedule put you at ' + formatPaise(model.scheduledBalance) +
                  ' after ' + model.asOfMonth + ' months.';

  if (model.outstandingIsAuto) {
    headline.className = 'panel headline';
    headline.innerHTML = '<p><strong>Assuming you are exactly on schedule.</strong> ' + scheduled +
      ' Enter your real outstanding balance above to see where you actually stand.</p>';
    return;
  }
  if (model.exceedsPrincipal) {
    headline.className = 'panel headline bad';
    headline.innerHTML = '<p><strong>That outstanding is more than the sanctioned amount.</strong> ' +
      'Check the figures – unless interest was capitalised during a moratorium, ' +
      'you cannot owe more than you borrowed.</p>';
    return;
  }
  if (Math.abs(ahead) < 100) {
    headline.className = 'panel headline';
    headline.innerHTML = '<p><strong>Exactly on schedule.</strong> ' + scheduled + '</p>';
  } else if (ahead > 0) {
    headline.className = 'panel headline good';
    headline.innerHTML = '<p><strong>' + formatPaise(ahead) + ' ahead of schedule.</strong> ' +
      scheduled + ' Past prepayments account for the difference.</p>';
  } else {
    headline.className = 'panel headline bad';
    headline.innerHTML = '<p><strong>' + formatPaise(-ahead) + ' behind schedule.</strong> ' +
      scheduled + '</p>';
  }
}

/* ---- comparison table -------------------------------------------------- */

function renderComparison(model) {
  var head = '<thead><tr>' +
    '<th>Scenario</th><th>Closes</th><th>Time saved</th>' +
    '<th>Interest from here</th><th>Interest saved</th>' +
    '<th title="Voluntary prepayments only, on top of the EMI">Front-loaded</th>' +
    '<th title="EMIs plus prepayments – everything that leaves your pocket from here">Total outlay</th>' +
    '<th title="Interest cancelled per rupee front-loaded">Saved per ₹1</th>' +
    '</tr></thead>';

  // Best value per column gets highlighted.
  var best = { interest: Infinity, outlay: Infinity, saved: -Infinity, ratio: -Infinity };
  model.results.forEach(function (res) {
    if (res.run.error || !res.delta) return;
    best.interest = Math.min(best.interest, res.run.totalInterest);
    best.outlay = Math.min(best.outlay, res.run.totalPaid);
    best.saved = Math.max(best.saved, res.delta.interestSaved);
    if (res.delta.savedPerRupee != null) {
      best.ratio = Math.max(best.ratio, res.delta.savedPerRupee);
    }
  });

  var body = model.results.map(function (res, i) {
    var name = '<td><span class="swatch" style="background:' + colorFor(i) + '"></span>' +
               escapeHtml(res.scenario.name) + '</td>';
    if (res.run.error) {
      return '<tr>' + name + '<td colspan="7" class="bad">' + escapeHtml(res.run.error) + '</td></tr>';
    }
    var d = res.delta || { monthsSaved: 0, interestSaved: 0, extraPaid: 0, savedPerRupee: null };
    var cell = function (value, isBest) {
      return '<td' + (isBest ? ' class="best"' : '') + '>' + value + '</td>';
    };
    return '<tr>' + name +
      '<td>' + monthLabel(model.startDate, res.run.lastMonth) + '</td>' +
      '<td>' + (d.monthsSaved ? formatMonths(d.monthsSaved) : '–') + '</td>' +
      cell(formatPaise(res.run.totalInterest), res.run.totalInterest === best.interest) +
      cell(d.interestSaved ? formatPaise(d.interestSaved) : '–',
           d.interestSaved > 0 && d.interestSaved === best.saved) +
      '<td>' + (d.extraPaid ? formatPaise(d.extraPaid) : '–') + '</td>' +
      cell(formatPaise(res.run.totalPaid), res.run.totalPaid === best.outlay) +
      cell(d.savedPerRupee == null ? '–' : '₹' + d.savedPerRupee.toFixed(2),
           d.savedPerRupee != null && d.savedPerRupee === best.ratio) +
    '</tr>';
  }).join('');

  $('comparison').innerHTML = head + '<tbody>' + body + '</tbody>';
}

/* ---- schedule table ---------------------------------------------------- */

function renderSchedulePicker(model) {
  var sel = $('schedule-scenario');
  sel.innerHTML = state.scenarios.map(function (sc) {
    return '<option value="' + sc.id + '"' +
           (sc.id === state.scheduleScenario ? ' selected' : '') + '>' +
           escapeHtml(sc.name) + '</option>';
  }).join('');
}

function renderSchedule(model) {
  var index = 0;
  for (var i = 0; i < state.scenarios.length; i++) {
    if (state.scenarios[i].id === state.scheduleScenario) index = i;
  }
  var res = model.results[index];
  var table = $('schedule');

  if (res.run.error) {
    table.innerHTML = '<tbody><tr><td class="bad">' + escapeHtml(res.run.error) + '</td></tr></tbody>';
    return;
  }

  var rows = state.scheduleView === 'monthly'
    ? res.run.rows.map(function (row) {
        return {
          label: monthLabel(model.startDate, row.month),
          month: row.month,
          opening: row.openingBalance,
          emi: row.emi,
          interest: row.interest,
          principal: row.principal,
          prepayment: row.prepayment,
          closing: row.closingBalance
        };
      })
    : aggregateByYear(res.run.rows, model.startDate);

  var head = '<thead><tr>' +
    '<th>' + (state.scheduleView === 'monthly' ? 'Month' : 'Year') + '</th>' +
    '<th>Opening</th><th>Paid</th><th>Interest</th><th>Principal</th>' +
    '<th>Extra</th><th>Closing</th><th>Original</th>' +
    '</tr></thead>';

  var body = rows.map(function (row) {
    var scheduled = model.original.error ? 0 : balanceAtMonth(model.original.rows, row.month);
    return '<tr>' +
      '<td>' + escapeHtml(row.label) + '</td>' +
      '<td>' + formatPaise(row.opening) + '</td>' +
      '<td>' + formatPaise(row.emi) + '</td>' +
      '<td>' + formatPaise(row.interest) + '</td>' +
      '<td>' + formatPaise(row.principal) + '</td>' +
      '<td>' + (row.prepayment ? formatPaise(row.prepayment) : '–') + '</td>' +
      '<td>' + formatPaise(row.closing) + '</td>' +
      '<td class="muted">' + formatPaise(scheduled) + '</td>' +
    '</tr>';
  }).join('');

  table.innerHTML = head + '<tbody>' + body + '</tbody>';
}

function aggregateByYear(rows, startISO) {
  var out = [];
  var bucket = null;
  rows.forEach(function (row) {
    var year = new Date(new Date(startISO + 'T00:00:00').setMonth(
      new Date(startISO + 'T00:00:00').getMonth() + row.month)).getFullYear();
    if (!bucket || bucket.year !== year) {
      bucket = {
        year: year, label: String(year), month: row.month,
        opening: row.openingBalance, emi: 0, interest: 0,
        principal: 0, prepayment: 0, closing: row.closingBalance
      };
      out.push(bucket);
    }
    bucket.emi += row.emi;
    bucket.interest += row.interest;
    bucket.principal += row.principal;
    bucket.prepayment += row.prepayment;
    bucket.closing = row.closingBalance;
    bucket.month = row.month;
  });
  return out;
}

/* ---- chart -------------------------------------------------------------- */

var PALETTE = [];

function readPalette() {
  var styles = getComputedStyle(document.documentElement);
  PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'].map(function (name) {
    return styles.getPropertyValue(name).trim();
  });
}

function colorFor(index) {
  if (!PALETTE.length) readPalette();
  return PALETTE[index % PALETTE.length];
}

function drawChart(model) {
  var canvas = $('chart');
  var ratio = window.devicePixelRatio || 1;
  var cssWidth = canvas.clientWidth;
  var cssHeight = 320;
  canvas.width = cssWidth * ratio;
  canvas.height = cssHeight * ratio;
  canvas.style.height = cssHeight + 'px';

  var ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  var styles = getComputedStyle(document.documentElement);
  var ink = styles.getPropertyValue('--ink').trim();
  var faint = styles.getPropertyValue('--line').trim();

  var pad = { top: 12, right: 12, bottom: 28, left: 68 };
  var w = cssWidth - pad.left - pad.right;
  var h = cssHeight - pad.top - pad.bottom;
  if (w <= 0) return;

  // Curves: the original trajectory plus one per scenario.
  var series = [];
  if (!model.original.error) {
    series.push({
      color: faint, dashed: true, label: 'Original',
      points: model.original.rows.map(function (r) {
        return [r.month, r.closingBalance];
      })
    });
  }
  model.results.forEach(function (res, i) {
    if (res.run.error) return;
    var points = [[model.asOfMonth, model.outstanding]];
    res.run.rows.forEach(function (r) { points.push([r.month, r.closingBalance]); });
    series.push({ color: colorFor(i), label: res.scenario.name, points: points });
  });
  if (!series.length) return;

  var maxMonth = 1, maxBalance = 1;
  series.forEach(function (s) {
    s.points.forEach(function (p) {
      if (p[0] > maxMonth) maxMonth = p[0];
      if (p[1] > maxBalance) maxBalance = p[1];
    });
  });

  var x = function (month) { return pad.left + (month / maxMonth) * w; };
  var y = function (balance) { return pad.top + h - (balance / maxBalance) * h; };

  // Axes and horizontal gridlines.
  ctx.strokeStyle = faint;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (var g = 0; g <= 4; g++) {
    var value = (maxBalance / 4) * g;
    var gy = Math.round(y(value)) + 0.5;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(pad.left + w, gy);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(compactINR(value), pad.left - 8, gy);
  }

  // Year ticks along the bottom.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  var yearStep = maxMonth > 180 ? 60 : maxMonth > 60 ? 24 : 12;
  for (var m = 0; m <= maxMonth; m += yearStep) {
    ctx.globalAlpha = 0.7;
    ctx.fillText(monthLabel(model.startDate, m), x(m), pad.top + h + 8);
    ctx.globalAlpha = 1;
  }

  // "You are here" marker.
  if (model.asOfMonth > 0) {
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(model.asOfMonth), pad.top);
    ctx.lineTo(x(model.asOfMonth), pad.top + h);
    ctx.stroke();
    ctx.restore();
  }

  // The curves themselves.
  series.forEach(function (s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.dashed ? 1.5 : 2;
    if (s.dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    s.points.forEach(function (p, i) {
      var px = x(p[0]), py = y(p[1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  });

  $('chart-legend').innerHTML = series.map(function (s) {
    return '<span class="legend-item"><span class="swatch' + (s.dashed ? ' dashed' : '') +
           '" style="background:' + s.color + '"></span>' + escapeHtml(s.label) + '</span>';
  }).join('');
}

/** Axis labels in lakhs and crores – full rupee figures are too wide. */
function compactINR(paise) {
  var rupees = toRupees(paise);
  if (rupees >= 10000000) return '₹' + (rupees / 10000000).toFixed(1) + 'Cr';
  if (rupees >= 100000) return '₹' + (rupees / 100000).toFixed(1) + 'L';
  if (rupees >= 1000) return '₹' + Math.round(rupees / 1000) + 'k';
  return '₹' + Math.round(rupees);
}

/* ---- render orchestration ----------------------------------------------- */

function render() {
  var model = buildModel();
  renderSummary(model);
  renderComparison(model);
  renderSchedulePicker(model);
  renderSchedule(model);
  drawChart(model);
  updateScenarioSummaries(model);
}

/** Full rebuild, including the scenario editor markup. */
function renderAll() {
  var model = buildModel();
  renderScenarios(model);
  renderRateChanges(model);
  renderSummary(model);
  renderComparison(model);
  renderSchedulePicker(model);
  renderSchedule(model);
  drawChart(model);
}

/** Refresh the one-line summary on each scenario card without rebuilding it. */
function updateScenarioSummaries(model) {
  var cards = $('scenario-list').querySelectorAll('.scenario');
  Array.prototype.forEach.call(cards, function (card, i) {
    var res = model.results[i];
    if (!res) return;
    var el = card.querySelector('.scenario-summary');
    if (!el) return;
    if (res.run.error) {
      el.innerHTML = '<span class="bad">' + escapeHtml(res.run.error) + '</span>';
      return;
    }
    var text = 'Closes ' + monthLabel(model.startDate, res.run.lastMonth) +
               ' · ' + formatPaise(res.run.totalInterest) + ' interest from here';
    if (res.delta && res.delta.monthsSaved > 0) {
      text += ' · <span class="good">' + formatMonths(res.delta.monthsSaved) + ' sooner</span>';
    }
    el.innerHTML = text;
  });
}

function init() {
  readPalette();
  fillInputs();
  bindInputs();
  bindScenarioList();
  bindRateChanges();

  // A worked example beats an empty comparison table on first load.
  state.scenarios.push({
    id: makeId(), name: '₹5,000 extra a month',
    rules: [{ id: makeId(), kind: 'recurring', amount: 5000, everyK: 1,
              startMonth: 1, endType: 'forever', endValue: 12 }]
  });
  state.scenarios.push({
    id: makeId(), name: '₹1L bonus every year',
    rules: [{ id: makeId(), kind: 'recurring', amount: 100000, everyK: 12,
              startMonth: 3, endType: 'forever', endValue: 12 }]
  });

  renderAll();

  // Some browsers restore form controls after DOMContentLoaded, which would
  // leave the visible fields disagreeing with state. Reassert state as the
  // source of truth once the page has fully loaded.
  window.addEventListener('load', function () {
    fillInputs();
    render();
  });

  window.addEventListener('resize', function () { drawChart(buildModel()); });
  var scheme = window.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', function () {
    readPalette();
    renderAll();
  });
}

document.addEventListener('DOMContentLoaded', init);

// Exposed for console testing.
window.emi = {
  emiFor: emiFor, monthsFor: monthsFor, expandRules: expandRules,
  buildSchedule: buildSchedule, balanceAtMonth: balanceAtMonth,
  compare: compare, toPaise: toPaise, toRupees: toRupees,
  buildModel: buildModel, state: state
};
