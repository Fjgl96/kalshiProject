/**
 * KALSHI PERÚ - Rutas de Wallet
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  getWalletBalance,
  verifyWalletBalance,
  getTransactionHistory,
  canDeposit,
  canWithdraw,
  initiateWithdrawal
} from '../../services/wallet.service';
import {
  authenticate,
  requireKYC,
  requireActiveAccount
} from '../../middleware/auth.middleware';
import { validateRequest } from '../validators/common.validator';

const router = Router();

// ============================================================================
// SCHEMAS
// ============================================================================

const transactionHistorySchema = z.object({
  query: z.object({
    limit: z.string().optional().transform(v => v ? parseInt(v) : 20),
    offset: z.string().optional().transform(v => v ? parseInt(v) : 0),
    type: z.enum([
      'deposit', 'withdrawal', 'order_escrow', 'order_release',
      'trade_execution', 'market_settlement', 'commission_charge',
      'refund', 'adjustment'
    ]).optional(),
    status: z.enum(['pending', 'processing', 'completed', 'failed', 'reversed']).optional(),
    startDate: z.string().optional().transform(v => v ? new Date(v) : undefined),
    endDate: z.string().optional().transform(v => v ? new Date(v) : undefined)
  })
});

const withdrawalSchema = z.object({
  body: z.object({
    amount: z.number().positive('El monto debe ser positivo').min(20, 'Mínimo S/20'),
    method: z.enum(['bank_transfer']),
    description: z.string().optional()
  })
});

// ============================================================================
// RUTAS
// ============================================================================

/**
 * GET /wallet/balance
 * Obtiene el balance de la billetera
 */
router.get(
  '/balance',
  authenticate,
  async (req, res, next) => {
    try {
      const balance = await getWalletBalance(req.user!.sub);

      res.json({
        success: true,
        data: {
          balance
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /wallet/verify
 * Verifica la integridad del balance (auditoría)
 */
router.get(
  '/verify',
  authenticate,
  async (req, res, next) => {
    try {
      const verification = await verifyWalletBalance(req.user!.sub);

      res.json({
        success: true,
        data: verification
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /wallet/transactions
 * Obtiene el historial de transacciones
 */
router.get(
  '/transactions',
  authenticate,
  validateRequest(transactionHistorySchema),
  async (req, res, next) => {
    try {
      const result = await getTransactionHistory(req.user!.sub, {
        limit: req.query.limit as number,
        offset: req.query.offset as number,
        type: req.query.type as never,
        status: req.query.status as never,
        startDate: req.query.startDate as Date | undefined,
        endDate: req.query.endDate as Date | undefined
      });

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /wallet/limits
 * Obtiene los límites de depósito/retiro del usuario
 */
router.get(
  '/limits',
  authenticate,
  async (req, res, next) => {
    try {
      const [depositCheck, withdrawCheck] = await Promise.all([
        canDeposit(req.user!.sub, 0),  // Solo para obtener el límite
        canWithdraw(req.user!.sub, 0)
      ]);

      res.json({
        success: true,
        data: {
          deposit: {
            allowed: depositCheck.allowed,
            remainingDaily: depositCheck.limit
          },
          withdrawal: {
            allowed: withdrawCheck.allowed,
            availableBalance: withdrawCheck.availableBalance
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /wallet/withdraw
 * Inicia un retiro de fondos
 */
router.post(
  '/withdraw',
  authenticate,
  requireKYC,
  requireActiveAccount,
  validateRequest(withdrawalSchema),
  async (req, res, next) => {
    try {
      const { amount, method, description } = req.body;

      // Verificar si puede retirar
      const canWithdrawCheck = await canWithdraw(req.user!.sub, amount);
      if (!canWithdrawCheck.allowed) {
        res.status(400).json({
          success: false,
          error: canWithdrawCheck.reason,
          availableBalance: canWithdrawCheck.availableBalance
        });
        return;
      }

      const result = await initiateWithdrawal(req.user!.sub, amount, {
        method,
        description
      });

      res.json({
        success: true,
        message: 'Retiro iniciado. Se procesará en 24-48 horas.',
        data: {
          paymentId: result.paymentId,
          amount: result.amount,
          fee: result.fee,
          netAmount: result.netAmount,
          newBalance: result.newBalance
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
