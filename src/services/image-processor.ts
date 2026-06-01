/**
 * 图片预处理工具
 * 上传 OSS 前做压缩/缩放，解决超大图 OSS 处理失败、小程序加载慢等问题
 */
import path from 'path';
import sharp from 'sharp';
import { appLogger } from '../logger.js';

const log = appLogger.child({ module: 'image-processor' });

/** 最长边限制 —— 阿里云 OSS 图片处理要求最长边 ≤ 30000px，这里设 4096 确保安全 */
const MAX_DIMENSION_PX = 4096;
/** WebP 质量 */
const WEBP_QUALITY = 85;
/** 是否转换为 WebP 格式 */
const CONVERT_TO_WEBP = true;
/** 是否移除 EXIF/ICC 元数据（隐私 + 省体积） */
const STRIP_METADATA = true;

interface ProcessOptions {
  /** 最长边限制，默认 4096px */
  maxDimension?: number;
  /** WebP 质量 1-100，默认 85 */
  webpQuality?: number;
  /** 是否转 WebP，默认 true */
  convertToWebp?: boolean;
  /** 是否移除元数据，默认 true */
  stripMetadata?: boolean;
}

interface ProcessResult {
  /** 处理后的图片 buffer */
  buffer: Buffer;
  /** 新的文件扩展名 */
  ext: string;
  /** 新的 Content-Type */
  mimeType: string;
  /** 原始尺寸 */
  originalDimensions: { width: number; height: number } | null;
  /** 处理后尺寸 */
  processedDimensions: { width: number; height: number } | null;
  /** 原始文件大小 (bytes) */
  originalSize: number;
  /** 处理后文件大小 (bytes) */
  processedSize: number;
}

/**
 * 预检查：是否需要处理
 * - 尺寸超过 4096px → 需要
 * - 非 WebP 格式 → 需要（转 WebP）
 * - 体积过大（>5MB）→ 需要
 */
function shouldProcess(
  metadata: sharp.Metadata,
  originalSize: number,
): boolean {
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const maxDim = Math.max(width, height);

  if (maxDim > MAX_DIMENSION_PX) return true;
  if (originalSize > 5 * 1024 * 1024) return true; // >5MB
  if (CONVERT_TO_WEBP && metadata.format !== 'webp') return true;

  return false;
}

/**
 * 处理单张图片（resize + 转 WebP + 去元数据）
 */
export async function processImage(
  buffer: Buffer,
  originalName: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const {
    maxDimension = MAX_DIMENSION_PX,
    webpQuality = WEBP_QUALITY,
    convertToWebp = CONVERT_TO_WEBP,
    stripMetadata = STRIP_METADATA,
  } = opts;

  const originalSize = buffer.length;

  try {
    const metadata = await sharp(buffer).metadata();

    const originalDims = metadata.width && metadata.height
      ? { width: metadata.width, height: metadata.height }
      : null;

    // 不需要处理 → 原样返回
    if (!shouldProcess(metadata, originalSize)) {
      log.debug(
        { name: originalName, dims: originalDims, size: originalSize },
        'image skip processing (within limits)',
      );
      const ext = (metadata.format || 'jpg').replace('jpeg', 'jpg');
      return {
        buffer,
        ext: `.${ext}`,
        mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        originalDimensions: originalDims,
        processedDimensions: originalDims,
        originalSize,
        processedSize: originalSize,
      };
    }

    // 开始处理
    let pipeline = sharp(buffer);

    // 自动纠正方向（基于 EXIF）
    pipeline = pipeline.rotate();

    // 缩放到最长边 ≤ maxDimension
    const maxDim = Math.max(metadata.width || 0, metadata.height || 0);
    if (maxDim > maxDimension) {
      pipeline = pipeline.resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // 转 WebP
    const outputExt = convertToWebp ? '.webp' : `.${(metadata.format || 'jpg').replace('jpeg', 'jpg')}`;
    const outputMime = convertToWebp
      ? 'image/webp'
      : `image/${(metadata.format || 'jpeg').replace('jpeg', 'jpeg')}`;

    if (convertToWebp) {
      pipeline = pipeline.webp({ quality: webpQuality });
    }

    // 去除元数据（EXIF + ICC + XMP）
    if (stripMetadata) {
      pipeline = pipeline.withMetadata({
        // 仅保留有限元数据
        icc: '', // 去除 ICC 色彩配置文件
        density: 0,
      });
    }

    const outputBuffer = await pipeline.toBuffer();

    // 读取处理后尺寸
    let processedDims: { width: number; height: number } | null = null;
    try {
      const outMeta = await sharp(outputBuffer).metadata();
      if (outMeta.width && outMeta.height) {
        processedDims = { width: outMeta.width, height: outMeta.height };
      }
    } catch {
      // 元数据读取失败不阻塞
    }

    const saved = originalSize > outputBuffer.length
      ? Math.round((1 - outputBuffer.length / originalSize) * 100)
      : 0;

    log.info(
      {
        name: originalName,
        originalDims,
        processedDims,
        originalSize,
        processedSize: outputBuffer.length,
        savedPct: saved,
        outputExt,
      },
      'image processed',
    );

    return {
      buffer: outputBuffer,
      ext: outputExt,
      mimeType: outputMime,
      originalDimensions: originalDims,
      processedDimensions: processedDims,
      originalSize,
      processedSize: outputBuffer.length,
    };
  } catch (err) {
    // 处理失败 → 原样上传，不阻塞业务流程
    log.warn(
      { err, name: originalName },
      'image processing failed, using original buffer',
    );
    return {
      buffer,
      ext: path.extname(originalName),
      mimeType: 'application/octet-stream',
      originalDimensions: null,
      processedDimensions: null,
      originalSize,
      processedSize: originalSize,
    };
  }
}
