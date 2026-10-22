-- ============================================================================
-- 日常维护 SQL
--
-- 建议由爬虫每次收尾时执行一次，或单独挂一条每日 cron：
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/maintenance.sql
--
-- 全部语句幂等，可反复执行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 阵容：每队只保留最近 1 场（对应"阵容只看最近"的需求）
-- ----------------------------------------------------------------------------
with ranked as (
  select
    l.match_id,
    l.team_id,
    row_number() over (
      partition by l.team_id
      order by l.captured_at desc, m.kickoff_at desc
    ) as rn
  from match_lineup l
  join match m on m.id = l.match_id
)
delete from match_lineup l
using ranked r
where l.match_id = r.match_id
  and l.team_id = r.team_id
  and r.rn > 1;
-- match_lineup_player 由外键 on delete cascade 自动清理

-- ----------------------------------------------------------------------------
-- 2. 赔率快照：保留 120 天
--    （一场比赛每天约 30-80 次变更，不裁剪会以 GB/年 增长）
-- ----------------------------------------------------------------------------
delete from match_odds_snapshot
where captured_at < now() - interval '120 days';

-- ----------------------------------------------------------------------------
-- 3. 抓取日志：保留 30 天
-- ----------------------------------------------------------------------------
delete from crawl_run
where started_at < now() - interval '30 days';

-- ----------------------------------------------------------------------------
-- 4. 伤病：已痊愈且超过 1 年的记录清掉
-- ----------------------------------------------------------------------------
delete from injury
where ended_on is not null
  and ended_on < current_date - interval '1 year';

-- ----------------------------------------------------------------------------
-- 5. 失效比赛：连续 14 天没再出现的，标记为已结束（不要物理删除，赔率还要用）
-- ----------------------------------------------------------------------------
update match
set status = 'finished',
    updated_at = now()
where status = 'scheduled'
  and kickoff_at < now() - interval '1 day'
  and last_seen_at < now() - interval '14 days';

-- ----------------------------------------------------------------------------
-- 6. 巡检：以下查询应恒为空，返回行说明数据链路有问题
-- ----------------------------------------------------------------------------

-- 6.1 有赛事但没有赔率（爬虫写入顺序错了）
-- select m.id, m.sporttery_match_id, m.kickoff_at
-- from match m
-- where not exists (select 1 from match_odds_snapshot s where s.match_id = m.id)
--   and m.kickoff_at > now()
-- order by m.kickoff_at
-- limit 20;

-- 6.2 已结束但没有比分（赛果链路断了）
-- select sporttery_match_id, kickoff_at, status
-- from match
-- where status = 'finished' and home_score is null
-- order by kickoff_at desc
-- limit 20;

-- 6.3 开奖期数对不上（四个彩种的总期数应只增不减）
-- select g.game_key, count(*) as draws, max(d.issue_seq) as newest
-- from lottery_game g left join lottery_draw d on d.game_no = g.game_no
-- group by g.game_key order by g.game_key;

-- 6.4 数据新鲜度：在售赛程超过 5 分钟没更新就要告警
-- select source, max(finished_at) as last_ok,
--        round(extract(epoch from now() - max(finished_at)) / 60) as minutes_ago
-- from crawl_run
-- where status = 'ok'
-- group by source
-- order by source;
