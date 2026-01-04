/**
 * KALSHI PERÚ - Servicio de Pagos
 *
 * Integración con pasarelas de pago peruanas:
 * - Yape/Plin: Pagos por QR
 * - Culqi: Tarjetas de crédito/débito
 * - Izipay: Alternativa para tarjetas
 *
 * FLUJO DE DEPÓSITO:
 * 1. Usuario solicita depósito → se crea Payment en estado 'pending'
 * 2. Se genera QR o se procesa tarjeta
 * 3. Webhook confirma pago → se procesa depósito en wallet
 *
 * SEGURIDAD:
 * - Webhooks verificados con HMAC
 * - Idempotencia con transaction IDs
 * - Timeout para pagos pendientes
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction } from '../config/database.config';
import { env } from '../config/env.config';
import { processDeposit, canDeposit } from './wallet.service';
import { PaymentMethod, TransactionStatus } from '../types/database.types';

// ============================================================================
// TIPOS
// ============================================================================

export interface PaymentRequest {
  userId: string;
  amount: number;
  method: PaymentMethod;
  metadata?: Record<string, unknown>;
}

export interface QRPaymentResult {
  paymentId: string;
  qrCode: string;
  qrImage: string;  // Base64 del QR
  expiresAt: Date;
  amount: number;
  reference: string;
}

export interface CardPaymentRequest {
  userId: string;
  amount: number;
  cardToken: string;  // Token generado por Culqi.js
  email: string;
  metadata?: Record<string, unknown>;
}

export interface CardPaymentResult {
  paymentId: string;
  status: 'approved' | 'declined' | 'pending';
  authorizationCode?: string;
  cardBrand?: string;
  lastFour?: string;
  message?: string;
}

export interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// YAPE / PLIN (Pagos QR)
// ============================================================================

/**
 * Genera un código QR para pago con Yape o Plin
 *
 * En producción, esto se integraría con:
 * - Niubiz (procesa Yape/Plin)
 * - API directa de Yape Business
 */
export async function generateQRPayment(
  request: PaymentRequest
): Promise<QRPaymentResult> {
  const { userId, amount, method } = request;

  // Validar que puede depositar
  const canDep = await canDeposit(userId, amount);
  if (!canDep.allowed) {
    throw new PaymentError(canDep.reason || 'Cannot process deposit', 'DEPOSIT_NOT_ALLOWED', 400);
  }

  // Generar referencia única
  const reference = generatePaymentReference();

  // Calcular expiración (15 minutos para QR)
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);

  // Crear registro de pago
  const [payment] = await query<{ id: string }>(`
    INSERT INTO payments (
      user_id, payment_type, method, amount, fee, net_amount,
      currency, status, external_reference, qr_expires_at
    ) VALUES (
      $1, 'deposit', $2, $3, 0, $3,
      'PEN', 'pending', $4, $5
    ) RETURNING id
  `, [userId, method, amount, reference, expiresAt]);

  // Generar QR
  // En producción, esto llamaría a la API de Yape/Niubiz
  const qrData = await generateQRCode(method, amount, reference);

  // Actualizar payment con QR
  await query(`
    UPDATE payments SET qr_code = $1 WHERE id = $2
  `, [qrData.code, payment.id]);

  // Log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      description, metadata
    ) VALUES ($1, 'payment.qr_generated', 'payment', $2, 'QR payment initiated', $3)
  `, [userId, payment.id, JSON.stringify({ method, amount, reference })]);

  return {
    paymentId: payment.id,
    qrCode: qrData.code,
    qrImage: qrData.image,
    expiresAt,
    amount,
    reference
  };
}

/**
 * Genera el código QR (simulado en desarrollo)
 */
async function generateQRCode(
  method: PaymentMethod,
  amount: number,
  reference: string
): Promise<{ code: string; image: string }> {
  if (env.NODE_ENV === 'production' && env.ENABLE_REAL_PAYMENTS) {
    // Aquí iría la integración real con Niubiz/Yape
    return generateRealQR(method, amount, reference);
  }

  // Simulación para desarrollo
  const qrContent = JSON.stringify({
    method,
    amount,
    reference,
    merchant: 'KALSHI_PERU',
    currency: 'PEN',
    timestamp: Date.now()
  });

  // Generar imagen QR simulada (base64 de un placeholder)
  const qrImage = generatePlaceholderQR(qrContent);

  return {
    code: qrContent,
    image: qrImage
  };
}

/**
 * Integración real con Yape/Niubiz (para producción)
 */
async function generateRealQR(
  method: PaymentMethod,
  amount: number,
  reference: string
): Promise<{ code: string; image: string }> {
  // Ejemplo de integración con Niubiz
  if (method === 'yape') {
    const response = await fetch('https://api.niubiz.com.pe/v1/qr/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.YAPE_API_KEY}`
      },
      body: JSON.stringify({
        merchantId: env.YAPE_MERCHANT_ID,
        amount: amount.toFixed(2),
        currency: 'PEN',
        reference,
        description: 'Depósito Kalshi Perú',
        expirationMinutes: 15
      })
    });

    if (!response.ok) {
      throw new PaymentError('Failed to generate QR', 'QR_GENERATION_FAILED', 502);
    }

    const data = await response.json();
    return {
      code: data.qrCode,
      image: data.qrImage
    };
  }

  throw new PaymentError('Unsupported payment method', 'UNSUPPORTED_METHOD', 400);
}

/**
 * Genera un QR placeholder para desarrollo
 */
function generatePlaceholderQR(content: string): string {
  // En desarrollo, retornamos un SVG simple como base64
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
      <rect width="200" height="200" fill="white"/>
      <rect x="20" y="20" width="160" height="160" fill="none" stroke="black" stroke-width="2"/>
      <text x="100" y="90" text-anchor="middle" font-size="12" fill="black">QR SIMULADO</text>
      <text x="100" y="110" text-anchor="middle" font-size="10" fill="gray">Desarrollo</text>
      <text x="100" y="130" text-anchor="middle" font-size="8" fill="gray">${content.slice(0, 30)}...</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Verifica el estado de un pago QR
 */
export async function checkQRPaymentStatus(
  paymentId: string
): Promise<{ status: TransactionStatus; message: string }> {
  const payment = await queryOne<{
    status: TransactionStatus;
    qr_expires_at: Date;
    amount: string;
  }>(`
    SELECT status, qr_expires_at, amount FROM payments WHERE id = $1
  `, [paymentId]);

  if (!payment) {
    throw new PaymentError('Payment not found', 'PAYMENT_NOT_FOUND', 404);
  }

  // Verificar expiración
  if (payment.status === 'pending' && new Date() > payment.qr_expires_at) {
    await query(`
      UPDATE payments SET status = 'failed', failure_reason = 'QR expired'
      WHERE id = $1 AND status = 'pending'
    `, [paymentId]);

    return { status: 'failed', message: 'QR code expired' };
  }

  return {
    status: payment.status,
    message: getStatusMessage(payment.status)
  };
}

// ============================================================================
// CULQI (Tarjetas de Crédito/Débito)
// ============================================================================

/**
 * Procesa un pago con tarjeta usando Culqi
 *
 * El flujo es:
 * 1. Frontend genera token con Culqi.js
 * 2. Backend crea el cargo con el token
 * 3. Culqi procesa y responde
 */
export async function processCardPayment(
  request: CardPaymentRequest
): Promise<CardPaymentResult> {
  const { userId, amount, cardToken, email, metadata } = request;

  // Validar depósito
  const canDep = await canDeposit(userId, amount);
  if (!canDep.allowed) {
    throw new PaymentError(canDep.reason || 'Cannot process deposit', 'DEPOSIT_NOT_ALLOWED', 400);
  }

  // Generar referencia
  const reference = generatePaymentReference();

  // Crear registro de pago
  const [payment] = await query<{ id: string }>(`
    INSERT INTO payments (
      user_id, payment_type, method, amount, fee, net_amount,
      currency, status, external_reference
    ) VALUES (
      $1, 'deposit', 'credit_card', $2, 0, $2,
      'PEN', 'processing', $3
    ) RETURNING id
  `, [userId, amount, reference]);

  try {
    // Procesar con Culqi
    const culqiResult = await chargeCulqi({
      token: cardToken,
      amount: Math.round(amount * 100),  // Culqi usa centavos
      email,
      reference,
      metadata: {
        paymentId: payment.id,
        userId,
        ...metadata
      }
    });

    if (culqiResult.approved) {
      // Actualizar payment
      await query(`
        UPDATE payments SET
          status = 'completed',
          provider_transaction_id = $1,
          card_last_four = $2,
          card_brand = $3,
          completed_at = NOW()
        WHERE id = $4
      `, [
        culqiResult.chargeId,
        culqiResult.lastFour,
        culqiResult.brand,
        payment.id
      ]);

      // Procesar depósito en wallet
      await processDeposit(userId, amount, payment.id, {
        method: 'credit_card',
        providerTransactionId: culqiResult.chargeId,
        description: `Depósito con tarjeta ${culqiResult.brand} ****${culqiResult.lastFour}`
      });

      return {
        paymentId: payment.id,
        status: 'approved',
        authorizationCode: culqiResult.authCode,
        cardBrand: culqiResult.brand,
        lastFour: culqiResult.lastFour
      };
    } else {
      // Pago rechazado
      await query(`
        UPDATE payments SET
          status = 'failed',
          failure_reason = $1,
          failed_at = NOW()
        WHERE id = $2
      `, [culqiResult.declineMessage, payment.id]);

      return {
        paymentId: payment.id,
        status: 'declined',
        message: culqiResult.declineMessage
      };
    }
  } catch (error) {
    // Error en el procesamiento
    await query(`
      UPDATE payments SET
        status = 'failed',
        failure_reason = $1,
        failed_at = NOW()
      WHERE id = $2
    `, [error instanceof Error ? error.message : 'Unknown error', payment.id]);

    throw error;
  }
}

/**
 * Crea un cargo en Culqi
 */
async function chargeCulqi(params: {
  token: string;
  amount: number;
  email: string;
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  approved: boolean;
  chargeId?: string;
  authCode?: string;
  brand?: string;
  lastFour?: string;
  declineMessage?: string;
}> {
  // En desarrollo, simular respuesta
  if (!env.ENABLE_REAL_PAYMENTS || env.NODE_ENV !== 'production') {
    return simulateCulqiCharge(params);
  }

  // Producción: llamar a API de Culqi
  const response = await fetch('https://api.culqi.com/v2/charges', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.CULQI_SECRET_KEY}`
    },
    body: JSON.stringify({
      amount: params.amount,
      currency_code: 'PEN',
      email: params.email,
      source_id: params.token,
      description: `Depósito Kalshi Perú - ${params.reference}`,
      metadata: params.metadata
    })
  });

  const data = await response.json();

  if (response.ok && data.outcome?.type === 'venta_exitosa') {
    return {
      approved: true,
      chargeId: data.id,
      authCode: data.authorization_code,
      brand: data.source?.card_type,
      lastFour: data.source?.last_four
    };
  }

  return {
    approved: false,
    declineMessage: data.user_message || data.merchant_message || 'Payment declined'
  };
}

/**
 * Simula respuesta de Culqi para desarrollo
 */
function simulateCulqiCharge(params: {
  token: string;
  amount: number;
}): {
  approved: boolean;
  chargeId?: string;
  authCode?: string;
  brand?: string;
  lastFour?: string;
  declineMessage?: string;
} {
  // Tokens especiales para pruebas
  if (params.token.includes('decline')) {
    return {
      approved: false,
      declineMessage: 'Tarjeta rechazada (modo prueba)'
    };
  }

  if (params.token.includes('insufficient')) {
    return {
      approved: false,
      declineMessage: 'Fondos insuficientes (modo prueba)'
    };
  }

  // Aprobado por defecto en desarrollo
  return {
    approved: true,
    chargeId: `chr_test_${uuidv4().slice(0, 8)}`,
    authCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
    brand: 'VISA',
    lastFour: '4242'
  };
}

// ============================================================================
// WEBHOOKS
// ============================================================================

/**
 * Procesa webhook de Yape/Niubiz
 */
export async function processYapeWebhook(
  payload: WebhookPayload,
  signature: string
): Promise<{ processed: boolean; paymentId?: string }> {
  // Verificar firma
  if (!verifyWebhookSignature(payload, signature, env.YAPE_WEBHOOK_SECRET || '')) {
    throw new PaymentError('Invalid webhook signature', 'INVALID_SIGNATURE', 401);
  }

  const { event, data } = payload;

  // Buscar payment por referencia
  const payment = await queryOne<{
    id: string;
    user_id: string;
    amount: string;
    status: TransactionStatus;
  }>(`
    SELECT id, user_id, amount, status FROM payments
    WHERE external_reference = $1 AND status = 'pending'
  `, [data.reference]);

  if (!payment) {
    // Payment no encontrado o ya procesado - idempotencia
    return { processed: false };
  }

  if (event === 'payment.completed') {
    // Actualizar payment
    await query(`
      UPDATE payments SET
        status = 'completed',
        provider_transaction_id = $1,
        webhook_received_at = NOW(),
        webhook_payload = $2,
        completed_at = NOW()
      WHERE id = $3
    `, [data.transactionId, JSON.stringify(payload), payment.id]);

    // Procesar depósito
    await processDeposit(
      payment.user_id,
      parseFloat(payment.amount),
      payment.id,
      {
        method: 'yape',
        providerTransactionId: data.transactionId as string,
        description: 'Depósito vía Yape'
      }
    );

    return { processed: true, paymentId: payment.id };
  }

  if (event === 'payment.failed') {
    await query(`
      UPDATE payments SET
        status = 'failed',
        failure_reason = $1,
        webhook_received_at = NOW(),
        webhook_payload = $2,
        failed_at = NOW()
      WHERE id = $3
    `, [data.reason || 'Payment failed', JSON.stringify(payload), payment.id]);

    return { processed: true, paymentId: payment.id };
  }

  return { processed: false };
}

/**
 * Procesa webhook de Culqi
 */
export async function processCulqiWebhook(
  payload: WebhookPayload,
  signature: string
): Promise<{ processed: boolean; paymentId?: string }> {
  // Verificar firma
  if (!verifyWebhookSignature(payload, signature, env.CULQI_WEBHOOK_SECRET || '')) {
    throw new PaymentError('Invalid webhook signature', 'INVALID_SIGNATURE', 401);
  }

  // Culqi envía eventos para charges, refunds, etc.
  // Implementar según necesidad
  const { event, data } = payload;

  if (event === 'charge.creation.succeeded') {
    // El cargo ya se procesa sincrónicamente en processCardPayment
    // Este webhook es para confirmación/auditoría
    await query(`
      INSERT INTO audit_logs (
        action, resource_type, description, metadata
      ) VALUES ('webhook.culqi_charge', 'payment', 'Culqi charge confirmed', $1)
    `, [JSON.stringify(payload)]);

    return { processed: true };
  }

  if (event === 'refund.creation.succeeded') {
    // Procesar reembolso
    // TODO: Implementar lógica de reembolso
    return { processed: true };
  }

  return { processed: false };
}

/**
 * Verifica la firma de un webhook
 */
function verifyWebhookSignature(
  payload: WebhookPayload,
  signature: string,
  secret: string
): boolean {
  if (!secret) return true;  // Skip en desarrollo sin secret

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// ============================================================================
// UTILIDADES
// ============================================================================

/**
 * Genera una referencia única para pagos
 */
function generatePaymentReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `KP-${timestamp}-${random}`;
}

/**
 * Mensaje según estado
 */
function getStatusMessage(status: TransactionStatus): string {
  const messages: Record<TransactionStatus, string> = {
    pending: 'Esperando pago',
    processing: 'Procesando pago',
    completed: 'Pago completado',
    failed: 'Pago fallido',
    reversed: 'Pago revertido'
  };
  return messages[status];
}

/**
 * Cancela pagos pendientes expirados (job de limpieza)
 */
export async function cancelExpiredPayments(): Promise<number> {
  const result = await query(`
    UPDATE payments SET
      status = 'failed',
      failure_reason = 'Payment expired',
      failed_at = NOW()
    WHERE status = 'pending'
      AND (
        (method IN ('yape', 'plin') AND qr_expires_at < NOW())
        OR (created_at < NOW() - INTERVAL '1 hour')
      )
    RETURNING id
  `);

  return result.length;
}

/**
 * Obtiene los pagos pendientes de un usuario
 */
export async function getPendingPayments(userId: string): Promise<{
  id: string;
  method: PaymentMethod;
  amount: number;
  status: TransactionStatus;
  createdAt: Date;
  expiresAt?: Date;
}[]> {
  const payments = await query<{
    id: string;
    method: PaymentMethod;
    amount: string;
    status: TransactionStatus;
    created_at: Date;
    qr_expires_at: Date;
  }>(`
    SELECT id, method, amount, status, created_at, qr_expires_at
    FROM payments
    WHERE user_id = $1 AND status IN ('pending', 'processing')
    ORDER BY created_at DESC
  `, [userId]);

  return payments.map(p => ({
    id: p.id,
    method: p.method,
    amount: parseFloat(p.amount),
    status: p.status,
    createdAt: p.created_at,
    expiresAt: p.qr_expires_at
  }));
}

// ============================================================================
// ERROR PERSONALIZADO
// ============================================================================

export class PaymentError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}
