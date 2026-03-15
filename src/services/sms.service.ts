/**
 * 阿里云短信服务
 * 文档：https://help.aliyun.com/document_detail/419273.html
 *
 * 安装依赖：
 * npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client
 */
import Dysmsapi20170525, * as $Dysmsapi20170525 from '@alicloud/dysmsapi20170525';
import * as $OpenApi from '@alicloud/openapi-client';

/**
 * 初始化短信客户端
 */
function createSmsClient(): Dysmsapi20170525 {
  const config = new $OpenApi.Config({
    // 复用 OSS 的 AccessKey
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
    endpoint: 'dysmsapi.aliyuncs.com'
  });
  return new Dysmsapi20170525(config);
}

/**
 * 发送短信通用方法
 */
async function sendSMS(
  phoneNumbers: string,
  templateCode: string,
  templateParam: Record<string, string>
): Promise<boolean> {
  const client = createSmsClient();

  try {
    const request = new $Dysmsapi20170525.SendSmsRequest({
      phoneNumbers: phoneNumbers,
      signName: process.env.SMS_SIGN_NAME || '嘉美麓德', // 短信签名
      templateCode: templateCode,
      templateParam: JSON.stringify(templateParam)
    });

    const response = await client.sendSms(request);

    if (response.body.code === 'OK') {
      console.log('[SMS] 短信发送成功:', {
        phone: phoneNumbers,
        bizId: response.body.bizId
      });
      return true;
    } else {
      console.error('[SMS] 短信发送失败:', {
        code: response.body.code,
        message: response.body.message
      });
      return false;
    }
  } catch (err: any) {
    console.error('[SMS] 短信发送异常:', err.message);
    return false;
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
    console.warn('[SMS] 未配置销售手机号 SALES_PHONES');
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
    console.log(`[SMS] 已通知 ${salesPhones.length} 位销售`);
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
