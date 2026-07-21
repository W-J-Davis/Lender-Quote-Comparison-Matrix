// ─────────────────────────────────────────────────────────────
// DATA LAYER — backed by Supabase (deals + lender_quotes tables).
// Function names/shapes match the earlier UX prototype on purpose,
// so index.html / deal.html didn't need to change much once this
// swapped from localStorage to a real database.
// ─────────────────────────────────────────────────────────────

// Registry of tools available on the platform. To add a new tool
// later: add an entry here, create its table in Supabase, and build
// its page. Dashboard cards and deal workspace cards read from this
// list automatically — nothing else has to change.
const TOOLS = [
  {
    key: 'lenderMatrix',
    label: 'Lender Quote Comparison',
    icon: '📋',
    description: 'Compare lender term sheets and email quotes side by side, all-in cost, and pick a winner.',
    table: 'lender_quotes',
    href: 'lender-matrix.html'
  },
  {
    key: 'rentRoll',
    label: 'Rent Roll Analyzer',
    icon: '🏢',
    description: 'Upload a rent roll and get occupancy, in-place rents, and lease rollover summarized.',
    table: 'rent_roll_units',
    href: 'rent-roll.html'
  },
  {
    key: 't12Analyzer',
    label: 'T-12 Analyzer',
    icon: '📈',
    description: 'Parse a trailing-twelve-month operating statement into income and expenses, and compute NOI, expense ratio, and analyst adjustments.',
    table: 't12_line_items',
    href: 't12-analyzer.html'
  }
];

function mapDealRow(d, toolCounts) {
  return {
    id: d.id,
    name: d.name,
    propertyType: d.property_type,
    loanAmount: d.loan_amount,
    status: d.status,
    date: d.created_at ? d.created_at.slice(0, 10) : null,
    selectedLenderQuoteId: d.selected_lender_quote_id || null,
    tools: Object.fromEntries(TOOLS.map(t => {
      const count = toolCounts && toolCounts[t.key] ? toolCounts[t.key][d.id] : null;
      return [t.key, count ? { count } : null];
    }))
  };
}

// Counts rows per deal_id for every tool that has a real table, so
// dashboard/workspace cards can show "4 quotes" / "not started".
async function loadToolCounts() {
  const counts = {};
  for (const t of TOOLS) {
    if (!t.table) continue;
    const { data, error } = await sb.from(t.table).select('deal_id');
    if (error) { console.error(`Could not read ${t.table}:`, error.message); continue; }
    counts[t.key] = {};
    data.forEach(row => { counts[t.key][row.deal_id] = (counts[t.key][row.deal_id] || 0) + 1; });
  }
  return counts;
}

async function loadDeals() {
  const { data, error } = await sb.from('deals').select('*').order('created_at', { ascending: false });
  if (error) { console.error('Could not load deals:', error.message); return []; }
  const toolCounts = await loadToolCounts();
  return data.map(d => mapDealRow(d, toolCounts));
}

async function getDeal(id) {
  const { data, error } = await sb.from('deals').select('*').eq('id', id).single();
  if (error || !data) return null;
  const toolCounts = await loadToolCounts();
  return mapDealRow(data, toolCounts);
}

async function createDeal({ name, propertyType, loanAmount, status }) {
  const { data, error } = await sb
    .from('deals')
    .insert({ name, property_type: propertyType, loan_amount: loanAmount, status: status || 'active' })
    .select()
    .single();
  if (error) { alert('Could not create deal: ' + error.message); throw error; }
  return mapDealRow(data, {});
}

function fmtMoney(n) {
  if (n == null) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toLocaleString();
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─────────────────────────────────────────────────────────────
// EXAMPLE DEAL — a fully-seeded, internally-consistent demo deal so
// someone can explore Rent Roll, T-12, and Lender Matrix without
// uploading anything. Idempotent: repeated clicks (even from two
// people at once) converge on the same single deal — see comment on
// loadOrCreateExampleDeal below.
// ─────────────────────────────────────────────────────────────

const EXAMPLE_DEAL_NAME = '🧪 Example Deal — Sunset Ridge Apartments';

// Same amortizing-payment / all-in-cost math as lender-matrix.html, reused
// here so seeded quotes' all_in values are computed exactly the way the
// app itself would compute them for identical inputs.
function exampleMonthlyPayment(principal, annualRate, amortYears) {
  const r = annualRate / 100 / 12;
  const n = amortYears * 12;
  if (r === 0) return principal / n;
  return principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}
function exampleRemainingBalance(principal, annualRate, amortYears, monthsPaid) {
  const r = annualRate / 100 / 12;
  const n = amortYears * 12;
  if (r === 0) return principal - (principal / n) * monthsPaid;
  const pmt = exampleMonthlyPayment(principal, annualRate, amortYears);
  return principal * Math.pow(1 + r, monthsPaid) - pmt * (Math.pow(1 + r, monthsPaid) - 1) / r;
}
function exampleNewtonIRR(cashFlows, guess = 0.005) {
  let rate = guess;
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + rate, t);
      dnpv -= t * cashFlows[t] / Math.pow(1 + rate, t + 1);
    }
    if (Math.abs(dnpv) < 1e-12) break;
    const newRate = rate - npv / dnpv;
    if (Math.abs(newRate - rate) < 1e-10) { rate = newRate; break; }
    rate = newRate;
  }
  return rate * 12 * 100;
}
function exampleCalcAllIn(rate, origFee, term, amount, amort, io) {
  if (rate != null && amount && term) {
    try {
      const fee = amount * ((origFee || 0) / 100);
      const netProceeds = amount - fee;
      const termMonths = term * 12;
      const ioMonths = Math.min((io || 0), termMonths);
      const actualAmort = amort || term;
      const monthlyIO = amount * (rate / 100 / 12);
      const amortPmt = exampleMonthlyPayment(amount, rate, actualAmort);
      const cfs = [netProceeds];
      for (let t = 1; t <= termMonths; t++) {
        const pmt = t <= ioMonths ? monthlyIO : amortPmt;
        if (t === termMonths) {
          const balloon = exampleRemainingBalance(amount, rate, actualAmort, termMonths - ioMonths);
          cfs.push(-(pmt + balloon));
        } else {
          cfs.push(-pmt);
        }
      }
      const irr = exampleNewtonIRR(cfs);
      if (isFinite(irr) && irr > 0 && irr < 30) return irr;
    } catch (e) {}
  }
  if (rate == null) return null;
  return rate + (term && term > 0 ? (origFee || 0) / term : 0);
}

// month/day are relative to whenever this runs, so lease dates always
// land in "the next 12 months" no matter when someone clicks the button.
function exampleIsoDate(monthsFromNow, dayOfMonth) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthsFromNow);
  d.setDate(dayOfMonth);
  return d.toISOString().slice(0, 10);
}
function exampleIsoDateMonthsBefore(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function buildExampleRentRollRows(dealId) {
  // unitType/sqft/currentRent/marketRent chosen so occupied-unit rents,
  // rolled up, tie out to the T-12 Gross Potential Rent / Loss to Lease
  // line items below. leaseEndOffset spreads rollover across 10 of the
  // next 12 months (2 leases each) instead of piling into one month.
  const units = [
    { unit: 'S-101', unitType: 'Studio', sqft: 550, tenant: 'M. Alvarez', status: 'Occupied', currentRent: 1140, marketRent: 1225, leaseEndOffset: 1, day: 12 },
    { unit: 'S-102', unitType: 'Studio', sqft: 550, tenant: 'J. Chen', status: 'Occupied', currentRent: 1155, marketRent: 1225, leaseEndOffset: 1, day: 26 },
    { unit: 'S-103', unitType: 'Studio', sqft: 550, tenant: 'R. Patel', status: 'Occupied', currentRent: 1125, marketRent: 1225, leaseEndOffset: 2, day: 9 },
    { unit: 'S-104', unitType: 'Studio', sqft: 550, tenant: 'K. Brooks', status: 'Occupied', currentRent: 1165, marketRent: 1225, leaseEndOffset: 2, day: 23 },
    { unit: 'S-105', unitType: 'Studio', sqft: 550, tenant: 'T. Nguyen', status: 'Occupied', currentRent: 1150, marketRent: 1225, leaseEndOffset: 3, day: 15 },
    { unit: 'S-106', unitType: 'Studio', sqft: 550, tenant: null, status: 'Vacant', currentRent: null, marketRent: 1225, leaseEndOffset: null, day: null },
    { unit: '1BR-201', unitType: '1BR/1BA', sqft: 700, tenant: 'A. Rivera', status: 'Occupied', currentRent: 1340, marketRent: 1425, leaseEndOffset: 3, day: 28 },
    { unit: '1BR-202', unitType: '1BR/1BA', sqft: 700, tenant: 'S. Okafor', status: 'Occupied', currentRent: 1360, marketRent: 1425, leaseEndOffset: 4, day: 6 },
    { unit: '1BR-203', unitType: '1BR/1BA', sqft: 700, tenant: 'D. Kim', status: 'Occupied', currentRent: 1320, marketRent: 1425, leaseEndOffset: 4, day: 19 },
    { unit: '1BR-204', unitType: '1BR/1BA', sqft: 700, tenant: 'L. Martinez', status: 'Occupied', currentRent: 1375, marketRent: 1425, leaseEndOffset: 5, day: 11 },
    { unit: '1BR-205', unitType: '1BR/1BA', sqft: 700, tenant: 'B. Wallace', status: 'Occupied', currentRent: 1350, marketRent: 1425, leaseEndOffset: 5, day: 24 },
    { unit: '1BR-206', unitType: '1BR/1BA', sqft: 700, tenant: 'C. Yoder', status: 'Occupied', currentRent: 1330, marketRent: 1425, leaseEndOffset: 6, day: 8 },
    { unit: '1BR-207', unitType: '1BR/1BA', sqft: 700, tenant: 'E. Fischer', status: 'Occupied', currentRent: 1365, marketRent: 1425, leaseEndOffset: 6, day: 21 },
    { unit: '1BR-208', unitType: '1BR/1BA', sqft: 700, tenant: 'P. Grant', status: 'Occupied', currentRent: 1345, marketRent: 1425, leaseEndOffset: 7, day: 14 },
    { unit: '1BR-209', unitType: '1BR/1BA', sqft: 700, tenant: 'N. Suarez', status: 'Occupied', currentRent: 1355, marketRent: 1425, leaseEndOffset: 7, day: 27 },
    { unit: '1BR-210', unitType: '1BR/1BA', sqft: 700, tenant: null, status: 'Vacant', currentRent: null, marketRent: 1425, leaseEndOffset: null, day: null },
    { unit: '2BR-301', unitType: '2BR/2BA', sqft: 950, tenant: 'H. Delgado', status: 'Occupied', currentRent: 1640, marketRent: 1750, leaseEndOffset: 8, day: 5 },
    { unit: '2BR-302', unitType: '2BR/2BA', sqft: 950, tenant: 'W. Foster', status: 'Occupied', currentRent: 1660, marketRent: 1750, leaseEndOffset: 8, day: 20 },
    { unit: '2BR-303', unitType: '2BR/2BA', sqft: 950, tenant: 'G. Osei', status: 'Occupied', currentRent: 1620, marketRent: 1750, leaseEndOffset: 9, day: 10 },
    { unit: '2BR-304', unitType: '2BR/2BA', sqft: 950, tenant: 'V. Petrova', status: 'Occupied', currentRent: 1675, marketRent: 1750, leaseEndOffset: 9, day: 25 },
    { unit: '2BR-305', unitType: '2BR/2BA', sqft: 950, tenant: 'I. Haddad', status: 'Occupied', currentRent: 1650, marketRent: 1750, leaseEndOffset: 10, day: 7 },
    { unit: '2BR-306', unitType: '2BR/2BA', sqft: 950, tenant: 'F. Delaney', status: 'Occupied', currentRent: 1630, marketRent: 1750, leaseEndOffset: 10, day: 22 },
    { unit: '2BR-307', unitType: '2BR/2BA', sqft: 950, tenant: 'Y. Tanaka', status: 'Occupied', currentRent: 1665, marketRent: 1750, leaseEndOffset: 11, day: 16 },
    { unit: '2BR-308', unitType: '2BR/2BA', sqft: 950, tenant: 'Q. Reyes', status: 'Notice', currentRent: 1645, marketRent: 1750, leaseEndOffset: 12, day: 3 }
  ];

  return units.map(u => {
    const leaseEnd = u.leaseEndOffset != null ? exampleIsoDate(u.leaseEndOffset, u.day) : null;
    const leaseStart = leaseEnd ? exampleIsoDateMonthsBefore(leaseEnd, 12) : null;
    return {
      deal_id: dealId, unit: u.unit, unit_type: u.unitType, sqft: u.sqft, tenant: u.tenant,
      lease_start: leaseStart, lease_end: leaseEnd,
      current_rent: u.currentRent, market_rent: u.marketRent, status: u.status
    };
  });
}

function buildExampleT12Rows(dealId) {
  // Ties to the rent roll above: GPR = sum(market_rent)*12 for all 24 units,
  // Vacancy Loss = market rent of the 2 vacant units, Loss to Lease = the
  // market-vs-current gap on the 22 leased units. Reported vs. adjusted
  // differ only on Insurance / Mgmt Fee / RE Taxes — a normal, modest
  // set of lender underwriting adjustments (net -$10,000 to NOI).
  const rows = [
    { category: 'Income', lineItem: 'Gross Potential Rent', reported: 427200, adjusted: 427200 },
    { category: 'Income', lineItem: 'Vacancy Loss', reported: -31800, adjusted: -31800 },
    { category: 'Income', lineItem: 'Concessions / Loss to Lease', reported: -22680, adjusted: -22680 },
    { category: 'Income', lineItem: 'Other Income (Laundry, Parking, Fees, RUBS)', reported: 13000, adjusted: 13000 },
    { category: 'Expense', lineItem: 'Payroll & Administrative', reported: 21600, adjusted: 21600 },
    { category: 'Expense', lineItem: 'Repairs & Maintenance', reported: 15600, adjusted: 15600 },
    { category: 'Expense', lineItem: 'Utilities - Electric', reported: 4320, adjusted: 4320 },
    { category: 'Expense', lineItem: 'Utilities - Gas', reported: 2880, adjusted: 2880 },
    { category: 'Expense', lineItem: 'Utilities - Water/Sewer/Trash', reported: 10800, adjusted: 10800 },
    { category: 'Expense', lineItem: 'Contract Services', reported: 7200, adjusted: 7200 },
    { category: 'Expense', lineItem: 'Marketing & Advertising', reported: 3600, adjusted: 3600 },
    { category: 'Expense', lineItem: 'General & Administrative', reported: 4800, adjusted: 4800 },
    { category: 'Expense', lineItem: 'Insurance', reported: 14500, adjusted: 16800, notes: 'Renewal quote reflects hard insurance market' },
    { category: 'Expense', lineItem: 'Property Management Fee', reported: 12000, adjusted: 15400, notes: 'Normalized to 4% market fee — seller was self-managing' },
    { category: 'Expense', lineItem: 'Real Estate Taxes', reported: 38900, adjusted: 43200, notes: 'Reassessed post-sale at purchase basis' },
    { category: 'Expense', lineItem: 'Reserves for Replacement', reported: 6000, adjusted: 6000 }
  ];
  return rows.map(r => ({
    deal_id: dealId, category: r.category, line_item: r.lineItem,
    reported_amount: r.reported, adjusted_amount: r.adjusted, notes: r.notes || null
  }));
}

function buildExampleLenderQuoteRows(dealId) {
  // NOI (adjusted) works out to $233,520/yr from the T-12 above. Amounts/LTVs
  // all imply roughly the same ~$3.89M value at different leverage points —
  // Heartland most conservative (best rate, lowest leverage) through Beacon
  // most aggressive (highest leverage/rate, shortest term, interest reserve).
  const quotes = [
    {
      name: 'Meridian Capital', type: 'Agency (Fannie/Freddie)', amount: 2725000, ltv: 70,
      rate: 5.85, rateType: 'Fixed', spread: null, term: 10, amort: 30, io: 12, dscr: 1.25,
      recourse: 'Non-Recourse', prepay: 'Yield Maintenance', ext: '2 × 1yr',
      origFee: 1.00, appFee: 10000, cash: 'Cash Trap / Springing', close: 55,
      reserves: 'Tax & Insurance, Replacement Reserve', conditions: 'PCA & Phase I required · min DSCR 1.25x',
      notes: 'Best all-in pricing; longest amortization'
    },
    {
      name: 'First Sterling Bank', type: 'Bank', amount: 2600000, ltv: 67,
      rate: 6.35, rateType: 'Fixed', spread: null, term: 5, amort: 25, io: 0, dscr: 1.20,
      recourse: 'Recourse', prepay: 'Step-Down (5-4-3-2-1)', ext: '1 × 1yr',
      origFee: 0.75, appFee: 5000, cash: 'Soft Lockbox', close: 35,
      reserves: 'Tax & Insurance', conditions: 'Personal guaranty from sponsor required',
      notes: 'Fastest close; relationship pricing'
    },
    {
      name: 'Beacon Bridge Debt Fund', type: 'Debt Fund', amount: 2800000, ltv: 72,
      rate: 6.95, rateType: 'Floating', spread: 'SOFR + 275', term: 3, amort: 30, io: 24, dscr: 1.15,
      recourse: 'Non-Recourse', prepay: 'Open', ext: '2 × 1yr',
      origFee: 1.50, appFee: 15000, cash: 'Hard Lockbox', close: 25,
      reserves: 'Interest Reserve, Replacement Reserve', conditions: 'Rate cap required (strike 6.00%)',
      notes: 'Highest leverage; bridge-style flexibility for lease-up'
    },
    {
      name: 'Heartland Life Insurance Co.', type: 'Life Company', amount: 2530000, ltv: 65,
      rate: 5.70, rateType: 'Fixed', spread: null, term: 10, amort: 30, io: 0, dscr: 1.35,
      recourse: 'Non-Recourse', prepay: 'Defeasance', ext: '',
      origFee: 0.50, appFee: 7500, cash: 'None', close: 60,
      reserves: 'Replacement Reserve', conditions: 'Min 1.35x DSCR · no cash-out',
      notes: 'Lowest rate; most conservative leverage'
    }
  ];

  return quotes.map(q => ({
    deal_id: dealId, name: q.name, type: q.type, amount: q.amount, ltv: q.ltv, rate: q.rate,
    rate_type: q.rateType, spread: q.spread, term: q.term, amort: q.amort, io: q.io,
    dscr: q.dscr, recourse: q.recourse, prepay: q.prepay, ext: q.ext,
    orig_fee: q.origFee, app_fee: q.appFee,
    all_in: exampleCalcAllIn(q.rate, q.origFee, q.term, q.amount, q.amort, q.io),
    cash: q.cash, close: q.close, reserves: q.reserves, conditions: q.conditions, notes: q.notes,
    extra_terms: null
  }));
}

async function seedExampleDeal() {
  const deal = await createDeal({
    name: EXAMPLE_DEAL_NAME,
    propertyType: 'Garden-Style Multifamily',
    loanAmount: 2700000,
    status: 'active'
  });

  const [rr, t12, lq] = await Promise.all([
    sb.from('rent_roll_units').insert(buildExampleRentRollRows(deal.id)),
    sb.from('t12_line_items').insert(buildExampleT12Rows(deal.id)),
    sb.from('lender_quotes').insert(buildExampleLenderQuoteRows(deal.id))
  ]);
  if (rr.error) console.error('Could not seed rent roll for example deal:', rr.error.message);
  if (t12.error) console.error('Could not seed T-12 for example deal:', t12.error.message);
  if (lq.error) console.error('Could not seed lender quotes for example deal:', lq.error.message);

  return deal.id;
}

// Idempotent: looks for an existing deal with the exact example-deal name
// first. Two people clicking "Load Example Deal" at nearly the same moment
// can still both pass the initial check and each insert a deal — there's
// no unique constraint on deals.name to prevent that at the DB level — but
// both then re-resolve to whichever one has the earliest created_at, so
// everyone converges on the same single deal going forward. A rare double
// click just leaves one harmless, fully-seeded, never-linked-to duplicate.
async function loadOrCreateExampleDeal() {
  const { data: existing, error: selErr } = await sb
    .from('deals').select('id').eq('name', EXAMPLE_DEAL_NAME).order('created_at', { ascending: true }).limit(1);
  if (selErr) { alert('Could not check for example deal: ' + selErr.message); throw selErr; }
  if (existing && existing.length) return existing[0].id;

  const newId = await seedExampleDeal();

  const { data: afterInsert } = await sb
    .from('deals').select('id').eq('name', EXAMPLE_DEAL_NAME).order('created_at', { ascending: true }).limit(1);
  return (afterInsert && afterInsert.length) ? afterInsert[0].id : newId;
}
