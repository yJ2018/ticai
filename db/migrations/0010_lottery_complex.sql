-- ============================================================================
-- 0010：彩票复式投注
--
-- 号码结构从「单式」升级为「复式」：
--   - 排列五 / 七星彩：{"main": [[1,2],[5],[4],[4],[8]], "extra": []}
--     每个位次一个数组，数组里的数字任选；注数 = 各位长度的乘积。
--   - 大乐透：{"main": [1,6,10,15,32,...], "extra": [3,8,...]}
--     前区至少 5 个、后区至少 2 个；注数 = C(前区个数,5) × C(后区个数,2)。
--
-- 旧的单式注单是 {"main": [1,5,4,4,8], "extra": []}（位次型），这里原地转换，
-- 注数与金额不变（每位只有 1 个数字，乘积仍为 1 注 × 倍数）。
-- ============================================================================

update bet
set lottery_numbers = jsonb_build_object(
  'main',
  (
    select jsonb_agg(jsonb_build_array(value))
    from jsonb_array_elements(lottery_numbers -> 'main') as value
  ),
  'extra', '[]'::jsonb
)
where kind = 'lottery'
  and lottery_game_no in ('350133', '04')
  and lottery_numbers is not null
  and jsonb_typeof(lottery_numbers -> 'main') = 'array'
  and jsonb_typeof(lottery_numbers -> 'main' -> 0) = 'number';
