export function getWechatConfig(): { appId: string; appSecret: string } {
  const appId = process.env.WECHAT_APPID || process.env.WX_APPID || '';
  const appSecret = process.env.WECHAT_APPSECRET || process.env.WX_APPSECRET || '';

  if (!appId || !appSecret || appSecret === 'your_appsecret_here') {
    throw new Error('微信配置缺失：请设置 WECHAT_APPID / WECHAT_APPSECRET');
  }

  return { appId, appSecret };
}

