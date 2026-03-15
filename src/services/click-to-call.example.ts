/**
 * 点击拨号通知服务（免费方案）
 * 通过企业微信/钉钉机器人发送可点击的电话号码
 */
import axios from 'axios';

interface LeadNotification {
  name: string;
  phone: string;
  store: string;
  weddingDate?: string;
  remark?: string;
}

/**
 * 发送企业微信机器人通知（支持 Markdown 格式）
 */
export async function sendWeComNotification(lead: LeadNotification) {
  const webhookUrl = process.env.WECOM_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('[ClickToCall] 未配置企业微信 Webhook');
    return false;
  }

  try {
    // Markdown 格式支持电话号码自动识别
    const content = `## 🎉 新客户留资通知

> **客户信息**
> 姓名：<font color="info">${lead.name}</font>
> 手机：<font color="warning">${lead.phone}</font>
> 门店：${lead.store}
${lead.weddingDate ? `> 婚期：${lead.weddingDate}` : ''}
${lead.remark ? `> 备注：${lead.remark}` : ''}

> **操作提示**
> 点击手机号即可拨打电话 📞`;

    await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: {
        content: content
      }
    });

    console.log('[ClickToCall] 企业微信通知发送成功');
    return true;
  } catch (err: any) {
    console.error('[ClickToCall] 企业微信通知失败:', err.message);
    return false;
  }
}

/**
 * 发送钉钉机器人通知（支持 ActionCard）
 */
export async function sendDingTalkNotification(lead: LeadNotification) {
  const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('[ClickToCall] 未配置钉钉 Webhook');
    return false;
  }

  try {
    await axios.post(webhookUrl, {
      msgtype: 'actionCard',
      actionCard: {
        title: '🎉 新客户留资',
        text: `### 客户信息\n\n` +
              `**姓名**：${lead.name}\n\n` +
              `**手机**：${lead.phone}\n\n` +
              `**门店**：${lead.store}\n\n` +
              `${lead.weddingDate ? `**婚期**：${lead.weddingDate}\n\n` : ''}` +
              `${lead.remark ? `**备注**：${lead.remark}\n\n` : ''}`,
        btnOrientation: '0',
        btns: [
          {
            title: '📞 立即拨打',
            actionURL: `tel:${lead.phone}` // 点击直接拨号
          },
          {
            title: '💬 发送短信',
            actionURL: `sms:${lead.phone}`
          }
        ]
      }
    });

    console.log('[ClickToCall] 钉钉通知发送成功');
    return true;
  } catch (err: any) {
    console.error('[ClickToCall] 钉钉通知失败:', err.message);
    return false;
  }
}

/**
 * 发送短信通知（带可点击电话号码）
 * 注意：短信中的电话号码在大部分手机上可以长按拨打
 */
export async function sendSMSWithPhone(adminPhone: string, lead: LeadNotification) {
  // 这里使用阿里云短信示例
  // 实际需要安装 @alicloud/dysmsapi20170525

  const message = `【嘉美麓德】新客户留资：${lead.name}，手机${lead.phone}，意向${lead.store}。请及时联系客户。`;

  console.log('[ClickToCall] 短信内容:', message);
  // 实际发送逻辑...

  return true;
}

/**
 * 统一通知入口（多渠道）
 */
export async function notifyAdminWithClickToCall(lead: LeadNotification) {
  const results = await Promise.allSettled([
    sendWeComNotification(lead),
    sendDingTalkNotification(lead)
  ]);

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[ClickToCall] 通知完成: ${successCount}/${results.length} 成功`);
}

/**
 * 使用示例：
 *
 * // 在留资提交后调用
 * await notifyAdminWithClickToCall({
 *   name: '张先生',
 *   phone: '13912345678',
 *   store: '旗舰店',
 *   weddingDate: '2026-06-01',
 *   remark: '预算30万'
 * });
 *
 * // 管理员会收到企业微信/钉钉通知
 * // 点击电话号码即可拨打
 */
