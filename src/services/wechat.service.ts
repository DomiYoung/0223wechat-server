/**
 * 微信服务 - 订阅消息发送
 */
import axios from 'axios';
import pool from '../db.js';
import { getWechatConfig } from './wechat-config.js';

interface SubscribeMessageData {
  [key: string]: {
    value: string;
  };
}

// Access Token 缓存
let cachedAccessToken: string | null = null;
let tokenExpireTime: number = 0;

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
      console.log('[Wechat] Access Token 获取成功');
      return cachedAccessToken as string;
    }

    throw new Error(`获取 Access Token 失败: ${JSON.stringify(response.data)}`);
  } catch (err: any) {
    console.error('[Wechat] 获取 Access Token 异常:', err.message);
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
export async function sendSubscribeMessage(
  openId: string,
  templateId: string,
  data: SubscribeMessageData,
  page?: string
): Promise<boolean> {
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
      console.log('[Wechat] 订阅消息发送成功:', { openId, templateId });
      return true;
    } else {
      console.error('[Wechat] 订阅消息发送失败:', response.data);
      return false;
    }
  } catch (err: any) {
    console.error('[Wechat] 发送订阅消息异常:', err.message);
    return false;
  }
}

/**
 * 发送留资通知给用户
 * @param openId 用户OpenID
 * @param formData 表单数据
 */
export async function sendFormSubmitNotification(
  openId: string,
  formData: {
    name: string;
    phone: string;
    store: string;
    weddingDate: string;
  }
): Promise<void> {
  try {
    // 从数据库查询用户是否授权了该模板
    const [rows] = await pool.execute(
      'SELECT template_id FROM user_subscribe WHERE open_id = ? AND biz_type = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      [openId, 'form_submit']
    ) as any;

    if (rows.length === 0) {
      console.log('[Wechat] 用户未授权订阅消息:', openId);
      return;
    }

    const templateId = rows[0].template_id;

    // 发送订阅消息
    // 注意：这里的字段需要根据实际模板配置调整
    await sendSubscribeMessage(
      openId,
      templateId,
      {
        thing1: { value: '您的预约已提交' },
        name2: { value: formData.name.substring(0, 20) }, // 限制长度
        phone_number3: { value: formData.phone },
        thing4: { value: formData.store.substring(0, 20) },
        date5: { value: formData.weddingDate || '待定' }
      },
      'pages/form/form'
    );
  } catch (err: any) {
    console.error('[Wechat] 发送留资通知失败:', err.message);
  }
}

/**
 * 发送新留资通知给管理员
 * @param formData 表单数据
 */
export async function sendNewLeadNotificationToAdmins(
  formData: {
    name: string;
    phone: string;
    store: string;
    weddingDate: string;
  }
): Promise<void> {
  try {
    // 从环境变量读取管理员 OpenID 列表
    const adminOpenIds = process.env.ADMIN_OPENIDS?.split(',').map(id => id.trim()).filter(Boolean) || [];

    if (adminOpenIds.length === 0) {
      console.log('[Wechat] 未配置管理员 OpenID，跳过管理员通知');
      return;
    }

    console.log(`[Wechat] 准备向 ${adminOpenIds.length} 位管理员发送新留资通知`);

    // 并行发送给所有管理员
    const sendPromises = adminOpenIds.map(async (adminOpenId) => {
      try {
        // 查询管理员是否授权了新留资通知模板
        const [rows] = await pool.execute(
          'SELECT template_id FROM user_subscribe WHERE open_id = ? AND biz_type = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
          [adminOpenId, 'new_lead_admin']
        ) as any;

        if (rows.length === 0) {
          console.log('[Wechat] 管理员未授权订阅消息:', adminOpenId);
          return false;
        }

        const templateId = rows[0].template_id;

        // 发送订阅消息（管理员视角：收到新留资）
        const success = await sendSubscribeMessage(
          adminOpenId,
          templateId,
          {
            thing1: { value: '新客户留资' },
            name2: { value: formData.name.substring(0, 20) },
            phone_number3: { value: formData.phone },
            thing4: { value: formData.store.substring(0, 20) },
            date5: { value: formData.weddingDate || '待定' }
          },
          'pages/index/index'
        );

        if (success) {
          console.log('[Wechat] 管理员通知发送成功:', adminOpenId);
        }
        return success;
      } catch (err: any) {
        console.error('[Wechat] 向管理员发送通知失败:', adminOpenId, err.message);
        return false;
      }
    });

    const results = await Promise.all(sendPromises);
    const successCount = results.filter(Boolean).length;
    console.log(`[Wechat] 管理员通知完成: ${successCount}/${adminOpenIds.length} 成功`);
  } catch (err: any) {
    console.error('[Wechat] 发送管理员通知异常:', err.message);
  }
}
