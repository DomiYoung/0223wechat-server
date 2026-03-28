import pool from '../db.js';
import { appLogger } from '../logger.js';
import { dispatchWechatSubscribeMessage, type SubscribeMessageData } from './wechat.service.js';

type MessageTaskStatus = 'pending' | 'processing' | 'sent' | 'failed';

type MessageTaskRow = {
  id: number;
  channel: string;
  biz_type: string;
  biz_id: string;
  receiver: string;
  template_id: string;
  page_path: string;
  payload_json: string | Record<string, unknown>;
  status: MessageTaskStatus;
  retry_count: number;
  max_retry_count: number;
};

const log = appLogger.child({ module: 'message-task-service' });
const MESSAGE_CHANNEL_WECHAT_SUBSCRIBE = 'wechat_subscribe';
const RETRY_DELAY_MS = 60_000;
let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

function parseJsonObject(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value;
}

async function createMessageTask(input: {
  channel: string;
  bizType: string;
  bizId?: string | number;
  receiver: string;
  templateId: string;
  pagePath?: string;
  payload: Record<string, unknown>;
}) {
  const [result] = await pool.execute(
    `INSERT INTO message_task (
      channel, biz_type, biz_id, receiver, template_id, page_path, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.channel,
      input.bizType,
      input.bizId ? String(input.bizId) : '',
      input.receiver,
      input.templateId,
      input.pagePath || '',
      JSON.stringify(input.payload),
    ]
  ) as any;

  return Number(result.insertId);
}

async function getLatestSubscribedTemplate(openId: string, bizType: string): Promise<string | null> {
  const [rows] = await pool.execute(
    `SELECT template_id
     FROM user_subscribe
     WHERE open_id = ? AND biz_type = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [openId, bizType]
  ) as any;

  return rows[0]?.template_id || null;
}

export async function enqueueFormSubmitNotificationTask(input: {
  openId: string;
  submitId: number | string;
  name: string;
  phone: string;
  store: string;
  weddingDate: string;
}) {
  const templateId = await getLatestSubscribedTemplate(input.openId, 'form_submit');
  if (!templateId) {
    log.info({ openId: input.openId, bizType: 'form_submit' }, 'message task skipped because subscription was not found');
    return null;
  }

  const payload: { data: SubscribeMessageData; page: string } = {
    data: {
      thing1: { value: '您的预约已提交' },
      name2: { value: input.name.substring(0, 20) },
      phone_number3: { value: input.phone },
      thing4: { value: input.store.substring(0, 20) },
      date5: { value: input.weddingDate || '待定' },
    },
    page: 'pages/form/form',
  };

  return createMessageTask({
    channel: MESSAGE_CHANNEL_WECHAT_SUBSCRIBE,
    bizType: 'form_submit',
    bizId: input.submitId,
    receiver: input.openId,
    templateId,
    pagePath: payload.page,
    payload,
  });
}

export async function enqueueAdminNewLeadNotificationTasks(input: {
  submitId: number | string;
  name: string;
  phone: string;
  store: string;
  weddingDate: string;
}) {
  const adminOpenIds = process.env.ADMIN_OPENIDS?.split(',').map((id) => id.trim()).filter(Boolean) || [];
  if (adminOpenIds.length === 0) {
    log.info('message task skipped because admin open ids are not configured');
    return [];
  }

  const taskIds: number[] = [];
  for (const adminOpenId of adminOpenIds) {
    const templateId = await getLatestSubscribedTemplate(adminOpenId, 'new_lead_admin');
    if (!templateId) {
      log.info({ adminOpenId, bizType: 'new_lead_admin' }, 'message task skipped because admin subscription was not found');
      continue;
    }

    const payload: { data: SubscribeMessageData; page: string } = {
      data: {
        thing1: { value: '新客户留资' },
        name2: { value: input.name.substring(0, 20) },
        phone_number3: { value: input.phone },
        thing4: { value: input.store.substring(0, 20) },
        date5: { value: input.weddingDate || '待定' },
      },
      page: 'pages/index/index',
    };

    const taskId = await createMessageTask({
      channel: MESSAGE_CHANNEL_WECHAT_SUBSCRIBE,
      bizType: 'new_lead_admin',
      bizId: input.submitId,
      receiver: adminOpenId,
      templateId,
      pagePath: payload.page,
      payload,
    });
    taskIds.push(taskId);
  }

  return taskIds;
}

async function insertMessageSendLog(input: {
  taskId: number;
  channel: string;
  receiver: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}) {
  await pool.execute(
    `INSERT INTO message_send_log (
      task_id, channel, receiver, request_payload, response_payload, success, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.taskId,
      input.channel,
      input.receiver,
      JSON.stringify(input.requestPayload),
      input.responsePayload ? JSON.stringify(input.responsePayload) : null,
      input.success ? 1 : 0,
      input.errorCode || '',
      input.errorMessage || null,
    ]
  );
}

async function markTaskFailed(task: MessageTaskRow, errorCode: string, errorMessage: string, responsePayload: Record<string, unknown> | null) {
  const nextRetryCount = Number(task.retry_count || 0) + 1;
  const hasMoreRetries = nextRetryCount < Number(task.max_retry_count || 3);
  const nextRetryAt = hasMoreRetries ? new Date(Date.now() + RETRY_DELAY_MS) : null;
  const payload = parseJsonObject(task.payload_json);

  await insertMessageSendLog({
    taskId: task.id,
    channel: task.channel,
    receiver: task.receiver,
    requestPayload: payload,
    responsePayload,
    success: false,
    errorCode,
    errorMessage,
  });

  await pool.execute(
    `UPDATE message_task
     SET status = 'failed',
         retry_count = ?,
         next_retry_at = ?,
         last_error = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [nextRetryCount, nextRetryAt, errorMessage, task.id]
  );
}

async function markTaskSent(task: MessageTaskRow, responsePayload: Record<string, unknown> | null) {
  const payload = parseJsonObject(task.payload_json);

  await insertMessageSendLog({
    taskId: task.id,
    channel: task.channel,
    receiver: task.receiver,
    requestPayload: payload,
    responsePayload,
    success: true,
  });

  await pool.execute(
    `UPDATE message_task
     SET status = 'sent',
         sent_at = NOW(),
         next_retry_at = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = ?`,
    [task.id]
  );
}

async function tryClaimTask(taskId: number) {
  const [result] = await pool.execute(
    `UPDATE message_task
     SET status = 'processing', updated_at = NOW()
     WHERE id = ?
       AND (
         status = 'pending' OR
         (status = 'failed' AND retry_count < max_retry_count AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
       )`,
    [taskId]
  ) as any;

  return Number(result.affectedRows || 0) > 0;
}

export async function processMessageTask(taskId: number) {
  const claimed = await tryClaimTask(taskId);
  if (!claimed) return false;

  const [rows] = await pool.execute(
    `SELECT id, channel, biz_type, biz_id, receiver, template_id, page_path, payload_json, status, retry_count, max_retry_count
     FROM message_task
     WHERE id = ?
     LIMIT 1`,
    [taskId]
  ) as any;

  const task = rows[0] as MessageTaskRow | undefined;
  if (!task) return false;

  try {
    if (task.channel !== MESSAGE_CHANNEL_WECHAT_SUBSCRIBE) {
      await markTaskFailed(task, 'unsupported_channel', `unsupported channel: ${task.channel}`, null);
      return false;
    }

    const payload = parseJsonObject(task.payload_json) as {
      data?: SubscribeMessageData;
      page?: string;
    };

    if (!payload.data || typeof payload.data !== 'object') {
      await markTaskFailed(task, 'invalid_payload', 'wechat subscribe payload is missing data', payload);
      return false;
    }

    const result = await dispatchWechatSubscribeMessage(
      task.receiver,
      task.template_id,
      payload.data,
      payload.page || task.page_path || undefined
    );

    if (result.success) {
      await markTaskSent(task, result.responseData);
      return true;
    }

    await markTaskFailed(
      task,
      result.errorCode || 'wechat_send_failed',
      result.errorMessage || 'wechat subscribe message failed',
      result.responseData
    );
    return false;
  } catch (err: any) {
    await markTaskFailed(task, 'unexpected_error', err.message || 'unexpected task processing error', null);
    log.error({ err, taskId }, 'message task processing failed unexpectedly');
    return false;
  }
}

export async function processPendingMessageTasks(limit = 20) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const [rows] = await pool.execute(
      `SELECT id
       FROM message_task
       WHERE status = 'pending'
          OR (status = 'failed' AND retry_count < max_retry_count AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
       ORDER BY id ASC
       LIMIT ?`,
      [limit]
    ) as any;

    for (const row of rows as Array<{ id: number }>) {
      await processMessageTask(row.id);
    }
  } finally {
    workerRunning = false;
  }
}

export function kickMessageTaskWorker() {
  setTimeout(() => {
    void processPendingMessageTasks().catch((err) => {
      log.error({ err }, 'message task worker kick failed');
    });
  }, 0);
}

export function startMessageTaskWorker(intervalMs = Number.parseInt(process.env.MESSAGE_TASK_WORKER_INTERVAL_MS || '', 10) || 15_000) {
  if (workerTimer) return;

  workerTimer = setInterval(() => {
    void processPendingMessageTasks().catch((err) => {
      log.error({ err }, 'message task worker loop failed');
    });
  }, intervalMs);
  workerTimer.unref?.();

  kickMessageTaskWorker();
  log.info({ intervalMs }, 'message task worker started');
}
