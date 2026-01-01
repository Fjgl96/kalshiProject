/**
 * KALSHI PERÚ - Configuración de Variables de Entorno
 *
 * ESTRATEGIA DE SEGURIDAD:
 * 1. Validación estricta con Zod al inicio de la aplicación
 * 2. Tipado fuerte para evitar errores de runtime
 * 3. Valores por defecto seguros para desarrollo
 * 4. Separación clara entre dev/staging/production
 *
 * RIESGOS MITIGADOS:
 * - Variables faltantes: La app no inicia sin todas las variables requeridas
 * - Variables mal formateadas: Zod valida formatos (URLs, números, etc.)
 * - Exposición accidental: Las keys sensibles nunca se loguean
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Cargar archivo .env basado en NODE_ENV
const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : process.env.NODE_ENV === 'test'
    ? '.env.test'
    : '.env';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

// ============================================================================
// ESQUEMA DE VALIDACIÓN
// ============================================================================

const envSchema = z.object({
  // =========================================================================
  // GENERAL
  // =========================================================================
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test'])
    .default('development'),

  PORT: z.string()
    .transform(Number)
    .pipe(z.number().min(1).max(65535))
    .default('3000'),

  API_VERSION: z.string().default('v1'),

  // URL base del API (para generar links)
  API_BASE_URL: z.string().url().default('http://localhost:3000'),

  // URL del frontend (para CORS)
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // =========================================================================
  // BASE DE DATOS
  // =========================================================================
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform(Number).default('5432'),
  DB_NAME: z.string().default('kalshi_peru'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().min(8),

  // Pool de conexiones
  DB_POOL_MIN: z.string().transform(Number).default('2'),
  DB_POOL_MAX: z.string().transform(Number).default('10'),

  // SSL para producción
  DB_SSL_CA: z.string().optional(),

  // =========================================================================
  // ENCRIPTACIÓN Y SEGURIDAD
  // =========================================================================

  // Clave AES-256 (64 caracteres hex = 256 bits)
  // GENERAR CON: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ENCRYPTION_KEY: z.string()
    .regex(/^[a-f0-9]{64}$/i, 'ENCRYPTION_KEY must be 64 hex characters'),

  // Secreto para hashing de búsqueda (HMAC)
  HASH_SECRET: z.string().min(32),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // =========================================================================
  // RATE LIMITING
  // =========================================================================
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'), // 1 minuto
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('100'),

  // Límites específicos por endpoint
  RATE_LIMIT_AUTH_MAX: z.string().transform(Number).default('5'),    // Login/register
  RATE_LIMIT_ORDER_MAX: z.string().transform(Number).default('30'),  // Órdenes

  // =========================================================================
  // PASARELAS DE PAGO (Perú)
  // =========================================================================

  // Yape (Simulado - En producción sería Niubiz o similar)
  YAPE_MERCHANT_ID: z.string().optional(),
  YAPE_API_KEY: z.string().optional(),
  YAPE_WEBHOOK_SECRET: z.string().optional(),

  // Plin (Simulado)
  PLIN_MERCHANT_ID: z.string().optional(),
  PLIN_API_KEY: z.string().optional(),
  PLIN_WEBHOOK_SECRET: z.string().optional(),

  // Culqi (Pasarela de tarjetas)
  CULQI_PUBLIC_KEY: z.string().optional(),
  CULQI_SECRET_KEY: z.string().optional(),
  CULQI_WEBHOOK_SECRET: z.string().optional(),

  // Izipay (Alternativa)
  IZIPAY_MERCHANT_ID: z.string().optional(),
  IZIPAY_API_KEY: z.string().optional(),
  IZIPAY_API_SECRET: z.string().optional(),

  // =========================================================================
  // SERVICIOS EXTERNOS
  // =========================================================================

  // SMS (Twilio o similar)
  SMS_PROVIDER: z.enum(['twilio', 'aws_sns', 'mock']).default('mock'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // Email (SendGrid, AWS SES, etc.)
  EMAIL_PROVIDER: z.enum(['sendgrid', 'aws_ses', 'smtp', 'mock']).default('mock'),
  SENDGRID_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default('noreply@kalshiperu.com'),

  // KYC - RENIEC (Simulado)
  RENIEC_API_URL: z.string().url().optional(),
  RENIEC_API_KEY: z.string().optional(),

  // Storage (S3, GCS, local)
  STORAGE_PROVIDER: z.enum(['s3', 'gcs', 'local']).default('local'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional(),

  // =========================================================================
  // TRADING
  // =========================================================================

  // Comisiones (en porcentaje)
  TRADING_COMMISSION_RATE: z.string().transform(Number).default('0.02'), // 2%
  MIN_TRADING_COMMISSION: z.string().transform(Number).default('0.10'),  // S/ 0.10 mínimo

  // Límites
  MIN_ORDER_AMOUNT: z.string().transform(Number).default('1'),      // S/ 1 mínimo
  MAX_ORDER_AMOUNT: z.string().transform(Number).default('10000'),  // S/ 10,000 máximo
  MIN_DEPOSIT: z.string().transform(Number).default('10'),          // S/ 10 mínimo
  MAX_DAILY_DEPOSIT: z.string().transform(Number).default('50000'), // S/ 50,000 diario
  MIN_WITHDRAWAL: z.string().transform(Number).default('20'),       // S/ 20 mínimo

  // =========================================================================
  // MONITOREO Y LOGGING
  // =========================================================================
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Sentry para error tracking
  SENTRY_DSN: z.string().url().optional(),

  // APM (Application Performance Monitoring)
  APM_ENABLED: z.string().transform(v => v === 'true').default('false'),

  // =========================================================================
  // FEATURE FLAGS
  // =========================================================================
  ENABLE_KYC_VERIFICATION: z.string().transform(v => v === 'true').default('true'),
  ENABLE_REAL_PAYMENTS: z.string().transform(v => v === 'true').default('false'),
  ENABLE_SMS_VERIFICATION: z.string().transform(v => v === 'true').default('false'),
  MAINTENANCE_MODE: z.string().transform(v => v === 'true').default('false'),
});

// ============================================================================
// PARSEAR Y VALIDAR
// ============================================================================

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// ============================================================================
// VALIDACIONES ADICIONALES POR ENTORNO
// ============================================================================

if (env.NODE_ENV === 'production') {
  const requiredInProduction = [
    'DB_SSL_CA',
    'SENTRY_DSN',
  ];

  const paymentKeysRequired = env.ENABLE_REAL_PAYMENTS ? [
    'CULQI_PUBLIC_KEY',
    'CULQI_SECRET_KEY',
  ] : [];

  const smsRequired = env.ENABLE_SMS_VERIFICATION ? [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ] : [];

  const missing = [...requiredInProduction, ...paymentKeysRequired, ...smsRequired]
    .filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing required production variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Verifica si estamos en desarrollo
 */
export const isDevelopment = env.NODE_ENV === 'development';

/**
 * Verifica si estamos en producción
 */
export const isProduction = env.NODE_ENV === 'production';

/**
 * Verifica si estamos en modo test
 */
export const isTest = env.NODE_ENV === 'test';

/**
 * Obtiene la URL completa del API
 */
export function getApiUrl(path: string): string {
  return `${env.API_BASE_URL}/api/${env.API_VERSION}${path}`;
}

// ============================================================================
// TIPO EXPORTADO
// ============================================================================

export type Env = z.infer<typeof envSchema>;
