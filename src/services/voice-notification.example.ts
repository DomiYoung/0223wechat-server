/**
 * 语音通知服务示例（阿里云）
 * 需要安装：npm install @alicloud/dyvmsapi20170525
 */
import Dyvmsapi from '@alicloud/dyvmsapi20170525';
import * as $OpenApi from '@alicloud/openapi-client';

interface VoiceNotificationParams {
  calledNumber: string;      // 被叫号码（管理员手机号）
  ttsCode: string;           // 语音模板ID
  ttsParam: Record<string, string>; // 模板变量
}

/**
 * 初始化语音通知客户端
 */
function createVoiceClient() {
  const config = new $OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    endpoint: 'dyvmsapi.aliyuncs.com'
  });
  return new Dyvmsapi(config);
}

/**
 * 发送语音通知
 * @param params 通知参数
 */
export async function sendVoiceNotification(params: VoiceNotificationParams) {
  const client = createVoiceClient();

  try {
    const request = new Dyvmsapi.SingleCallByTtsRequest({
      calledNumber: params.calledNumber,
      calledShowNumber: process.env.VOICE_SHOW_NUMBER, // 主叫显号（需要申请）
      ttsCode: params.ttsCode,
      ttsParam: JSON.stringify(params.ttsParam),
      playTimes: 2, // 播放次数
      volume: 100   // 音量（0-100）
    });

    const response = await client.singleCallByTts(request);

    if (response.body.code === 'OK') {
      console.log('[Voice] 语音通知发送成功:', response.body.callId);
      return true;
    } else {
      console.error('[Voice] 语音通知发送失败:', response.body.message);
      return false;
    }
  } catch (err: any) {
    console.error('[Voice] 语音通知异常:', err.message);
    return false;
  }
}

/**
 * 发送新留资语音通知给管理员
 */
export async function notifyAdminByVoice(formData: {
  name: string;
  phone: string;
  store: string;
}) {
  const adminPhones = process.env.ADMIN_PHONES?.split(',') || [];

  for (const adminPhone of adminPhones) {
    await sendVoiceNotification({
      calledNumber: adminPhone,
      ttsCode: 'TTS_123456', // 需要在阿里云申请模板
      ttsParam: {
        name: formData.name,
        phone: formData.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), // 脱敏
        store: formData.store
      }
    });
  }
}

/**
 * 使用示例：
 *
 * // 在留资提交后调用
 * await notifyAdminByVoice({
 *   name: '张先生',
 *   phone: '13912345678',
 *   store: '旗舰店'
 * });
 *
 * // 管理员会接到电话，听到：
 * "您好，有新的客户留资。客户姓名张先生，手机号139****5678，意向门店旗舰店。"
 */
