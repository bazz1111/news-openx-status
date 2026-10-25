# 新闻站 API 状态

[![API monitor](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml/badge.svg)](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml)

从 GitHub 公开仓库的标准托管 runner 独立检查 [讯流](https://news.openx.ccwu.cc/)，不增加付费告警服务、服务器进程或长期 Token。

| 接口 | 成功条件 |
| --- | --- |
| `/api/health` | HTTP 200、live 模式、status ok |
| `/api/news?limit=1` | HTTP 200、live 模式、items 数组及 total |
| `/api/stats` | HTTP 200、live 模式、hourly 数组及 total |

保留既有 Upptime 的公开 HTTP、正文匹配和五秒降级规则，沿用 curl 探针。由项目级更新器直接管理一次探测的结果，避免门控以后 Upptime 又探测一次、引入未经确认的第三份结果。每个接口独立确认，不借用其他接口的失败。

- 名义每五分钟执行；GitHub 调度可能延迟，不承诺五分钟送达。
- 新故障及恢复均需间隔 120 秒的两次确认。混合结果保留该接口上次已确认状态；缺失结果使工作流失败，不会关闭事件。
- 同一时段的多个异常接口合并为一个带 `project-monitor` 标签的 [状态事件](https://github.com/bazz1111/news-openx-status/issues?q=label%3Aproject-monitor)。异常范围改变只更新原事件，不逐接口建单、不增加指派邮件或恢复评论。
- 所有接口确认恢复后关闭原事件；30 分钟内确认复发重开原事件。更晚的独立故障创建新事件。
- 已有 Issues 自定义订阅保留，创建、重开及关闭可触发 GitHub 邮件；是否实际送达仍取决于用户的全局邮件设置。没有短信或其他付费通道。

[history/project.json](history/project.json) 在首次运行、已确认状态变化和每六小时延迟采样时保存。`checked_at` 是最近保存时间；每次探测结果与具体执行时间以 [Actions 日志](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml) 为准。原 Upptime 的 `history/*.yml` 和历史事件保留为归档，不再由旧动作更新。离散样本不能表示连续停机时长、采集新鲜度或内容正确性；空新闻数组允许。

PR 及脚本修改运行本地 HTTP 和事件生命周期回归；PR 不探测生产、不写 Issue、不发演练邮件。定时检查不重复跑回归 job。使用公开仓库标准 `ubuntu-latest`，保持既有零付费预算，不使用大 runner、付费通知、模型请求或 artifact 上传。Cloudflare 的连接器健康告警独立保留，不用接口恢复代替 Tunnel 健康。

这里只公开网址、HTTP 码、时延、时间、确认状态与监控代码。不保存响应正文、新闻内容、业务源码、备份、凭据或账户资料。停止本工作流不会停止新闻站或删除历史。

回滚：恢复先前工作流及 `.upptimerc.yml` 后，确认旧版逐接口告警会重新生效；保留项目事件及 `history/project.json`，不要删除故障记录。旧版回滚会恢复原有通知数量，应在有实际故障时慎重操作。
