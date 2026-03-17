# Task Plan: 后端代码审查与部署优化

## 目标与范围
- **目标**：在缺乏本地直连 ECS SSH 密钥权限的情况下，完成后端最新代码（包含数据库迁移脚本）的部署与自动执行。
- **不做**：直接配置本地代理/跳板机尝试建立本地到服务器的 SSH 通道；直接修改业务逻辑代码。

## 权重评估
- **复杂度**：5 分（修改 CI/CD 流水线以编排多个预部署/后部署命令）。
- **风险**：7 分（线上系统部署与生产机器的数据库变更）。
- **总分**：7 → 工作流：planning-with-files

## 方案选型
### 方案 A（推荐）：基于 GitHub Actions 扩展持续集成流水线
- **描述**：通过修改 `.github/workflows/deploy.yml` 文件，将执行数据库迁移任务（`bun run migrate:core`, `bun run migrate:reservation-unique` 和 `oss-remove-encryption.mjs` 等）加入到使用服务器密码和 IP (`SERVER_PASS`, `SERVER_IP`) 认证的 ssh部署阶段。提交推送到 main 分支自动触发执行。
- **优势**：利用现存的 GitHub Secrets 以及既有的自动化部署流程，规避本地机器无直连权限的问题，过程透明且符合项目已有运维范式。
- **劣势**：CI/CD 耗时较长，排错仅能通过 GitHub Actions 的日志查看。

### 方案 B：依赖内部临时网关层转发
- **描述**：假设项目存在特定中转脚本利用本地可控网关代理执行命令。
- **劣势**：尚未发现可用的代理网关配置。

## Expert Panel
- **主审专家**：后端架构师 / QA
- **审查点**：
  1. 确认 `deploy.yml` 中注入的多命令执行是否会被中断。
  2. 确认数据库迁移脚本是否有幂等性处理（或发生失败时的影响边界）。

## 变更清单
| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `.github/workflows/deploy.yml` | MODIFY | 在 `Deploy to Server` 步骤中增加远程服务器执行数据库迁移脚本（通过 sshpass 执行 `bun run migrate:*`）。 |

## 验证计划
- [ ] 检查 GitHub Actions 流水线执行状态页日志。
- [ ] 调用后端业务 API 进行冒烟测试。

## 回滚方案
- 如线上应用异常，立刻把 `.github/workflows/deploy.yml` 去除脚本执行指令并恢复上一个 commit，或者通过 GitHub 执行 Revert。

## 参考的知识源
- [x] 项目级规范：CLAUDE.md 中定义的 Deployment Protocol (`CI/CD Future Path: ... route all deployments via GitHub Actions`)。
