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

  // 1. 【CPU 熔断快速防卡死防线】：如果图片最长边 > 12000px，或者单文件 > 12MB，这属于超规格巨图。
  // 在服务器端强行使用 sharp 解码/重构图片会瞬间侵占数 GB 内存并将单核 CPU 飙至 100%，导致整台服务器所有接口卡死假死。
  // 我们采用最高效的熔断短路设计：直接返回 false 不进行同步处理，快速 0ms 返回原图。
  // 复杂的超大图优化我们会推给 PC 后台的前端上传拦截器（方案A）在客户端来做，从而绝对保证服务器高可用与极速响应！
  if (maxDim > 12000 || originalSize > 12 * 1024 * 1024) {
    return false;
  }

  // 2. 常规尺寸/常规体积大图优化处理
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

    const maxDim = Math.max(metadata.width || 0, metadata.height || 0);

    // 缩放尺寸自适应高清调整：
    // 如果是一般图片，最长边缩放到 4096 像素（maxDimension）已极其高清。
    // 如果原图是超高清大图或拼接长图（最长边 > 8192px 且在安全线以内），粗暴地缩到 4096px 会使其彻底模糊丢细节。
    // 我们对于这种图采用“高保真宽限度缩放”，将最长边限宽大幅提升到 10000px，既能大幅节省体积，又绝对保证细节不糊！
    let finalMaxDimension = maxDimension;
    if (maxDim > 8192) {
      finalMaxDimension = Math.min(10000, maxDim);
    }

    if (maxDim > finalMaxDimension) {
      pipeline = pipeline.resize(finalMaxDimension, finalMaxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // 自动判定：如果图片最长边超出了 16383 像素（WebP 的安全软限制或硬限制），
    // 强制不转 WebP，改用 JPEG 格式进行高保真压缩（质量 95），规避 sharp 的 WebP 编码器超长图限制报错！
    let finalConvertToWebp = convertToWebp;
    let finalQuality = webpQuality;

    if (maxDim > 16383) {
      finalConvertToWebp = false;
      finalQuality = 95;
      log.info(
        { name: originalName, maxDim },
        'Image is extremely large. Force converting to high-fidelity JPEG (Quality 95) instead of WebP to prevent encoder limits.',
      );
    }

    // 转 WebP 或 JPEG
    const outputExt = finalConvertToWebp ? '.webp' : '.jpg';
    const outputMime = finalConvertToWebp ? 'image/webp' : 'image/jpeg';

    if (finalConvertToWebp) {
      pipeline = pipeline.webp({ quality: finalQuality });
    } else {
      pipeline = pipeline.jpeg({ quality: finalQuality });
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
