const exposeInternalErrors =
  process.env.EXPOSE_INTERNAL_ERRORS === '1' && process.env.NODE_ENV !== 'production';

export function getErrorDetail(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return '未知错误';
}

export function getClientErrorMessage(err: unknown, fallback: string): string {
  if (!exposeInternalErrors) return fallback;
  const detail = getErrorDetail(err);
  return detail || fallback;
}
