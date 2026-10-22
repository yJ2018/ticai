-- ============================================================================
-- 0002：对战数据订阅源
--
-- 体彩「足球对阵数据」页（m.sporttery.cn/zqlszl/bssj）背后有 7 个接口：
--   历史交锋 / 伤停 / 近期赛果 / 未来赛程 / 特征 / 积分榜 / 射手
--
-- 其中「伤停」和「赛果」有对应的规范化表（player / injury / match.result_*），
-- 其余 5 个先按原始 JSON 留档，等真的要用再决定怎么拆表——避免为了可能用不到的
-- 字段提前设计一堆表。
-- ============================================================================

alter table player
  add column if not exists sporttery_person_id bigint unique;

create table if not exists match_feed (
  sporttery_match_id bigint not null,
  feed               text not null,   -- 'history' | 'injury' | 'result' | 'future' | 'feature' | 'tables' | 'shooter'
  payload            jsonb not null,
  content_hash       text not null,
  fetched_at         timestamptz not null default now(),
  primary key (sporttery_match_id, feed)
);

create index if not exists match_feed_recent_idx on match_feed (feed, fetched_at desc);
