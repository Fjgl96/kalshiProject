/**
 * RUTAS DE ÓRDENES DE TRADING
 *
 * Endpoints para gestión de órdenes en mercados de predicción
 *
 * ENDPOINTS:
 * POST   /orders           - Crear nueva orden
 * GET    /orders           - Listar mis órdenes
 * GET    /orders/:id       - Detalle de orden
 * DELETE /orders/:id       - Cancelar orden
 * GET    /positions        - Listar mis posiciones
 * GET    /trades           - Historial de mis trades
 * GET    /stats            - Estadísticas de trading
 *
 * SEGURIDAD:
 * - Todas las rutas requieren autenticación
 * - KYC verificado requerido para trading
 * - Validación de fondos disponibles
 * - Límites de orden por mercado
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import {
  authenticateToken,
  requireKYC,
  AuthenticatedRequest
} from '../../middleware/auth.middleware';
import * as OrderService from '../../services/order.service';
import * as MarketService from '../../services/market.service';

const router = Router();

// ============================================================================
// RATE LIMITING
// ============================================================================

// Límite estricto para creación de órdenes
const orderCreationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // 30 órdenes por minuto
  message: {
    error: 'Límite de órdenes excedido. Espere un momento.',
    code: 'ORDER_RATE_LIMIT'
  }
});

// Límite para consultas
const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas solicitudes', code: 'RATE_LIMIT' }
});

// ============================================================================
// CREAR ORDEN
// ============================================================================

/**
 * POST /orders
 * Crear nueva orden de compra
 */
router.post(
  '/',
  authenticateToken,
  requireKYC,
  orderCreationLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const {
        marketId,
        side,
        orderType,
        quantity,
        price,
        expiresAt
      } = req.body;

      // Validaciones básicas
      if (!marketId) {
        res.status(400).json({
          success: false,
          error: 'El ID del mercado es requerido',
          code: 'MISSING_MARKET_ID'
        });
        return;
      }

      if (!side || !['yes', 'no'].includes(side)) {
        res.status(400).json({
          success: false,
          error: 'El lado debe ser "yes" o "no"',
          code: 'INVALID_SIDE'
        });
        return;
      }

      if (!orderType || !['market', 'limit'].includes(orderType)) {
        res.status(400).json({
          success: false,
          error: 'El tipo de orden debe ser "market" o "limit"',
          code: 'INVALID_ORDER_TYPE'
        });
        return;
      }

      if (!quantity || quantity < 1) {
        res.status(400).json({
          success: false,
          error: 'La cantidad debe ser al menos 1',
          code: 'INVALID_QUANTITY'
        });
        return;
      }

      if (orderType === 'limit') {
        if (!price || price < 1 || price > 99) {
          res.status(400).json({
            success: false,
            error: 'El precio límite debe estar entre 1 y 99 centavos',
            code: 'INVALID_PRICE'
          });
          return;
        }
      }

      // Obtener IP del request
      const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || '0.0.0.0';

      const result = await OrderService.createOrder(
        {
          marketId,
          side,
          orderType,
          quantity: parseInt(quantity),
          price: price ? parseInt(price) : undefined,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined
        },
        {
          userId: req.user!.userId,
          ipAddress
        }
      );

      res.status(201).json({
        success: true,
        data: {
          order: result.order,
          trades: result.trades,
          position: result.position
        },
        message: result.trades.length > 0
          ? `Orden creada. ${result.trades.length} trade(s) ejecutado(s).`
          : 'Orden creada y añadida al order book.'
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// CONSULTAR ÓRDENES
// ============================================================================

/**
 * GET /orders
 * Listar mis órdenes con filtros
 */
router.get(
  '/',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filters: OrderService.OrderFilters = {
        marketId: req.query.marketId as string,
        status: req.query.status as any,
        side: req.query.side as any,
        page: parseInt(req.query.page as string) || 1,
        limit: Math.min(parseInt(req.query.limit as string) || 20, 100)
      };

      const result = await OrderService.getUserOrders(req.user!.userId, filters);

      res.json({
        success: true,
        data: result.orders,
        pagination: result.pagination
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /orders/:id
 * Obtener detalle de una orden
 */
router.get(
  '/:id',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const order = await OrderService.getOrderById(req.params.id, req.user!.userId);

      res.json({
        success: true,
        data: order
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /orders/:id
 * Cancelar una orden pendiente
 */
router.delete(
  '/:id',
  authenticateToken,
  orderCreationLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const order = await OrderService.cancelOrder(req.params.id, req.user!.userId);

      res.json({
        success: true,
        data: order,
        message: 'Orden cancelada. Fondos liberados.'
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// POSICIONES
// ============================================================================

/**
 * GET /positions
 * Listar todas mis posiciones activas
 */
router.get(
  '/positions/all',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const includeSettled = req.query.includeSettled === 'true';
      const positions = await OrderService.getUserPositions(req.user!.userId, includeSettled);

      res.json({
        success: true,
        data: positions
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /positions/:marketId
 * Obtener mi posición en un mercado específico
 */
router.get(
  '/positions/:marketId',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const position = await OrderService.getPosition(req.user!.userId, req.params.marketId);

      res.json({
        success: true,
        data: position
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// TRADES
// ============================================================================

/**
 * GET /trades
 * Historial de mis trades
 */
router.get(
  '/trades/history',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filters = {
        marketId: req.query.marketId as string,
        page: parseInt(req.query.page as string) || 1,
        limit: Math.min(parseInt(req.query.limit as string) || 20, 100)
      };

      const result = await OrderService.getUserTrades(req.user!.userId, filters);

      res.json({
        success: true,
        data: result.trades,
        pagination: result.pagination
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// ESTADÍSTICAS
// ============================================================================

/**
 * GET /stats
 * Estadísticas de trading del usuario
 */
router.get(
  '/stats/summary',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const stats = await OrderService.getUserTradingStats(req.user!.userId);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /stats/pnl
 * Profit/Loss detallado
 */
router.get(
  '/stats/pnl',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const period = (req.query.period as string) || '30d';
      const pnl = await OrderService.getUserPnLHistory(req.user!.userId, period);

      res.json({
        success: true,
        data: pnl
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// ORDEN RÁPIDA (PRECIO DE MERCADO)
// ============================================================================

/**
 * POST /orders/quick-buy
 * Compra rápida al precio de mercado
 */
router.post(
  '/quick-buy',
  authenticateToken,
  requireKYC,
  orderCreationLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { marketId, side, amount } = req.body;

      if (!marketId || !side || !amount) {
        res.status(400).json({
          success: false,
          error: 'marketId, side y amount son requeridos',
          code: 'MISSING_FIELDS'
        });
        return;
      }

      // Obtener precio actual del mercado
      const market = await MarketService.getMarketById(marketId);
      const currentPrice = side === 'yes' ? market.yesPrice : market.noPrice;

      // Calcular cantidad basada en monto
      const quantity = Math.floor((amount * 100) / currentPrice);

      if (quantity < 1) {
        res.status(400).json({
          success: false,
          error: 'El monto es muy pequeño para comprar al menos 1 contrato',
          code: 'AMOUNT_TOO_SMALL'
        });
        return;
      }

      const ipAddress = req.ip || req.headers['x-forwarded-for'] as string || '0.0.0.0';

      const result = await OrderService.createOrder(
        {
          marketId,
          side,
          orderType: 'market',
          quantity
        },
        {
          userId: req.user!.userId,
          ipAddress
        }
      );

      res.status(201).json({
        success: true,
        data: {
          order: result.order,
          trades: result.trades,
          position: result.position,
          estimatedCost: quantity * currentPrice
        },
        message: `Comprados ${quantity} contratos ${side.toUpperCase()}`
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// PREVIEW DE ORDEN
// ============================================================================

/**
 * POST /orders/preview
 * Preview de orden sin ejecutar
 */
router.post(
  '/preview',
  authenticateToken,
  queryLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { marketId, side, orderType, quantity, price } = req.body;

      // Obtener order book
      const orderBook = await MarketService.getOrderBook(marketId);
      const market = await MarketService.getMarketById(marketId);

      let estimatedPrice: number;
      let estimatedCost: number;
      let estimatedFill: number;

      if (orderType === 'market') {
        // Simular ejecución de mercado
        const oppositeSide = side === 'yes' ? orderBook.asks : orderBook.bids;
        let remainingQty = quantity;
        let totalCost = 0;

        for (const level of oppositeSide) {
          const fillQty = Math.min(remainingQty, level.quantity);
          totalCost += fillQty * level.price;
          remainingQty -= fillQty;
          if (remainingQty <= 0) break;
        }

        estimatedFill = quantity - remainingQty;
        estimatedCost = totalCost;
        estimatedPrice = estimatedFill > 0 ? Math.round(totalCost / estimatedFill) : 0;
      } else {
        // Orden límite
        estimatedPrice = price;
        estimatedCost = quantity * price;
        estimatedFill = quantity; // Asumiendo llenado completo
      }

      res.json({
        success: true,
        data: {
          marketId,
          side,
          orderType,
          quantity,
          limitPrice: price,
          estimatedPrice,
          estimatedCost,
          estimatedFill,
          currentYesPrice: market.yesPrice,
          currentNoPrice: market.noPrice,
          potentialPayout: estimatedFill * 100, // 100 centavos por contrato si gana
          potentialProfit: (estimatedFill * 100) - estimatedCost
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
