/**
 * KALSHI PERÚ - Servicio KYC (Know Your Customer)
 *
 * Verificación de identidad para usuarios peruanos.
 * Incluye:
 * - Validación de DNI con RENIEC (simulado)
 * - Subida y validación de documentos
 * - Detección básica de fraude
 *
 * ¿Por qué KYC?
 * - Requerido por regulaciones anti-lavado (AML)
 * - Previene fraude y robo de identidad
 * - Habilita límites de transacción más altos
 *
 * RIESGOS MITIGADOS:
 * 1. Robo de identidad: Verificación con documento oficial
 * 2. Documentos falsos: Detección básica de manipulación
 * 3. Datos expuestos: Encriptación de información sensible
 */

import { env } from '../config/env.config';
import { query, queryOne, transaction } from '../config/database.config';
import {
  encryptDNI,
  encryptPersonalData,
  createSearchableHash
} from '../utils/encryption';
import { KycStatus, KycDocument } from '../types/database.types';

// ============================================================================
// TIPOS
// ============================================================================

export interface ReniecPerson {
  dni: string;
  firstName: string;
  lastName: string;
  maternalLastName: string;
  birthDate: string;
  gender: 'M' | 'F';
  department: string;
  province: string;
  district: string;
  address: string;
  photo?: string;  // Base64 de la foto (si disponible)
  valid: boolean;
}

export interface KYCSubmission {
  dni: string;
  firstName: string;
  lastName: string;
  birthDate: string;  // YYYY-MM-DD
  address: string;
}

export interface DocumentUpload {
  type: 'dni_front' | 'dni_back' | 'selfie' | 'proof_of_address';
  fileBuffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface KYCResult {
  success: boolean;
  status: KycStatus;
  message: string;
  errors?: string[];
}

export interface DocumentAnalysis {
  valid: boolean;
  confidence: number;
  issues: string[];
  extractedData?: {
    dni?: string;
    name?: string;
    birthDate?: string;
  };
}

// ============================================================================
// RENIEC - API SIMULADA
// ============================================================================

/**
 * Consulta simulada a RENIEC
 *
 * En producción, esto se conectaría a la API real de RENIEC
 * o a un proveedor autorizado como:
 * - SUNAT (para RUC/DNI)
 * - Proveedores privados (Equifax, Sentinel, etc.)
 */
export async function consultarRENIEC(dni: string): Promise<ReniecPerson | null> {
  // Validar formato de DNI
  if (!isValidDNI(dni)) {
    return null;
  }

  // Si hay API real configurada, usarla
  if (env.RENIEC_API_URL && env.RENIEC_API_KEY) {
    try {
      return await consultarRENIECReal(dni);
    } catch (error) {
      console.error('Error consultando RENIEC:', error);
      // Fallback a simulación en desarrollo
      if (env.NODE_ENV !== 'production') {
        return consultarRENIECSimulado(dni);
      }
      throw error;
    }
  }

  // Modo simulado para desarrollo
  return consultarRENIECSimulado(dni);
}

/**
 * Consulta real a RENIEC (cuando esté disponible)
 */
async function consultarRENIECReal(dni: string): Promise<ReniecPerson | null> {
  const response = await fetch(`${env.RENIEC_API_URL}/consulta/dni`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RENIEC_API_KEY}`
    },
    body: JSON.stringify({ dni })
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;  // DNI no encontrado
    }
    throw new Error(`RENIEC API error: ${response.status}`);
  }

  const data = await response.json();
  return mapReniecResponse(data);
}

/**
 * Simulación de RENIEC para desarrollo
 * Genera datos ficticios pero consistentes basados en el DNI
 */
function consultarRENIECSimulado(dni: string): ReniecPerson | null {
  // DNIs de prueba que siempre fallan
  const invalidDNIs = ['00000000', '11111111', '99999999'];
  if (invalidDNIs.includes(dni)) {
    return null;
  }

  // Generar datos determinísticos basados en el DNI
  const seed = parseInt(dni);

  // Nombres y apellidos ficticios
  const nombres = ['Juan Carlos', 'María Elena', 'José Luis', 'Ana María', 'Carlos Alberto'];
  const apellidosP = ['García', 'Rodríguez', 'Martínez', 'López', 'Gonzáles'];
  const apellidosM = ['Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores'];
  const departamentos = ['Lima', 'Arequipa', 'Cusco', 'La Libertad', 'Piura'];

  const firstName = nombres[seed % nombres.length];
  const lastName = apellidosP[seed % apellidosP.length];
  const maternalLastName = apellidosM[(seed + 1) % apellidosM.length];
  const department = departamentos[seed % departamentos.length];

  // Fecha de nacimiento (entre 18 y 80 años)
  const ageYears = 18 + (seed % 62);
  const birthYear = new Date().getFullYear() - ageYears;
  const birthMonth = (seed % 12) + 1;
  const birthDay = (seed % 28) + 1;

  return {
    dni,
    firstName,
    lastName,
    maternalLastName,
    birthDate: `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`,
    gender: seed % 2 === 0 ? 'M' : 'F',
    department,
    province: department,
    district: 'Centro',
    address: `Av. Principal ${seed % 1000}, ${department}`,
    valid: true
  };
}

function mapReniecResponse(data: Record<string, unknown>): ReniecPerson {
  return {
    dni: data.dni as string,
    firstName: data.nombres as string,
    lastName: data.apellidoPaterno as string,
    maternalLastName: data.apellidoMaterno as string,
    birthDate: data.fechaNacimiento as string,
    gender: data.sexo as 'M' | 'F',
    department: data.departamento as string,
    province: data.provincia as string,
    district: data.distrito as string,
    address: data.direccion as string,
    photo: data.foto as string | undefined,
    valid: true
  };
}

// ============================================================================
// VALIDACIÓN DE DNI
// ============================================================================

/**
 * Valida el formato de un DNI peruano
 * - 8 dígitos numéricos
 * - No puede ser todos ceros o todos unos
 */
export function isValidDNI(dni: string): boolean {
  // Limpiar espacios
  const cleaned = dni.replace(/\s/g, '');

  // Debe ser 8 dígitos
  if (!/^\d{8}$/.test(cleaned)) {
    return false;
  }

  // No puede ser todos iguales
  if (/^(\d)\1{7}$/.test(cleaned)) {
    return false;
  }

  return true;
}

/**
 * Valida que el DNI no esté ya registrado
 */
export async function isDNIAvailable(dni: string): Promise<boolean> {
  const hash = createSearchableHash(dni);

  const existing = await queryOne<{ id: string }>(`
    SELECT id FROM users
    WHERE dni_hash = $1 AND deleted_at IS NULL
  `, [hash]);

  return !existing;
}

// ============================================================================
// PROCESO KYC
// ============================================================================

/**
 * Inicia el proceso KYC para un usuario
 */
export async function initiateKYC(
  userId: string,
  submission: KYCSubmission,
  metadata: { ipAddress?: string } = {}
): Promise<KYCResult> {
  const errors: string[] = [];

  // Validar DNI
  if (!isValidDNI(submission.dni)) {
    errors.push('DNI inválido. Debe tener 8 dígitos.');
  }

  // Verificar disponibilidad del DNI
  if (!(await isDNIAvailable(submission.dni))) {
    errors.push('Este DNI ya está registrado en otra cuenta.');
  }

  // Validar fecha de nacimiento (mayor de 18 años)
  const birthDate = new Date(submission.birthDate);
  const age = calculateAge(birthDate);
  if (age < 18) {
    errors.push('Debes ser mayor de 18 años.');
  }

  if (errors.length > 0) {
    return {
      success: false,
      status: 'pending',
      message: 'Errores de validación',
      errors
    };
  }

  // Consultar RENIEC
  const reniecData = await consultarRENIEC(submission.dni);

  if (!reniecData) {
    return {
      success: false,
      status: 'rejected',
      message: 'DNI no encontrado en RENIEC',
      errors: ['El DNI ingresado no existe en los registros de RENIEC']
    };
  }

  // Verificar que los datos coincidan
  const validationResult = validateAgainstRENIEC(submission, reniecData);

  if (!validationResult.valid) {
    return {
      success: false,
      status: 'rejected',
      message: 'Los datos no coinciden con RENIEC',
      errors: validationResult.errors
    };
  }

  // Guardar datos encriptados
  await transaction(async (client) => {
    const dniEncryption = encryptDNI(submission.dni, userId);

    await client.query(`
      UPDATE users SET
        dni_encrypted = $1,
        dni_hash = $2,
        first_name_encrypted = $3,
        last_name_encrypted = $4,
        birth_date_encrypted = $5,
        address_encrypted = $6,
        kyc_status = 'submitted',
        kyc_submitted_at = NOW(),
        updated_at = NOW()
      WHERE id = $7
    `, [
      dniEncryption.data,
      dniEncryption.hash,
      encryptPersonalData(reniecData.firstName, userId, 'first_name'),
      encryptPersonalData(`${reniecData.lastName} ${reniecData.maternalLastName}`, userId, 'last_name'),
      encryptPersonalData(reniecData.birthDate, userId, 'birth_date'),
      encryptPersonalData(submission.address, userId, 'address')
    ]);

    // Log de auditoría
    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        ip_address, description
      ) VALUES ($1, 'kyc.submitted', 'user', $1, $2, 'KYC data submitted')
    `, [userId, metadata.ipAddress]);
  });

  return {
    success: true,
    status: 'submitted',
    message: 'Datos enviados correctamente. Por favor, sube los documentos requeridos.'
  };
}

/**
 * Valida los datos ingresados contra RENIEC
 */
function validateAgainstRENIEC(
  submission: KYCSubmission,
  reniec: ReniecPerson
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Comparar nombre (flexible con mayúsculas/minúsculas)
  const submittedName = normalizeText(submission.firstName);
  const reniecName = normalizeText(reniec.firstName);

  if (!submittedName.includes(reniecName) && !reniecName.includes(submittedName)) {
    errors.push('El nombre no coincide con RENIEC');
  }

  // Comparar apellido
  const submittedLastName = normalizeText(submission.lastName);
  const reniecLastName = normalizeText(`${reniec.lastName} ${reniec.maternalLastName}`);

  if (!submittedLastName.includes(reniec.lastName.toLowerCase())) {
    errors.push('El apellido no coincide con RENIEC');
  }

  // Comparar fecha de nacimiento
  if (submission.birthDate !== reniec.birthDate) {
    errors.push('La fecha de nacimiento no coincide con RENIEC');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================================
// GESTIÓN DE DOCUMENTOS
// ============================================================================

/**
 * Sube un documento KYC
 */
export async function uploadDocument(
  userId: string,
  document: DocumentUpload,
  metadata: { ipAddress?: string } = {}
): Promise<{ success: boolean; fileKey: string; analysis: DocumentAnalysis }> {
  // Validar tipo de archivo
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowedTypes.includes(document.mimeType)) {
    throw new KYCError('Tipo de archivo no permitido', 'INVALID_FILE_TYPE');
  }

  // Validar tamaño (máximo 10MB)
  const maxSize = 10 * 1024 * 1024;
  if (document.fileBuffer.length > maxSize) {
    throw new KYCError('Archivo muy grande (máximo 10MB)', 'FILE_TOO_LARGE');
  }

  // Analizar documento
  const analysis = await analyzeDocument(document);

  // Generar key único para almacenamiento
  const fileKey = `kyc/${userId}/${document.type}_${Date.now()}.${getExtension(document.mimeType)}`;

  // Guardar archivo (según el proveedor configurado)
  await saveFile(fileKey, document.fileBuffer, document.mimeType);

  // Actualizar registro de usuario
  await query(`
    UPDATE users SET
      kyc_documents = kyc_documents || $1::jsonb,
      updated_at = NOW()
    WHERE id = $2
  `, [
    JSON.stringify([{
      type: document.type,
      file_key: fileKey,
      uploaded_at: new Date().toISOString(),
      verified: false,
      analysis_result: {
        confidence: analysis.confidence,
        issues: analysis.issues
      }
    }]),
    userId
  ]);

  // Log de auditoría
  await query(`
    INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      ip_address, description, metadata
    ) VALUES ($1, 'kyc.document_uploaded', 'document', $1, $2, 'Document uploaded', $3)
  `, [
    userId,
    metadata.ipAddress,
    JSON.stringify({ type: document.type, fileKey, confidence: analysis.confidence })
  ]);

  return {
    success: analysis.valid,
    fileKey,
    analysis
  };
}

/**
 * Obtiene los documentos KYC de un usuario
 */
export async function getKYCDocuments(userId: string): Promise<KycDocument[]> {
  const result = await queryOne<{ kyc_documents: KycDocument[] }>(`
    SELECT kyc_documents FROM users WHERE id = $1
  `, [userId]);

  return result?.kyc_documents || [];
}

/**
 * Verifica si el usuario tiene todos los documentos requeridos
 */
export async function hasRequiredDocuments(userId: string): Promise<{
  complete: boolean;
  missing: string[];
}> {
  const documents = await getKYCDocuments(userId);
  const requiredTypes = ['dni_front', 'dni_back', 'selfie'];
  const uploadedTypes = documents.map(d => d.type);

  const missing = requiredTypes.filter(t => !uploadedTypes.includes(t as never));

  return {
    complete: missing.length === 0,
    missing
  };
}

// ============================================================================
// ANÁLISIS DE DOCUMENTOS (Detección de Fraude Básica)
// ============================================================================

/**
 * Analiza un documento para detectar posibles fraudes
 *
 * Esta es una implementación básica. En producción se usaría:
 * - AWS Rekognition
 * - Google Cloud Vision
 * - Azure Computer Vision
 * - Servicios especializados (Onfido, Jumio, etc.)
 */
async function analyzeDocument(document: DocumentUpload): Promise<DocumentAnalysis> {
  const issues: string[] = [];
  let confidence = 100;

  // Verificación básica de tamaño
  if (document.fileBuffer.length < 50000) {  // Menos de 50KB
    issues.push('Imagen de baja resolución');
    confidence -= 20;
  }

  // Verificar dimensiones mínimas (si es imagen)
  if (document.mimeType.startsWith('image/')) {
    const dimensions = await getImageDimensions(document.fileBuffer);

    if (dimensions.width < 640 || dimensions.height < 480) {
      issues.push('Resolución insuficiente (mínimo 640x480)');
      confidence -= 15;
    }

    // Verificar aspect ratio para DNI
    if (document.type === 'dni_front' || document.type === 'dni_back') {
      const aspectRatio = dimensions.width / dimensions.height;
      // DNI peruano tiene ratio aproximado de 1.58 (85.6mm x 53.98mm)
      if (aspectRatio < 1.4 || aspectRatio > 1.8) {
        issues.push('Proporción de imagen incorrecta para DNI');
        confidence -= 10;
      }
    }

    // Verificar que selfie sea más vertical
    if (document.type === 'selfie') {
      const aspectRatio = dimensions.width / dimensions.height;
      if (aspectRatio > 1.5) {
        issues.push('La selfie debe mostrar claramente tu rostro');
        confidence -= 10;
      }
    }
  }

  // Análisis de metadatos EXIF (detectar edición)
  const exifAnalysis = await analyzeExifData(document.fileBuffer);
  if (exifAnalysis.editedWithPhotoshop) {
    issues.push('Posible edición detectada en la imagen');
    confidence -= 30;
  }

  // Verificar consistencia de fechas
  if (exifAnalysis.creationDate) {
    const daysSinceCreation = (Date.now() - exifAnalysis.creationDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation > 30) {
      issues.push('Imagen tomada hace más de 30 días');
      confidence -= 5;
    }
  }

  return {
    valid: confidence >= 60 && issues.length < 3,
    confidence: Math.max(0, confidence),
    issues
  };
}

/**
 * Obtiene dimensiones de una imagen
 */
async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  // Implementación básica leyendo headers
  // Para PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }

  // Para JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;

      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);

      // SOF markers (Start of Frame)
      if (marker >= 0xc0 && marker <= 0xc3) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }

      offset += 2 + length;
    }
  }

  // Default
  return { width: 1000, height: 1000 };
}

/**
 * Analiza datos EXIF de una imagen
 */
async function analyzeExifData(buffer: Buffer): Promise<{
  editedWithPhotoshop: boolean;
  creationDate: Date | null;
  software: string | null;
}> {
  // Implementación simplificada
  // En producción usar librería como 'exif-parser' o 'sharp'

  const bufferString = buffer.toString('binary');

  // Buscar indicadores de Photoshop
  const photoshopIndicators = ['Photoshop', 'Adobe', 'GIMP'];
  const editedWithPhotoshop = photoshopIndicators.some(
    indicator => bufferString.includes(indicator)
  );

  return {
    editedWithPhotoshop,
    creationDate: null,  // Requeriría parsing completo de EXIF
    software: null
  };
}

// ============================================================================
// ALMACENAMIENTO DE ARCHIVOS
// ============================================================================

/**
 * Guarda un archivo según el proveedor configurado
 */
async function saveFile(key: string, buffer: Buffer, mimeType: string): Promise<void> {
  switch (env.STORAGE_PROVIDER) {
    case 's3':
      await saveToS3(key, buffer, mimeType);
      break;
    case 'gcs':
      await saveToGCS(key, buffer, mimeType);
      break;
    case 'local':
    default:
      await saveToLocal(key, buffer);
      break;
  }
}

async function saveToS3(key: string, buffer: Buffer, mimeType: string): Promise<void> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY || ''
    }
  });

  await client.send(new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ServerSideEncryption: 'AES256'
  }));
}

async function saveToGCS(key: string, buffer: Buffer, mimeType: string): Promise<void> {
  // Implementar cuando se necesite
  throw new Error('GCS storage not implemented');
}

async function saveToLocal(key: string, buffer: Buffer): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const filePath = path.join(process.cwd(), 'uploads', key);
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, buffer);
}

// ============================================================================
// APROBACIÓN/RECHAZO KYC (Admin)
// ============================================================================

/**
 * Aprueba el KYC de un usuario (solo admin)
 */
export async function approveKYC(
  userId: string,
  adminId: string,
  notes?: string
): Promise<void> {
  await transaction(async (client) => {
    await client.query(`
      UPDATE users SET
        kyc_status = 'verified',
        kyc_verified_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [userId]);

    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'kyc.approved', 'user', $2, 'KYC approved by admin', $3)
    `, [adminId, userId, JSON.stringify({ notes })]);
  });
}

/**
 * Rechaza el KYC de un usuario (solo admin)
 */
export async function rejectKYC(
  userId: string,
  adminId: string,
  reason: string
): Promise<void> {
  await transaction(async (client) => {
    await client.query(`
      UPDATE users SET
        kyc_status = 'rejected',
        kyc_rejection_reason = $1,
        updated_at = NOW()
      WHERE id = $2
    `, [reason, userId]);

    await client.query(`
      INSERT INTO audit_logs (
        user_id, action, resource_type, resource_id,
        description, metadata
      ) VALUES ($1, 'kyc.rejected', 'user', $2, 'KYC rejected by admin', $3)
    `, [adminId, userId, JSON.stringify({ reason })]);
  });
}

// ============================================================================
// HELPERS
// ============================================================================

function calculateAge(birthDate: Date): number {
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }

  return age;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Quitar acentos
    .replace(/\s+/g, ' ')
    .trim();
}

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf'
  };
  return map[mimeType] || 'bin';
}

// ============================================================================
// ERROR PERSONALIZADO
// ============================================================================

export class KYCError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'KYCError';
  }
}
