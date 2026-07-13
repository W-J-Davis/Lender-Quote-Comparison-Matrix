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
    key: 'omParser',
    label: 'OM Parser',
    icon: '📑',
    description: 'Extract key deal metrics and assumptions out of an offering memorandum.',
    table: null,
    href: null
  },
  {
    key: 'debtOM',
    label: 'Debt OM Drafting',
    icon: '📝',
    description: 'Draft a written offering memorandum to send to prospective lenders, section by section.',
    table: 'om_drafts',
    href: 'om-memo.html'
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
