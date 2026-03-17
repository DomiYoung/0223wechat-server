import { verifyAdminToken } from '../security/admin-auth.js';

export const adminAuthMiddleware = async (c: any, next: () => Promise<void>) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
  if (!token) return c.json({ error: '未提供认证令牌' }, 401);

  const claims = verifyAdminToken(token);
  if (!claims) return c.json({ error: '无效的认证令牌' }, 401);

  c.set?.('adminClaims', claims);
  await next();
};

