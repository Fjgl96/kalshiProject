/**
 * KALSHI PERÚ - Servicio de Verificación SMS
 *
 * Integración con proveedores de SMS para números peruanos.
 * Soporta: Twilio, AWS SNS, y modo Mock para desarrollo.
 *
 * ¿Por qué verificación SMS?
 * - Los números móviles peruanos son únicos por persona
 * - Proporciona segundo factor de autenticación
 * - Requerido para transacciones financieras
 *
 * RIESGOS MITIGADOS:
 * 1. SMS bombing: Rate limiting por número
 * 2. Códigos adivinados: 6 dígitos + expiración corta + max intentos
 * 3. Replay attacks: Códigos de un solo uso
 */

import { env } from '../config/env.config';
import { query, queryOne } from '../config/database.config';
import { generateVerificationCode, hashToken, generateSecureToken } from '../utils/encryption';

// ============================================================================
// TIPOS
// ============================================================================

export interface SendSMSResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface VerifyCodeResult {
  valid: boolean;
  error?: string;
  remainingAttempts?: number;
}

type VerificationType = 'phone' | 'password_reset' | '2fa';

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MINUTES = 60;
const MAX_CODES_PER_HOUR = 5;

// ============================================================================
// PROVEEDORES DE SMS
// ============================================================================

interface SMSProvider {
  send(phone: string, message: string): Promise<SendSMSResult>;
}

/**
 * Proveedor Mock para desarrollo
 */
class MockSMSProvider implements SMSProvider {
  private sentMessages: Map<string, string[]> = new Map();

  async send(phone: string, message: string): Promise<SendSMSResult> {
    console.log(`[MOCK SMS] To: ${phone}`);
    console.log(`[MOCK SMS] Message: ${message}`);

    // Almacenar para pruebas
    const existing = this.sentMessages.get(phone) || [];
    existing.push(message);
    this.sentMessages.set(phone, existing);

    // Simular delay de red
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      success: true,
      messageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`
    };
  }

  // Helper para pruebas
  getLastCode(phone: string): string | null {
    const messages = this.sentMessages.get(phone);
    if (!messages || messages.length === 0) return null;

    const lastMessage = messages[messages.length - 1];
    const match = lastMessage.match(/\b(\d{6})\b/);
    return match ? match[1] : null;
  }
}

/**
 * Proveedor Twilio
 */
class TwilioProvider implements SMSProvider {
  private accountSid: string;
  private authToken: string;
  private fromNumber: string;

  constructor() {
    this.accountSid = env.TWILIO_ACCOUNT_SID || '';
    this.authToken = env.TWILIO_AUTH_TOKEN || '';
    this.fromNumber = env.TWILIO_PHONE_NUMBER || '';
  }

  async send(phone: string, message: string): Promise<SendSMSResult> {
    try {
      // Importación dinámica de Twilio (solo si se usa)
      const twilio = await import('twilio');
      const client = twilio.default(this.accountSid, this.authToken);

      const result = await client.messages.create({
        body: message,
        from: this.fromNumber,
        to: phone
      });

      return {
        success: true,
        messageId: result.sid
      };
    } catch (error) {
      console.error('Twilio error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

/**
 * Proveedor AWS SNS
 */
class AWSSNSProvider implements SMSProvider {
  async send(phone: string, message: string): Promise<SendSMSResult> {
    try {
      // Importación dinámica de AWS SDK
      const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');

      const client = new SNSClient({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID || '',
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const command = new PublishCommand({
        PhoneNumber: phone,
        Message: message,
        MessageAttributes: {
          'AWS.SNS.SMS.SenderID': {
            DataType: 'String',
            StringValue: 'KalshiPE'
          },
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional'
          }
        }
      });

      const result = await client.send(command);

      return {
        success: true,
        messageId: result.MessageId
      };
    } catch (error) {
      console.error('AWS SNS error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// ============================================================================
// FACTORY DE PROVEEDORES
// ============================================================================

let smsProvider: SMSProvider | null = null;

function getSMSProvider(): SMSProvider {
  if (smsProvider) return smsProvider;

  switch (env.SMS_PROVIDER) {
    case 'twilio':
      smsProvider = new TwilioProvider();
      break;
    case 'aws_sns':
      smsProvider = new AWSSNSProvider();
      break;
    case 'mock':
    default:
      smsProvider = new MockSMSProvider();
      break;
  }

  return smsProvider;
}

// Exportar mock provider para pruebas
export function getMockProvider(): MockSMSProvider | null {
  if (env.SMS_PROVIDER === 'mock' && smsProvider instanceof MockSMSProvider) {
    return smsProvider;
  }
  return null;
}

// ============================================================================
// FUNCIONES PRINCIPALES
// ============================================================================

/**
 * Envía un código de verificación por SMS
 */
export async function sendVerificationCode(
  phone: string,
  type: VerificationType,
  userId?: string,
  metadata: { ipAddress?: string } = {}
): Promise<{ success: boolean; expiresAt: Date; error?: string }> {
  // Validar formato de teléfono peruano
  if (!isValidPeruvianPhone(phone)) {
    return {
      success: false,
      expiresAt: new Date(),
      error: 'Número de teléfono inválido'
    };
  }

  // Rate limiting: máximo X códigos por hora por número
  const recentCodes = await queryOne<{ count: string }>(`
    SELECT COUNT(*) as count
    FROM verification_codes
    WHERE destination = $1
      AND type = $2
      AND created_at > NOW() - INTERVAL '${RATE_LIMIT_WINDOW_MINUTES} minutes'
  `, [phone, type]);

  if (recentCodes && parseInt(recentCodes.count) >= MAX_CODES_PER_HOUR) {
    return {
      success: false,
      expiresAt: new Date(),
      error: 'Demasiados códigos enviados. Intenta más tarde.'
    };
  }

  // Generar código
  const code = generateVerificationCode(CODE_LENGTH);
  const codeHash = hashToken(code);

  // Calcular expiración
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + CODE_EXPIRY_MINUTES);

  // Invalidar códigos anteriores del mismo tipo
  await query(`
    UPDATE verification_codes
    SET verified = true
    WHERE destination = $1 AND type = $2 AND verified = false
  `, [phone, type]);

  // Guardar nuevo código
  await query(`
    INSERT INTO verification_codes (
      user_id, type, destination, code_hash, expires_at, ip_address
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId || null, type, phone, codeHash, expiresAt, metadata.ipAddress]);

  // Construir mensaje
  const message = buildSMSMessage(type, code);

  // Enviar SMS
  const provider = getSMSProvider();
  const result = await provider.send(phone, message);

  if (!result.success) {
    return {
      success: false,
      expiresAt,
      error: 'Error al enviar SMS. Intenta de nuevo.'
    };
  }

  // Log para auditoría (sin el código)
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, ip_address, description, metadata
    ) VALUES ($1, 'sms.verification_sent', 'verification', $2, 'Verification code sent', $3)
  `, [
    userId,
    metadata.ipAddress,
    JSON.stringify({ phone: maskPhone(phone), type, messageId: result.messageId })
  ]);

  return {
    success: true,
    expiresAt
  };
}

/**
 * Verifica un código de SMS
 */
export async function verifyCode(
  phone: string,
  code: string,
  type: VerificationType,
  metadata: { ipAddress?: string } = {}
): Promise<VerifyCodeResult> {
  const codeHash = hashToken(code);

  // Buscar código válido
  const verification = await queryOne<{
    id: string;
    user_id: string | null;
    attempts: number;
    max_attempts: number;
    expires_at: Date;
  }>(`
    SELECT id, user_id, attempts, max_attempts, expires_at
    FROM verification_codes
    WHERE destination = $1
      AND type = $2
      AND verified = false
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `, [phone, type]);

  if (!verification) {
    return {
      valid: false,
      error: 'Código expirado o inválido'
    };
  }

  // Verificar intentos
  if (verification.attempts >= verification.max_attempts) {
    // Marcar como usado
    await query(`
      UPDATE verification_codes SET verified = true WHERE id = $1
    `, [verification.id]);

    return {
      valid: false,
      error: 'Máximo de intentos alcanzado',
      remainingAttempts: 0
    };
  }

  // Verificar código
  const storedHash = await queryOne<{ code_hash: string }>(`
    SELECT code_hash FROM verification_codes WHERE id = $1
  `, [verification.id]);

  if (!storedHash || storedHash.code_hash !== codeHash) {
    // Incrementar intentos
    await query(`
      UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1
    `, [verification.id]);

    const remainingAttempts = verification.max_attempts - verification.attempts - 1;

    return {
      valid: false,
      error: 'Código incorrecto',
      remainingAttempts
    };
  }

  // Código válido - marcar como verificado
  await query(`
    UPDATE verification_codes
    SET verified = true, verified_at = NOW()
    WHERE id = $1
  `, [verification.id]);

  // Si hay usuario asociado, marcar teléfono como verificado
  if (verification.user_id && type === 'phone') {
    await query(`
      UPDATE users SET phone_verified = true WHERE id = $1
    `, [verification.user_id]);
  }

  // Log de auditoría
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, ip_address, description
    ) VALUES ($1, 'sms.verification_success', 'verification', $2, 'Phone verified successfully')
  `, [verification.user_id, metadata.ipAddress]);

  return { valid: true };
}

/**
 * Reenvía un código de verificación
 */
export async function resendVerificationCode(
  phone: string,
  type: VerificationType,
  userId?: string,
  metadata: { ipAddress?: string } = {}
): Promise<{ success: boolean; expiresAt: Date; error?: string; waitSeconds?: number }> {
  // Verificar si hay un código reciente (menos de 60 segundos)
  const recentCode = await queryOne<{ created_at: Date }>(`
    SELECT created_at
    FROM verification_codes
    WHERE destination = $1 AND type = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [phone, type]);

  if (recentCode) {
    const secondsSinceLastCode = (Date.now() - recentCode.created_at.getTime()) / 1000;
    const minWaitSeconds = 60;

    if (secondsSinceLastCode < minWaitSeconds) {
      return {
        success: false,
        expiresAt: new Date(),
        error: 'Espera antes de solicitar otro código',
        waitSeconds: Math.ceil(minWaitSeconds - secondsSinceLastCode)
      };
    }
  }

  // Enviar nuevo código
  return sendVerificationCode(phone, type, userId, metadata);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Valida formato de teléfono peruano
 */
function isValidPeruvianPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s-]/g, '');

  if (cleaned.startsWith('+51')) {
    const number = cleaned.slice(3);
    // Móvil peruano
    if (number.startsWith('9') && number.length === 9) {
      return true;
    }
    // Fijo Lima
    if (number.startsWith('1') && number.length === 8) {
      return true;
    }
  }

  return false;
}

/**
 * Construye el mensaje SMS según el tipo
 */
function buildSMSMessage(type: VerificationType, code: string): string {
  switch (type) {
    case 'phone':
      return `Tu código de verificación Kalshi Perú es: ${code}. Válido por ${CODE_EXPIRY_MINUTES} minutos. No compartas este código.`;
    case 'password_reset':
      return `Tu código para restablecer contraseña en Kalshi Perú es: ${code}. Válido por ${CODE_EXPIRY_MINUTES} minutos.`;
    case '2fa':
      return `Tu código de acceso Kalshi Perú es: ${code}. Válido por ${CODE_EXPIRY_MINUTES} minutos.`;
    default:
      return `Tu código Kalshi Perú es: ${code}. Válido por ${CODE_EXPIRY_MINUTES} minutos.`;
  }
}

/**
 * Enmascara número de teléfono para logs
 */
function maskPhone(phone: string): string {
  if (phone.length < 6) return '***';
  return phone.slice(0, 4) + '***' + phone.slice(-2);
}

// ============================================================================
// LIMPIEZA
// ============================================================================

/**
 * Limpia códigos expirados (ejecutar como cron job)
 */
export async function cleanupExpiredCodes(): Promise<number> {
  const result = await query<{ count: number }>(`
    DELETE FROM verification_codes
    WHERE expires_at < NOW()
    RETURNING 1
  `, []);

  return result.length;
}
