/**
 * 微信服务 - 订阅消息发送
 */
import axios from 'axios';
import { appLogger } from '../logger.js';
import { getWechatConfig } from './wechat-config.js';

export interface SubscribeMessageData {
  [key: string]: {
    value: string;
  };
}

type DispatchWechatSubscribeMessageResult = {
  success: boolean;
  responseData: Record<string, unknown> | null;
  errorCode?: string;
  errorMessage?: string;
};

// Access Token 缓存
let cachedAccessToken: string | null = null;
let tokenExpireTime: number = 0;
const log = appLogger.child({ module: 'wechat-service' });

/**
 * 获取微信 Access Token
 * 使用缓存机制，避免频繁请求
 */
async function getAccessToken(): Promise<string> {
  // 检查缓存是否有效（提前5分钟刷新）
  const now = Date.now();
  if (cachedAccessToken && tokenExpireTime > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  const { appId, appSecret } = getWechatConfig();

  try {
    const response = await axios.get(
      `https://api.weixin.qq.com/cgi-bin/token`,
      {
        params: {
          grant_type: 'client_credential',
          appid: appId,
          secret: appSecret
        }
      }
    );

    if (response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      // 默认有效期7200秒（2小时）
      tokenExpireTime = now + (response.data.expires_in || 7200) * 1000;
      log.info('wechat access token fetched');
      return cachedAccessToken as string;
    }

    throw new Error(`获取 Access Token 失败: ${JSON.stringify(response.data)}`);
  } catch (err: any) {
    log.error({ err }, 'wechat access token fetch failed');
    throw err;
  }
}

/**
 * 发送订阅消息
 * @param openId 用户OpenID
 * @param templateId 模板ID
 * @param data 模板数据
 * @param page 跳转页面路径
 */
export async function dispatchWechatSubscribeMessage(
  openId: string,
  templateId: string,
  data: SubscribeMessageData,
  page?: string
): Promise<DispatchWechatSubscribeMessageResult> {
  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      {
        touser: openId,
        template_id: templateId,
        page: page || 'pages/index/index',
        data: data,
        miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'trial'
      }
    );

    if (response.data.errcode === 0) {
      log.info({ openId, templateId }, 'wechat subscribe message sent');
      return {
        success: true,
        responseData: response.data as Record<string, unknown>,
      };
    } else {
      log.error({ openId, templateId, response: response.data }, 'wechat subscribe message failed');
      return {
        success: false,
        responseData: response.data as Record<string, unknown>,
        errorCode: String(response.data?.errcode || 'wechat_send_failed'),
        errorMessage: String(response.data?.errmsg || 'wechat subscribe message failed'),
      };
    }
  } catch (err: any) {
    log.error({ err, openId, templateId }, 'wechat subscribe message exception');
    return {
      success: false,
      responseData: null,
      errorCode: err.code || 'wechat_request_exception',
      errorMessage: err.message || 'wechat subscribe message exception',
    };
  }
}
