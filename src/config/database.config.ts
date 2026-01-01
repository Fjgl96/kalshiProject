/**
 * KALSHI PERÚ - Configuración de Base de Datos
 * PostgreSQL optimizado para transacciones de alta frecuencia
 */

import { Pool, PoolConfig } from 'pg';
import { env } from './env.config';

// ============================================================================
// CONFIGURACIÓN DEL POOL DE CONEXIONES
// ============================================================================

const poolConfig: PoolConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,

  // Pool sizing optimizado para alta frecuencia
  // Fórmula: connections = (core_count * 2) + effective_spindle_count
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,

  // Timeouts
  connectionTimeoutMillis: 10000,     // 10s para obtener conexión
  idleTimeoutMillis: 30000,           // 30s antes de cerrar conexión idle
  query_timeout: 30000,               // 30s timeout por query

  // SSL en producción
  ssl: env.NODE_ENV === 'production' ? {
    rejectUnauthorized: true,
    ca: env.DB_SSL_CA,
  } : false,

  // Statement timeout para prevenir queries largas
  statement_timeout: 30000,

  // Application name para debugging
  application_name: 'kalshi-peru-api',
};

// ============================================================================
// POOL PRINCIPAL
// ============================================================================

export const pool = new Pool(poolConfig);

// Manejo de errores del pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

pool.on('connect', (client) => {
  // Configurar timezone para Perú
  client.query("SET timezone = 'America/Lima'");
});

// ============================================================================
// FUNCIONES DE UTILIDAD
// ============================================================================

/**
 * Ejecutar query con reintentos automáticos
 */
export async function query<T>(
  text: string,
  params?: unknown[],
  retries = 3
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } catch (error) {
    if (retries > 0 && isTransientError(error)) {
      await sleep(100 * (4 - retries));
      return query(text, params, retries - 1);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ejecutar query que retorna un solo registro
 */
export async function queryOne<T>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Ejecutar múltiples queries en una transacción
 */
export async function transaction<T>(
  callback: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback({
      query: async <R>(text: string, params?: unknown[]) => {
        const res = await client.query(text, params);
        return res.rows as R[];
      },
      queryOne: async <R>(text: string, params?: unknown[]) => {
        const res = await client.query(text, params);
        return (res.rows[0] as R) || null;
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface TransactionClient {
  query: <T>(text: string, params?: unknown[]) => Promise<T[]>;
  queryOne: <T>(text: string, params?: unknown[]) => Promise<T | null>;
}

/**
 * Ejecutar transacción con nivel de aislamiento específico
 * Para operaciones financieras críticas usar SERIALIZABLE
 */
export async function transactionWithIsolation<T>(
  isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE',
  callback: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    const result = await callback({
      query: async <R>(text: string, params?: unknown[]) => {
        const res = await client.query(text, params);
        return res.rows as R[];
      },
      queryOne: async <R>(text: string, params?: unknown[]) => {
        const res = await client.query(text, params);
        return (res.rows[0] as R) || null;
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verificar salud de la conexión
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query<{ now: Date }>('SELECT NOW()');
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Cerrar todas las conexiones (para shutdown graceful)
 */
export async function closePool(): Promise<void> {
  await pool.end();
}

// ============================================================================
// HELPERS INTERNOS
// ============================================================================

function isTransientError(error: unknown): boolean {
  const transientCodes = [
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
  ];

  if (error && typeof error === 'object' && 'code' in error) {
    return transientCodes.includes((error as { code: string }).code);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// QUERIES PREPARADAS PARA OPERACIONES FRECUENTES
// ============================================================================

export const preparedQueries = {
  // Obtener balance de usuario
  getUserBalance: `
    SELECT available_balance, escrow_balance, total_balance
    FROM wallets
    WHERE user_id = $1
  `,

  // Obtener órdenes activas del order book
  getOrderBook: `
    SELECT
      side,
      limit_price as price,
      SUM(remaining_quantity) as quantity,
      COUNT(*) as order_count
    FROM orders
    WHERE market_id = $1
      AND status IN ('open', 'partially_filled')
    GROUP BY side, limit_price
    ORDER BY
      side,
      CASE WHEN side = 'yes' THEN limit_price END DESC,
      CASE WHEN side = 'no' THEN limit_price END ASC
  `,

  // Obtener posiciones del usuario
  getUserPositions: `
    SELECT
      p.*,
      m.ticker,
      m.title,
      m.last_yes_price,
      m.last_no_price,
      m.status as market_status
    FROM positions p
    JOIN markets m ON m.id = p.market_id
    WHERE p.user_id = $1
      AND (p.yes_quantity > 0 OR p.no_quantity > 0)
  `,

  // Insertar audit log
  insertAuditLog: `
    INSERT INTO audit_logs (
      user_id, session_id, ip_address, user_agent,
      action, resource_type, resource_id, severity,
      description, old_values, new_values, metadata,
      success, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `,
};
