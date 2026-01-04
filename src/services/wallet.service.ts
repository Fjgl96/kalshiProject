/**
 * KALSHI PERÚ - Servicio de Wallet (Billetera)
 *
 * Gestión de billeteras de usuarios usando Double-Entry Bookkeeping.
 * Todas las operaciones financieras pasan por este servicio.
 *
 * PRINCIPIOS:
 * 1. Toda operación genera entradas en el ledger
 * 2. Los balances SIEMPRE se calculan desde el ledger
 * 3. Las operaciones críticas usan transacciones SERIALIZABLE
 * 4. El escrow bloquea fondos hasta la resolución
 *
 * RIESGOS MITIGADOS:
 * - Race conditions: Locks de base de datos + versioning
 * - Balance negativo: Validación antes de cada operación
 * - Inconsistencias: Double-entry garantiza balance cero
 */

import { v4 as uuidv4 } from 'uuid';
import {
  query,
  queryOne,
  transaction,
  transactionWithIsolation
} from '../config/database.config';
import { TransactionType, TransactionStatus } from '../types/database.types';

// ============================================================================
// TIPOS
// ============================================================================

export interface WalletBalance {
  available: number;
  escrow: number;
  total: number;
  currency: string;
}

export interface WalletTransaction {
  id: string;
  type: TransactionType;
  amount: number;
  status: TransactionStatus;
  description: string;
  referenceType?: string;
  referenceId?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface TransferResult {
  success: boolean;
  transactionId: string;
  newBalance: WalletBalance;
}

export interface DepositResult {
  success: boolean;
  transactionId: string;
  paymentId: string;
  amount: number;
  newBalance: WalletBalance;
}

export interface WithdrawalResult {
  success: boolean;
  transactionId: string;
  paymentId: string;
  amount: number;
  fee: number;
  netAmount: number;
  newBalance: WalletBalance;
}

// ============================================================================
// OBTENER BALANCE
// ============================================================================

/**
 * Obtiene el balance actual de la billetera de un usuario
 */
export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const wallet = await queryOne<{
    available_balance: string;
    escrow_balance: string;
    total_balance: string;
    currency: string;
  }>(`
    SELECT available_balance, escrow_balance, total_balance, currency
    FROM wallets
    WHERE user_id = $1
  `, [userId]);

  if (!wallet) {
    throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
  }

  return {
    available: parseFloat(wallet.available_balance),
    escrow: parseFloat(wallet.escrow_balance),
    total: parseFloat(wallet.total_balance),
    currency: wallet.currency
  };
}

/**
 * Verifica el balance calculado desde el ledger (para auditoría)
 */
export async function verifyWalletBalance(userId: string): Promise<{
  stored: WalletBalance;
  calculated: WalletBalance;
  match: boolean;
}> {
  const wallet = await queryOne<{
    available_account_id: string;
    escrow_account_id: string;
    available_balance: string;
    escrow_balance: string;
    currency: string;
  }>(`
    SELECT available_account_id, escrow_account_id,
           available_balance, escrow_balance, currency
    FROM wallets WHERE user_id = $1
  `, [userId]);

  if (!wallet) {
    throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
  }

  // Calcular desde ledger
  const [availableCalc] = await query<{ balance: string }>(`
    SELECT COALESCE(SUM(debit) - SUM(credit), 0) as balance
    FROM ledger_entries
    WHERE account_id = $1
  `, [wallet.available_account_id]);

  const [escrowCalc] = await query<{ balance: string }>(`
    SELECT COALESCE(SUM(debit) - SUM(credit), 0) as balance
    FROM ledger_entries
    WHERE account_id = $1
  `, [wallet.escrow_account_id]);

  const stored = {
    available: parseFloat(wallet.available_balance),
    escrow: parseFloat(wallet.escrow_balance),
    total: parseFloat(wallet.available_balance) + parseFloat(wallet.escrow_balance),
    currency: wallet.currency
  };

  const calculated = {
    available: parseFloat(availableCalc.balance),
    escrow: parseFloat(escrowCalc.balance),
    total: parseFloat(availableCalc.balance) + parseFloat(escrowCalc.balance),
    currency: wallet.currency
  };

  return {
    stored,
    calculated,
    match: stored.available === calculated.available &&
           stored.escrow === calculated.escrow
  };
}

// ============================================================================
// DEPÓSITOS
// ============================================================================

/**
 * Procesa un depósito confirmado
 * Solo llamar después de confirmar el pago con la pasarela
 */
export async function processDeposit(
  userId: string,
  amount: number,
  paymentId: string,
  metadata: {
    method: string;
    providerTransactionId?: string;
    description?: string;
  }
): Promise<DepositResult> {
  // Validar monto
  if (amount <= 0) {
    throw new WalletError('Invalid deposit amount', 'INVALID_AMOUNT', 400);
  }

  // Usar transacción SERIALIZABLE para operaciones financieras críticas
  const result = await transactionWithIsolation('SERIALIZABLE', async (client) => {
    // Obtener cuentas
    const wallet = await client.queryOne<{
      available_account_id: string;
    }>(`
      SELECT available_account_id FROM wallets WHERE user_id = $1
    `, [userId]);

    if (!wallet) {
      throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
    }

    // Obtener cuenta de tesorería
    const treasury = await client.queryOne<{ account_id: string }>(`
      SELECT account_id FROM system_accounts WHERE name = 'PLATFORM_TREASURY'
    `);

    if (!treasury) {
      throw new WalletError('System account not found', 'SYSTEM_ERROR', 500);
    }

    // Crear transacción
    const [txn] = await client.query<{ id: string }>(`
      INSERT INTO transactions (
        reference_type, reference_id, transaction_type, status,
        amount, currency, description, metadata, initiated_by
      ) VALUES (
        'payment', $1, 'deposit', 'completed',
        $2, 'PEN', $3, $4, $5
      ) RETURNING id
    `, [
      paymentId,
      amount,
      metadata.description || 'Depósito de fondos',
      JSON.stringify(metadata),
      userId
    ]);

    // Entrada de débito: Sale de tesorería
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES (
        $1, $2, 0, $3, 0, 'Deposit - Treasury out', 1
      )
    `, [txn.id, treasury.account_id, amount]);

    // Entrada de crédito: Entra a wallet del usuario
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES (
        $1, $2, $3, 0, 0, 'Deposit - User wallet in', 2
      )
    `, [txn.id, wallet.available_account_id, amount]);

    // Actualizar payment
    await client.query(`
      UPDATE payments SET
        status = 'completed',
        transaction_id = $1,
        completed_at = NOW()
      WHERE id = $2
    `, [txn.id, paymentId]);

    // Actualizar timestamp de transacción
    await client.query(`
      UPDATE transactions SET completed_at = NOW() WHERE id = $1
    `, [txn.id]);

    // Log de auditoría
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'wallet.deposit', 'wallet', $2, 'Deposit completed', $3)
    `, [userId, txn.id, JSON.stringify({ amount, paymentId })]);

    return { transactionId: txn.id };
  });

  // Obtener balance actualizado
  const newBalance = await getWalletBalance(userId);

  return {
    success: true,
    transactionId: result.transactionId,
    paymentId,
    amount,
    newBalance
  };
}

// ============================================================================
// RETIROS
// ============================================================================

/**
 * Inicia un retiro de fondos
 */
export async function initiateWithdrawal(
  userId: string,
  amount: number,
  metadata: {
    method: string;
    destinationAccount?: string;
    description?: string;
  }
): Promise<WithdrawalResult> {
  // Validar monto
  if (amount <= 0) {
    throw new WalletError('Invalid withdrawal amount', 'INVALID_AMOUNT', 400);
  }

  // Calcular comisión (ejemplo: 1% con mínimo S/1)
  const feeRate = 0.01;
  const minFee = 1.00;
  const fee = Math.max(amount * feeRate, minFee);
  const netAmount = amount - fee;

  if (netAmount <= 0) {
    throw new WalletError('Amount too small after fees', 'AMOUNT_TOO_SMALL', 400);
  }

  const result = await transactionWithIsolation('SERIALIZABLE', async (client) => {
    // Verificar balance disponible
    const wallet = await client.queryOne<{
      available_account_id: string;
      available_balance: string;
    }>(`
      SELECT available_account_id, available_balance
      FROM wallets WHERE user_id = $1
      FOR UPDATE
    `, [userId]);

    if (!wallet) {
      throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
    }

    const availableBalance = parseFloat(wallet.available_balance);
    if (availableBalance < amount) {
      throw new WalletError(
        `Insufficient balance: ${availableBalance} < ${amount}`,
        'INSUFFICIENT_BALANCE',
        400
      );
    }

    // Obtener cuentas del sistema
    const [treasury, commissions] = await Promise.all([
      client.queryOne<{ account_id: string }>(`
        SELECT account_id FROM system_accounts WHERE name = 'PLATFORM_TREASURY'
      `),
      client.queryOne<{ account_id: string }>(`
        SELECT account_id FROM system_accounts WHERE name = 'COMMISSION_POOL'
      `)
    ]);

    // Crear registro de pago
    const [payment] = await client.query<{ id: string }>(`
      INSERT INTO payments (
        user_id, payment_type, method, amount, fee, net_amount,
        currency, status
      ) VALUES (
        $1, 'withdrawal', $2, $3, $4, $5, 'PEN', 'processing'
      ) RETURNING id
    `, [userId, metadata.method, amount, fee, netAmount]);

    // Crear transacción principal (retiro)
    const [txn] = await client.query<{ id: string }>(`
      INSERT INTO transactions (
        reference_type, reference_id, transaction_type, status,
        amount, currency, description, metadata, initiated_by
      ) VALUES (
        'payment', $1, 'withdrawal', 'completed',
        $2, 'PEN', $3, $4, $5
      ) RETURNING id
    `, [
      payment.id,
      netAmount,
      metadata.description || 'Retiro de fondos',
      JSON.stringify(metadata),
      userId
    ]);

    // Entrada 1: Débito de wallet del usuario (sale netAmount)
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, 0, $3, 0, 'Withdrawal - User wallet out', 1)
    `, [txn.id, wallet.available_account_id, netAmount]);

    // Entrada 2: Crédito a tesorería (entra para procesar retiro)
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, $3, 0, 0, 'Withdrawal - Treasury in', 2)
    `, [txn.id, treasury!.account_id, netAmount]);

    // Crear transacción de comisión
    if (fee > 0) {
      const [feeTxn] = await client.query<{ id: string }>(`
        INSERT INTO transactions (
          reference_type, reference_id, transaction_type, status,
          amount, currency, description, initiated_by
        ) VALUES (
          'payment', $1, 'commission_charge', 'completed',
          $2, 'PEN', 'Withdrawal fee', $3
        ) RETURNING id
      `, [payment.id, fee, userId]);

      // Débito de wallet (sale comisión)
      await client.query(`
        INSERT INTO ledger_entries (
          transaction_id, account_id, debit, credit,
          running_balance, line_description, sequence_number
        ) VALUES ($1, $2, 0, $3, 0, 'Withdrawal fee - User out', 1)
      `, [feeTxn.id, wallet.available_account_id, fee]);

      // Crédito a pool de comisiones
      await client.query(`
        INSERT INTO ledger_entries (
          transaction_id, account_id, debit, credit,
          running_balance, line_description, sequence_number
        ) VALUES ($1, $2, $3, 0, 0, 'Withdrawal fee - Commission in', 2)
      `, [feeTxn.id, commissions!.account_id, fee]);
    }

    // Actualizar payment con transaction_id
    await client.query(`
      UPDATE payments SET transaction_id = $1 WHERE id = $2
    `, [txn.id, payment.id]);

    // Log de auditoría
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'wallet.withdrawal', 'wallet', $2, 'Withdrawal initiated', $3)
    `, [userId, txn.id, JSON.stringify({ amount, fee, netAmount })]);

    return {
      transactionId: txn.id,
      paymentId: payment.id
    };
  });

  const newBalance = await getWalletBalance(userId);

  return {
    success: true,
    transactionId: result.transactionId,
    paymentId: result.paymentId,
    amount,
    fee,
    netAmount,
    newBalance
  };
}

// ============================================================================
// ESCROW (Bloqueo de Fondos)
// ============================================================================

/**
 * Bloquea fondos en escrow para una orden
 */
export async function lockFundsForOrder(
  userId: string,
  amount: number,
  orderId: string
): Promise<{ transactionId: string; newBalance: WalletBalance }> {
  if (amount <= 0) {
    throw new WalletError('Invalid escrow amount', 'INVALID_AMOUNT', 400);
  }

  const result = await transactionWithIsolation('SERIALIZABLE', async (client) => {
    // Obtener wallet con lock
    const wallet = await client.queryOne<{
      available_account_id: string;
      escrow_account_id: string;
      available_balance: string;
    }>(`
      SELECT available_account_id, escrow_account_id, available_balance
      FROM wallets WHERE user_id = $1
      FOR UPDATE
    `, [userId]);

    if (!wallet) {
      throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
    }

    const available = parseFloat(wallet.available_balance);
    if (available < amount) {
      throw new WalletError(
        `Insufficient balance for order: ${available} < ${amount}`,
        'INSUFFICIENT_BALANCE',
        400
      );
    }

    // Crear transacción
    const [txn] = await client.query<{ id: string }>(`
      INSERT INTO transactions (
        reference_type, reference_id, transaction_type, status,
        amount, currency, description, initiated_by
      ) VALUES (
        'order', $1, 'order_escrow', 'completed',
        $2, 'PEN', 'Funds locked for order', $3
      ) RETURNING id
    `, [orderId, amount, userId]);

    // Débito de disponible
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, 0, $3, 0, 'Order escrow - Available out', 1)
    `, [txn.id, wallet.available_account_id, amount]);

    // Crédito a escrow
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, $3, 0, 0, 'Order escrow - Escrow in', 2)
    `, [txn.id, wallet.escrow_account_id, amount]);

    return { transactionId: txn.id };
  });

  const newBalance = await getWalletBalance(userId);

  return {
    transactionId: result.transactionId,
    newBalance
  };
}

/**
 * Libera fondos del escrow (cancelación de orden)
 */
export async function releaseFundsFromEscrow(
  userId: string,
  amount: number,
  orderId: string
): Promise<{ transactionId: string; newBalance: WalletBalance }> {
  if (amount <= 0) {
    throw new WalletError('Invalid release amount', 'INVALID_AMOUNT', 400);
  }

  const result = await transactionWithIsolation('SERIALIZABLE', async (client) => {
    const wallet = await client.queryOne<{
      available_account_id: string;
      escrow_account_id: string;
      escrow_balance: string;
    }>(`
      SELECT available_account_id, escrow_account_id, escrow_balance
      FROM wallets WHERE user_id = $1
      FOR UPDATE
    `, [userId]);

    if (!wallet) {
      throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
    }

    const escrowBalance = parseFloat(wallet.escrow_balance);
    if (escrowBalance < amount) {
      throw new WalletError(
        `Insufficient escrow balance: ${escrowBalance} < ${amount}`,
        'INSUFFICIENT_ESCROW',
        400
      );
    }

    // Crear transacción
    const [txn] = await client.query<{ id: string }>(`
      INSERT INTO transactions (
        reference_type, reference_id, transaction_type, status,
        amount, currency, description, initiated_by
      ) VALUES (
        'order', $1, 'order_release', 'completed',
        $2, 'PEN', 'Funds released from escrow', $3
      ) RETURNING id
    `, [orderId, amount, userId]);

    // Débito de escrow
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, 0, $3, 0, 'Order release - Escrow out', 1)
    `, [txn.id, wallet.escrow_account_id, amount]);

    // Crédito a disponible
    await client.query(`
      INSERT INTO ledger_entries (
        transaction_id, account_id, debit, credit,
        running_balance, line_description, sequence_number
      ) VALUES ($1, $2, $3, 0, 0, 'Order release - Available in', 2)
    `, [txn.id, wallet.available_account_id, amount]);

    return { transactionId: txn.id };
  });

  const newBalance = await getWalletBalance(userId);

  return {
    transactionId: result.transactionId,
    newBalance
  };
}

// ============================================================================
// HISTORIAL DE TRANSACCIONES
// ============================================================================

/**
 * Obtiene el historial de transacciones del usuario
 */
export async function getTransactionHistory(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    type?: TransactionType;
    status?: TransactionStatus;
    startDate?: Date;
    endDate?: Date;
  } = {}
): Promise<{
  transactions: WalletTransaction[];
  total: number;
  hasMore: boolean;
}> {
  const {
    limit = 20,
    offset = 0,
    type,
    status,
    startDate,
    endDate
  } = options;

  // Construir query dinámicamente
  let whereClause = 'WHERE t.initiated_by = $1';
  const params: unknown[] = [userId];
  let paramIndex = 2;

  if (type) {
    whereClause += ` AND t.transaction_type = $${paramIndex}`;
    params.push(type);
    paramIndex++;
  }

  if (status) {
    whereClause += ` AND t.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (startDate) {
    whereClause += ` AND t.created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND t.created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  // Obtener total
  const [countResult] = await query<{ count: string }>(`
    SELECT COUNT(*) as count FROM transactions t ${whereClause}
  `, params);
  const total = parseInt(countResult.count);

  // Obtener transacciones
  params.push(limit, offset);
  const transactions = await query<{
    id: string;
    transaction_type: TransactionType;
    amount: string;
    status: TransactionStatus;
    description: string;
    reference_type: string;
    reference_id: string;
    created_at: Date;
    completed_at: Date;
  }>(`
    SELECT
      t.id, t.transaction_type, t.amount, t.status, t.description,
      t.reference_type, t.reference_id, t.created_at, t.completed_at
    FROM transactions t
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `, params);

  return {
    transactions: transactions.map(t => ({
      id: t.id,
      type: t.transaction_type,
      amount: parseFloat(t.amount),
      status: t.status,
      description: t.description,
      referenceType: t.reference_type,
      referenceId: t.reference_id,
      createdAt: t.created_at,
      completedAt: t.completed_at
    })),
    total,
    hasMore: offset + transactions.length < total
  };
}

// ============================================================================
// LÍMITES Y VALIDACIONES
// ============================================================================

/**
 * Verifica si el usuario puede depositar el monto especificado
 */
export async function canDeposit(
  userId: string,
  amount: number
): Promise<{ allowed: boolean; reason?: string; limit?: number }> {
  const [user] = await query<{
    daily_deposit_limit: string;
    kyc_status: string;
  }>(`
    SELECT daily_deposit_limit, kyc_status FROM users WHERE id = $1
  `, [userId]);

  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  // Verificar KYC
  if (user.kyc_status !== 'verified') {
    return {
      allowed: false,
      reason: 'KYC verification required for deposits'
    };
  }

  // Calcular depósitos del día
  const [deposits] = await query<{ total: string }>(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE user_id = $1
      AND payment_type = 'deposit'
      AND status = 'completed'
      AND created_at >= CURRENT_DATE
  `, [userId]);

  const dailyDeposits = parseFloat(deposits.total);
  const dailyLimit = parseFloat(user.daily_deposit_limit);
  const remaining = dailyLimit - dailyDeposits;

  if (amount > remaining) {
    return {
      allowed: false,
      reason: `Daily deposit limit exceeded. Remaining: S/${remaining.toFixed(2)}`,
      limit: remaining
    };
  }

  return { allowed: true, limit: remaining };
}

/**
 * Verifica si el usuario puede retirar el monto especificado
 */
export async function canWithdraw(
  userId: string,
  amount: number
): Promise<{ allowed: boolean; reason?: string; availableBalance?: number }> {
  const balance = await getWalletBalance(userId);

  if (amount > balance.available) {
    return {
      allowed: false,
      reason: 'Insufficient available balance',
      availableBalance: balance.available
    };
  }

  // Verificar límite diario
  const [user] = await query<{ daily_withdrawal_limit: string }>(`
    SELECT daily_withdrawal_limit FROM users WHERE id = $1
  `, [userId]);

  const [withdrawals] = await query<{ total: string }>(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE user_id = $1
      AND payment_type = 'withdrawal'
      AND status IN ('completed', 'processing')
      AND created_at >= CURRENT_DATE
  `, [userId]);

  const dailyWithdrawals = parseFloat(withdrawals.total);
  const dailyLimit = parseFloat(user.daily_withdrawal_limit);
  const remaining = dailyLimit - dailyWithdrawals;

  if (amount > remaining) {
    return {
      allowed: false,
      reason: `Daily withdrawal limit exceeded. Remaining: S/${remaining.toFixed(2)}`,
      availableBalance: balance.available
    };
  }

  return { allowed: true, availableBalance: balance.available };
}

// ============================================================================
// ERROR PERSONALIZADO
// ============================================================================

export class WalletError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
