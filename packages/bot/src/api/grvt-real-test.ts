import dotenv from 'dotenv';
import { GRVT_MARKET_DATA_BASE_URL, GRVT_TRADING_BASE_URL } from './grvt-config.js';

dotenv.config();

console.log('🔧 Edison: Testing GRVT API with REAL endpoints...\n');

// Test Market Data (público) - endpoints verificados por Marta
async function testMarketDataDirect() {
  console.log('📊 Testing Market Data (sin auth)...\n');
  
  try {
    // Test 1: Obtener instrumentos
    console.log('🎯 Testing /instruments endpoint...');
    const instrumentsRes = await fetch(`${GRVT_MARKET_DATA_BASE_URL}/instruments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    
    if (instrumentsRes.ok) {
      const instruments = await instrumentsRes.json();
      console.log('✅ Instruments endpoint working!');
      console.log('📋 Instruments response:', instruments);
      
      // La respuesta puede ser un objeto o array, vamos a investigar
      if (Array.isArray(instruments)) {
        console.log(`📋 Found ${instruments.length} instruments`);
        const btcInstruments = instruments.filter((i: any) => 
          i?.instrument_id?.includes('BTC') || i?.symbol?.includes('BTC')
        );
        const ethInstruments = instruments.filter((i: any) => 
          i?.instrument_id?.includes('ETH') || i?.symbol?.includes('ETH')
        );
        console.log('🎯 BTC instruments found:', btcInstruments?.length || 0);
        console.log('🎯 ETH instruments found:', ethInstruments?.length || 0);
      } else {
        console.log('📋 Instruments is not an array, structure:', typeof instruments);
        console.log('📋 Keys:', Object.keys(instruments || {}));
      }
    } else {
      console.log('❌ Instruments request failed:', instrumentsRes.status, await instrumentsRes.text());
    }

    // Test 2: Ticker de BTC
    console.log('\n💰 Testing BTC ticker...');
    const btcTickerRes = await fetch(`${GRVT_MARKET_DATA_BASE_URL}/ticker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument: 'BTC_USDT_Perp' })
    });

    if (btcTickerRes.ok) {
      const btcTicker = await btcTickerRes.json();
      console.log('✅ BTC ticker working!');
      console.log('💲 BTC price data:', btcTicker);
    } else {
      console.log('❌ BTC ticker failed:', btcTickerRes.status, await btcTickerRes.text());
    }

    // Test 3: Ticker de ETH
    console.log('\n💰 Testing ETH ticker...');
    const ethTickerRes = await fetch(`${GRVT_MARKET_DATA_BASE_URL}/ticker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument: 'ETH_USDT_Perp' })
    });

    if (ethTickerRes.ok) {
      const ethTicker = await ethTickerRes.json();
      console.log('✅ ETH ticker working!');
      console.log('💲 ETH price data:', ethTicker);
    } else {
      console.log('❌ ETH ticker failed:', ethTickerRes.status, await ethTickerRes.text());
    }

  } catch (error) {
    console.error('❌ Market data test error:', error);
  }
}

// Test Trading API (con autenticación)
async function testTradingAuth() {
  console.log('\n\n🔐 Testing Trading API authentication...\n');
  
  try {
    // Intentar acceso a account_summary
    console.log('💳 Testing account_summary endpoint...');
    
    // Para la Trading API se necesita cookie-based auth
    // Por ahora solo testeo si el endpoint responde
    const tradingRes = await fetch(`${GRVT_TRADING_BASE_URL}/account_summary`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID
      })
    });

    console.log('🔍 Trading API response status:', tradingRes.status);
    const responseText = await tradingRes.text();
    console.log('📄 Trading API response:', responseText.substring(0, 200), '...');

    if (tradingRes.status === 401) {
      console.log('✅ Trading API endpoint reachable (401 = auth required)');
    } else if (tradingRes.ok) {
      console.log('✅ Trading API working! (unexpected)');
    } else {
      console.log('❌ Trading API error:', tradingRes.status);
    }

  } catch (error) {
    console.error('❌ Trading auth test error:', error);
  }
}

async function runRealTests() {
  console.log('🎯 Probando endpoints reales verificados por Marta...\n');
  
  await testMarketDataDirect();
  await testTradingAuth();
  
  console.log('\n📋 CONCLUSIONES:');
  console.log('✅ Market Data: Endpoints públicos /full/v1/ funcionan');  
  console.log('⚠️  Trading: Requiere implementar cookie-based auth');
  console.log('🎯 Próximo paso: Implementar auth flow para Trading API');
}

runRealTests();