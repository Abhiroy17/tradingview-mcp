// Quick test script for ownership data pipeline
// Tests: NSE (likely blocked) → DB cache → Yahoo Finance fallback
import { fetchNseShareholding } from '../src/data/ownership/nse-shareholding.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function testDirect() {
  console.log('=== NSE Direct API Test ===');
  console.log('(NSE is behind Akamai Bot Manager — expect failures without proxy)\n');
  const symbols = ['NSE:RELIANCE', 'NSE:TCS', 'NSE:JUSTDIAL'];
  for (const sym of symbols) {
    const result = await fetchNseShareholding(sym);
    console.log(`${sym}: ${result ? result.length + ' quarters ✅' : 'null (blocked) ❌'}`);
  }
}

async function testViaModule() {
  console.log('\n=== Via getOwnership() (with Yahoo fallback) ===');
  process.env.OWNERSHIP_DEBUG = '1';
  const { getOwnership } = await import('../src/data/ownership/index.js');
  const symbols = ['NSE:RELIANCE', 'NSE:TCS', 'NSE:JUSTDIAL'];
  for (const sym of symbols) {
    try {
      const result = await getOwnership(sym);
      const hasData = result.promoterHolding != null || result.fiiHolding != null;
      console.log(`\n✅ ${sym}: source=${result.source || 'none'} available=${hasData || result.available}`);
      console.log(`   promoter=${result.promoterHolding} fii=${result.fiiHolding} dii=${result.diiHolding}`);
      console.log(`   smartMoney=${result.smartMoneyScore} instTrend=${result.institutionalTrend}`);
    } catch (e) {
      console.log(`\n❌ ${sym}: ERROR ${e.message}`);
    }
  }
}

await testDirect();
await testViaModule();
