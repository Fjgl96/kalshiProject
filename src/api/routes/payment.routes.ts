/**
 * KALSHI PERÚ - Rutas de Pagos
 */

import { Router, raw } from 'express';
import { z } from 'zod';
import {
  generateQRPayment,
  checkQRPaymentStatus,
  processCardPayment,
  processYapeWebhook,
  processCulqiWebhook,
  getPendingPayments,
  PaymentError
} from '../../services/payment.service';
import {
  authenticate,
  requireKYC,
  requireActiveAccount
} from '../../middleware/auth.middleware';
import { validateRequest } from '../validators/common.validator';
import { env } from '../../config/env.config';
import { query } from '../../config/database.config';

const router = Router();

// ============================================================================
// SCHEMAS
// ============================================================================

const qrPaymentSchema = z.object({
  body: z.object({
    amount: z.number()
      .positive('El monto debe ser positivo')
      .min(10, 'Mínimo S/10')
      .max(10000, 'Máximo S/10,000'),
    method: z.enum(['yape', 'plin'])
  })
});

const cardPaymentSchema = z.object({
  body: z.object({
    amount: z.number()
      .positive('El monto debe ser positivo')
      .min(10, 'Mínimo S/10')
      .max(10000, 'Máximo S/10,000'),
    cardToken: z.string().min(1, 'Token de tarjeta requerido'),
    email: z.string().email('Email inválido')
  })
});

// ============================================================================
// DEPÓSITOS
// ============================================================================

/**
 * POST /payments/deposit/qr
 * Genera un código QR para depósito con Yape/Plin
 */
router.post(
  '/deposit/qr',
  authenticate,
  requireKYC,
  requireActiveAccount,
  validateRequest(qrPaymentSchema),
  async (req, res, next) => {
    try {
      const { amount, method } = req.body;

      const result = await generateQRPayment({
        userId: req.user!.sub,
        amount,
        method
      });

      res.json({
        success: true,
        message: `Escanea el código QR con ${method === 'yape' ? 'Yape' : 'Plin'} para completar el depósito`,
        data: {
          paymentId: result.paymentId,
          qrCode: result.qrCode,
          qrImage: result.qrImage,
          amount: result.amount,
          reference: result.reference,
          expiresAt: result.expiresAt,
          expiresIn: Math.floor((result.expiresAt.getTime() - Date.now()) / 1000)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/deposit/qr/:paymentId/status
 * Verifica el estado de un pago QR
 */
router.get(
  '/deposit/qr/:paymentId/status',
  authenticate,
  async (req, res, next) => {
    try {
      const { paymentId } = req.params;

      // Verificar que el pago pertenece al usuario
      const [payment] = await query<{ user_id: string }>(`
        SELECT user_id FROM payments WHERE id = $1
      `, [paymentId]);

      if (!payment || payment.user_id !== req.user!.sub) {
        res.status(404).json({
          success: false,
          error: 'Payment not found'
        });
        return;
      }

      const status = await checkQRPaymentStatus(paymentId);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/deposit/card
 * Procesa un depósito con tarjeta de crédito/débito
 */
router.post(
  '/deposit/card',
  authenticate,
  requireKYC,
  requireActiveAccount,
  validateRequest(cardPaymentSchema),
  async (req, res, next) => {
    try {
      const { amount, cardToken, email } = req.body;

      const result = await processCardPayment({
        userId: req.user!.sub,
        amount,
        cardToken,
        email
      });

      if (result.status === 'approved') {
        res.json({
          success: true,
          message: 'Depósito procesado correctamente',
          data: {
            paymentId: result.paymentId,
            status: result.status,
            cardBrand: result.cardBrand,
            lastFour: result.lastFour,
            authorizationCode: result.authorizationCode
          }
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.message || 'Pago rechazado',
          data: {
            paymentId: result.paymentId,
            status: result.status
          }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/pending
 * Lista los pagos pendientes del usuario
 */
router.get(
  '/pending',
  authenticate,
  async (req, res, next) => {
    try {
      const payments = await getPendingPayments(req.user!.sub);

      res.json({
        success: true,
        data: { payments }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/:paymentId
 * Obtiene detalles de un pago
 */
router.get(
  '/:paymentId',
  authenticate,
  async (req, res, next) => {
    try {
      const [payment] = await query<{
        id: string;
        payment_type: string;
        method: string;
        amount: string;
        fee: string;
        net_amount: string;
        status: string;
        created_at: Date;
        completed_at: Date;
        failure_reason: string;
        user_id: string;
      }>(`
        SELECT * FROM payments WHERE id = $1
      `, [req.params.paymentId]);

      if (!payment || payment.user_id !== req.user!.sub) {
        res.status(404).json({
          success: false,
          error: 'Payment not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          id: payment.id,
          type: payment.payment_type,
          method: payment.method,
          amount: parseFloat(payment.amount),
          fee: parseFloat(payment.fee),
          netAmount: parseFloat(payment.net_amount),
          status: payment.status,
          createdAt: payment.created_at,
          completedAt: payment.completed_at,
          failureReason: payment.failure_reason
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// WEBHOOKS (No requieren autenticación de usuario)
// ============================================================================

/**
 * POST /payments/webhooks/yape
 * Webhook de Yape/Niubiz
 */
router.post(
  '/webhooks/yape',
  raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const signature = req.headers['x-yape-signature'] as string || '';
      const payload = JSON.parse(req.body.toString());

      const result = await processYapeWebhook(payload, signature);

      // Siempre responder 200 para que no reintente
      res.json({
        received: true,
        processed: result.processed
      });
    } catch (error) {
      console.error('Yape webhook error:', error);

      // Aún así responder 200 para evitar reintentos infinitos
      // Pero loguear el error
      await query(`
        INSERT INTO audit_logs (
          action, resource_type, severity, description, metadata
        ) VALUES ('webhook.yape_error', 'payment', 'error', 'Webhook processing failed', $1)
      `, [JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
        body: req.body?.toString()
      })]);

      res.json({ received: true, processed: false, error: true });
    }
  }
);

/**
 * POST /payments/webhooks/culqi
 * Webhook de Culqi
 */
router.post(
  '/webhooks/culqi',
  raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const signature = req.headers['x-culqi-signature'] as string || '';
      const payload = JSON.parse(req.body.toString());

      const result = await processCulqiWebhook(payload, signature);

      res.json({
        received: true,
        processed: result.processed
      });
    } catch (error) {
      console.error('Culqi webhook error:', error);

      await query(`
        INSERT INTO audit_logs (
          action, resource_type, severity, description, metadata
        ) VALUES ('webhook.culqi_error', 'payment', 'error', 'Webhook processing failed', $1)
      `, [JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error'
      })]);

      res.json({ received: true, processed: false, error: true });
    }
  }
);

// ============================================================================
// MÉTODOS DE PAGO DISPONIBLES
// ============================================================================

/**
 * GET /payments/methods
 * Lista los métodos de pago disponibles
 */
router.get(
  '/methods',
  async (req, res) => {
    const methods = [
      {
        id: 'yape',
        name: 'Yape',
        type: 'qr',
        enabled: true,
        minAmount: 10,
        maxAmount: 10000,
        fee: 0,
        feeType: 'fixed',
        description: 'Paga escaneando el código QR con tu app de Yape',
        icon: 'yape-icon'
      },
      {
        id: 'plin',
        name: 'Plin',
        type: 'qr',
        enabled: true,
        minAmount: 10,
        maxAmount: 10000,
        fee: 0,
        feeType: 'fixed',
        description: 'Paga escaneando el código QR con tu app de Plin',
        icon: 'plin-icon'
      },
      {
        id: 'credit_card',
        name: 'Tarjeta de Crédito',
        type: 'card',
        enabled: env.ENABLE_REAL_PAYMENTS || env.NODE_ENV === 'development',
        minAmount: 10,
        maxAmount: 10000,
        fee: 3.5,
        feeType: 'percentage',
        description: 'Visa, Mastercard, American Express',
        icon: 'card-icon',
        brands: ['visa', 'mastercard', 'amex', 'diners']
      },
      {
        id: 'debit_card',
        name: 'Tarjeta de Débito',
        type: 'card',
        enabled: env.ENABLE_REAL_PAYMENTS || env.NODE_ENV === 'development',
        minAmount: 10,
        maxAmount: 5000,
        fee: 2.5,
        feeType: 'percentage',
        description: 'Visa Débito, Mastercard Débito',
        icon: 'card-icon',
        brands: ['visa', 'mastercard']
      }
    ];

    res.json({
      success: true,
      data: { methods }
    });
  }
);

export default router;
