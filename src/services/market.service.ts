/**
 * KALSHI PERÚ - Servicio de Mercados
 *
 * Gestión de mercados de predicción (eventos).
 * Un mercado representa una pregunta binaria: "¿Ocurrirá X?"
 *
 * CONCEPTOS CLAVE:
 * - Contrato YES: Paga S/100 si el evento ocurre
 * - Contrato NO: Paga S/100 si el evento NO ocurre
 * - Precio: Representa probabilidad implícita (ej: S/60 = 60% prob)
 * - YES + NO siempre suma S/100 (arbitraje)
 *
 * CICLO DE VIDA:
 * draft → scheduled → open → closed → settled
 *                          ↓
 *                     suspended → open
 *                          ↓
 *                     cancelled
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction } from '../config/database.config';
import { MarketStatus, MarketOutcome } from '../types/database.types';

// ============================================================================
// TIPOS
// ============================================================================

export interface CreateMarketInput {
  ticker: string;
  title: string;
  description?: string;
  category: string;
  subcategory?: string;
  tags?: string[];
  resolutionSource: string;
  resolutionCriteria: string;
  closesAt: Date;
  settlementDate: Date;
  minPrice?: number;
  maxPrice?: number;
  tickSize?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
  positionLimit?: number;
}

export interface Market {
  id: string;
  ticker: string;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  resolutionSource: string;
  resolutionCriteria: string;
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  minOrderSize: number;
  maxOrderSize: number;
  positionLimit: number;
  contractValue: number;
  scheduledOpenAt: Date | null;
  openedAt: Date | null;
  closesAt: Date;
  settlementDate: Date;
  settledAt: Date | null;
  status: MarketStatus;
  outcome: MarketOutcome | null;
  lastYesPrice: number | null;
  lastNoPrice: number | null;
  volume24h: number;
  totalVolume: number;
  openInterest: number;
  createdAt: Date;
}

export interface MarketSummary {
  id: string;
  ticker: string;
  title: string;
  category: string;
  status: MarketStatus;
  lastYesPrice: number | null;
  lastNoPrice: number | null;
  volume24h: number;
  closesAt: Date;
  impliedProbability: number | null;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

export interface OrderBook {
  marketId: string;
  ticker: string;
  bids: OrderBookLevel[];   // Órdenes de compra YES
  asks: OrderBookLevel[];   // Órdenes de venta YES (compra NO)
  yesBids: OrderBookLevel[];  // Órdenes de compra YES (demanda)
  noAsks: OrderBookLevel[];   // Órdenes de compra NO (equivale a vender YES)
  lastYesPrice: number | null;
  lastNoPrice: number | null;
  spread: number | null;
}

export interface MarketFilters {
  status?: MarketStatus;
  category?: string;
  search?: string;
  sortBy?: 'created_at' | 'volume' | 'closes_at';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface MarketDetail extends Market {
  yesPrice: number;
  noPrice: number;
  priceChange24h: number;
  lastTradePrice: number | null;
}

// ============================================================================
// CREACIÓN DE MERCADOS (Admin)
// ============================================================================

/**
 * Crea un nuevo mercado de predicción
 */
export async function createMarket(
  input: CreateMarketInput,
  createdBy: string
): Promise<Market> {
  // Validaciones
  if (input.closesAt <= new Date()) {
    throw new MarketError('Close date must be in the future', 'INVALID_CLOSE_DATE', 400);
  }

  if (input.settlementDate < input.closesAt) {
    throw new MarketError('Settlement date must be after close date', 'INVALID_SETTLEMENT_DATE', 400);
  }

  // Verificar ticker único
  const existing = await queryOne<{ id: string }>(`
    SELECT id FROM markets WHERE ticker = $1
  `, [input.ticker.toUpperCase()]);

  if (existing) {
    throw new MarketError('Ticker already exists', 'TICKER_EXISTS', 409);
  }

  const [market] = await query<Market>(`
    INSERT INTO markets (
      ticker, title, description, category, subcategory, tags,
      resolution_source, resolution_criteria,
      min_price, max_price, tick_size,
      min_order_size, max_order_size, position_limit,
      closes_at, settlement_date,
      status, created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, $16,
      'draft', $17
    ) RETURNING *
  `, [
    input.ticker.toUpperCase(),
    input.title,
    input.description || null,
    input.category,
    input.subcategory || null,
    JSON.stringify(input.tags || []),
    input.resolutionSource,
    input.resolutionCriteria,
    input.minPrice || 1,
    input.maxPrice || 99,
    input.tickSize || 1,
    input.minOrderSize || 1,
    input.maxOrderSize || 10000,
    input.positionLimit || 50000,
    input.closesAt,
    input.settlementDate,
    createdBy
  ]);

  // Log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description, metadata
    ) VALUES ($1, 'market.created', 'market', $2, 'Market created', $3)
  `, [createdBy, market.id, JSON.stringify({ ticker: input.ticker })]);

  return mapMarketRow(market);
}

/**
 * Abre un mercado para trading
 */
export async function openMarket(
  marketId: string,
  adminId: string
): Promise<Market> {
  const [market] = await query<Market>(`
    UPDATE markets SET
      status = 'open',
      opened_at = NOW(),
      updated_at = NOW()
    WHERE id = $1 AND status IN ('draft', 'scheduled')
    RETURNING *
  `, [marketId]);

  if (!market) {
    throw new MarketError('Market not found or cannot be opened', 'CANNOT_OPEN', 400);
  }

  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description
    ) VALUES ($1, 'market.opened', 'market', $2, 'Market opened for trading')
  `, [adminId, marketId]);

  return mapMarketRow(market);
}

/**
 * Suspende un mercado temporalmente
 */
export async function suspendMarket(
  marketId: string,
  adminId: string,
  reason: string
): Promise<Market> {
  const [market] = await query<Market>(`
    UPDATE markets SET
      status = 'suspended',
      updated_at = NOW(),
      metadata = metadata || $1
    WHERE id = $2 AND status = 'open'
    RETURNING *
  `, [JSON.stringify({ suspensionReason: reason }), marketId]);

  if (!market) {
    throw new MarketError('Market not found or cannot be suspended', 'CANNOT_SUSPEND', 400);
  }

  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description, metadata
    ) VALUES ($1, 'market.suspended', 'market', $2, 'Market suspended', $3)
  `, [adminId, marketId, JSON.stringify({ reason })]);

  return mapMarketRow(market);
}

/**
 * Cierra un mercado para nuevas órdenes
 */
export async function closeMarket(
  marketId: string,
  adminId: string
): Promise<Market> {
  const [market] = await query<Market>(`
    UPDATE markets SET
      status = 'closed',
      updated_at = NOW()
    WHERE id = $1 AND status = 'open'
    RETURNING *
  `, [marketId]);

  if (!market) {
    throw new MarketError('Market not found or cannot be closed', 'CANNOT_CLOSE', 400);
  }

  // Cancelar todas las órdenes abiertas
  await query(`
    UPDATE orders SET
      status = 'cancelled',
      cancelled_at = NOW(),
      rejection_reason = 'Market closed'
    WHERE market_id = $1 AND status IN ('open', 'partially_filled')
  `, [marketId]);

  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description
    ) VALUES ($1, 'market.closed', 'market', $2, 'Market closed for trading')
  `, [adminId, marketId]);

  return mapMarketRow(market);
}

// ============================================================================
// CONSULTAS DE MERCADOS
// ============================================================================

/**
 * Obtiene un mercado por ID
 */
export async function getMarket(marketId: string): Promise<Market> {
  const market = await queryOne<Market>(`
    SELECT * FROM markets WHERE id = $1
  `, [marketId]);

  if (!market) {
    throw new MarketError('Market not found', 'NOT_FOUND', 404);
  }

  return mapMarketRow(market);
}

/**
 * Obtiene un mercado por ticker
 */
export async function getMarketByTicker(ticker: string): Promise<Market> {
  const market = await queryOne<Market>(`
    SELECT * FROM markets WHERE ticker = $1
  `, [ticker.toUpperCase()]);

  if (!market) {
    throw new MarketError('Market not found', 'NOT_FOUND', 404);
  }

  return mapMarketRow(market);
}

/**
 * Lista mercados con filtros
 */
export async function listMarkets(options: {
  status?: MarketStatus;
  category?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'volume' | 'closes_at' | 'created_at';
}): Promise<{ markets: MarketSummary[]; total: number }> {
  const { status, category, limit = 20, offset = 0, orderBy = 'volume' } = options;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (category) {
    whereClause += ` AND category = $${paramIndex}`;
    params.push(category);
    paramIndex++;
  }

  // Ordenamiento
  const orderClause = {
    volume: 'volume_24h DESC',
    closes_at: 'closes_at ASC',
    created_at: 'created_at DESC'
  }[orderBy];

  // Contar total
  const [countResult] = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM markets ${whereClause}
  `, params);

  // Obtener mercados
  params.push(limit, offset);
  const markets = await query<Market>(`
    SELECT * FROM markets ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `, params);

  return {
    markets: markets.map(m => ({
      id: m.id,
      ticker: m.ticker,
      title: m.title,
      category: m.category,
      status: m.status,
      lastYesPrice: m.last_yes_price ? parseFloat(m.last_yes_price as unknown as string) : null,
      lastNoPrice: m.last_no_price ? parseFloat(m.last_no_price as unknown as string) : null,
      volume24h: parseInt(m.volume_24h as unknown as string),
      closesAt: m.closes_at,
      impliedProbability: m.last_yes_price ? parseFloat(m.last_yes_price as unknown as string) / 100 : null
    })),
    total: parseInt(countResult.count)
  };
}

/**
 * Obtiene mercados destacados (más volumen)
 */
export async function getFeaturedMarkets(limit: number = 10): Promise<MarketSummary[]> {
  const { markets } = await listMarkets({
    status: 'open',
    limit,
    orderBy: 'volume'
  });
  return markets;
}

/**
 * Obtiene mercados por categoría
 */
export async function getMarketsByCategory(category: string): Promise<MarketSummary[]> {
  const { markets } = await listMarkets({
    category,
    status: 'open',
    orderBy: 'volume'
  });
  return markets;
}

/**
 * Obtiene las categorías disponibles
 */
export async function getCategories(): Promise<{ category: string; count: number }[]> {
  const categories = await query<{ category: string; count: string }>(`
    SELECT category, COUNT(*) as count
    FROM markets
    WHERE status = 'open'
    GROUP BY category
    ORDER BY count DESC
  `);

  return categories.map(c => ({
    category: c.category,
    count: parseInt(c.count)
  }));
}

// ============================================================================
// ORDER BOOK
// ============================================================================

/**
 * Obtiene el order book de un mercado
 */
export async function getOrderBook(marketId: string): Promise<OrderBook> {
  const market = await getMarket(marketId);

  // Obtener órdenes de compra YES (bids)
  const yesBids = await query<{ price: string; quantity: string; order_count: string }>(`
    SELECT
      limit_price as price,
      SUM(remaining_quantity) as quantity,
      COUNT(*) as order_count
    FROM orders
    WHERE market_id = $1
      AND side = 'yes'
      AND status IN ('open', 'partially_filled')
    GROUP BY limit_price
    ORDER BY limit_price DESC
    LIMIT 10
  `, [marketId]);

  // Obtener órdenes de compra NO (asks - equivale a vender YES)
  const noAsks = await query<{ price: string; quantity: string; order_count: string }>(`
    SELECT
      limit_price as price,
      SUM(remaining_quantity) as quantity,
      COUNT(*) as order_count
    FROM orders
    WHERE market_id = $1
      AND side = 'no'
      AND status IN ('open', 'partially_filled')
    GROUP BY limit_price
    ORDER BY limit_price ASC
    LIMIT 10
  `, [marketId]);

  // Calcular spread
  const bestBid = yesBids[0] ? parseFloat(yesBids[0].price) : null;
  const bestAsk = noAsks[0] ? 100 - parseFloat(noAsks[0].price) : null;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

  const bids = yesBids.map(b => ({
    price: parseFloat(b.price),
    quantity: parseInt(b.quantity),
    orderCount: parseInt(b.order_count)
  }));

  const asks = noAsks.map(a => ({
    price: 100 - parseFloat(a.price), // Convertir precio NO a precio YES equivalente
    quantity: parseInt(a.quantity),
    orderCount: parseInt(a.order_count)
  }));

  return {
    marketId,
    ticker: market.ticker,
    bids,
    asks,
    yesBids: bids,
    noAsks: noAsks.map(a => ({
      price: parseFloat(a.price),
      quantity: parseInt(a.quantity),
      orderCount: parseInt(a.order_count)
    })),
    lastYesPrice: market.lastYesPrice,
    lastNoPrice: market.lastNoPrice,
    spread
  };
}

/**
 * Obtiene el historial de precios de un mercado
 */
export async function getPriceHistory(
  marketId: string,
  interval: '1h' | '1d' | '1w' = '1h',
  limit: number = 100
): Promise<{
  timestamp: Date;
  yesPrice: number;
  noPrice: number;
  volume: number;
}[]> {
  // Agrupar trades por intervalo
  const intervalSql = {
    '1h': "date_trunc('hour', executed_at)",
    '1d': "date_trunc('day', executed_at)",
    '1w': "date_trunc('week', executed_at)"
  }[interval];

  const history = await query<{
    bucket: Date;
    avg_price: string;
    volume: string;
  }>(`
    SELECT
      ${intervalSql} as bucket,
      AVG(price) as avg_price,
      SUM(quantity) as volume
    FROM trades
    WHERE market_id = $1
    GROUP BY bucket
    ORDER BY bucket DESC
    LIMIT $2
  `, [marketId, limit]);

  return history.map(h => ({
    timestamp: h.bucket,
    yesPrice: parseFloat(h.avg_price),
    noPrice: 100 - parseFloat(h.avg_price),
    volume: parseInt(h.volume)
  })).reverse();
}

// ============================================================================
// ESTADÍSTICAS
// ============================================================================

/**
 * Actualiza las estadísticas de un mercado después de un trade
 */
export async function updateMarketStats(
  marketId: string,
  tradePrice: number,
  tradeQuantity: number,
  tradeSide: 'yes' | 'no'
): Promise<void> {
  const yesPrice = tradeSide === 'yes' ? tradePrice : 100 - tradePrice;
  const noPrice = 100 - yesPrice;

  await query(`
    UPDATE markets SET
      last_yes_price = $1,
      last_no_price = $2,
      volume_24h = volume_24h + $3,
      total_volume = total_volume + $3,
      updated_at = NOW()
    WHERE id = $4
  `, [yesPrice, noPrice, tradeQuantity, marketId]);
}

/**
 * Recalcula el open interest de un mercado
 */
export async function recalculateOpenInterest(marketId: string): Promise<number> {
  // Open interest = suma de posiciones YES (o NO, son simétricas)
  const [result] = await query<{ total: string }>(`
    SELECT COALESCE(SUM(yes_quantity), 0) as total
    FROM positions
    WHERE market_id = $1
  `, [marketId]);

  const openInterest = parseInt(result.total);

  await query(`
    UPDATE markets SET open_interest = $1, updated_at = NOW()
    WHERE id = $2
  `, [openInterest, marketId]);

  return openInterest;
}

// ============================================================================
// HELPERS
// ============================================================================

function mapMarketRow(row: Market): Market {
  return {
    id: row.id,
    ticker: row.ticker,
    title: row.title,
    description: row.description,
    category: row.category,
    subcategory: row.subcategory,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags as unknown as string) : row.tags,
    resolutionSource: row.resolution_source as unknown as string,
    resolutionCriteria: row.resolution_criteria as unknown as string,
    minPrice: parseFloat(row.min_price as unknown as string),
    maxPrice: parseFloat(row.max_price as unknown as string),
    tickSize: parseFloat(row.tick_size as unknown as string),
    minOrderSize: parseInt(row.min_order_size as unknown as string),
    maxOrderSize: parseInt(row.max_order_size as unknown as string),
    positionLimit: parseInt(row.position_limit as unknown as string),
    contractValue: parseFloat(row.contract_value as unknown as string),
    scheduledOpenAt: row.scheduled_open_at,
    openedAt: row.opened_at,
    closesAt: row.closes_at,
    settlementDate: row.settlement_date,
    settledAt: row.settled_at,
    status: row.status,
    outcome: row.outcome,
    lastYesPrice: row.last_yes_price ? parseFloat(row.last_yes_price as unknown as string) : null,
    lastNoPrice: row.last_no_price ? parseFloat(row.last_no_price as unknown as string) : null,
    volume24h: parseInt(row.volume_24h as unknown as string || '0'),
    totalVolume: parseInt(row.total_volume as unknown as string || '0'),
    openInterest: parseInt(row.open_interest as unknown as string || '0'),
    createdAt: row.created_at
  };
}

// ============================================================================
// FUNCIONES ADICIONALES PARA RUTAS
// ============================================================================

/**
 * Alias de getMarket para las rutas
 */
export async function getMarketById(marketId: string): Promise<MarketDetail> {
  const market = await getMarket(marketId);

  // Calcular cambio de precio en 24h
  const priceHistory = await query<{ price: string }>(`
    SELECT price FROM trades
    WHERE market_id = $1
      AND executed_at >= NOW() - INTERVAL '24 hours'
    ORDER BY executed_at ASC
    LIMIT 1
  `, [marketId]);

  const oldPrice = priceHistory.length > 0 ? parseFloat(priceHistory[0].price) : market.lastYesPrice || 50;
  const currentPrice = market.lastYesPrice || 50;
  const priceChange24h = currentPrice - oldPrice;

  return {
    ...market,
    yesPrice: market.lastYesPrice || 50,
    noPrice: market.lastNoPrice || 50,
    priceChange24h,
    lastTradePrice: market.lastYesPrice
  };
}

/**
 * Obtiene mercados con filtros y paginación (para rutas)
 */
export async function getMarkets(filters: MarketFilters): Promise<{
  markets: MarketSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}> {
  const {
    status,
    category,
    search,
    sortBy = 'created_at',
    sortOrder = 'desc',
    page = 1,
    limit = 20
  } = filters;

  const offset = (page - 1) * limit;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (category) {
    whereClause += ` AND category = $${paramIndex}`;
    params.push(category);
    paramIndex++;
  }

  if (search) {
    whereClause += ` AND (title ILIKE $${paramIndex} OR ticker ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  // Ordenamiento
  const sortColumn = {
    created_at: 'created_at',
    volume: 'volume_24h',
    closes_at: 'closes_at'
  }[sortBy] || 'created_at';

  const orderClause = `${sortColumn} ${sortOrder.toUpperCase()}`;

  // Contar total
  const [countResult] = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM markets ${whereClause}
  `, params);

  const total = parseInt(countResult.count);

  // Obtener mercados
  params.push(limit, offset);
  const markets = await query<Market>(`
    SELECT * FROM markets ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `, params);

  return {
    markets: markets.map(m => ({
      id: m.id,
      ticker: m.ticker,
      title: m.title,
      category: m.category,
      status: m.status,
      lastYesPrice: m.last_yes_price ? parseFloat(m.last_yes_price as unknown as string) : null,
      lastNoPrice: m.last_no_price ? parseFloat(m.last_no_price as unknown as string) : null,
      volume24h: parseInt(m.volume_24h as unknown as string || '0'),
      closesAt: m.closes_at as unknown as Date,
      impliedProbability: m.last_yes_price ? parseFloat(m.last_yes_price as unknown as string) / 100 : null
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

/**
 * Obtiene trades de un mercado
 */
export async function getMarketTrades(
  marketId: string,
  limit: number = 50,
  offset: number = 0
): Promise<{
  id: string;
  price: number;
  quantity: number;
  side: 'yes' | 'no';
  executedAt: Date;
}[]> {
  const trades = await query<{
    id: string;
    price: string;
    quantity: string;
    side: string;
    executed_at: Date;
  }>(`
    SELECT id, price, quantity, side, executed_at
    FROM trades
    WHERE market_id = $1
    ORDER BY executed_at DESC
    LIMIT $2 OFFSET $3
  `, [marketId, limit, offset]);

  return trades.map(t => ({
    id: t.id,
    price: parseFloat(t.price),
    quantity: parseInt(t.quantity),
    side: t.side as 'yes' | 'no',
    executedAt: t.executed_at
  }));
}

/**
 * Actualiza un mercado (solo en estado draft)
 */
export async function updateMarket(
  marketId: string,
  updates: Partial<CreateMarketInput>,
  adminId: string
): Promise<Market> {
  // Verificar que el mercado existe y está en draft
  const existing = await getMarket(marketId);

  if (existing.status !== 'draft') {
    throw new MarketError(
      'Solo se pueden editar mercados en estado draft',
      'CANNOT_UPDATE',
      400
    );
  }

  // Construir query de actualización
  const updateFields: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (updates.title) {
    updateFields.push(`title = $${paramIndex}`);
    params.push(updates.title);
    paramIndex++;
  }

  if (updates.description !== undefined) {
    updateFields.push(`description = $${paramIndex}`);
    params.push(updates.description);
    paramIndex++;
  }

  if (updates.category) {
    updateFields.push(`category = $${paramIndex}`);
    params.push(updates.category);
    paramIndex++;
  }

  if (updates.resolutionCriteria) {
    updateFields.push(`resolution_criteria = $${paramIndex}`);
    params.push(updates.resolutionCriteria);
    paramIndex++;
  }

  if (updates.closesAt) {
    updateFields.push(`closes_at = $${paramIndex}`);
    params.push(updates.closesAt);
    paramIndex++;
  }

  if (updates.settlementDate) {
    updateFields.push(`settlement_date = $${paramIndex}`);
    params.push(updates.settlementDate);
    paramIndex++;
  }

  if (updates.tags) {
    updateFields.push(`tags = $${paramIndex}`);
    params.push(JSON.stringify(updates.tags));
    paramIndex++;
  }

  if (updateFields.length === 0) {
    return existing;
  }

  updateFields.push('updated_at = NOW()');
  params.push(marketId);

  const [market] = await query<Market>(`
    UPDATE markets SET ${updateFields.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
  `, params);

  // Log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description, metadata
    ) VALUES ($1, 'market.updated', 'market', $2, 'Market updated', $3)
  `, [adminId, marketId, JSON.stringify(updates)]);

  return mapMarketRow(market);
}

/**
 * Programa la apertura de un mercado
 */
export async function scheduleMarket(
  marketId: string,
  openDate: Date,
  adminId: string
): Promise<Market> {
  if (openDate <= new Date()) {
    throw new MarketError('La fecha de apertura debe ser futura', 'INVALID_DATE', 400);
  }

  const [market] = await query<Market>(`
    UPDATE markets SET
      status = 'scheduled',
      scheduled_open_at = $1,
      updated_at = NOW()
    WHERE id = $2 AND status = 'draft'
    RETURNING *
  `, [openDate, marketId]);

  if (!market) {
    throw new MarketError('Mercado no encontrado o no puede ser programado', 'CANNOT_SCHEDULE', 400);
  }

  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id, description, metadata
    ) VALUES ($1, 'market.scheduled', 'market', $2, 'Market scheduled', $3)
  `, [adminId, marketId, JSON.stringify({ openDate: openDate.toISOString() })]);

  return mapMarketRow(market);
}

// ============================================================================
// ERROR
// ============================================================================

export class MarketError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'MarketError';
  }
}
