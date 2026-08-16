# Loan payoff planner

A calculator for Indian home and car loans, using monthly reducing balance.
No frameworks, no build step, no dependencies. Three files and a browser.

> **Built with AI.** This project was written with a lot of help from AI coding
> tools. The maths has been checked, but do your own sums before acting on
> anything it tells you.

Most EMI calculators start a loan from day one and stop at "what is my EMI?".
This one starts from where your loan is today, and helps you work out what to
do next.

## What it does differently

**It starts from your outstanding balance, not the original loan amount.**
If you have made prepayments over the years, you probably cannot remember the
amounts and dates. But your bank tells you the outstanding. That one number is
enough. The app works out the rest and tells you where you stand:

> **₹1,81,849 ahead of schedule.** The original schedule put you at ₹43,81,849
> after 62 months. Past prepayments account for the difference.

*This example is ₹50,00,000 at 8.5% over 20 years, taken in June 2021, with
₹42,00,000 left today. The page loads with the outstanding blank, so it says
"exactly on schedule" until you type your own number.*

**It compares plans side by side.** Pay ₹5,000 extra each month? ₹1,00,000 a
year when the bonus arrives? Only for the next three years? Each is a scenario.
They appear as rows in one table and lines on one chart, all measured against a
fixed "Do nothing" baseline.

## Running it

Open `index.html` in a browser. That is all. There are no modules and no
network calls, so opening the file directly works.

To serve it instead:

```bash
python3 -m http.server 8770 --bind 127.0.0.1
```

## Using it

**Original loan.** Amount, rate, tenure and start date. The app works out the
contractual EMI. *EMI you actually paid* is a separate box, in case you rounded
₹43,392 up to ₹45,000 from the start.

**Where the loan is now.** Today's date and your outstanding balance. Leave the
balance blank and the app assumes you are exactly on schedule; the grey text in
the box shows that figure. Remaining tenure is worked out from the balance,
rate and EMI, so you never type it.

**Expected rate changes.** For floating-rate resets. These belong to the loan,
not to a scenario, so they apply to every plan at once. A rate change is not
something you choose, so putting it on one scenario only would make that
comparison unfair.

**Scenarios.** Each holds any number of repeating extra payments (₹X every K
months, ending when the loan closes, after M payments, or at a chosen month)
and one-off prepayments (which either shorten the tenure or lower the EMI).
Copy a scenario and change one number to compare ₹5k against ₹10k against ₹15k.
The baseline takes no extra payments, because it sets what "saved" means.

## Reading the table

Two columns are easy to misread.

**Front-loaded** counts only your extra payments, not your EMIs. This is money
paid *earlier*, not money paid *on top*. Every rupee of it is principal you
owed anyway.

**Total outlay** is everything you pay from here, EMIs included. It goes *down*
as front-loading goes up:

| Scenario | Front-loaded | Total outlay |
|---|---|---|
| Do nothing | – | ₹71,13,531 |
| ₹5,000 extra a month | ₹6,75,000 | ₹65,40,059 |
| ₹1L bonus every year | ₹10,00,000 | ₹62,34,089 |

That is not a trick. Both paths start at the same balance and end at zero, so
what you pay is the balance plus the interest. Only the interest changes. Put
in ₹6,75,000 early and you pay ₹5,73,472 less overall.

**Saved per ₹1** is the interest cancelled by each rupee you pay early. Use it
to rank plans against each other. It cannot tell you whether to prepay at all,
because that depends on what else you could do with the money, and the app
knows nothing about that. No figure here is adjusted for inflation or for
returns you might earn elsewhere.

Interest is counted **from today onwards**. What you have already paid cannot
be worked out from a balance alone, so it is left out rather than guessed.

## How it calculates

- The monthly rate is the yearly rate **divided by 12** (9% a year is
  0.75% a month), which is how Indian lenders do it.
- EMIs are whole rupees, **rounded up**, so the loan finishes within its stated
  tenure. The last instalment is smaller and clears whatever is left.
- Prepayments **shorten the tenure** by default. One-off prepayments can lower
  the EMI instead. Repeating extra payments always shorten the tenure.
- Rate changes **keep the EMI and move the tenure** by default, which is what
  lenders have done since 2019. Recalculating the EMI is the other option.
- Money is stored as whole paise. Over 240 to 360 rows, decimal drift would
  show up. Here every schedule ends at exactly zero.

## Files

| File | |
|---|---|
| `index.html` | Markup. Plain script tag, no modules. |
| `app.js` | Part 1 is the calculation engine. Part 2 is the interface. |
| `styles.css` | Hand-written. Stacks below 700px. Dark mode. |

## The engine

Part 1 of `app.js` never touches the page. It is available as `window.emi` so
you can use it from the browser console:

```js
emiFor(balancePaise, monthlyRate, months)   // the EMI formula
monthsFor(balancePaise, monthlyRate, emi)   // the reverse
expandRules(rules, offset, horizon)         // repeating rules to a flat list
buildSchedule({ balance, annualRate, emi, events, startMonth })
balanceAtMonth(rows, k)
compare(scenario, baseline)
```

`buildSchedule` does all the work. It takes a starting balance and an EMI, so
the same function draws every line on the chart. The original loan starts from
the sanctioned amount at month 0. Each scenario starts from today's balance at
month *k*. It steps through month by month, because the formula stops working
once prepayments are involved.

Try it in the console:

```js
const P = emi.toPaise(5000000);
const e = emi.emiFor(P, 8.5/12/100, 240);      // 4339200 paise, or ₹43,392
const s = emi.buildSchedule({ balance: P, annualRate: 8.5, emi: e, startMonth: 0 });
s.months;                                       // 240
s.rows[s.rows.length - 1].closingBalance;       // 0
```

Three things hold exactly, not roughly. Principal plus prepayments always adds
up to the starting balance, down to the paise. A repeating extra of ₹X a month
gives the same schedule as raising the EMI by ₹X. And across 300 random loans,
every one finishes in exactly its stated tenure.

If an EMI is too small to cover the interest, the app says so instead of
looping forever. Runs stop at 1200 months. A prepayment bigger than the balance
is cut down to what is left, since the last of a repeating series usually
overshoots.

## Not built yet

Flat rate comparison, APR including fees and GST, pre-EMI interest on
part-released loans, daily reducing balance, saving your scenarios between
visits, and the savings side (FD, RD, PPF, SIP).
