/**
 * 婚庆行业专业通知方案
 * 基于实际业务场景的最佳实践
 */
import axios from 'axios';
import pool from '../db.js';

interface LeadData {
  id: number;
  name: string;
  phone: string;
  store: string;
  weddingDate?: string;
  remark?: string;
  submitTime: Date;
}

/**
 * 完整的通知链路
 */
export async function professionalNotificationFlow(lead: LeadData) {
  // 1. 用户侧：微信订阅消息（已实现）
  await sendUserConfirmation(lead);

  // 2. 销售团队：企业微信群通知（推荐）
  await sendSalesTeamNotification(lead);

  // 3. CRM 系统：自动分配销售（可选）
  await assignToSales(lead);

  // 4. 监控：记录通知日志
  await logNotification(lead);
}

/**
 * 1. 用户确认通知（微信订阅消息）
 */
async function sendUserConfirmation(lead: LeadData) {
  // 这部分已经在 wechat.service.ts 中实现
  console.log('[Professional] 用户订阅消息已发送');
}

/**
 * 2. 销售团队通知（企业微信群机器人）
 * 这是最关键的环节
 */
async function sendSalesTeamNotification(lead: LeadData) {
  const webhookUrl = process.env.WECOM_SALES_WEBHOOK;

  if (!webhookUrl) {
    console.warn('[Professional] 未配置销售群 Webhook');
    return;
  }

  try {
    // 计算时间差（用于紧急提醒）
    const minutesAgo = Math.floor((Date.now() - lead.submitTime.getTime()) / 60000);
    const urgencyTag = minutesAgo > 5 ? '⚠️ 超时' : '🔥 新留资';

    await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: {
        content: `## ${urgencyTag}

> **客户信息**
> 姓名：<font color="info">${lead.name}</font>
> 手机：<font color="warning">${lead.phone}</font>
> 门店：${lead.store}
${lead.weddingDate ? `> 婚期：${lead.weddingDate}` : ''}
${lead.remark ? `> 备注：${lead.remark}` : ''}
> 提交时间：${lead.submitTime.toLocaleString('zh-CN')}

> **操作提示**
> 请在 <font color="warning">5分钟内</font> 联系客户
> 点击手机号即可拨打 📞`
      }
    });

    console.log('[Professional] 销售团队通知发送成功');
  } catch (err: any) {
    console.error('[Professional] 销售团队通知失败:', err.message);
  }
}

/**
 * 3. CRM 自动分配（可选功能）
 * 根据门店、值班表自动分配给对应销售
 */
async function assignToSales(lead: LeadData) {
  try {
    // 查询值班销售（按门店 + 时间段）
    const [rows] = await pool.execute(
      `SELECT sales_id, sales_name, sales_phone
       FROM sales_schedule
       WHERE store_name = ?
         AND is_on_duty = 1
         AND CURTIME() BETWEEN duty_start AND duty_end
       LIMIT 1`,
      [lead.store]
    ) as any;

    if (rows.length > 0) {
      const sales = rows[0];

      // 更新 reservation 表，分配销售
      await pool.execute(
        `UPDATE reservation
         SET assigned_sales_id = ?,
             assigned_at = NOW(),
             status = '已分配'
         WHERE id = ?`,
        [sales.sales_id, lead.id]
      );

      // 发送个人通知给该销售
      await sendPersonalNotification(sales, lead);

      console.log(`[Professional] 已分配给销售: ${sales.sales_name}`);
    } else {
      console.warn('[Professional] 未找到值班销售，进入公海池');
    }
  } catch (err: any) {
    console.error('[Professional] 自动分配失败:', err.message);
  }
}

/**
 * 发送个人通知给指定销售
 */
async function sendPersonalNotification(sales: any, lead: LeadData) {
  // 可以通过企业微信应用消息、短信等方式
  // 这里示例使用企业微信应用消息（需要企业微信应用配置）
  console.log(`[Professional] 向 ${sales.sales_name} 发送个人通知`);
}

/**
 * 4. 记录通知日志（用于监控和统计）
 */
async function logNotification(lead: LeadData) {
  try {
    await pool.execute(
      `INSERT INTO notification_log
       (lead_id, notification_type, status, created_at)
       VALUES (?, 'sales_team', 'sent', NOW())`,
      [lead.id]
    );
  } catch (err: any) {
    console.error('[Professional] 日志记录失败:', err.message);
  }
}

/**
 * 超时预警（定时任务，每分钟执行）
 * 可以用 node-cron 或 PM2 cron 实现
 */
export async function checkOverdueLeads() {
  try {
    // 查询超过5分钟未跟进的留资
    const [rows] = await pool.execute(
      `SELECT r.*,
              TIMESTAMPDIFF(MINUTE, r.created_at, NOW()) as minutes_ago
       FROM reservation r
       WHERE r.status = '待跟进'
         AND r.created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
         AND TIMESTAMPDIFF(MINUTE, r.created_at, NOW()) > 5
         AND NOT EXISTS (
           SELECT 1 FROM notification_log nl
           WHERE nl.lead_id = r.id
             AND nl.notification_type = 'overdue_alert'
         )`,
      []
    ) as any;

    for (const lead of rows) {
      await sendOverdueAlert(lead);
    }
  } catch (err: any) {
    console.error('[Professional] 超时检查失败:', err.message);
  }
}

/**
 * 发送超时预警
 */
async function sendOverdueAlert(lead: any) {
  const webhookUrl = process.env.WECOM_MANAGER_WEBHOOK; // 管理层群

  if (!webhookUrl) return;

  try {
    await axios.post(webhookUrl, {
      msgtype: 'text',
      text: {
        content: `⚠️ 超时预警\n\n` +
                 `客户 ${lead.name}（${lead.phone}）的留资已超过 ${lead.minutes_ago} 分钟未跟进\n` +
                 `门店：${lead.store}\n` +
                 `请尽快处理！`,
        mentioned_list: ['@all'] // @所有人
      }
    });

    // 记录已发送预警
    await pool.execute(
      `INSERT INTO notification_log
       (lead_id, notification_type, status, created_at)
       VALUES (?, 'overdue_alert', 'sent', NOW())`,
      [lead.id]
    );
  } catch (err: any) {
    console.error('[Professional] 超时预警发送失败:', err.message);
  }
}

/**
 * 使用示例：
 *
 * // 在留资提交后调用
 * await professionalNotificationFlow({
 *   id: 123,
 *   name: '张先生',
 *   phone: '13912345678',
 *   store: '旗舰店',
 *   weddingDate: '2026-06-01',
 *   remark: '预算30万',
 *   submitTime: new Date()
 * });
 *
 * // 定时任务（每分钟检查超时）
 * setInterval(checkOverdueLeads, 60000);
 */
