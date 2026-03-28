/**
 * 阿里云短信服务
 * 文档：https://help.aliyun.com/document_detail/419273.html
 *
 * 安装依赖：
 * npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
 */
import Dysmsapi20170525 from '@alicloud/dysmsapi20170525';
import OpenApi from '@alicloud/openapi-client';
import { appLogger } from '../logger.js';

const log = appLogger.child({ module: 'sms-service' });

/**
 * 初始化短信客户端
 */
function createSmsClient() {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID || process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('短信配置缺失：请设置 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET（或兼容使用 OSS 的 AK）');
  }
  const config = new OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: 'dysmsapi.aliyuncs.com'
  });
  return new Dysmsapi20170525.default(config);
}

let smsClient: Dysmsapi20170525.default | null = null;

function getSmsClient() {
  if (!smsClient) {
    smsClient = createSmsClient();
  }
  return smsClient;
}

/**
 * 发送短信通用方法
 */
async function sendSMS(
  phoneNumbers: string,
  templateCode: string,
  templateParam: Record<string, string>
): Promise<boolean> {
  const client = getSmsClient();

  try {
    const request = new Dysmsapi20170525.SendSmsRequest({
      phoneNumbers: phoneNumbers,
      signName: process.env.SMS_SIGN_NAME || '嘉美麓德', // 短信签名
      templateCode: templateCode,
      templateParam: JSON.stringify(templateParam)
    });

    const response = await client.sendSms(request);

    if (!response.body) {
      throw new Error('短信服务返回空响应');
    }

    if (response.body.code === 'OK') {
      log.info({
        phone: phoneNumbers,
        bizId: response.body.bizId
      }, 'sms sent');

      // 记录成功日志到数据库
      await logSMS(phoneNumbers, templateCode, templateParam, response.body.bizId || null, 'success', null);

      return true;
    } else {
      log.error({
        code: response.body.code,
        message: response.body.message
      }, 'sms send failed');

      // 记录失败日志到数据库
      await logSMS(phoneNumbers, templateCode, templateParam, null, 'failed', `${response.body.code}: ${response.body.message}`);

      return false;
    }
  } catch (err: any) {
    log.error({ err, phoneNumbers, templateCode }, 'sms send exception');

    // 记录异常日志到数据库
    await logSMS(phoneNumbers, templateCode, templateParam, null, 'failed', err.message);

    return false;
  }
}

/**
 * 记录短信发送日志到数据库
 */
async function logSMS(
  phone: string,
  templateCode: string,
  templateParam: Record<string, string>,
  bizId: string | null,
  status: 'success' | 'failed',
  errorMessage: string | null
) {
  try {
    const pool = (await import('../db.js')).default;

    await pool.execute(
      `INSERT INTO sms_log (phone, template_code, template_param, biz_id, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [phone, templateCode, JSON.stringify(templateParam), bizId, status, errorMessage]
    );
  } catch (err: any) {
    // 日志记录失败不影响主流程
    log.error({ err, phone, templateCode }, 'sms log persistence failed');
  }
}

/**
 * 发送新线索通知给销售
 *
 * 模板示例（需要在阿里云短信平台申请）：
 * 【嘉美麓德】有新的小程序报价线索，姓名：${name}，电话：${mobile}，门店：${store}，请尽快跟进。
 */
export async function notifySalesNewLead(leadData: {
  name: string;
  phone: string;
  store: string;
  weddingDate?: string;
}) {
  // 从环境变量读取销售手机号（支持多个，逗号分隔）
  const salesPhones = process.env.SALES_PHONES?.split(',').map(p => p.trim()).filter(Boolean) || [];

  if (salesPhones.length === 0) {
    log.warn('sales phone list is not configured');
    return;
  }

  // 模板 ID（需要在阿里云申请）
  const templateCode = process.env.SMS_TEMPLATE_NEW_LEAD || 'SMS_123456789';

  // 模板变量
  const templateParam = {
    name: leadData.name,
    mobile: leadData.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), // 脱敏
    store: leadData.store
  };

  // 发送给所有销售（阿里云支持批量发送，最多 1000 个号码）
  const phoneNumbers = salesPhones.join(',');

  const success = await sendSMS(phoneNumbers, templateCode, templateParam);

  if (success) {
    log.info({ salesCount: salesPhones.length }, 'sales notified by sms');
  }

  return success;
}

/**
 * 发送报价完成通知给客户（可选）
 *
 * 模板示例：
 * 【嘉美麓德】${name}您好，您的婚宴报价已生成，点击查看：${url}
 */
export async function notifyCustomerQuoteReady(customerData: {
  name: string;
  phone: string;
  quoteUrl: string;
}) {
  const templateCode = process.env.SMS_TEMPLATE_QUOTE_READY || 'SMS_987654321';

  const templateParam = {
    name: customerData.name,
    url: customerData.quoteUrl
  };

  return await sendSMS(customerData.phone, templateCode, templateParam);
}

/**
 * 发送预约确认短信给客户
 *
 * 模板示例：
 * 【嘉美麓德】${name}您好，您已成功预约${store}，预约时间${time}，我们会尽快与您联系。
 */
export async function notifyCustomerAppointmentConfirm(appointmentData: {
  name: string;
  phone: string;
  store: string;
  time: string;
}) {
  const templateCode = process.env.SMS_TEMPLATE_APPOINTMENT || 'SMS_111222333';

  const templateParam = {
    name: appointmentData.name,
    store: appointmentData.store,
    time: appointmentData.time
  };

  return await sendSMS(appointmentData.phone, templateCode, templateParam);
}
