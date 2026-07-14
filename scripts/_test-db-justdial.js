import { query, isDbConfigured } from '../src/db/client.js';

if (!isDbConfigured()) {
  console.log('DB not configured');
  process.exit(0);
}

// Check if JUSTDIAL and NAUKRI exist in DB symbols table
const r = await query(
  `SELECT canonical, industry, sector, active FROM symbols WHERE canonical = ANY($1) AND exchange = 'NSE'`,
  [['NSE:JUSTDIAL', 'NSE:NAUKRI']]
);
console.log('JUSTDIAL/NAUKRI in DB:', r.rows);

// Check what the sec_media industry query returns
const patterns = ['Entertainment', 'Broadcasting', 'Publishing', 'Advertising', 'Internet Content'];
const conditions = patterns.map((_, i) => `industry ILIKE $${i + 1}`);
const params = patterns.map(p => `%${p}%`);
const r2 = await query(
  `SELECT canonical, industry FROM symbols WHERE (${conditions.join(' OR ')}) AND exchange = 'NSE' AND active = TRUE ORDER BY market_cap DESC NULLS LAST`,
  params
);
console.log('\nsec_media DB query results:', r2.rows.length);
r2.rows.forEach(row => console.log(' ', row.canonical, '-', row.industry));

// Check if JUSTDIAL industry in DB matches
const r3 = await query(
  `SELECT canonical, industry, sector FROM symbols WHERE canonical = 'NSE:JUSTDIAL'`
);
console.log('\nJUSTDIAL DB record:', r3.rows);
