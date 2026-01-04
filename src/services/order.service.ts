/**
 * KALSHI PERÚ - Servicio de Órdenes y Matching Engine
 *
 * Motor de ejecución de órdenes para mercados de predicción.
 *
 * LÓGICA DE MATCHING:
 * - Comprador YES a S/60 matchea con comprador NO a S/40 (suman 100)
 * - Precio de ejecución: punto medio o precio del maker
 * - Prioridad: Precio > Tiempo (FIFO)
 *
 * FLUJO DE ORDEN:
 * 1. Validar orden
 * 2. Calcular costo y bloquear fondos (escrow)
 * 3. Intentar match con órdenes existentes
 * 4. Si no matchea completamente, agregar al order book
 * 5. Actualizar posiciones
 */

import { v4 as uuidv4 } from 'uuid';
import {
  query,
  queryOne,
  transaction,
  transactionWithIsolation
} from '../config/database.config';
import { env } from '../config/env.config';
import { OrderSide, OrderType, OrderStatus } from '../types/database.types';
import {
  lockFundsForOrder,
  releaseFundsFromEscrow,
  getWalletBalance
} from './wallet.service';
import { getMarket, updateMarketStats } from './market.service';

// ============================================================================
// TIPOS
// ============================================================================

export interface CreateOrderInput {
  userId: string;
  marketId: string;
  side: OrderSide;        // 'yes' o 'no'
  orderType: OrderType;   // 'limit' o 'market'
  limitPrice?: number;    // Precio límite (1-99)
  quantity: number;       // Número de contratos
}

export interface Order {
  id: string;
  userId: string;
  marketId: string;
  orderNumber: number;
  side: OrderSide;
  orderType: OrderType;
  limitPrice: number | null;
  avgFillPrice: number | null;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  estimatedCost: number;
  actualCost: number;
  commission: number;
  escrowAmount: number;
  status: OrderStatus;
  submittedAt: Date;
  filledAt: Date | null;
}

export interface Trade {
  id: string;
  tradeNumber: number;
  marketId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  side: OrderSide;
  price: number;
  quantity: number;
  totalValue: number;
  makerCommission: number;
  takerCommission: number;
  executedAt: Date;
}

export interface Position {
  userId: string;
  marketId: string;
  yesQuantity: number;
  yesAvgPrice: number;
  yesCost: number;
  noQuantity: number;
  noAvgPrice: number;
  noCost: number;
  totalInvested: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface OrderResult {
  order: Order;
  trades: Trade[];
  position: Position;
  message: string;
}

export interface OrderFilters {
  marketId?: string;
  status?: OrderStatus;
  side?: OrderSide;
  page?: number;
  limit?: number;
}

export interface CreateOrderRequest {
  marketId: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  price?: number;
  expiresAt?: Date;
}

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const COMMISSION_RATE = parseFloat(env.TRADING_COMMISSION_RATE || '0.02');
const MIN_COMMISSION = parseFloat(env.MIN_TRADING_COMMISSION || '0.10');

// ============================================================================
// CREAR ORDEN
// ============================================================================

/**
 * Crea y ejecuta una orden
 */
export async function createOrder(
  input: CreateOrderRequest,
  metadata: { userId: string; ipAddress?: string; userAgent?: string }
): Promise<OrderResult> {
  const { marketId, side, orderType, quantity, price: limitPrice } = input;
  const { userId } = metadata;

  // Validaciones básicas
  if (quantity <= 0) {
    throw new OrderError('Quantity must be positive', 'INVALID_QUANTITY', 400);
  }

  if (orderType === 'limit' && (limitPrice === undefined || limitPrice < 1 || limitPrice > 99)) {
    throw new OrderError('Limit price must be between 1 and 99', 'INVALID_PRICE', 400);
  }

  // Obtener mercado
  const market = await getMarket(marketId);

  if (market.status !== 'open') {
    throw new OrderError('Market is not open for trading', 'MARKET_NOT_OPEN', 400);
  }

  if (new Date() >= market.closesAt) {
    throw new OrderError('Market is closed', 'MARKET_CLOSED', 400);
  }

  // Validar límites del mercado
  if (quantity < market.minOrderSize) {
    throw new OrderError(`Minimum order size is ${market.minOrderSize}`, 'ORDER_TOO_SMALL', 400);
  }

  if (quantity > market.maxOrderSize) {
    throw new OrderError(`Maximum order size is ${market.maxOrderSize}`, 'ORDER_TOO_LARGE', 400);
  }

  // Calcular costo estimado
  const price = orderType === 'market' ? (side === 'yes' ? 99 : 99) : limitPrice!;
  const estimatedCost = calculateOrderCost(price, quantity);
  const commission = calculateCommission(estimatedCost);
  const totalRequired = estimatedCost + commission;

  // Verificar balance
  const balance = await getWalletBalance(userId);
  if (balance.available < totalRequired) {
    throw new OrderError(
      `Insufficient balance. Required: S/${totalRequired.toFixed(2)}, Available: S/${balance.available.toFixed(2)}`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }

  // Verificar límite de posición
  const currentPosition = await getPosition(userId, marketId);
  const newPositionSize = (side === 'yes' ? currentPosition.yesQuantity : currentPosition.noQuantity) + quantity;
  if (newPositionSize > market.positionLimit) {
    throw new OrderError(
      `Position limit exceeded. Max: ${market.positionLimit}`,
      'POSITION_LIMIT_EXCEEDED',
      400
    );
  }

  // Ejecutar orden en transacción
  return transactionWithIsolation('SERIALIZABLE', async (client) => {
    // Bloquear fondos
    const escrowResult = await lockFundsForOrder(userId, totalRequired, uuidv4());

    // Crear orden
    const [order] = await client.query<Order>(`
      INSERT INTO orders (
        user_id, market_id, side, order_type, limit_price,
        quantity, estimated_cost, escrow_amount,
        status, submitted_at, submitted_from_ip, user_agent
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        'open', NOW(), $9, $10
      ) RETURNING *
    `, [
      userId, marketId, side, orderType, limitPrice || null,
      quantity, estimatedCost, totalRequired,
      metadata.ipAddress, metadata.userAgent
    ]);

    // Actualizar con transaction de escrow
    await client.query(`
      UPDATE orders SET escrow_transaction_id = $1 WHERE id = $2
    `, [escrowResult.transactionId, order.id]);

    // Intentar match
    const { trades, remainingQuantity } = await matchOrder(
      client,
      order.id,
      marketId,
      side,
      orderType,
      limitPrice || null,
      quantity,
      userId
    );

    // Actualizar orden según resultado
    const filledQuantity = quantity - remainingQuantity;
    let newStatus: OrderStatus = 'open';

    if (remainingQuantity === 0) {
      newStatus = 'filled';
    } else if (filledQuantity > 0) {
      newStatus = 'partially_filled';
    }

    // Si es market order y no se llenó completamente, cancelar el resto
    if (orderType === 'market' && remainingQuantity > 0) {
      newStatus = filledQuantity > 0 ? 'filled' : 'cancelled';
    }

    const avgFillPrice = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.price * t.quantity, 0) / filledQuantity
      : null;

    const actualCost = trades.reduce((sum, t) => sum + t.totalValue, 0);
    const totalCommission = trades.reduce((sum, t) => sum + t.takerCommission, 0);

    await client.query(`
      UPDATE orders SET
        status = $1,
        filled_quantity = $2,
        remaining_quantity = $3,
        avg_fill_price = $4,
        actual_cost = $5,
        commission = $6,
        filled_at = CASE WHEN $1 = 'filled' THEN NOW() ELSE NULL END,
        updated_at = NOW()
      WHERE id = $7
    `, [newStatus, filledQuantity, remainingQuantity, avgFillPrice, actualCost, totalCommission, order.id]);

    // Si quedó sin llenar o cancelada, liberar escrow sobrante
    if (newStatus === 'cancelled' || (orderType === 'market' && remainingQuantity > 0)) {
      const usedAmount = actualCost + totalCommission;
      const refundAmount = totalRequired - usedAmount;
      if (refundAmount > 0) {
        await releaseFundsFromEscrow(userId, refundAmount, order.id);
      }
    }

    // Log de auditoría
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'order.created', 'order', $2, 'Order created', $3)
    `, [userId, order.id, JSON.stringify({
      side, orderType, quantity, limitPrice,
      status: newStatus, filledQuantity, trades: trades.length
    })]);

    // Obtener orden actualizada
    const updatedOrder = await client.queryOne<Order>(`
      SELECT * FROM orders WHERE id = $1
    `, [order.id]);

    // Obtener posición actualizada
    const position = await getPosition(userId, marketId);

    return {
      order: mapOrderRow(updatedOrder!),
      trades,
      position,
      message: getOrderMessage(newStatus, filledQuantity, remainingQuantity)
    };
  });
}

// ============================================================================
// MATCHING ENGINE
// ============================================================================

/**
 * Intenta matchear una orden con órdenes existentes
 */
async function matchOrder(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  orderId: string,
  marketId: string,
  side: OrderSide,
  orderType: OrderType,
  limitPrice: number | null,
  quantity: number,
  userId: string
): Promise<{ trades: Trade[]; remainingQuantity: number }> {
  const trades: Trade[] = [];
  let remainingQuantity = quantity;

  // Buscar órdenes opuestas que puedan matchear
  // Para comprar YES a precio P, busco compradores de NO a precio (100-P) o mejor
  // Ejemplo: Quiero YES a 60 → busco NO a 40 o menos (40+60=100, ambos ganan)

  const oppositeSide: OrderSide = side === 'yes' ? 'no' : 'yes';

  // Para limit orders: el precio opuesto máximo aceptable
  // Si compro YES a 60, acepto NO hasta 40 (100-60)
  const maxOppositePrice = limitPrice ? 100 - limitPrice : null;

  // Ordenar por precio (mejor precio primero) y tiempo (FIFO)
  const priceOrder = oppositeSide === 'yes' ? 'DESC' : 'ASC';

  let matchQuery = `
    SELECT * FROM orders
    WHERE market_id = $1
      AND side = $2
      AND status IN ('open', 'partially_filled')
      AND user_id != $3
  `;
  const params: unknown[] = [marketId, oppositeSide, userId];
  let paramIndex = 4;

  if (orderType === 'limit' && maxOppositePrice !== null) {
    // Para órdenes límite, solo matchear si el precio opuesto es <= max
    matchQuery += ` AND limit_price <= $${paramIndex}`;
    params.push(maxOppositePrice);
    paramIndex++;
  }

  matchQuery += ` ORDER BY limit_price ${priceOrder}, created_at ASC`;

  const oppositeOrders = await client.query<Order>(matchQuery, params);

  for (const makerOrder of oppositeOrders) {
    if (remainingQuantity <= 0) break;

    const makerPrice = parseFloat(makerOrder.limit_price as unknown as string);
    const makerRemaining = parseInt(makerOrder.remaining_quantity as unknown as string);

    // Verificar que los precios sean compatibles
    // YES@60 matchea con NO@40 (60+40=100)
    if (limitPrice !== null && orderType === 'limit') {
      if (side === 'yes' && makerPrice > 100 - limitPrice) continue;
      if (side === 'no' && makerPrice > 100 - limitPrice) continue;
    }

    // Calcular cantidad a ejecutar
    const executeQuantity = Math.min(remainingQuantity, makerRemaining);

    // Precio de ejecución: precio del maker
    const executePrice = side === 'yes' ? 100 - makerPrice : makerPrice;

    // Crear trade
    const trade = await executeTrade(
      client,
      marketId,
      makerOrder.id,
      orderId,
      makerOrder.user_id,
      userId,
      side,
      executePrice,
      executeQuantity
    );

    trades.push(trade);
    remainingQuantity -= executeQuantity;

    // Actualizar orden del maker
    const newMakerFilled = parseInt(makerOrder.filled_quantity as unknown as string) + executeQuantity;
    const newMakerRemaining = makerRemaining - executeQuantity;
    const makerStatus: OrderStatus = newMakerRemaining === 0 ? 'filled' : 'partially_filled';

    await client.query(`
      UPDATE orders SET
        filled_quantity = $1,
        remaining_quantity = $2,
        status = $3,
        actual_cost = actual_cost + $4,
        commission = commission + $5,
        filled_at = CASE WHEN $3 = 'filled' THEN NOW() ELSE filled_at END,
        updated_at = NOW()
      WHERE id = $6
    `, [
      newMakerFilled,
      newMakerRemaining,
      makerStatus,
      executePrice * executeQuantity,
      trade.makerCommission,
      makerOrder.id
    ]);
  }

  return { trades, remainingQuantity };
}

/**
 * Ejecuta un trade entre dos órdenes
 */
async function executeTrade(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  marketId: string,
  makerOrderId: string,
  takerOrderId: string,
  makerUserId: string,
  takerUserId: string,
  takerSide: OrderSide,
  price: number,
  quantity: number
): Promise<Trade> {
  const totalValue = price * quantity;
  const makerCommission = calculateCommission(totalValue * 0.5); // Maker paga menos
  const takerCommission = calculateCommission(totalValue);

  // Crear registro de trade
  const [trade] = await client.query<Trade>(`
    INSERT INTO trades (
      market_id, maker_order_id, taker_order_id,
      maker_user_id, taker_user_id,
      side, price, quantity, total_value,
      maker_commission, taker_commission
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    ) RETURNING *
  `, [
    marketId, makerOrderId, takerOrderId,
    makerUserId, takerUserId,
    takerSide, price, quantity, totalValue,
    makerCommission, takerCommission
  ]);

  // Actualizar posiciones de ambos usuarios
  await updatePosition(client, makerUserId, marketId, takerSide === 'yes' ? 'no' : 'yes', price, quantity);
  await updatePosition(client, takerUserId, marketId, takerSide, price, quantity);

  // Actualizar estadísticas del mercado
  await updateMarketStats(marketId, price, quantity, takerSide);

  return mapTradeRow(trade);
}

/**
 * Actualiza la posición de un usuario después de un trade
 */
async function updatePosition(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  userId: string,
  marketId: string,
  side: OrderSide,
  price: number,
  quantity: number
): Promise<void> {
  // Verificar si existe posición
  const [existing] = await client.query<Position>(`
    SELECT * FROM positions WHERE user_id = $1 AND market_id = $2
  `, [userId, marketId]);

  if (!existing) {
    // Crear nueva posición
    if (side === 'yes') {
      await client.query(`
        INSERT INTO positions (user_id, market_id, yes_quantity, yes_avg_price, yes_cost, last_trade_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [userId, marketId, quantity, price, price * quantity]);
    } else {
      await client.query(`
        INSERT INTO positions (user_id, market_id, no_quantity, no_avg_price, no_cost, last_trade_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [userId, marketId, quantity, price, price * quantity]);
    }
  } else {
    // Actualizar posición existente
    if (side === 'yes') {
      const newQty = parseInt(existing.yes_quantity as unknown as string) + quantity;
      const oldCost = parseFloat(existing.yes_cost as unknown as string);
      const newCost = oldCost + price * quantity;
      const newAvgPrice = newCost / newQty;

      await client.query(`
        UPDATE positions SET
          yes_quantity = $1,
          yes_avg_price = $2,
          yes_cost = $3,
          last_trade_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $4 AND market_id = $5
      `, [newQty, newAvgPrice, newCost, userId, marketId]);
    } else {
      const newQty = parseInt(existing.no_quantity as unknown as string) + quantity;
      const oldCost = parseFloat(existing.no_cost as unknown as string);
      const newCost = oldCost + price * quantity;
      const newAvgPrice = newCost / newQty;

      await client.query(`
        UPDATE positions SET
          no_quantity = $1,
          no_avg_price = $2,
          no_cost = $3,
          last_trade_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $4 AND market_id = $5
      `, [newQty, newAvgPrice, newCost, userId, marketId]);
    }
  }
}

// ============================================================================
// CANCELAR ORDEN
// ============================================================================

/**
 * Cancela una orden abierta
 */
export async function cancelOrder(
  orderId: string,
  userId: string
): Promise<Order> {
  return transactionWithIsolation('SERIALIZABLE', async (client) => {
    // Obtener orden con lock
    const [order] = await client.query<Order>(`
      SELECT * FROM orders
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
    `, [orderId, userId]);

    if (!order) {
      throw new OrderError('Order not found', 'NOT_FOUND', 404);
    }

    if (!['open', 'partially_filled'].includes(order.status)) {
      throw new OrderError('Order cannot be cancelled', 'CANNOT_CANCEL', 400);
    }

    // Calcular monto a devolver
    const remainingQuantity = parseInt(order.remaining_quantity as unknown as string);
    const estimatedCost = parseFloat(order.estimated_cost as unknown as string);
    const actualCost = parseFloat(order.actual_cost as unknown as string);
    const filledQuantity = parseInt(order.filled_quantity as unknown as string);
    const totalQuantity = parseInt(order.quantity as unknown as string);

    const refundAmount = (estimatedCost / totalQuantity) * remainingQuantity;

    // Actualizar orden
    await client.query(`
      UPDATE orders SET
        status = 'cancelled',
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [orderId]);

    // Liberar fondos del escrow
    if (refundAmount > 0) {
      await releaseFundsFromEscrow(userId, refundAmount, orderId);
    }

    // Log
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'order.cancelled', 'order', $2, 'Order cancelled', $3)
    `, [userId, orderId, JSON.stringify({ refundAmount })]);

    // Retornar orden actualizada
    const [updated] = await client.query<Order>(`
      SELECT * FROM orders WHERE id = $1
    `, [orderId]);

    return mapOrderRow(updated);
  });
}

// ============================================================================
// CONSULTAS
// ============================================================================

/**
 * Obtiene las órdenes de un usuario con filtros y paginación
 */
export async function getUserOrders(
  userId: string,
  filters: OrderFilters = {}
): Promise<{
  orders: Order[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}> {
  const { status, marketId, side, page = 1, limit = 20 } = filters;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE user_id = $1';
  const params: unknown[] = [userId];
  let paramIndex = 2;

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (marketId) {
    whereClause += ` AND market_id = $${paramIndex}`;
    params.push(marketId);
    paramIndex++;
  }

  if (side) {
    whereClause += ` AND side = $${paramIndex}`;
    params.push(side);
    paramIndex++;
  }

  const [countResult] = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM orders ${whereClause}
  `, params);

  const total = parseInt(countResult.count);

  params.push(limit, offset);
  const orders = await query<Order>(`
    SELECT * FROM orders ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `, params);

  return {
    orders: orders.map(mapOrderRow),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

/**
 * Obtiene una orden por ID
 */
export async function getOrder(orderId: string, userId?: string): Promise<Order> {
  let queryStr = 'SELECT * FROM orders WHERE id = $1';
  const params: unknown[] = [orderId];

  if (userId) {
    queryStr += ' AND user_id = $2';
    params.push(userId);
  }

  const order = await queryOne<Order>(queryStr, params);

  if (!order) {
    throw new OrderError('Order not found', 'NOT_FOUND', 404);
  }

  return mapOrderRow(order);
}

/**
 * Obtiene la posición de un usuario en un mercado
 */
export async function getPosition(userId: string, marketId: string): Promise<Position> {
  const position = await queryOne<Position>(`
    SELECT * FROM positions WHERE user_id = $1 AND market_id = $2
  `, [userId, marketId]);

  if (!position) {
    return {
      userId,
      marketId,
      yesQuantity: 0,
      yesAvgPrice: 0,
      yesCost: 0,
      noQuantity: 0,
      noAvgPrice: 0,
      noCost: 0,
      totalInvested: 0,
      realizedPnl: 0,
      unrealizedPnl: 0
    };
  }

  return mapPositionRow(position);
}

/**
 * Obtiene todas las posiciones de un usuario
 */
export async function getUserPositions(
  userId: string,
  includeSettled: boolean = false
): Promise<Position[]> {
  let queryStr = `
    SELECT p.*, m.ticker, m.title, m.last_yes_price
    FROM positions p
    JOIN markets m ON m.id = p.market_id
    WHERE p.user_id = $1
  `;

  if (!includeSettled) {
    queryStr += ' AND (p.yes_quantity > 0 OR p.no_quantity > 0) AND (p.settled = false OR p.settled IS NULL)';
  }

  queryStr += ' ORDER BY p.last_trade_at DESC';

  const positions = await query<Position & { ticker: string; title: string; last_yes_price: string }>(
    queryStr,
    [userId]
  );

  return positions.map(p => {
    const pos = mapPositionRow(p);
    // Calcular P&L no realizado
    const lastPrice = p.last_yes_price ? parseFloat(p.last_yes_price) : 50;
    pos.unrealizedPnl =
      (pos.yesQuantity * lastPrice - pos.yesCost) +
      (pos.noQuantity * (100 - lastPrice) - pos.noCost);
    return pos;
  });
}

/**
 * Obtiene los trades de un usuario
 */
export async function getUserTrades(
  userId: string,
  options: { marketId?: string; page?: number; limit?: number } = {}
): Promise<{
  trades: Trade[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}> {
  const { marketId, page = 1, limit = 20 } = options;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE (maker_user_id = $1 OR taker_user_id = $1)';
  const params: unknown[] = [userId];
  let paramIndex = 2;

  if (marketId) {
    whereClause += ` AND market_id = $${paramIndex}`;
    params.push(marketId);
    paramIndex++;
  }

  const [countResult] = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM trades ${whereClause}
  `, params);

  const total = parseInt(countResult.count);

  params.push(limit, offset);
  const trades = await query<Trade>(`
    SELECT * FROM trades ${whereClause}
    ORDER BY executed_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `, params);

  return {
    trades: trades.map(mapTradeRow),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function calculateOrderCost(price: number, quantity: number): number {
  return price * quantity;
}

function calculateCommission(value: number): number {
  const commission = value * COMMISSION_RATE;
  return Math.max(commission, MIN_COMMISSION);
}

function getOrderMessage(status: OrderStatus, filled: number, remaining: number): string {
  if (status === 'filled') {
    return `Order filled: ${filled} contracts executed`;
  }
  if (status === 'partially_filled') {
    return `Order partially filled: ${filled} executed, ${remaining} remaining`;
  }
  if (status === 'cancelled') {
    return filled > 0
      ? `Order cancelled: ${filled} contracts executed before cancellation`
      : 'Order cancelled: no contracts executed';
  }
  return `Order placed: ${remaining} contracts pending`;
}

function mapOrderRow(row: Order): Order {
  return {
    id: row.id,
    userId: row.user_id as unknown as string,
    marketId: row.market_id as unknown as string,
    orderNumber: parseInt(row.order_number as unknown as string),
    side: row.side,
    orderType: row.order_type as unknown as OrderType,
    limitPrice: row.limit_price ? parseFloat(row.limit_price as unknown as string) : null,
    avgFillPrice: row.avg_fill_price ? parseFloat(row.avg_fill_price as unknown as string) : null,
    quantity: parseInt(row.quantity as unknown as string),
    filledQuantity: parseInt(row.filled_quantity as unknown as string),
    remainingQuantity: parseInt(row.remaining_quantity as unknown as string),
    estimatedCost: parseFloat(row.estimated_cost as unknown as string),
    actualCost: parseFloat(row.actual_cost as unknown as string),
    commission: parseFloat(row.commission as unknown as string),
    escrowAmount: parseFloat(row.escrow_amount as unknown as string),
    status: row.status,
    submittedAt: row.submitted_at as unknown as Date,
    filledAt: row.filled_at as unknown as Date | null
  };
}

function mapTradeRow(row: Trade): Trade {
  return {
    id: row.id,
    tradeNumber: parseInt(row.trade_number as unknown as string),
    marketId: row.market_id as unknown as string,
    makerOrderId: row.maker_order_id as unknown as string,
    takerOrderId: row.taker_order_id as unknown as string,
    makerUserId: row.maker_user_id as unknown as string,
    takerUserId: row.taker_user_id as unknown as string,
    side: row.side,
    price: parseFloat(row.price as unknown as string),
    quantity: parseInt(row.quantity as unknown as string),
    totalValue: parseFloat(row.total_value as unknown as string),
    makerCommission: parseFloat(row.maker_commission as unknown as string),
    takerCommission: parseFloat(row.taker_commission as unknown as string),
    executedAt: row.executed_at as unknown as Date
  };
}

function mapPositionRow(row: Position): Position {
  return {
    userId: row.user_id as unknown as string,
    marketId: row.market_id as unknown as string,
    yesQuantity: parseInt(row.yes_quantity as unknown as string || '0'),
    yesAvgPrice: parseFloat(row.yes_avg_price as unknown as string || '0'),
    yesCost: parseFloat(row.yes_cost as unknown as string || '0'),
    noQuantity: parseInt(row.no_quantity as unknown as string || '0'),
    noAvgPrice: parseFloat(row.no_avg_price as unknown as string || '0'),
    noCost: parseFloat(row.no_cost as unknown as string || '0'),
    totalInvested: parseFloat(row.total_invested as unknown as string || '0'),
    realizedPnl: parseFloat(row.realized_pnl as unknown as string || '0'),
    unrealizedPnl: 0  // Se calcula en runtime
  };
}

// ============================================================================
// FUNCIONES ADICIONALES
// ============================================================================

/**
 * Obtiene una orden por ID (alias para getOrder)
 */
export async function getOrderById(orderId: string, userId?: string): Promise<Order> {
  return getOrder(orderId, userId);
}

/**
 * Obtiene las órdenes de un usuario en un mercado específico
 */
export async function getUserOrdersInMarket(
  userId: string,
  marketId: string,
  status?: OrderStatus
): Promise<Order[]> {
  let queryStr = 'SELECT * FROM orders WHERE user_id = $1 AND market_id = $2';
  const params: unknown[] = [userId, marketId];

  if (status) {
    queryStr += ' AND status = $3';
    params.push(status);
  }

  queryStr += ' ORDER BY created_at DESC';

  const orders = await query<Order>(queryStr, params);
  return orders.map(mapOrderRow);
}

/**
 * Obtiene estadísticas de trading de un usuario
 */
export async function getUserTradingStats(userId: string): Promise<{
  totalOrders: number;
  filledOrders: number;
  cancelledOrders: number;
  totalTrades: number;
  totalVolume: number;
  totalCommissions: number;
  winRate: number;
  avgOrderSize: number;
}> {
  // Estadísticas de órdenes
  const orderStats = await queryOne<{
    total: string;
    filled: string;
    cancelled: string;
    avg_size: string;
    total_volume: string;
    total_commission: string;
  }>(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'filled') as filled,
      COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
      AVG(quantity) as avg_size,
      COALESCE(SUM(actual_cost), 0) as total_volume,
      COALESCE(SUM(commission), 0) as total_commission
    FROM orders
    WHERE user_id = $1
  `, [userId]);

  // Estadísticas de trades
  const tradeStats = await queryOne<{ total: string }>(`
    SELECT COUNT(*) as total
    FROM trades
    WHERE maker_user_id = $1 OR taker_user_id = $1
  `, [userId]);

  // Calcular win rate basado en posiciones liquidadas
  const pnlStats = await queryOne<{
    wins: string;
    total: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
      COUNT(*) as total
    FROM positions
    WHERE user_id = $1 AND settled = true
  `, [userId]);

  const wins = parseInt(pnlStats?.wins || '0');
  const totalSettled = parseInt(pnlStats?.total || '0');
  const winRate = totalSettled > 0 ? (wins / totalSettled) * 100 : 0;

  return {
    totalOrders: parseInt(orderStats?.total || '0'),
    filledOrders: parseInt(orderStats?.filled || '0'),
    cancelledOrders: parseInt(orderStats?.cancelled || '0'),
    totalTrades: parseInt(tradeStats?.total || '0'),
    totalVolume: parseFloat(orderStats?.total_volume || '0'),
    totalCommissions: parseFloat(orderStats?.total_commission || '0'),
    winRate,
    avgOrderSize: parseFloat(orderStats?.avg_size || '0')
  };
}

/**
 * Obtiene historial de P&L de un usuario
 */
export async function getUserPnLHistory(
  userId: string,
  period: string = '30d'
): Promise<{
  dates: string[];
  pnl: number[];
  cumulative: number[];
}> {
  // Calcular fecha de inicio basada en período
  const periodDays = parseInt(period.replace('d', '')) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  // Obtener trades agrupados por día
  const results = await query<{
    date: string;
    daily_pnl: string;
  }>(`
    SELECT
      DATE(executed_at) as date,
      SUM(
        CASE
          WHEN taker_user_id = $1 THEN -taker_commission
          WHEN maker_user_id = $1 THEN -maker_commission
          ELSE 0
        END
      ) as daily_pnl
    FROM trades
    WHERE (maker_user_id = $1 OR taker_user_id = $1)
      AND executed_at >= $2
    GROUP BY DATE(executed_at)
    ORDER BY date
  `, [userId, startDate]);

  // Obtener P&L de posiciones liquidadas
  const settledPnL = await query<{
    date: string;
    pnl: string;
  }>(`
    SELECT
      DATE(settled_at) as date,
      SUM(realized_pnl) as pnl
    FROM positions
    WHERE user_id = $1
      AND settled = true
      AND settled_at >= $2
    GROUP BY DATE(settled_at)
    ORDER BY date
  `, [userId, startDate]);

  // Combinar datos
  const pnlByDate: Map<string, number> = new Map();

  for (const row of results) {
    const date = row.date;
    pnlByDate.set(date, (pnlByDate.get(date) || 0) + parseFloat(row.daily_pnl));
  }

  for (const row of settledPnL) {
    const date = row.date;
    pnlByDate.set(date, (pnlByDate.get(date) || 0) + parseFloat(row.pnl));
  }

  // Generar arrays
  const dates = Array.from(pnlByDate.keys()).sort();
  const pnl = dates.map(d => pnlByDate.get(d) || 0);
  const cumulative: number[] = [];
  let cumSum = 0;
  for (const p of pnl) {
    cumSum += p;
    cumulative.push(cumSum);
  }

  return { dates, pnl, cumulative };
}

// ============================================================================
// ERROR
// ============================================================================

export class OrderError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'OrderError';
  }
}
