/**
 * SERVICIO DE LIQUIDACIÓN DE MERCADOS
 *
 * Maneja la resolución y liquidación de mercados de predicción:
 * - Resolución de mercados (YES gana o NO gana)
 * - Distribución de ganancias a posiciones ganadoras
 * - Liberación de fondos en escrow
 * - Cancelación de órdenes pendientes
 *
 * LIBRERÍAS Y DECISIONES:
 * - PostgreSQL SERIALIZABLE: Consistencia absoluta en liquidaciones
 * - Double-Entry Bookkeeping: Auditoría completa de pagos
 *
 * RIESGOS DE SEGURIDAD Y MITIGACIONES:
 * 1. Double-spend en liquidación → Transacciones SERIALIZABLE
 * 2. Liquidación incorrecta → Validación de estado del mercado
 * 3. Fondos huérfanos → Reconciliación automática
 * 4. Fraude en resolución → Requiere admin + periodo de disputa
 */

import { pool, withSerializableTransaction } from '../config/database.config';
import * as WalletService from './wallet.service';
import * as MarketService from './market.service';

// ============================================================================
// TIPOS
// ============================================================================

export interface SettlementResult {
  marketId: string;
  outcome: 'yes' | 'no';
  totalPositions: number;
  totalWinners: number;
  totalLosers: number;
  totalPayout: number;
  settledAt: Date;
}

export interface PositionSettlement {
  positionId: string;
  userId: string;
  side: 'yes' | 'no';
  quantity: number;
  avgPrice: number;
  payout: number;
  profit: number;
  isWinner: boolean;
}

export interface DisputeRequest {
  marketId: string;
  userId: string;
  reason: string;
  evidence?: string;
}

export interface Dispute {
  id: string;
  marketId: string;
  userId: string;
  reason: string;
  evidence: string | null;
  status: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

// ============================================================================
// ERROR PERSONALIZADO
// ============================================================================

export class SettlementError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'SettlementError';
  }
}

// ============================================================================
// CONSTANTES
// ============================================================================

// Período de disputa antes de liquidación final (24 horas)
const DISPUTE_PERIOD_HOURS = 24;

// Pago por contrato ganador (100 centavos = 1 sol)
const WINNING_PAYOUT_PER_CONTRACT = 100; // centavos

// ============================================================================
// RESOLUCIÓN DE MERCADOS
// ============================================================================

/**
 * Cierra un mercado y establece el resultado preliminar
 * Inicia el período de disputa antes de la liquidación final
 */
export async function resolveMarket(
  marketId: string,
  outcome: 'yes' | 'no',
  adminId: string,
  resolutionSource: string = 'admin_decision'
): Promise<{ market: any; disputePeriodEnds: Date }> {
  return withSerializableTransaction(async (client) => {
    // Verificar que el mercado existe y está cerrado
    const marketResult = await client.query(
      `SELECT * FROM markets WHERE id = $1 FOR UPDATE`,
      [marketId]
    );

    if (marketResult.rows.length === 0) {
      throw new SettlementError('Mercado no encontrado', 'MARKET_NOT_FOUND', 404);
    }

    const market = marketResult.rows[0];

    // Validar estado
    if (market.status !== 'closed') {
      throw new SettlementError(
        `El mercado debe estar cerrado para resolver. Estado actual: ${market.status}`,
        'INVALID_MARKET_STATE'
      );
    }

    // Calcular fin del período de disputa
    const disputePeriodEnds = new Date();
    disputePeriodEnds.setHours(disputePeriodEnds.getHours() + DISPUTE_PERIOD_HOURS);

    // Actualizar mercado con resultado preliminar
    const updateResult = await client.query(
      `UPDATE markets
       SET resolution = $1,
           resolution_source = $2,
           resolved_by = $3,
           resolved_at = NOW(),
           dispute_period_ends = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [outcome, resolutionSource, adminId, disputePeriodEnds, marketId]
    );

    // Registrar en auditoría
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        'MARKET_RESOLVED',
        'market',
        marketId,
        JSON.stringify({
          outcome,
          resolutionSource,
          disputePeriodEnds: disputePeriodEnds.toISOString()
        }),
        '0.0.0.0'
      ]
    );

    return {
      market: updateResult.rows[0],
      disputePeriodEnds
    };
  });
}

/**
 * Ejecuta la liquidación final de un mercado
 * Solo se puede ejecutar después del período de disputa
 */
export async function settleMarket(
  marketId: string,
  adminId: string
): Promise<SettlementResult> {
  return withSerializableTransaction(async (client) => {
    // Obtener mercado con bloqueo
    const marketResult = await client.query(
      `SELECT * FROM markets WHERE id = $1 FOR UPDATE`,
      [marketId]
    );

    if (marketResult.rows.length === 0) {
      throw new SettlementError('Mercado no encontrado', 'MARKET_NOT_FOUND', 404);
    }

    const market = marketResult.rows[0];

    // Validar que tiene resolución
    if (!market.resolution) {
      throw new SettlementError(
        'El mercado no ha sido resuelto aún',
        'MARKET_NOT_RESOLVED'
      );
    }

    // Validar que ya pasó el período de disputa
    if (market.dispute_period_ends && new Date(market.dispute_period_ends) > new Date()) {
      throw new SettlementError(
        `El período de disputa termina el ${market.dispute_period_ends}`,
        'DISPUTE_PERIOD_ACTIVE'
      );
    }

    // Validar que no hay disputas pendientes
    const disputeCheck = await client.query(
      `SELECT COUNT(*) as count FROM market_disputes
       WHERE market_id = $1 AND status IN ('pending', 'reviewing')`,
      [marketId]
    );

    if (parseInt(disputeCheck.rows[0].count) > 0) {
      throw new SettlementError(
        'Hay disputas pendientes de resolución',
        'PENDING_DISPUTES'
      );
    }

    // Validar estado
    if (market.status === 'settled') {
      throw new SettlementError(
        'El mercado ya ha sido liquidado',
        'ALREADY_SETTLED'
      );
    }

    const outcome = market.resolution as 'yes' | 'no';
    const winningSide = outcome;
    const losingSide = outcome === 'yes' ? 'no' : 'yes';

    // Cancelar todas las órdenes pendientes y liberar escrow
    await cancelPendingOrders(client, marketId);

    // Obtener todas las posiciones
    const positionsResult = await client.query(
      `SELECT p.*, u.email as user_email
       FROM positions p
       JOIN users u ON p.user_id = u.id
       WHERE p.market_id = $1 AND p.quantity > 0
       FOR UPDATE`,
      [marketId]
    );

    const settlements: PositionSettlement[] = [];
    let totalPayout = 0;
    let totalWinners = 0;
    let totalLosers = 0;

    // Procesar cada posición
    for (const position of positionsResult.rows) {
      const isWinner = position.side === winningSide;
      let payout = 0;
      let profit = 0;

      if (isWinner) {
        // Ganadores reciben 100 centavos por contrato
        payout = position.quantity * WINNING_PAYOUT_PER_CONTRACT;
        // Costo original = promedio_precio * cantidad
        const cost = Math.round(position.avg_price * position.quantity);
        profit = payout - cost;
        totalWinners++;
        totalPayout += payout;

        // Transferir ganancias al usuario
        await WalletService.releaseFromEscrow(
          position.user_id,
          cost, // Liberar lo que puso en escrow
          `Liquidación mercado ${market.title} - Capital`,
          { marketId, positionId: position.id, type: 'capital_return' }
        );

        // Si hay ganancia, transferir del fondo del mercado
        if (profit > 0) {
          // Las ganancias vienen de los perdedores (ya en escrow del sistema)
          await transferWinnings(client, position.user_id, profit, marketId, position.id);
        }
      } else {
        // Perdedores pierden su inversión (ya en escrow, se transfiere al sistema)
        const loss = Math.round(position.avg_price * position.quantity);
        profit = -loss;
        totalLosers++;

        // El escrow de los perdedores ya fue capturado al momento del trade
        // Marcar como pérdida realizada
        await client.query(
          `INSERT INTO ledger_entries
           (account_id, entry_type, amount, balance_after, reference_type, reference_id, description)
           SELECT
             (SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'trading'),
             'debit',
             $2,
             0,
             'settlement',
             $3,
             $4`,
          [position.user_id, loss, position.id, `Pérdida en ${market.title}`]
        );
      }

      // Actualizar posición como liquidada
      await client.query(
        `UPDATE positions
         SET realized_pnl = realized_pnl + $1,
             quantity = 0,
             settled = true,
             settled_at = NOW()
         WHERE id = $2`,
        [profit, position.id]
      );

      settlements.push({
        positionId: position.id,
        userId: position.user_id,
        side: position.side,
        quantity: position.quantity,
        avgPrice: position.avg_price,
        payout,
        profit,
        isWinner
      });
    }

    // Actualizar mercado como liquidado
    await client.query(
      `UPDATE markets
       SET status = 'settled',
           settled_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [marketId]
    );

    // Registrar en auditoría
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        'MARKET_SETTLED',
        'market',
        marketId,
        JSON.stringify({
          outcome,
          totalPositions: positionsResult.rows.length,
          totalWinners,
          totalLosers,
          totalPayout,
          settlements: settlements.map(s => ({
            positionId: s.positionId,
            payout: s.payout,
            profit: s.profit
          }))
        }),
        '0.0.0.0'
      ]
    );

    return {
      marketId,
      outcome,
      totalPositions: positionsResult.rows.length,
      totalWinners,
      totalLosers,
      totalPayout,
      settledAt: new Date()
    };
  });
}

/**
 * Cancela todas las órdenes pendientes y libera escrow
 */
async function cancelPendingOrders(
  client: any,
  marketId: string
): Promise<number> {
  // Obtener órdenes pendientes
  const ordersResult = await client.query(
    `SELECT o.*, u.id as user_id
     FROM orders o
     JOIN users u ON o.user_id = u.id
     WHERE o.market_id = $1 AND o.status IN ('pending', 'partial')
     FOR UPDATE`,
    [marketId]
  );

  let cancelledCount = 0;

  for (const order of ordersResult.rows) {
    // Calcular cantidad no ejecutada
    const unfilledQty = order.quantity - order.filled_quantity;
    if (unfilledQty > 0) {
      // Liberar escrow
      const escrowAmount = Math.round(order.price * unfilledQty);

      await WalletService.releaseFromEscrow(
        order.user_id,
        escrowAmount,
        `Orden cancelada - Mercado liquidado`,
        { orderId: order.id, marketId, reason: 'market_settled' }
      );
    }

    // Marcar orden como cancelada
    await client.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancel_reason = 'market_settled'
       WHERE id = $1`,
      [order.id]
    );

    cancelledCount++;
  }

  return cancelledCount;
}

/**
 * Transfiere ganancias del pool del mercado al ganador
 */
async function transferWinnings(
  client: any,
  userId: string,
  amount: number,
  marketId: string,
  positionId: string
): Promise<void> {
  // Obtener cuenta de trading del usuario
  const userAccountResult = await client.query(
    `SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'trading'`,
    [userId]
  );

  if (userAccountResult.rows.length === 0) {
    throw new SettlementError('Cuenta de trading no encontrada', 'ACCOUNT_NOT_FOUND');
  }

  const userAccountId = userAccountResult.rows[0].id;

  // Obtener cuenta de escrow del sistema
  const systemAccountResult = await client.query(
    `SELECT id FROM accounts WHERE user_id IS NULL AND account_type = 'escrow'`
  );

  const systemEscrowId = systemAccountResult.rows[0].id;

  // Transferir del escrow del sistema al usuario
  await client.query(
    `SELECT transfer_funds($1, $2, $3, $4, $5, $6)`,
    [
      systemEscrowId,
      userAccountId,
      amount,
      'settlement',
      positionId,
      `Ganancias de mercado - Position ${positionId}`
    ]
  );

  // Actualizar balance del wallet
  await client.query(
    `UPDATE wallets
     SET balance = balance + $1,
         updated_at = NOW()
     WHERE user_id = $2`,
    [amount, userId]
  );
}

// ============================================================================
// SISTEMA DE DISPUTAS
// ============================================================================

/**
 * Crea una disputa sobre la resolución de un mercado
 */
export async function createDispute(
  input: DisputeRequest
): Promise<Dispute> {
  const { marketId, userId, reason, evidence } = input;

  // Verificar que el mercado existe y está en período de disputa
  const marketResult = await pool.query(
    `SELECT * FROM markets WHERE id = $1`,
    [marketId]
  );

  if (marketResult.rows.length === 0) {
    throw new SettlementError('Mercado no encontrado', 'MARKET_NOT_FOUND', 404);
  }

  const market = marketResult.rows[0];

  if (!market.resolution) {
    throw new SettlementError(
      'El mercado no ha sido resuelto aún',
      'MARKET_NOT_RESOLVED'
    );
  }

  if (market.status === 'settled') {
    throw new SettlementError(
      'El mercado ya ha sido liquidado, no se pueden crear disputas',
      'MARKET_ALREADY_SETTLED'
    );
  }

  // Verificar período de disputa
  if (market.dispute_period_ends && new Date(market.dispute_period_ends) < new Date()) {
    throw new SettlementError(
      'El período de disputa ha terminado',
      'DISPUTE_PERIOD_ENDED'
    );
  }

  // Verificar que el usuario tiene posición en el mercado
  const positionResult = await pool.query(
    `SELECT * FROM positions WHERE user_id = $1 AND market_id = $2 AND quantity > 0`,
    [userId, marketId]
  );

  if (positionResult.rows.length === 0) {
    throw new SettlementError(
      'Solo usuarios con posiciones pueden crear disputas',
      'NO_POSITION'
    );
  }

  // Verificar que no tenga otra disputa pendiente
  const existingDispute = await pool.query(
    `SELECT * FROM market_disputes
     WHERE market_id = $1 AND user_id = $2 AND status IN ('pending', 'reviewing')`,
    [marketId, userId]
  );

  if (existingDispute.rows.length > 0) {
    throw new SettlementError(
      'Ya tienes una disputa pendiente para este mercado',
      'DUPLICATE_DISPUTE'
    );
  }

  // Crear disputa
  const result = await pool.query(
    `INSERT INTO market_disputes (market_id, user_id, reason, evidence, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [marketId, userId, reason, evidence || null]
  );

  // Extender período de disputa si es necesario
  const newDisputeEnd = new Date();
  newDisputeEnd.setHours(newDisputeEnd.getHours() + 48); // 48 horas adicionales

  await pool.query(
    `UPDATE markets
     SET dispute_period_ends = GREATEST(dispute_period_ends, $1),
         updated_at = NOW()
     WHERE id = $2`,
    [newDisputeEnd, marketId]
  );

  return mapDispute(result.rows[0]);
}

/**
 * Resuelve una disputa (solo admins)
 */
export async function resolveDispute(
  disputeId: string,
  adminId: string,
  resolution: 'approved' | 'rejected',
  resolutionNotes: string,
  newOutcome?: 'yes' | 'no'
): Promise<Dispute> {
  return withSerializableTransaction(async (client) => {
    // Obtener disputa
    const disputeResult = await client.query(
      `SELECT d.*, m.id as market_id, m.resolution as current_resolution
       FROM market_disputes d
       JOIN markets m ON d.market_id = m.id
       WHERE d.id = $1
       FOR UPDATE`,
      [disputeId]
    );

    if (disputeResult.rows.length === 0) {
      throw new SettlementError('Disputa no encontrada', 'DISPUTE_NOT_FOUND', 404);
    }

    const dispute = disputeResult.rows[0];

    if (dispute.status !== 'pending' && dispute.status !== 'reviewing') {
      throw new SettlementError(
        'Esta disputa ya ha sido resuelta',
        'DISPUTE_ALREADY_RESOLVED'
      );
    }

    // Actualizar estado de disputa
    const status = resolution === 'approved' ? 'resolved' : 'rejected';

    await client.query(
      `UPDATE market_disputes
       SET status = $1,
           resolution = $2,
           resolved_at = NOW(),
           resolved_by = $3
       WHERE id = $4`,
      [status, resolutionNotes, adminId, disputeId]
    );

    // Si se aprueba y hay nuevo outcome, actualizar mercado
    if (resolution === 'approved' && newOutcome && newOutcome !== dispute.current_resolution) {
      await client.query(
        `UPDATE markets
         SET resolution = $1,
             resolution_source = 'dispute_resolution',
             updated_at = NOW()
         WHERE id = $2`,
        [newOutcome, dispute.market_id]
      );

      // Extender período de disputa
      const newDisputeEnd = new Date();
      newDisputeEnd.setHours(newDisputeEnd.getHours() + 24);

      await client.query(
        `UPDATE markets
         SET dispute_period_ends = $1
         WHERE id = $2`,
        [newDisputeEnd, dispute.market_id]
      );
    }

    // Registrar en auditoría
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        'DISPUTE_RESOLVED',
        'dispute',
        disputeId,
        JSON.stringify({
          resolution,
          notes: resolutionNotes,
          newOutcome,
          marketId: dispute.market_id
        }),
        '0.0.0.0'
      ]
    );

    // Obtener disputa actualizada
    const updatedResult = await client.query(
      `SELECT * FROM market_disputes WHERE id = $1`,
      [disputeId]
    );

    return mapDispute(updatedResult.rows[0]);
  });
}

/**
 * Obtiene disputas de un mercado
 */
export async function getMarketDisputes(marketId: string): Promise<Dispute[]> {
  const result = await pool.query(
    `SELECT * FROM market_disputes WHERE market_id = $1 ORDER BY created_at DESC`,
    [marketId]
  );

  return result.rows.map(mapDispute);
}

/**
 * Obtiene disputas pendientes (para admins)
 */
export async function getPendingDisputes(): Promise<Dispute[]> {
  const result = await pool.query(
    `SELECT d.*, m.title as market_title
     FROM market_disputes d
     JOIN markets m ON d.market_id = m.id
     WHERE d.status IN ('pending', 'reviewing')
     ORDER BY d.created_at ASC`
  );

  return result.rows.map(mapDispute);
}

// ============================================================================
// LIQUIDACIÓN AUTOMÁTICA
// ============================================================================

/**
 * Procesa mercados listos para liquidación automática
 * Debe ejecutarse periódicamente (cron job)
 */
export async function processAutoSettlements(): Promise<SettlementResult[]> {
  // Buscar mercados listos para liquidar
  const marketsResult = await pool.query(
    `SELECT m.id
     FROM markets m
     WHERE m.resolution IS NOT NULL
       AND m.status = 'closed'
       AND m.dispute_period_ends < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM market_disputes d
         WHERE d.market_id = m.id
         AND d.status IN ('pending', 'reviewing')
       )
     ORDER BY m.dispute_period_ends ASC
     LIMIT 10`
  );

  const results: SettlementResult[] = [];

  for (const market of marketsResult.rows) {
    try {
      // Usar cuenta del sistema para liquidación automática
      const result = await settleMarket(market.id, 'system');
      results.push(result);
      console.log(`✅ Mercado ${market.id} liquidado automáticamente`);
    } catch (error) {
      console.error(`❌ Error liquidando mercado ${market.id}:`, error);
    }
  }

  return results;
}

/**
 * Obtiene estadísticas de liquidación de un usuario
 */
export async function getUserSettlementStats(userId: string): Promise<{
  totalMarkets: number;
  wins: number;
  losses: number;
  totalProfit: number;
  totalPayout: number;
  winRate: number;
}> {
  const result = await pool.query(
    `SELECT
       COUNT(*) as total_markets,
       COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as wins,
       COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losses,
       COALESCE(SUM(realized_pnl), 0) as total_profit,
       COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl + (avg_price * quantity) ELSE 0 END), 0) as total_payout
     FROM positions
     WHERE user_id = $1 AND settled = true`,
    [userId]
  );

  const stats = result.rows[0];
  const totalMarkets = parseInt(stats.total_markets);
  const wins = parseInt(stats.wins);

  return {
    totalMarkets,
    wins,
    losses: parseInt(stats.losses),
    totalProfit: parseInt(stats.total_profit),
    totalPayout: parseInt(stats.total_payout),
    winRate: totalMarkets > 0 ? (wins / totalMarkets) * 100 : 0
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function mapDispute(row: any): Dispute {
  return {
    id: row.id,
    marketId: row.market_id,
    userId: row.user_id,
    reason: row.reason,
    evidence: row.evidence,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by
  };
}
