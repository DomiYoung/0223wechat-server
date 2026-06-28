import axios from 'axios';
import { appLogger } from '../logger.js';

const log = appLogger.child({ module: 'official-account-service' });

let cachedAccessToken: string | null = null;
let tokenExpireTime = 0;

export interface TemplateMessageData {
  [key: string]: {
    value: string;
    color?: string;
  };
}

/**
 * 获取服务号配置
 */
function getOfficialAccountConfig() {
  const appId = process.env.OFFICIAL_ACCOUNT_APPID;
  const appSecret = process.env.OFFICIAL_ACCOUNT_SECRET;
  const templateId = process.env.OFFICIAL_ACCOUNT_TEMPLATE_ID;
  const receiverOpenIds = process.env.OFFICIAL_ACCOUNT_RECEIVER_OPENIDS
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean) || [];

  return { appId, appSecret, templateId, receiverOpenIds };
}

/**
 * 获取服务号 Access Token (具备 2 小时本地缓存)
 */
async function getOfficialAccountAccessToken(): Promise<string | null> {
  const { appId, appSecret } = getOfficialAccountConfig();
  if (!appId || !appSecret) {
    log.warn('WeChat Official Account AppID or Secret is not configured.');
    return null;
  }

  const now = Date.now();
  if (cachedAccessToken && tokenExpireTime > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  try {
    const response = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: appId,
        secret: appSecret,
      },
    });

    if (response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      tokenExpireTime = now + (response.data.expires_in || 7200) * 1000;
      log.info('WeChat Official Account access token fetched successfully');
      return cachedAccessToken;
    }

    log.error({ data: response.data }, 'Failed to fetch Official Account access token');
    return null;
  } catch (err: any) {
    log.error({ err: err.message }, 'WeChat Official Account token request exception');
    return null;
  }
}

/**
 * 发送单条微信公众号/服务号模板消息
 */
export async function sendOfficialAccountTemplateMessage(input: {
  touser: string;
  templateId: string;
  data: TemplateMessageData;
  miniProgramAppId?: string;
  miniProgramPagePath?: string;
}): Promise<boolean> {
  try {
    const accessToken = await getOfficialAccountAccessToken();
    if (!accessToken) {
      log.warn('Skipping sendTemplateMessage because AccessToken is null');
      return false;
    }

    const payload: any = {
      touser: input.touser,
      template_id: input.templateId,
      data: input.data,
    };

    // 绑定小程序跳转
    if (input.miniProgramAppId) {
      payload.miniprogram = {
        appid: input.miniProgramAppId,
        pagepath: input.miniProgramPagePath || 'pages/index/index',
      };
    }

    log.info({ payload }, 'Sending Official Account template message payload');

    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
      payload
    );

    if (response.data.errcode === 0) {
      log.info({ touser: input.touser }, 'Official Account template message sent successfully');
      return true;
    }

    log.error(
      { touser: input.touser, response: response.data },
      'Official Account template message sending failed'
    );
    return false;
  } catch (err: any) {
    log.error(
      { touser: input.touser, err: err.message },
      'Official Account template message exception'
    );
    return false;
  }
}

/**
 * 向配置的所有销售群发新客留资提醒消息
 */
export async function notifySalesViaOfficialAccount(lead: {
  name: string;
  phone: string;
  source: string;
  type?: string;
  store?: string;
  weddingDate?: string;
  tablesCount?: number | string;
  category?: string;
  hallName?: string;
  remark?: string;
  submitTime?: Date;
}): Promise<number> {
  const { templateId, receiverOpenIds } = getOfficialAccountConfig();
  if (!templateId || receiverOpenIds.length === 0) {
    log.info('Official Account template message skipped: templateId or receivers not configured.');
    return 0;
  }

  // 防御性处理：统一时间格式为 YYYY-MM-DD HH:mm:ss 防止微信校验不通过
  const formatTime = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  };

  const timeStr = formatTime(lead.submitTime || new Date());

  // 拼装客户预约意向（分类/宴会厅 + 婚期 + 桌数），让销售直接可见
  let intentStr = '';
  if (lead.category) {
    intentStr += lead.category;
  }
  if (lead.hallName) {
    intentStr += (intentStr ? '-' : '') + lead.hallName;
  }
  if (lead.weddingDate) {
    intentStr += (intentStr ? '/' : '') + lead.weddingDate;
  }
  if (lead.tablesCount) {
    const tablesStr = String(lead.tablesCount);
    const suffix = tablesStr.includes('桌') ? '' : '桌';
    intentStr += (intentStr ? '/' : '') + tablesStr + suffix;
  }
  if (!intentStr) intentStr = lead.source || '在线预约';

  const data: TemplateMessageData = {
    thing11: {
      value: (lead.name || '微信用户').substring(0, 20),
      color: '#111111',
    },
    phone_number6: {
      value: (lead.phone || '未提供').substring(0, 20),
      color: '#ff9900', // 橙色高亮联系电话
    },
    thing5: {
      value: (lead.store || '嘉美麓德婚礼公馆').substring(0, 20),
      color: '#111111',
    },
    time8: {
      value: timeStr,
      color: '#111111',
    },
    thing2: {
      value: intentStr.substring(0, 20),
      color: '#111111',
    }
  };

  const miniAppId = process.env.WX_APPID || undefined;

  let successCount = 0;
  for (const openid of receiverOpenIds) {
    const success = await sendOfficialAccountTemplateMessage({
      touser: openid,
      templateId: templateId,
      data: data,
      miniProgramAppId: miniAppId,
      miniProgramPagePath: 'pages/index/index',
    });
    if (success) {
      successCount++;
    }
  }

  log.info({ total: receiverOpenIds.length, successCount }, 'Official Account notifications finished');
  return successCount;
}
