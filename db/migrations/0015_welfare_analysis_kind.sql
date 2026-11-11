-- ============================================================================
-- 0015：开奖分析快照支持福彩双色球 / 快乐8
--
-- 0007 建表时 kind 只允许 prediction / math_trend / dlt；0014 新增了两个号码池
-- 推演 kind（ssq / kl8），这里把 check 约束扩到五种。
-- ============================================================================

alter table lottery_analysis_snapshot
  drop constraint if exists lottery_analysis_kind_chk;

alter table lottery_analysis_snapshot
  add constraint lottery_analysis_kind_chk
  check (kind in ('prediction', 'math_trend', 'dlt', 'ssq', 'kl8'));

comment on column lottery_analysis_snapshot.kind is
  '分析种类：prediction / math_trend / dlt / ssq / kl8';
