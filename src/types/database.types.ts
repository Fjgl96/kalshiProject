/**
 * KALSHI PERÚ - Tipos de Base de Datos
 * Definiciones TypeScript que mapean al esquema SQL
 */

// ============================================================================
// ENUMS
// ============================================================================

export type KycStatus = 'pending' | 'submitted' | 'verified' | 'rejected' | 'suspended';

export type UserStatus = 'active' | 'inactive' | 'suspended' | 'banned';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type AccountCategory =
  | 'user_wallet'
  | 'user_escrow'
  | 'platform_commission'
  | 'platform_treasury'
  | 'settlement_pool';

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'order_escrow'
  | 'order_release'
  | 'trade_execution'
  | 'market_settlement'
  | 'commission_charge'
  | 'refund'
  | 'adjustment';

export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'reversed';

export type MarketStatus =
  | 'draft'
  | 'scheduled'
  | 'open'
  | 'suspended'
  | 'closed'
  | 'settled'
  | 'cancelled';

export type MarketOutcome = 'yes' | 'no' | 'void';

export type OrderSide = 'yes' | 'no';

export type OrderType = 'limit' | 'market';

export type OrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'rejected';

export type PaymentMethod =
  | 'yape'
  | 'plin'
  | 'credit_card'
  | 'debit_card'
  | 'bank_transfer'
  | 'platform_credit';

export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

// ============================================================================
// INTERFACES DE ENTIDADES
// ============================================================================

export interface User {
  id: string;
  email: string;
  email_verified: boolean;
  phone: string | null;
  phone_verified: boolean;
  password_hash: string;
  password_salt: string;

  // Datos encriptados (Buffer en Node.js)
  dni_encrypted: Buffer | null;
  dni_hash: string | null;
  first_name_encrypted: Buffer | null;
  last_name_encrypted: Buffer | null;
  birth_date_encrypted: Buffer | null;
  address_encrypted: Buffer | null;
  bank_account_encrypted: Buffer | null;
  bank_cci_encrypted: Buffer | null;
  bank_name: string | null;

  // KYC
  kyc_status: KycStatus;
  kyc_submitted_at: Date | null;
  kyc_verified_at: Date | null;
  kyc_rejection_reason: string | null;
  kyc_documents: KycDocument[];

  // Estado
  status: UserStatus;
  is_admin: boolean;

  // Límites
  daily_deposit_limit: number;
  daily_withdrawal_limit: number;
  max_position_size: number;

  // Seguridad
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  two_factor_enabled: boolean;
  two_factor_secret_encrypted: Buffer | null;

  // Metadatos
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface KycDocument {
  type: 'dni_front' | 'dni_back' | 'selfie' | 'proof_of_address';
  file_key: string;
  uploaded_at: string;
  verified: boolean;
}

export interface Account {
  id: string;
  user_id: string | null;
  account_number: string;
  name: string;
  account_type: AccountType;
  category: AccountCategory;
  currency: string;
  balance: number;
  version: number;
  is_active: boolean;
  frozen: boolean;
  frozen_reason: string | null;
  frozen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Transaction {
  id: string;
  reference_type: string | null;
  reference_id: string | null;
  transaction_type: TransactionType;
  status: TransactionStatus;
  amount: number;
  currency: string;
  description: string | null;
  metadata: Record<string, unknown>;
  initiated_by: string | null;
  requires_approval: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  is_reversal: boolean;
  reversal_of: string | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string;
  account_id: string;
  debit: number;
  credit: number;
  running_balance: number;
  line_description: string | null;
  sequence_number: number;
  created_at: Date;
}

export interface Wallet {
  id: string;
  user_id: string;
  available_account_id: string;
  escrow_account_id: string;
  available_balance: number;
  escrow_balance: number;
  total_balance: number;
  currency: string;
  version: number;
  last_transaction_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Market {
  id: string;
  ticker: string;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  resolution_source: string;
  resolution_criteria: string;
  min_price: number;
  max_price: number;
  tick_size: number;
  min_order_size: number;
  max_order_size: number;
  position_limit: number;
  contract_value: number;
  scheduled_open_at: Date | null;
  opened_at: Date | null;
  closes_at: Date;
  settlement_date: Date;
  settled_at: Date | null;
  status: MarketStatus;
  outcome: MarketOutcome | null;
  last_yes_price: number | null;
  last_no_price: number | null;
  volume_24h: number;
  total_volume: number;
  open_interest: number;
  created_by: string | null;
  settled_by: string | null;
  settlement_notes: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: string;
  user_id: string;
  market_id: string;
  order_number: number;
  side: OrderSide;
  order_type: OrderType;
  limit_price: number | null;
  avg_fill_price: number | null;
  quantity: number;
  filled_quantity: number;
  remaining_quantity: number;
  estimated_cost: number;
  actual_cost: number;
  commission: number;
  escrow_amount: number;
  escrow_transaction_id: string | null;
  status: OrderStatus;
  rejection_reason: string | null;
  expires_at: Date | null;
  submitted_at: Date;
  opened_at: Date | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
  submitted_from_ip: string | null;
  user_agent: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Trade {
  id: string;
  trade_number: number;
  market_id: string;
  maker_order_id: string;
  taker_order_id: string;
  maker_user_id: string;
  taker_user_id: string;
  side: OrderSide;
  price: number;
  quantity: number;
  total_value: number;
  maker_commission: number;
  taker_commission: number;
  transaction_id: string | null;
  executed_at: Date;
}

export interface Position {
  id: string;
  user_id: string;
  market_id: string;
  yes_quantity: number;
  yes_avg_price: number;
  yes_cost: number;
  no_quantity: number;
  no_avg_price: number;
  no_cost: number;
  total_invested: number;
  realized_pnl: number;
  version: number;
  last_trade_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Payment {
  id: string;
  user_id: string;
  payment_type: 'deposit' | 'withdrawal';
  method: PaymentMethod;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  status: TransactionStatus;
  external_reference: string | null;
  provider_transaction_id: string | null;
  qr_code: string | null;
  qr_expires_at: Date | null;
  card_last_four: string | null;
  card_brand: string | null;
  destination_account_encrypted: Buffer | null;
  transaction_id: string | null;
  webhook_received_at: Date | null;
  webhook_payload: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
  processed_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  severity: AuditSeverity;
  description: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  success: boolean;
  error_message: string | null;
  created_at: Date;
}

// ============================================================================
// TIPOS PARA RESPUESTAS DE API
// ============================================================================

export interface UserPublic {
  id: string;
  email: string;
  phone: string | null;
  kyc_status: KycStatus;
  status: UserStatus;
  created_at: Date;
}

export interface WalletSummary {
  available_balance: number;
  escrow_balance: number;
  total_balance: number;
  currency: string;
}

export interface MarketSummary {
  id: string;
  ticker: string;
  title: string;
  category: string;
  status: MarketStatus;
  last_yes_price: number | null;
  last_no_price: number | null;
  volume_24h: number;
  closes_at: Date;
}

export interface OrderBookEntry {
  price: number;
  quantity: number;
  order_count: number;
}

export interface OrderBook {
  market_id: string;
  ticker: string;
  yes_bids: OrderBookEntry[];
  no_bids: OrderBookEntry[];
}

export interface PositionSummary {
  market_id: string;
  ticker: string;
  title: string;
  yes_quantity: number;
  no_quantity: number;
  total_invested: number;
  unrealized_pnl: number;
}

// ============================================================================
// TIPOS PARA OPERACIONES
// ============================================================================

export interface CreateOrderParams {
  user_id: string;
  market_id: string;
  side: OrderSide;
  order_type: OrderType;
  limit_price?: number;
  quantity: number;
}

export interface TransferParams {
  from_account_id: string;
  to_account_id: string;
  amount: number;
  transaction_type: TransactionType;
  description: string;
  reference_type?: string;
  reference_id?: string;
  initiated_by?: string;
  metadata?: Record<string, unknown>;
}
