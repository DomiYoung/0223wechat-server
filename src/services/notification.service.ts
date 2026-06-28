import { appLogger } from '../logger.js';
import { notifySalesViaOfficialAccount } from './official-account.service.js';
import { notifySalesNewLead } from './sms.service.js';
import { enqueueAdminNewLeadNotificationTasks, kickMessageTaskWorker } from './message-task.service.js';

const log = appLogger.child({ module: 'unified-notification-service' });

export interface LeadNotificationData {
  id?: number | string;
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
}

/**
 * 统一分发新留资通知 (多通道)
 */
export async function notifyNewLead(lead: LeadNotificationData) {
  const submitTime = lead.submitTime || new Date();
  log.info({ name: lead.name, phone: lead.phone, source: lead.source }, 'Triggering unified notifications for new lead');

  // 1. 发送微信公众号/服务号模板消息推送（核心通道）
  try {
    await notifySalesViaOfficialAccount({
      ...lead,
      submitTime
    });
  } catch (err: any) {
    log.error({ err: err.message, name: lead.name }, 'WeChat Official Account notification failed');
  }

  // 2. 发送短信通知销售（备用通道）
  try {
    if (process.env.SALES_PHONES) {
      await notifySalesNewLead({
        name: lead.name,
        phone: lead.phone,
        store: lead.store || '小程序',
        weddingDate: lead.weddingDate
      });
    }
  } catch (err: any) {
    log.error({ err: err.message, name: lead.name }, 'SMS notification failed');
  }

  // 3. 发送微信小程序订阅消息给管理员（辅助通道）
  try {
    if (process.env.ADMIN_OPENIDS) {
      await enqueueAdminNewLeadNotificationTasks({
        submitId: lead.id || 0,
        name: lead.name,
        phone: lead.phone,
        store: lead.store || '小程序',
        weddingDate: lead.weddingDate || '待定'
      });
      kickMessageTaskWorker();
    }
  } catch (err: any) {
    log.error({ err: err.message, name: lead.name }, 'WeChat Mini Program admin subscription notification failed');
  }
}
