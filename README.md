# 新闻站 API 状态

[![API monitor](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml/badge.svg)](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml)

独立检查 [news.openx.ccwu.cc](https://news.openx.ccwu.cc/) 的公开接口。检查在 GitHub 标准托管 runner 运行，与新闻服务器分开；使用固定版本 [Upptime](https://upptime.js.org/docs/)，不创建长期访问 Token。

| 接口                                                    | 判定依据                                      | 状态与历史                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [健康检查](https://news.openx.ccwu.cc/api/health)       | HTTP 200、live 模式、status ok                | [health.yml](history/health.yml) · [变更记录](https://github.com/bazz1111/news-openx-status/commits/main/history/health.yml) |
| [新闻列表](https://news.openx.ccwu.cc/api/news?limit=1) | HTTP 200、live 模式、items 数组和 total 标记  | [news.yml](history/news.yml) · [变更记录](https://github.com/bazz1111/news-openx-status/commits/main/history/news.yml)       |
| [新闻统计](https://news.openx.ccwu.cc/api/stats)        | HTTP 200、live 模式、hourly 数组和 total 标记 | [stats.yml](history/stats.yml) · [变更记录](https://github.com/bazz1111/news-openx-status/commits/main/history/stats.yml)    |

首次检查完成前不代表监控已生效，请以 [Actions 实际运行](https://github.com/bazz1111/news-openx-status/actions/workflows/uptime.yml) 和 history 文件为准。

名义检查间隔为五分钟。某次检查若从正常变为失败或降级，同一轮会再等 120 秒复探；复探仍不正常才建故障 Issue。第一次探测已经看到、并且短于 120 秒的发布不会告警。已经记为故障的检查不会为了复探再等 120 秒，恢复后仍马上关闭 Issue。超过五秒视为降级，降级也要连续两次才建 Issue。GitHub 调度可能延迟，因此不能承诺五分钟内告警。每六小时额外保存一次延迟样本，状态变化立即保存；history 的 lastUpdated 是最近保存时间，不是每次检查时间。最新执行以 Actions 为准，可用率与延迟仅代表这些离散外部样本。

故障会建立 [状态 Issue](https://github.com/bazz1111/news-openx-status/issues?q=label%3Astatus)，分配给仓库拥有者；恢复后评论并关闭，保留历史。仓库已按用户选择关注 Issues，实际邮件送达还依赖其 GitHub 通知设置。演练 Issue 会明确标为“测试”，不计作真实故障。没有短信、电话或付费通知。

这里只公开网址、可用性、HTTP 码、延迟、时间及监控自身配置，不保存响应正文或新闻内容，不包含业务源码、服务器凭据、账户信息或备份。匹配器只检查必要结构标记，不代替完整 JSON Schema、采集新鲜度或内容正确性检查；空新闻列表允许，API 正常也不代表采集器持续采到新消息。

使用公开仓库标准 Actions 的免费范围；不使用私有仓库持续计时、不使用付费大 runner、不配置支付预算。GitHub 可能调整免费规则或停用长期无活动的 schedule；应关注 Actions 最近运行时间。六小时样本会写入新的公开状态提交。现有 Cloudflare Tunnel 告警独立保留，二者互补。

本轮不部署额外状态网站、数据库、云存储或外部分析脚本。停止监控可在 Actions 中停用本工作流；这不会停止新闻站或删除历史。
