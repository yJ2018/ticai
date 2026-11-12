import { fetchJson } from './http.mjs'

/**
 * 中国福利彩票（福彩）上游接口。
 *
 * 双色球 / 快乐8 都在同一个开奖公告接口里，`name` 是彩种：
 *   ssq = 双色球，kl8 = 快乐8
 *
 * 实测（2026-11-11）：
 *   - 必须带浏览器 UA；Referer 用 https://www.cwl.gov.cn/ 即可，不带也不会 567；
 *   - pageSize 最大 100，`pageNum` 是总页数，`total` 是总期数；
 *   - 双色球号码在 red（6 个，逗号分隔）+ blue（1 个）；快乐8 只有 red（20 个）。
 */

const CWL_HISTORY_PATH = '/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice'

const CWL_HEADERS = {
  referer: 'https://www.cwl.gov.cn/',
  origin: 'https://www.cwl.gov.cn',
}

export async function fetchWelfareHistoryPage(
  config,
  { name, pageNo = 1, pageSize = 100, fetchImpl } = {},
) {
  if (!name) {
    throw new Error('福彩开奖接口必须指定彩种 name')
  }

  const query = new URLSearchParams({
    name,
    issueCount: '',
    issueStart: '',
    issueEnd: '',
    dayStart: '',
    dayEnd: '',
    pageNo: String(pageNo),
    // 福彩接口 pageSize 上限 100，超过会被截断成不完整页
    pageSize: String(Math.min(Math.max(Number(pageSize) || 100, 1), 100)),
    week: '',
    systemType: 'PC',
    // 福彩公告走 CDN，开奖后短时间内可能仍返回上一期；带时间戳强制回源
    _t: String(Date.now()),
  })

  const json = await fetchJson(`${config.cwlBase}${CWL_HISTORY_PATH}?${query.toString()}`, {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    fetchImpl,
    headers: {
      ...CWL_HEADERS,
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  })

  if (!json || typeof json !== 'object') {
    throw new Error('福彩开奖接口返回结构异常')
  }
  // 福彩用 state=0 表示成功；其他值通常是 name 写错或被限流
  if (Number(json.state) !== 0) {
    throw new Error(`福彩开奖接口返回失败：${json.message || json.state || '未知原因'}`)
  }
  if (!Array.isArray(json.result)) {
    throw new Error('福彩开奖接口缺少 result')
  }

  const total = Number(json.total) || json.result.length
  const pages = Number(json.pageNum) || (total > 0 ? Math.ceil(total / pageSize) : 1)

  return {
    list: json.result,
    pageNo: Number(json.pageNo) || Number(pageNo) || 1,
    pages: Math.max(1, pages),
    total,
  }
}
