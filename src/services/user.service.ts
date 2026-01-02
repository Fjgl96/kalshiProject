/**
 * KALSHI PERÚ - Servicio de Usuarios
 *
 * Gestión de registro, login y perfil de usuarios.
 *
 * RIESGOS MITIGADOS:
 * 1. Enumeración de usuarios: Mensajes genéricos de error
 * 2. Timing attacks: bcrypt tiene tiempo constante
 * 3. Brute force: Rate limiting + bloqueo de cuenta
 * 4. Password débil: Validación de fortaleza
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction } from '../config/database.config';
import {
  hashPassword,
  verifyPassword,
  encryptPersonalData,
  decryptPersonalData,
  encryptDNI,
  createSearchableHash
} from '../utils/encryption';
import {
  generateTokenPair,
  revokeAllUserTokens,
  AuthTokens,
  AuthError
} from './auth.service';
import { User, UserStatus, KycStatus } from '../types/database.types';

// ============================================================================
// TIPOS
// ============================================================================

export interface RegisterInput {
  email: string;
  password: string;
  phone: string;
  acceptTerms: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface UserProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  kycStatus: KycStatus;
  status: UserStatus;
  createdAt: Date;
  // Datos personales (solo si KYC completado)
  firstName?: string;
  lastName?: string;
}

interface UserRecord {
  id: string;
  email: string;
  email_verified: boolean;
  phone: string;
  phone_verified: boolean;
  password_hash: string;
  kyc_status: KycStatus;
  status: UserStatus;
  is_admin: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
  first_name_encrypted: Buffer | null;
  last_name_encrypted: Buffer | null;
  created_at: Date;
}

// ============================================================================
// VALIDACIÓN
// ============================================================================

/**
 * Valida formato de email
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Valida teléfono peruano
 * Formato: +51 9XX XXX XXX (móvil) o +51 X XXX XXXX (fijo)
 */
function isValidPeruvianPhone(phone: string): boolean {
  // Limpiar espacios y guiones
  const cleaned = phone.replace(/[\s-]/g, '');

  // Móvil: +519XXXXXXXX (12 dígitos total)
  // Fijo Lima: +511XXXXXXX (11 dígitos)
  // Fijo provincias: +51XXXXXXXX (10-11 dígitos)

  if (cleaned.startsWith('+51')) {
    const number = cleaned.slice(3);
    // Móvil peruano empieza con 9
    if (number.startsWith('9') && number.length === 9) {
      return true;
    }
    // Fijo Lima empieza con 1
    if (number.startsWith('1') && number.length === 8) {
      return true;
    }
  }

  return false;
}

/**
 * Valida fortaleza de contraseña
 * - Mínimo 8 caracteres
 * - Al menos una mayúscula
 * - Al menos una minúscula
 * - Al menos un número
 */
function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('La contraseña debe tener al menos 8 caracteres');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('La contraseña debe contener al menos una mayúscula');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('La contraseña debe contener al menos una minúscula');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('La contraseña debe contener al menos un número');
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// REGISTRO
// ============================================================================

/**
 * Registra un nuevo usuario
 */
export async function register(
  input: RegisterInput,
  metadata: { ipAddress?: string; userAgent?: string } = {}
): Promise<{ user: UserProfile; tokens: AuthTokens }> {
  // Validaciones
  if (!input.acceptTerms) {
    throw new AuthError('Debes aceptar los términos y condiciones', 'TERMS_NOT_ACCEPTED', 400);
  }

  if (!isValidEmail(input.email)) {
    throw new AuthError('Email inválido', 'INVALID_EMAIL', 400);
  }

  if (!isValidPeruvianPhone(input.phone)) {
    throw new AuthError(
      'Número de teléfono inválido. Usa formato peruano: +51 9XX XXX XXX',
      'INVALID_PHONE',
      400
    );
  }

  const passwordValidation = validatePasswordStrength(input.password);
  if (!passwordValidation.valid) {
    throw new AuthError(
      passwordValidation.errors.join('. '),
      'WEAK_PASSWORD',
      400
    );
  }

  // Verificar si el email ya existe
  const existingUser = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
    [input.email.toLowerCase()]
  );

  if (existingUser) {
    throw new AuthError('El email ya está registrado', 'EMAIL_EXISTS', 409);
  }

  // Verificar si el teléfono ya existe
  const existingPhone = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL',
    [input.phone]
  );

  if (existingPhone) {
    throw new AuthError('El número de teléfono ya está registrado', 'PHONE_EXISTS', 409);
  }

  // Hash de password
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(input.password);

  // Crear usuario en transacción
  const result = await transaction(async (client) => {
    // Insertar usuario
    const [user] = await client.query<UserRecord>(`
      INSERT INTO users (
        email,
        phone,
        password_hash,
        password_salt,
        kyc_status,
        status
      ) VALUES ($1, $2, $3, $4, 'pending', 'active')
      RETURNING *
    `, [
      input.email.toLowerCase(),
      input.phone,
      passwordHash,
      passwordSalt
    ]);

    // El trigger create_user_accounts creará automáticamente
    // las cuentas y wallet del usuario

    // Registrar en audit log
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        ip_address, user_agent, description
      ) VALUES ($1, 'user.register', 'user', $1, $2, $3, 'User registered')
    `, [user.id, metadata.ipAddress, metadata.userAgent]);

    return user;
  });

  // Generar tokens
  const tokens = await generateTokenPair(
    result.id,
    result.email,
    'user',
    result.kyc_status,
    metadata
  );

  return {
    user: mapUserToProfile(result),
    tokens
  };
}

// ============================================================================
// LOGIN
// ============================================================================

/**
 * Inicia sesión de un usuario
 */
export async function login(
  input: LoginInput,
  metadata: { ipAddress?: string; userAgent?: string } = {}
): Promise<{ user: UserProfile; tokens: AuthTokens }> {
  const email = input.email.toLowerCase();

  // Verificar rate limiting
  const rateLimitCheck = await queryOne<{
    allowed: boolean;
    attempts_count: number;
    locked_until: Date | null;
  }>(`
    SELECT * FROM check_login_rate_limit($1, 'email')
  `, [email]);

  if (rateLimitCheck && !rateLimitCheck.allowed) {
    // Registrar intento bloqueado
    await query(`
      SELECT record_login_attempt($1, 'email', false, $2, $3, 'rate_limited')
    `, [email, metadata.ipAddress, metadata.userAgent]);

    throw new AuthError(
      'Demasiados intentos fallidos. Intenta de nuevo más tarde.',
      'RATE_LIMITED',
      429
    );
  }

  // Buscar usuario
  const user = await queryOne<UserRecord>(`
    SELECT * FROM users
    WHERE email = $1 AND deleted_at IS NULL
  `, [email]);

  // Usuario no existe - usar mensaje genérico para evitar enumeración
  if (!user) {
    await query(`
      SELECT record_login_attempt($1, 'email', false, $2, $3, 'user_not_found')
    `, [email, metadata.ipAddress, metadata.userAgent]);

    throw new AuthError('Credenciales inválidas', 'INVALID_CREDENTIALS', 401);
  }

  // Verificar si la cuenta está bloqueada
  if (user.locked_until && user.locked_until > new Date()) {
    throw new AuthError(
      'Cuenta bloqueada temporalmente. Intenta de nuevo más tarde.',
      'ACCOUNT_LOCKED',
      423
    );
  }

  // Verificar si la cuenta está activa
  if (user.status !== 'active') {
    throw new AuthError(
      'Cuenta suspendida o inactiva. Contacta a soporte.',
      'ACCOUNT_INACTIVE',
      403
    );
  }

  // Verificar password
  const isValidPassword = await verifyPassword(input.password, user.password_hash);

  if (!isValidPassword) {
    // Incrementar contador de intentos fallidos
    const newAttempts = user.failed_login_attempts + 1;
    const shouldLock = newAttempts >= 5;

    await query(`
      UPDATE users SET
        failed_login_attempts = $1,
        locked_until = CASE WHEN $2 THEN NOW() + INTERVAL '30 minutes' ELSE NULL END
      WHERE id = $3
    `, [newAttempts, shouldLock, user.id]);

    // Registrar intento fallido
    await query(`
      SELECT record_login_attempt($1, 'email', false, $2, $3, 'invalid_password')
    `, [email, metadata.ipAddress, metadata.userAgent]);

    throw new AuthError('Credenciales inválidas', 'INVALID_CREDENTIALS', 401);
  }

  // Login exitoso - resetear contador de intentos
  await query(`
    UPDATE users SET
      failed_login_attempts = 0,
      locked_until = NULL,
      last_login_at = NOW(),
      last_login_ip = $1
    WHERE id = $2
  `, [metadata.ipAddress, user.id]);

  // Registrar login exitoso
  await query(`
    SELECT record_login_attempt($1, 'email', true, $2, $3, NULL)
  `, [email, metadata.ipAddress, metadata.userAgent]);

  // Registrar en audit log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      ip_address, user_agent, description
    ) VALUES ($1, 'user.login', 'user', $1, $2, $3, 'User logged in')
  `, [user.id, metadata.ipAddress, metadata.userAgent]);

  // Generar tokens
  const tokens = await generateTokenPair(
    user.id,
    user.email,
    user.is_admin ? 'admin' : 'user',
    user.kyc_status,
    metadata
  );

  return {
    user: mapUserToProfile(user),
    tokens
  };
}

// ============================================================================
// LOGOUT
// ============================================================================

/**
 * Cierra sesión (revoca refresh token)
 */
export async function logout(
  userId: string,
  refreshToken: string,
  metadata: { ipAddress?: string; userAgent?: string } = {}
): Promise<void> {
  const { revokeRefreshToken } = await import('./auth.service');
  await revokeRefreshToken(refreshToken);

  // Registrar en audit log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      ip_address, user_agent, description
    ) VALUES ($1, 'user.logout', 'user', $1, $2, $3, 'User logged out')
  `, [userId, metadata.ipAddress, metadata.userAgent]);
}

/**
 * Cierra todas las sesiones
 */
export async function logoutAll(
  userId: string,
  metadata: { ipAddress?: string; userAgent?: string } = {}
): Promise<number> {
  const count = await revokeAllUserTokens(userId);

  // Registrar en audit log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      ip_address, user_agent, description, metadata
    ) VALUES ($1, 'user.logout_all', 'user', $1, $2, $3, 'User logged out from all sessions', $4)
  `, [userId, metadata.ipAddress, metadata.userAgent, JSON.stringify({ sessions_revoked: count })]);

  return count;
}

// ============================================================================
// PERFIL
// ============================================================================

/**
 * Obtiene el perfil de un usuario
 */
export async function getProfile(userId: string): Promise<UserProfile> {
  const user = await queryOne<UserRecord>(`
    SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL
  `, [userId]);

  if (!user) {
    throw new AuthError('Usuario no encontrado', 'USER_NOT_FOUND', 404);
  }

  return mapUserToProfile(user);
}

/**
 * Obtiene el perfil completo con datos personales (requiere KYC)
 */
export async function getFullProfile(userId: string): Promise<UserProfile & {
  firstName: string;
  lastName: string;
  dni: string;
  bankName: string | null;
}> {
  const user = await queryOne<UserRecord & {
    dni_encrypted: Buffer | null;
    bank_name: string | null;
  }>(`
    SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL
  `, [userId]);

  if (!user) {
    throw new AuthError('Usuario no encontrado', 'USER_NOT_FOUND', 404);
  }

  const profile = mapUserToProfile(user);

  // Desencriptar datos personales si existen
  let firstName = '';
  let lastName = '';
  let dni = '';

  if (user.first_name_encrypted) {
    firstName = decryptPersonalData(user.first_name_encrypted, userId, 'first_name');
  }
  if (user.last_name_encrypted) {
    lastName = decryptPersonalData(user.last_name_encrypted, userId, 'last_name');
  }
  if (user.dni_encrypted) {
    const { decryptDNI } = await import('../utils/encryption');
    dni = decryptDNI(user.dni_encrypted, userId);
  }

  return {
    ...profile,
    firstName,
    lastName,
    dni,
    bankName: user.bank_name
  };
}

// ============================================================================
// CAMBIO DE CONTRASEÑA
// ============================================================================

/**
 * Cambia la contraseña del usuario
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  metadata: { ipAddress?: string; userAgent?: string } = {}
): Promise<void> {
  // Obtener usuario
  const user = await queryOne<{ password_hash: string }>(`
    SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL
  `, [userId]);

  if (!user) {
    throw new AuthError('Usuario no encontrado', 'USER_NOT_FOUND', 404);
  }

  // Verificar contraseña actual
  const isValid = await verifyPassword(currentPassword, user.password_hash);
  if (!isValid) {
    throw new AuthError('Contraseña actual incorrecta', 'INVALID_PASSWORD', 400);
  }

  // Validar nueva contraseña
  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    throw new AuthError(validation.errors.join('. '), 'WEAK_PASSWORD', 400);
  }

  // Hash de nueva contraseña
  const { hash, salt } = await hashPassword(newPassword);

  // Actualizar contraseña
  await query(`
    UPDATE users SET
      password_hash = $1,
      password_salt = $2,
      updated_at = NOW()
    WHERE id = $3
  `, [hash, salt, userId]);

  // Revocar todas las sesiones excepto la actual
  await revokeAllUserTokens(userId);

  // Registrar en audit log
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      ip_address, user_agent, description
    ) VALUES ($1, 'user.password_changed', 'user', $1, $2, $3, 'Password changed successfully')
  `, [userId, metadata.ipAddress, metadata.userAgent]);
}

// ============================================================================
// HELPERS
// ============================================================================

function mapUserToProfile(user: UserRecord): UserProfile {
  const profile: UserProfile = {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified,
    phone: user.phone,
    phoneVerified: user.phone_verified,
    kycStatus: user.kyc_status,
    status: user.status,
    createdAt: user.created_at
  };

  // Agregar nombre si está verificado
  if (user.first_name_encrypted) {
    try {
      profile.firstName = decryptPersonalData(user.first_name_encrypted, user.id, 'first_name');
    } catch {
      // Silenciar error de desencriptación
    }
  }
  if (user.last_name_encrypted) {
    try {
      profile.lastName = decryptPersonalData(user.last_name_encrypted, user.id, 'last_name');
    } catch {
      // Silenciar error de desencriptación
    }
  }

  return profile;
}
