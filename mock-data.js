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

// Deterministic pseudo-random in [-1, 1], seeded by an integer — used for
// per-unit rent variance so a 180-unit rent roll doesn't look robotic,
// without pulling in a real RNG dependency or hand-authoring 180 rows.
function examplePseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const EXAMPLE_FIRST_NAMES = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Barbara', 'Richard', 'Jennifer', 'Joseph', 'Susan', 'Thomas', 'Jessica', 'Charles', 'Sarah', 'Daniel', 'Karen', 'Matthew', 'Nancy', 'Anthony', 'Lisa', 'Mark', 'Betty', 'Steven', 'Sandra', 'Andrew', 'Ashley', 'Kenneth', 'Emily', 'Paul', 'Kimberly', 'Joshua', 'Donna', 'Kevin', 'Michelle', 'Brian', 'Carol', 'George', 'Amanda', 'Edward', 'Dorothy', 'Ronald', 'Melissa', 'Timothy', 'Deborah', 'Jason', 'Stephanie', 'Jeffrey', 'Rebecca'];
const EXAMPLE_LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores'];

function exampleTenantName(seq) {
  const first = EXAMPLE_FIRST_NAMES[seq % EXAMPLE_FIRST_NAMES.length];
  const last = EXAMPLE_LAST_NAMES[(seq * 7 + 3) % EXAMPLE_LAST_NAMES.length];
  return `${first} ${last[0]}.`;
}

// 180 units across 4 unit types, ~92-93% occupancy (11 vacant, 2 on notice),
// sized so GPR/loss-to-lease roll up to the T-12 lines below and NOI lands
// around a ~$29.5M implied value at 65-75% LTV — see buildExampleLenderQuoteRows.
const EXAMPLE_UNIT_TYPES = [
  { key: 'S', unitType: 'Studio', sqft: 550, count: 25, marketRent: 1150 },
  { key: '1BR', unitType: '1BR/1BA', sqft: 700, count: 80, marketRent: 1350 },
  { key: '2BR', unitType: '2BR/2BA', sqft: 950, count: 60, marketRent: 1650 },
  { key: '3BR', unitType: '3BR/2BA', sqft: 1150, count: 15, marketRent: 1950 }
];
const EXAMPLE_VACANT_COUNT = 11;
const EXAMPLE_NOTICE_COUNT = 2;

function buildExampleUnits() {
  let seq = 0;
  const units = [];
  EXAMPLE_UNIT_TYPES.forEach((t, typeIdx) => {
    for (let i = 0; i < t.count; i++) {
      seq++;
      const unitNum = 100 * (typeIdx + 1) + i + 1;
      const rentNoise = Math.round(examplePseudoRandom(seq) * 30 / 5) * 5; // +/- $30, rounded to $5
      const lossToLeaseBase = Math.round(t.marketRent * 0.055 / 5) * 5; // ~5.5% loss to lease
      units.push({
        seq, unit: `${t.key}-${unitNum}`, unitType: t.unitType, sqft: t.sqft,
        marketRent: t.marketRent, currentRent: t.marketRent - lossToLeaseBase + rentNoise, status: 'Occupied'
      });
    }
  });

  // Spread vacant/notice units evenly across the whole roll (not clustered
  // in one unit type) by picking evenly-spaced indices into the flat list.
  const total = units.length;
  const step = Math.floor(total / (EXAMPLE_VACANT_COUNT + EXAMPLE_NOTICE_COUNT));
  for (let k = 0; k < EXAMPLE_VACANT_COUNT + EXAMPLE_NOTICE_COUNT; k++) {
    const idx = (k * step + 5) % total;
    units[idx].status = k < EXAMPLE_VACANT_COUNT ? 'Vacant' : 'Notice';
  }

  // Lease-end dates spread evenly across the next 12 months for every
  // leased unit (occupied + notice — both still have a rent roll lease),
  // so the Lease Rollover chart shows a distribution, not a spike.
  let leaseSeq = 0;
  units.forEach(u => {
    if (u.status === 'Vacant') { u.tenant = null; u.currentRent = null; return; }
    u.tenant = exampleTenantName(u.seq);
    u.leaseEndOffset = (leaseSeq % 12) + 1;
    u.day = 3 + ((leaseSeq * 5) % 25);
    leaseSeq++;
  });
  return units;
}

function buildExampleRentRollRows(dealId) {
  return buildExampleUnits().map(u => {
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
  // Ties to the rent roll above: GPR = sum(market_rent)*12 for all 180 units
  // ($3,180,000), Vacancy Loss = market rent of the 11 vacant units
  // ($184,200), Loss to Lease = the market-vs-current gap on the 169 leased
  // units ($164,580). EGI $2,928,420, adjusted NOI $1,798,020. Reported vs.
  // adjusted differ only on Insurance / Mgmt Fee / RE Taxes — a normal,
  // modest set of lender underwriting adjustments (net -$77,000 to NOI).
  const rows = [
    { category: 'Income', lineItem: 'Gross Potential Rent', reported: 3180000, adjusted: 3180000 },
    { category: 'Income', lineItem: 'Vacancy Loss', reported: -184200, adjusted: -184200 },
    { category: 'Income', lineItem: 'Concessions / Loss to Lease', reported: -164580, adjusted: -164580 },
    { category: 'Income', lineItem: 'Other Income (Laundry, Parking, Fees, RUBS)', reported: 97200, adjusted: 97200 },
    { category: 'Expense', lineItem: 'Payroll & Administrative', reported: 171000, adjusted: 171000 },
    { category: 'Expense', lineItem: 'Repairs & Maintenance', reported: 126000, adjusted: 126000 },
    { category: 'Expense', lineItem: 'Utilities - Electric', reported: 30600, adjusted: 30600 },
    { category: 'Expense', lineItem: 'Utilities - Gas', reported: 19800, adjusted: 19800 },
    { category: 'Expense', lineItem: 'Utilities - Water/Sewer/Trash', reported: 77400, adjusted: 77400 },
    { category: 'Expense', lineItem: 'Contract Services', reported: 50400, adjusted: 50400 },
    { category: 'Expense', lineItem: 'Marketing & Advertising', reported: 25200, adjusted: 25200 },
    { category: 'Expense', lineItem: 'General & Administrative', reported: 34200, adjusted: 34200 },
    { category: 'Expense', lineItem: 'Insurance', reported: 108000, adjusted: 126000, notes: 'Renewal quote reflects hard insurance market' },
    { category: 'Expense', lineItem: 'Property Management Fee', reported: 90000, adjusted: 117000, notes: 'Normalized to 4% market fee — seller was self-managing' },
    { category: 'Expense', lineItem: 'Real Estate Taxes', reported: 274000, adjusted: 306000, notes: 'Reassessed post-sale at purchase basis' },
    { category: 'Expense', lineItem: 'Reserves for Replacement', reported: 46800, adjusted: 46800 }
  ];
  return rows.map(r => ({
    deal_id: dealId, category: r.category, line_item: r.lineItem,
    reported_amount: r.reported, adjusted_amount: r.adjusted, notes: r.notes || null
  }));
}

function buildExampleLenderQuoteRows(dealId) {
  // NOI (adjusted) works out to $1,798,020/yr from the T-12 above. Amounts/
  // LTVs all imply roughly the same ~$29.5M value at different leverage
  // points across the 65-75% LTV band — Heartland most conservative (best
  // rate/all-in, lowest leverage, highest DSCR) through Beacon most
  // aggressive (highest leverage/rate, shortest term, interest reserve).
  const quotes = [
    {
      name: 'Heartland Life Insurance Co.', type: 'Life Company', amount: 19200000, ltv: 65,
      rate: 5.65, rateType: 'Fixed', spread: null, term: 10, amort: 30, io: 0, dscr: 1.35,
      recourse: 'Non-Recourse', prepay: 'Defeasance', ext: '',
      origFee: 0.50, appFee: 15000, cash: 'None', close: 65,
      reserves: 'Replacement Reserve', conditions: 'Min 1.35x DSCR · no cash-out',
      notes: 'Lowest rate and all-in cost; most conservative leverage and DSCR cushion'
    },
    {
      name: 'First Sterling Bank', type: 'Bank', amount: 20000000, ltv: 68,
      rate: 6.25, rateType: 'Fixed', spread: null, term: 5, amort: 25, io: 0, dscr: 1.20,
      recourse: 'Recourse', prepay: 'Step-Down (5-4-3-2-1)', ext: '1 × 1yr',
      origFee: 0.75, appFee: 10000, cash: 'Soft Lockbox', close: 40,
      reserves: 'Tax & Insurance', conditions: 'Personal guaranty from sponsor required',
      notes: 'Fastest close; relationship pricing; recourse required'
    },
    {
      name: 'Meridian Capital', type: 'Agency (Fannie/Freddie)', amount: 20650000, ltv: 70,
      rate: 5.85, rateType: 'Fixed', spread: null, term: 10, amort: 30, io: 12, dscr: 1.25,
      recourse: 'Non-Recourse', prepay: 'Yield Maintenance', ext: '2 × 1yr',
      origFee: 1.00, appFee: 20000, cash: 'Cash Trap / Springing', close: 60,
      reserves: 'Tax & Insurance, Replacement Reserve', conditions: 'PCA & Phase I required · min DSCR 1.25x',
      notes: 'Agency execution with 12-month interest-only; non-recourse'
    },
    {
      name: 'Beacon Bridge Debt Fund', type: 'Debt Fund', amount: 22100000, ltv: 75,
      rate: 6.85, rateType: 'Floating', spread: 'SOFR + 265', term: 3, amort: 30, io: 24, dscr: 1.15,
      recourse: 'Non-Recourse', prepay: 'Open', ext: '2 × 1yr',
      origFee: 1.50, appFee: 25000, cash: 'Hard Lockbox', close: 30,
      reserves: 'Interest Reserve, Replacement Reserve', conditions: 'Rate cap required (strike 7.00%)',
      notes: 'Highest leverage; floating-rate bridge execution for lease-up; interest reserve required'
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
    loanAmount: 20000000,
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
