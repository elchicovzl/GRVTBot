// GRVT Authentication Module
// Implementa cookie-based auth según la documentación de GRVT

import dotenv from 'dotenv';
import { GRVT_TRADING_BASE_URL } from './grvt-config.js';

dotenv.config();

const TRADING_BASE_URL = GRVT_TRADING_BASE_URL;

interface AuthState {
  cookies: string;
  isAuthenticated: boolean;
  expiresAt?: number;
}

let authState: AuthState = {
  cookies: '',
  isAuthenticated: false
};

/**
 * Intenta autenticar con GRVT usando API key y private key
 * Según la documentación, necesitamos firmar una solicitud con EIP-712
 */
export async function authenticateGRVT(): Promise<boolean> {
  try {
    console.log('🔐 Intentando autenticar con GRVT Trading API...');
    
    // Según la documentación, necesitamos:
    // 1. API Key
    // 2. Private Key del wallet taggeado para firma
    // 3. Timestamp y nonce para la firma EIP-712
    
    const apiKey = process.env.GRVT_API_KEY;
    const privateKey = process.env.GRVT_API_SECRET; // Es la private key
    const accountId = process.env.GRVT_TRADING_ACCOUNT_ID;
    
    if (!apiKey || !privateKey || !accountId) {
      throw new Error('Credenciales GRVT incompletas');
    }
    
    // Primero intentar una llamada básica para ver qué tipo de auth requiere
    const testResponse = await fetch(`${TRADING_BASE_URL}/account_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Intentar enviar API key como header básico
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        sub_account_id: accountId
      })
    });
    
    console.log('📄 Response status:', testResponse.status);
    console.log('📄 Response headers:', Object.fromEntries(testResponse.headers.entries()));
    
    if (testResponse.status === 401) {
      const errorText = await testResponse.text();
      console.log('❌ Error response:', errorText);
      
      // Buscar en headers si hay información sobre el método de auth requerido
      const authHeader = testResponse.headers.get('www-authenticate');
      console.log('🔍 Auth header:', authHeader);
      
      return false;
    } else if (testResponse.ok) {
      // Si funcionó, extraer cookies si las hay
      const setCookie = testResponse.headers.get('set-cookie');
      if (setCookie) {
        authState.cookies = setCookie;
        authState.isAuthenticated = true;
      }
      
      console.log('✅ Autenticación exitosa!');
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Error de autenticación:', error);
    return false;
  }
}

/**
 * Realiza una llamada autenticada a la Trading API
 */
export async function callAuthenticatedAPI(endpoint: string, body: object = {}) {
  if (!authState.isAuthenticated) {
    const authSuccess = await authenticateGRVT();
    if (!authSuccess) {
      throw new Error('No se pudo autenticar con GRVT');
    }
  }
  
  const response = await fetch(`${TRADING_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': authState.cookies,
      // También intentar el API key por si lo necesita
      'X-API-Key': process.env.GRVT_API_KEY!,
    },
    body: JSON.stringify(body)
  });
  
  // Si falla por auth, invalidar el estado y reintentar
  if (response.status === 401) {
    authState.isAuthenticated = false;
    authState.cookies = '';
    throw new Error('Sesión expirada');
  }
  
  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? await response.json() : await response.text()
  };
}

/**
 * Obtener balance de la cuenta trading
 */
export async function getAccountBalance() {
  return callAuthenticatedAPI('/account_summary', {
    sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID
  });
}

/**
 * Obtener posiciones abiertas
 */
export async function getPositions() {
  return callAuthenticatedAPI('/positions', {});
}

/**
 * Obtener órdenes abiertas
 */
export async function getOpenOrders() {
  return callAuthenticatedAPI('/open_orders', {});
}

// Exportar estado para debugging
export function getAuthStatus() {
  return {
    isAuthenticated: authState.isAuthenticated,
    hasCookies: !!authState.cookies
  };
}