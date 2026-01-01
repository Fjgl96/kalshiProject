/**
 * KALSHI PERÚ - Módulo de Encriptación
 *
 * Estrategia de encriptación para datos sensibles:
 * - AES-256-GCM para datos que necesitan ser desencriptados (DNI, datos bancarios)
 * - SHA-256 para hashing de búsqueda (DNI hash para búsquedas sin exponer el dato)
 * - bcrypt para passwords (resistente a ataques de fuerza bruta)
 *
 * RIESGOS MITIGADOS:
 * 1. Exposición de datos en caso de breach - Los datos están encriptados en reposo
 * 2. Ataques de rainbow table - Usamos salt único por registro
 * 3. Acceso no autorizado - Las claves están en variables de entorno
 * 4. Manipulación de datos - GCM provee autenticación
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { env } from '../config/env.config';

// ============================================================================
// CONSTANTES DE CONFIGURACIÓN
// ============================================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;           // 128 bits
const AUTH_TAG_LENGTH = 16;     // 128 bits
const SALT_LENGTH = 32;         // 256 bits
const BCRYPT_ROUNDS = 12;       // Balance entre seguridad y rendimiento

// ============================================================================
// INTERFACES
// ============================================================================

interface EncryptedData {
  iv: Buffer;
  authTag: Buffer;
  encrypted: Buffer;
}

interface EncryptionResult {
  data: Buffer;       // IV + authTag + encrypted concatenados
  hash?: string;      // Hash opcional para búsquedas
}

// ============================================================================
// AES-256-GCM ENCRYPTION
// Usado para datos que necesitan ser recuperados (DNI, datos bancarios)
// ============================================================================

/**
 * Encripta datos sensibles usando AES-256-GCM
 *
 * @param plaintext - Texto a encriptar
 * @param additionalData - Datos adicionales para autenticación (opcional)
 * @returns Buffer con formato: IV (16 bytes) + AuthTag (16 bytes) + Encrypted data
 *
 * ¿Por qué AES-256-GCM?
 * - GCM (Galois/Counter Mode) proporciona tanto confidencialidad como autenticación
 * - Detecta cualquier manipulación de los datos encriptados
 * - Es el estándar recomendado por NIST para encriptación autenticada
 */
export function encrypt(plaintext: string, additionalData?: string): Buffer {
  // Generar IV aleatorio (nunca reutilizar IVs con la misma clave)
  const iv = crypto.randomBytes(IV_LENGTH);

  // Crear cipher con la clave maestra
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    iv
  );

  // Agregar datos adicionales para autenticación (AAD)
  // Útil para vincular los datos encriptados a un contexto específico
  if (additionalData) {
    cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  }

  // Encriptar
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  // Obtener tag de autenticación
  const authTag = cipher.getAuthTag();

  // Concatenar: IV + AuthTag + Encrypted
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Desencripta datos usando AES-256-GCM
 *
 * @param encryptedBuffer - Buffer con formato: IV + AuthTag + Encrypted
 * @param additionalData - Datos adicionales usados en encriptación
 * @returns Texto desencriptado
 * @throws Error si la autenticación falla (datos manipulados)
 */
export function decrypt(encryptedBuffer: Buffer, additionalData?: string): string {
  // Extraer componentes
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = encryptedBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  // Crear decipher
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    iv
  );

  // Configurar tag de autenticación
  decipher.setAuthTag(authTag);

  // Configurar AAD si se proporcionó
  if (additionalData) {
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  }

  // Desencriptar
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

/**
 * Encripta con hash adicional para búsquedas
 * Útil para DNI: se puede buscar por hash sin exponer el valor real
 */
export function encryptWithHash(plaintext: string, additionalData?: string): EncryptionResult {
  return {
    data: encrypt(plaintext, additionalData),
    hash: createSearchableHash(plaintext)
  };
}

// ============================================================================
// HASHING PARA BÚSQUEDAS
// Permite buscar por DNI sin exponer el valor
// ============================================================================

/**
 * Crea un hash determinístico para búsquedas
 * Usa HMAC-SHA256 con una clave secreta para evitar rainbow tables
 */
export function createSearchableHash(value: string): string {
  return crypto
    .createHmac('sha256', env.HASH_SECRET)
    .update(value.toLowerCase().trim())
    .digest('hex');
}

/**
 * Verifica si un valor coincide con un hash
 */
export function verifyHash(value: string, hash: string): boolean {
  const computedHash = createSearchableHash(value);
  return crypto.timingSafeEqual(
    Buffer.from(computedHash, 'hex'),
    Buffer.from(hash, 'hex')
  );
}

// ============================================================================
// PASSWORD HASHING (bcrypt)
// ============================================================================

/**
 * Hashea una contraseña con bcrypt
 *
 * ¿Por qué bcrypt?
 * - Diseñado específicamente para passwords
 * - Incluye salt automáticamente
 * - Factor de trabajo ajustable (BCRYPT_ROUNDS)
 * - Resistente a ataques de GPU por su uso de memoria
 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  // Generar salt
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);

  // Hashear password
  const hash = await bcrypt.hash(password, salt);

  return { hash, salt };
}

/**
 * Verifica una contraseña contra su hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ============================================================================
// TOKENS Y CLAVES
// ============================================================================

/**
 * Genera un token seguro para sesiones, reset de password, etc.
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Genera un código numérico para verificación SMS
 */
export function generateVerificationCode(length: number = 6): string {
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  const code = crypto.randomInt(min, max);
  return code.toString();
}

/**
 * Hashea un token para almacenamiento seguro
 * Usado para tokens de reset password, API keys, etc.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ============================================================================
// ENCRIPTACIÓN ESPECÍFICA POR CAMPO
// Cada tipo de dato tiene su propia función para claridad
// ============================================================================

/**
 * Encripta DNI peruano
 * Retorna tanto el dato encriptado como el hash para búsquedas
 */
export function encryptDNI(dni: string, userId: string): EncryptionResult {
  // Validar formato DNI (8 dígitos)
  const cleanDNI = dni.replace(/\D/g, '');
  if (cleanDNI.length !== 8) {
    throw new Error('Invalid DNI format');
  }

  return encryptWithHash(cleanDNI, `dni:${userId}`);
}

/**
 * Desencripta DNI
 */
export function decryptDNI(encryptedDNI: Buffer, userId: string): string {
  return decrypt(encryptedDNI, `dni:${userId}`);
}

/**
 * Encripta datos bancarios (número de cuenta, CCI)
 */
export function encryptBankData(data: string, userId: string, dataType: 'account' | 'cci'): Buffer {
  return encrypt(data, `bank:${dataType}:${userId}`);
}

/**
 * Desencripta datos bancarios
 */
export function decryptBankData(encrypted: Buffer, userId: string, dataType: 'account' | 'cci'): string {
  return decrypt(encrypted, `bank:${dataType}:${userId}`);
}

/**
 * Encripta información personal (nombre, dirección, etc.)
 */
export function encryptPersonalData(data: string, userId: string, fieldName: string): Buffer {
  return encrypt(data, `personal:${fieldName}:${userId}`);
}

/**
 * Desencripta información personal
 */
export function decryptPersonalData(encrypted: Buffer, userId: string, fieldName: string): string {
  return decrypt(encrypted, `personal:${fieldName}:${userId}`);
}

// ============================================================================
// ROTACIÓN DE CLAVES
// Funciones para migrar datos cuando se rota la clave de encriptación
// ============================================================================

/**
 * Re-encripta datos con una nueva clave
 * Usado durante rotación de claves
 */
export function reencrypt(
  encryptedBuffer: Buffer,
  oldKey: string,
  newKey: string,
  additionalData?: string
): Buffer {
  // Desencriptar con clave antigua
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = encryptedBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(oldKey, 'hex'),
    iv
  );
  decipher.setAuthTag(authTag);
  if (additionalData) {
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  }

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString('utf8');

  // Re-encriptar con nueva clave
  const newIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(newKey, 'hex'),
    newIv
  );
  if (additionalData) {
    cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  }

  const newEncrypted = Buffer.concat([
    cipher.update(decrypted, 'utf8'),
    cipher.final()
  ]);
  const newAuthTag = cipher.getAuthTag();

  return Buffer.concat([newIv, newAuthTag, newEncrypted]);
}

// ============================================================================
// UTILIDADES DE VALIDACIÓN
// ============================================================================

/**
 * Valida que la clave de encriptación tenga el formato correcto
 */
export function validateEncryptionKey(key: string): boolean {
  // Debe ser hex de 64 caracteres (256 bits)
  return /^[a-f0-9]{64}$/i.test(key);
}

/**
 * Genera una nueva clave de encriptación
 * Usar solo para inicialización o rotación
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================================
// MÁSCARAS PARA DISPLAY
// ============================================================================

/**
 * Enmascara DNI para display (ej: "****4567")
 */
export function maskDNI(dni: string): string {
  if (dni.length !== 8) return '********';
  return '****' + dni.slice(-4);
}

/**
 * Enmascara número de cuenta bancaria
 */
export function maskBankAccount(account: string): string {
  if (account.length < 4) return '****';
  return '*'.repeat(account.length - 4) + account.slice(-4);
}

/**
 * Enmascara email (ej: "j***@gmail.com")
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***@***';
  const maskedLocal = local[0] + '***';
  return `${maskedLocal}@${domain}`;
}
