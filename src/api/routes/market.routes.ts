/**
 * RUTAS DE MERCADOS DE PREDICCIÓN
 *
 * Endpoints para gestión y consulta de mercados
 *
 * ENDPOINTS PÚBLICOS:
 * GET  /markets              - Listar mercados con filtros
 * GET  /markets/:id          - Detalle de mercado
 * GET  /markets/:id/orderbook - Order book del mercado
 * GET  /markets/:id/trades    - Historial de trades
 * GET  /markets/:id/stats     - Estadísticas del mercado
 * GET  /categories           - Listar categorías
 *
 * ENDPOINTS AUTENTICADOS:
 * GET  /markets/:id/position  - Mi posición en el mercado
 *
 * ENDPOINTS ADMIN:
 * POST   /markets             - Crear mercado
 * PUT    /markets/:id         - Actualizar mercado
 * POST   /markets/:id/open    - Abrir mercado
 * POST   /markets/:id/close   - Cerrar mercado
 * POST   /markets/:id/resolve - Resolver mercado
 * POST   /markets/:id/settle  - Liquidar mercado
 * GET    /markets/:id/disputes - Ver disputas
 * POST   /disputes/:id/resolve - Resolver disputa
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import {
  authenticateToken,
  requireKYC,
  requireAdmin,
  AuthenticatedRequest
} from '../../middleware/auth.middleware';
import * as MarketService from '../../services/market.service';
import * as SettlementService from '../../services/settlement.service';
import * as OrderService from '../../services/order.service';

const router = Router();

// ============================================================================
// RATE LIMITING
// ============================================================================

const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requests por minuto
  message: { error: 'Demasiadas solicitudes, intente más tarde', code: 'RATE_LIMIT' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas solicitudes admin', code: 'ADMIN_RATE_LIMIT' }
});

// ============================================================================
// ENDPOINTS PÚBLICOS
// ============================================================================

/**
 * GET /markets
 * Lista mercados con filtros y paginación
 */
router.get('/', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters: MarketService.MarketFilters = {
      status: req.query.status as any,
      category: req.query.category as string,
      search: req.query.search as string,
      sortBy: (req.query.sortBy as any) || 'created_at',
      sortOrder: (req.query.sortOrder as any) || 'desc',
      page: parseInt(req.query.page as string) || 1,
      limit: Math.min(parseInt(req.query.limit as string) || 20, 100)
    };

    const result = await MarketService.getMarkets(filters);

    res.json({
      success: true,
      data: result.markets,
      pagination: result.pagination
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /categories
 * Lista categorías de mercados
 */
router.get('/categories', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await MarketService.getCategories();

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /markets/:id
 * Obtiene detalle de un mercado
 */
router.get('/:id', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = await MarketService.getMarketById(req.params.id);

    res.json({
      success: true,
      data: market
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /markets/:id/orderbook
 * Obtiene order book del mercado
 */
router.get('/:id/orderbook', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderBook = await MarketService.getOrderBook(req.params.id);

    res.json({
      success: true,
      data: orderBook
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /markets/:id/trades
 * Historial de trades del mercado
 */
router.get('/:id/trades', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const trades = await MarketService.getMarketTrades(req.params.id, limit, offset);

    res.json({
      success: true,
      data: trades
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /markets/:id/stats
 * Estadísticas del mercado
 */
router.get('/:id/stats', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = await MarketService.getMarketById(req.params.id);

    res.json({
      success: true,
      data: {
        marketId: market.id,
        title: market.title,
        status: market.status,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        volume24h: market.volume24h,
        totalVolume: market.totalVolume,
        openInterest: market.openInterest,
        lastTradePrice: market.lastTradePrice,
        priceChange24h: market.priceChange24h
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /markets/:id/chart
 * Datos de precio histórico para gráficos
 */
router.get('/:id/chart', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const interval = (req.query.interval as string) || '1h';
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

    const chartData = await MarketService.getPriceHistory(req.params.id, interval, limit);

    res.json({
      success: true,
      data: chartData
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ENDPOINTS AUTENTICADOS
// ============================================================================

/**
 * GET /markets/:id/position
 * Obtiene mi posición en un mercado
 */
router.get(
  '/:id/position',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const position = await OrderService.getPosition(req.user!.userId, req.params.id);

      res.json({
        success: true,
        data: position
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /markets/:id/my-orders
 * Obtiene mis órdenes en un mercado
 */
router.get(
  '/:id/my-orders',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string;
      const orders = await OrderService.getUserOrdersInMarket(
        req.user!.userId,
        req.params.id,
        status as any
      );

      res.json({
        success: true,
        data: orders
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/dispute
 * Crear disputa sobre resolución del mercado
 */
router.post(
  '/:id/dispute',
  authenticateToken,
  requireKYC,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { reason, evidence } = req.body;

      if (!reason || reason.length < 20) {
        res.status(400).json({
          success: false,
          error: 'La razón debe tener al menos 20 caracteres',
          code: 'INVALID_REASON'
        });
        return;
      }

      const dispute = await SettlementService.createDispute({
        marketId: req.params.id,
        userId: req.user!.userId,
        reason,
        evidence
      });

      res.status(201).json({
        success: true,
        data: dispute
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// ENDPOINTS ADMIN
// ============================================================================

/**
 * POST /markets
 * Crear nuevo mercado (solo admin)
 */
router.post(
  '/',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const {
        title,
        description,
        category,
        resolutionCriteria,
        closeDate,
        settlementDate,
        tags,
        minOrderSize,
        maxOrderSize,
        initialYesPrice
      } = req.body;

      // Validaciones
      if (!title || title.length < 10) {
        res.status(400).json({
          success: false,
          error: 'El título debe tener al menos 10 caracteres',
          code: 'INVALID_TITLE'
        });
        return;
      }

      if (!closeDate) {
        res.status(400).json({
          success: false,
          error: 'La fecha de cierre es requerida',
          code: 'MISSING_CLOSE_DATE'
        });
        return;
      }

      const market = await MarketService.createMarket(
        {
          title,
          description,
          category,
          resolutionCriteria,
          closeDate: new Date(closeDate),
          settlementDate: settlementDate ? new Date(settlementDate) : undefined,
          tags,
          minOrderSize,
          maxOrderSize,
          initialYesPrice
        },
        req.user!.userId
      );

      res.status(201).json({
        success: true,
        data: market
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /markets/:id
 * Actualizar mercado (solo admin, solo en draft)
 */
router.put(
  '/:id',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const market = await MarketService.updateMarket(
        req.params.id,
        req.body,
        req.user!.userId
      );

      res.json({
        success: true,
        data: market
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/schedule
 * Programar apertura de mercado
 */
router.post(
  '/:id/schedule',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { openDate } = req.body;

      if (!openDate) {
        res.status(400).json({
          success: false,
          error: 'La fecha de apertura es requerida',
          code: 'MISSING_OPEN_DATE'
        });
        return;
      }

      const market = await MarketService.scheduleMarket(
        req.params.id,
        new Date(openDate),
        req.user!.userId
      );

      res.json({
        success: true,
        data: market
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/open
 * Abrir mercado para trading
 */
router.post(
  '/:id/open',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const market = await MarketService.openMarket(req.params.id, req.user!.userId);

      res.json({
        success: true,
        data: market,
        message: 'Mercado abierto para trading'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/close
 * Cerrar mercado (detener trading)
 */
router.post(
  '/:id/close',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const market = await MarketService.closeMarket(req.params.id, req.user!.userId);

      res.json({
        success: true,
        data: market,
        message: 'Mercado cerrado'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/resolve
 * Resolver mercado (establecer resultado)
 */
router.post(
  '/:id/resolve',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { outcome, source } = req.body;

      if (!outcome || !['yes', 'no'].includes(outcome)) {
        res.status(400).json({
          success: false,
          error: 'El resultado debe ser "yes" o "no"',
          code: 'INVALID_OUTCOME'
        });
        return;
      }

      const result = await SettlementService.resolveMarket(
        req.params.id,
        outcome,
        req.user!.userId,
        source || 'admin_decision'
      );

      res.json({
        success: true,
        data: result.market,
        disputePeriodEnds: result.disputePeriodEnds,
        message: `Mercado resuelto: ${outcome.toUpperCase()}. Período de disputa hasta ${result.disputePeriodEnds.toISOString()}`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /markets/:id/settle
 * Liquidar mercado (distribuir pagos)
 */
router.post(
  '/:id/settle',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await SettlementService.settleMarket(
        req.params.id,
        req.user!.userId
      );

      res.json({
        success: true,
        data: result,
        message: `Mercado liquidado. ${result.totalWinners} ganadores, ${result.totalLosers} perdedores. Total pagado: S/ ${(result.totalPayout / 100).toFixed(2)}`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /markets/:id/disputes
 * Ver disputas del mercado
 */
router.get(
  '/:id/disputes',
  authenticateToken,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const disputes = await SettlementService.getMarketDisputes(req.params.id);

      res.json({
        success: true,
        data: disputes
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /disputes/:id/resolve
 * Resolver una disputa
 */
router.post(
  '/disputes/:id/resolve',
  authenticateToken,
  requireAdmin,
  adminLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { resolution, notes, newOutcome } = req.body;

      if (!resolution || !['approved', 'rejected'].includes(resolution)) {
        res.status(400).json({
          success: false,
          error: 'La resolución debe ser "approved" o "rejected"',
          code: 'INVALID_RESOLUTION'
        });
        return;
      }

      if (!notes || notes.length < 10) {
        res.status(400).json({
          success: false,
          error: 'Las notas de resolución son requeridas (mín 10 caracteres)',
          code: 'MISSING_NOTES'
        });
        return;
      }

      const dispute = await SettlementService.resolveDispute(
        req.params.id,
        req.user!.userId,
        resolution,
        notes,
        newOutcome
      );

      res.json({
        success: true,
        data: dispute
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/disputes/pending
 * Lista todas las disputas pendientes
 */
router.get(
  '/admin/disputes/pending',
  authenticateToken,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const disputes = await SettlementService.getPendingDisputes();

      res.json({
        success: true,
        data: disputes
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
