import pool from '../db.js';

// ========== Types ==========
export interface ThemeQueryOptions {
  // 分页
  page?: number;
  pageSize?: number;
  // 筛选
  cityId?: number | null;
  venueId?: number;
  keyword?: string;
  featured?: number;
  active?: number;
  // 视图控制
  includeInactive?: boolean; // admin=true, public=false
  includeImages?: boolean;   // 是否批量获取图片
}

export interface ThemeRow {
  id: number;
  title: string;
  tag: string;
  hall_name: string;
  style: string;
  wedding_date: string;
  shop_label: string;
  description: string;
  cover_url: string;
  venue_id: number | null;
  sort_order: number;
  is_featured: number;
  is_active: number;
  created_at: string;
  venue_name: string | null;
  venue_city: string | null;
  image_count?: number;
  images?: any[];
}

export interface PaginatedResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ========== Core Query ==========
export async function queryThemes(options: ThemeQueryOptions): Promise<PaginatedResult<ThemeRow>> {
  const {
    page = 1,
    pageSize = 20,
    cityId,
    venueId,
    keyword,
    featured,
    active,
    includeInactive = false,
    includeImages = false,
  } = options;

  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: any[] = [];

  // 公开接口默认只返回 is_active=1
  if (!includeInactive) {
    conditions.push('wc.is_active = 1');
  } else if (active !== undefined) {
    conditions.push('wc.is_active = ?');
    params.push(active);
  }

  if (cityId) {
    conditions.push('v.city_id = ?');
    params.push(cityId);
  }
  if (venueId) {
    conditions.push('wc.venue_id = ?');
    params.push(venueId);
  }
  if (keyword) {
    conditions.push("(wc.title LIKE CONCAT('%', ?, '%') OR COALESCE(NULLIF(wc.hall_name, ''), wc.style) LIKE CONCAT('%', ?, '%'))");
    params.push(keyword, keyword);
  }
  if (featured !== undefined) {
    conditions.push('wc.is_featured = ?');
    params.push(featured);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // COUNT
  const [countResult] = await pool.execute(
    `SELECT COUNT(*) as total FROM wedding_case wc LEFT JOIN venue v ON wc.venue_id = v.id ${whereClause}`,
    params
  ) as any;
  const total = countResult[0].total;

  // 延迟关联分页（Deferred Join）
  const [rows] = await pool.execute(
    `SELECT
        wc.*,
        COALESCE(NULLIF(wc.hall_name, ''), wc.style) AS hall_name,
        v.name AS venue_name,
        COALESCE(cv.name, v.city) AS venue_city,
        (SELECT COUNT(*) FROM case_image ci WHERE ci.case_id = wc.id) AS image_count
     FROM wedding_case wc
     INNER JOIN (
         SELECT wc2.id
         FROM wedding_case wc2
         LEFT JOIN venue v2 ON wc2.venue_id = v2.id
         ${whereClause.replace(/\bv\./g, 'v2.').replace(/\bwc\./g, 'wc2.')}
         ORDER BY wc2.sort_order ASC, wc2.id DESC
         LIMIT ? OFFSET ?
     ) AS page_ids ON wc.id = page_ids.id
     LEFT JOIN venue v ON wc.venue_id = v.id
     LEFT JOIN city cv ON v.city_id = cv.id
     ORDER BY wc.sort_order ASC, wc.id DESC`,
    [...params, pageSize, offset]
  ) as any;

  // 批量获取图片
  if (includeImages && rows.length > 0) {
    const caseIds = rows.map((r: any) => r.id);
    const placeholders = caseIds.map(() => '?').join(',');
    const [images] = await pool.execute(
      `SELECT * FROM case_image WHERE case_id IN (${placeholders}) ORDER BY sort_order ASC`,
      caseIds
    ) as any;

    const imageMap = new Map<number, any[]>();
    for (const img of images) {
      if (!imageMap.has(img.case_id)) imageMap.set(img.case_id, []);
      imageMap.get(img.case_id)!.push(img);
    }
    for (const row of rows) {
      row.images = imageMap.get(row.id) || [];
    }
  }

  return { list: rows, total, page, pageSize };
}

// ========== Projections ==========
export function toPublicTheme(row: ThemeRow) {
  return {
    id: row.id,
    title: row.title,
    cover_url: row.cover_url,
    style: row.hall_name || row.style || '',
    venue_name: row.venue_name,
    venue_city: row.venue_city,
    images: row.images || [],
  };
}

export function toAdminTheme(row: ThemeRow) {
  return {
    ...row,
    hall_name: row.hall_name || row.style || '',
    style: row.hall_name || row.style || '',
  };
}
