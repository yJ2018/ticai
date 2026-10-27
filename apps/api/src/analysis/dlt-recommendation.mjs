// ⚠️ 自动生成，不要直接改这个文件。
// 源文件：src/domain/dltRecommendation.ts（算法改动请改 TS，然后 npm run analysis:sync）
// 生成器：scripts/sync-analysis.mjs · 源指纹 133b593c984e

import { DLT_BACK_MAX, DLT_BACK_MIN, DLT_FRONT_MAX, DLT_FRONT_MIN, computeDltBackIndicators, computeDltFrontIndicators, formatDltBigSmall, formatDltOddEven, formatDltZones, getDltFrontZoneIndex, parseDltBackNumbers, parseDltFrontNumbers, } from './dlt-indicators.mjs';
const FRONT_PICK_COUNT = 5;
const BACK_PICK_COUNT = 2;
/** 推演使用最近 300 期，兼顾稳定性与计算量 */
const LONG_WINDOW = 300;
/** 热度窗口 */
const RECENT_WINDOW = 30;
/** 短期热度窗口 */
const SHORT_WINDOW = 10;
/** 少于 30 期不生成号码 */
const MIN_SAMPLE = 30;
/** 前区每个区取评分最高的 4 个进入候选池 */
const ZONE_POOL_SIZE = 4;
/** 后区取评分最高的 5 个进入候选池 */
const BACK_POOL_SIZE = 5;
/**
 * 大乐透号码推演。
 *
 * 输入按「期号倒序」排列的开奖记录（historyService 已保证排序），只取最近 300 期：
 * 1. 统计每个号码的近 10 / 30 / 300 期出现次数与当前遗漏，得到综合评分；
 * 2. 前区每个区取评分最高的 4 个组成 12 码候选池，枚举 5 码组合；
 * 3. 用近 30 期的和值 / 跨度 / 奇偶 / 大小 / 三区均值给组合打分，兼顾评分与形态；
 * 4. 后区取 5 码候选池，枚举 2 码组合；
 * 5. 对候选池做近 30 期滚动覆盖回测，并生成可解释的推演理由。
 */
export function analyzeDltRecommendation(entries) {
    const draws = entries
        .slice(0, LONG_WINDOW)
        .map(toDraw)
        .filter((draw) => draw !== null);
    if (draws.length < MIN_SAMPLE) {
        return null;
    }
    const windows = {
        short: Math.min(SHORT_WINDOW, draws.length),
        recent: Math.min(RECENT_WINDOW, draws.length),
        long: draws.length,
    };
    const frontStats = rankNumbers(draws, windows, DLT_FRONT_MIN, DLT_FRONT_MAX, FRONT_PICK_COUNT, (draw) => draw.front);
    const backStats = rankNumbers(draws, windows, DLT_BACK_MIN, DLT_BACK_MAX, BACK_PICK_COUNT, (draw) => draw.back);
    const targets = computeTargets(draws, windows.recent);
    const frontPool = pickZoneCandidates(frontStats);
    const backPool = backStats.slice(0, BACK_POOL_SIZE);
    const lastDraw = draws[0];
    const frontCombination = pickFrontCombination(frontPool, frontStats, targets, lastDraw.front);
    const backCombination = pickBackCombination(backPool, backStats, targets, lastDraw.back);
    if (!frontCombination || !backCombination) {
        return null;
    }
    const pickedFront = new Set(frontCombination.numbers);
    const pickedBack = new Set(backCombination.numbers);
    const frontPoolSet = new Set(frontPool.map((stat) => stat.number));
    const alternatesFront = frontStats
        .filter((stat) => frontPoolSet.has(stat.number) && !pickedFront.has(stat.number))
        .slice(0, 5)
        .map((stat) => stat.number)
        .sort((left, right) => left - right);
    const alternatesBack = backStats
        .filter((stat) => !pickedBack.has(stat.number))
        .slice(0, 3)
        .map((stat) => stat.number)
        .sort((left, right) => left - right);
    return {
        windows,
        picks: {
            front: frontCombination.numbers,
            back: backCombination.numbers,
        },
        alternates: {
            front: alternatesFront,
            back: alternatesBack,
        },
        metrics: {
            front: frontCombination.metrics,
            back: backCombination.metrics,
        },
        targets,
        reasons: buildReasons({
            frontStats,
            backStats,
            frontMetrics: frontCombination.metrics,
            backMetrics: backCombination.metrics,
            picks: {
                front: frontCombination.numbers,
                back: backCombination.numbers,
            },
            targets,
            windows,
        }),
    };
}
function toDraw(entry) {
    const front = parseDltFrontNumbers(entry.numbers);
    const back = parseDltBackNumbers(entry.numbers);
    return front && back ? { front, back } : null;
}
/**
 * 逐号码评分：
 * - 短期 / 近期 / 长期频次按期望次数归一，热号得分高；
 * - 遗漏值按「平均多少期一出」归一，最多计 3 倍期望，避免极冷号因为超长遗漏霸榜。
 */
function rankNumbers(draws, windows, min, max, pickPerDraw, getNumbers) {
    const domainSize = max - min + 1;
    const counts = Array.from({ length: domainSize }, () => ({
        short: 0,
        recent: 0,
        long: 0,
        miss: null,
    }));
    for (let index = 0; index < draws.length; index += 1) {
        for (const number of getNumbers(draws[index])) {
            const count = counts[number - min];
            if (!count) {
                continue;
            }
            count.long += 1;
            if (index < windows.short) {
                count.short += 1;
            }
            if (index < windows.recent) {
                count.recent += 1;
            }
            if (count.miss === null) {
                count.miss = index;
            }
        }
    }
    const expectedShort = Math.max((windows.short * pickPerDraw) / domainSize, 1e-6);
    const expectedRecent = Math.max((windows.recent * pickPerDraw) / domainSize, 1e-6);
    const expectedLong = Math.max((windows.long * pickPerDraw) / domainSize, 1e-6);
    const expectedGap = domainSize / pickPerDraw;
    return counts
        .map((count, index) => {
        const number = min + index;
        const missSpan = count.miss ?? windows.long;
        // 频次 / 遗漏权重：近 10 期热度 30%、近 30 期 25%、长期 20%、遗漏 25%
        const score = 0.3 * (count.short / expectedShort) +
            0.25 * (count.recent / expectedRecent) +
            0.2 * (count.long / expectedLong) +
            0.25 * Math.min(missSpan / expectedGap, 3);
        return {
            number,
            score,
            shortCount: count.short,
            recentCount: count.recent,
            longCount: count.long,
            missSpan,
        };
    })
        .sort((left, right) => right.score - left.score || right.missSpan - left.missSpan || left.number - right.number);
}
function computeTargets(draws, window) {
    const sample = draws.slice(0, window);
    const oddEvenCounts = new Map();
    const bigSmallCounts = new Map();
    const zoneCounts = new Map();
    let validSamples = 0;
    let sum = 0;
    let span = 0;
    let odd = 0;
    let big = 0;
    let zone0 = 0;
    let zone1 = 0;
    let zone2 = 0;
    let backSum = 0;
    let backSpan = 0;
    let backOdd = 0;
    for (const draw of sample) {
        const front = computeDltFrontIndicators(draw.front);
        const back = computeDltBackIndicators(draw.back);
        if (!front || !back) {
            continue;
        }
        validSamples += 1;
        sum += front.sum;
        span += front.span;
        odd += front.odd;
        big += front.big;
        zone0 += front.zones[0];
        zone1 += front.zones[1];
        zone2 += front.zones[2];
        backSum += back.sum;
        backSpan += back.span;
        backOdd += back.odd;
        increment(oddEvenCounts, formatDltOddEven(front));
        increment(bigSmallCounts, formatDltBigSmall(front));
        increment(zoneCounts, formatDltZones(front));
    }
    const divisor = validSamples || 1;
    return {
        averageSum: sum / divisor,
        averageSpan: span / divisor,
        averageOdd: odd / divisor,
        averageBig: big / divisor,
        averageZones: [zone0 / divisor, zone1 / divisor, zone2 / divisor],
        commonOddEven: mostCommon(oddEvenCounts, '3:2'),
        commonBigSmall: mostCommon(bigSmallCounts, '2:3'),
        commonZones: mostCommon(zoneCounts, '1:2:2'),
        averageBackSum: backSum / divisor,
        averageBackSpan: backSpan / divisor,
        averageBackOdd: backOdd / divisor,
    };
}
function pickZoneCandidates(stats) {
    const byZone = [[], [], []];
    for (const stat of stats) {
        byZone[getDltFrontZoneIndex(stat.number)].push(stat);
    }
    return byZone.flatMap((zoneStats) => zoneStats.slice(0, ZONE_POOL_SIZE));
}
function pickFrontCombination(pool, stats, targets, lastFront) {
    const statByNumber = new Map(stats.map((stat) => [stat.number, stat]));
    const lastDrawSet = new Set(lastFront);
    const poolNumbers = pool.map((stat) => stat.number);
    let best = null;
    let bestSumDistance = Number.POSITIVE_INFINITY;
    for (let first = 0; first < poolNumbers.length - 4; first += 1) {
        for (let second = first + 1; second < poolNumbers.length - 3; second += 1) {
            for (let third = second + 1; third < poolNumbers.length - 2; third += 1) {
                for (let fourth = third + 1; fourth < poolNumbers.length - 1; fourth += 1) {
                    for (let fifth = fourth + 1; fifth < poolNumbers.length; fifth += 1) {
                        const numbers = [
                            poolNumbers[first],
                            poolNumbers[second],
                            poolNumbers[third],
                            poolNumbers[fourth],
                            poolNumbers[fifth],
                        ].sort((left, right) => left - right);
                        const metrics = computeDltFrontIndicators(numbers);
                        if (!metrics) {
                            continue;
                        }
                        const baseScore = numbers.reduce((total, number) => total + (statByNumber.get(number)?.score ?? 0), 0) /
                            numbers.length;
                        const sumDistance = Math.abs(metrics.sum - targets.averageSum);
                        const zoneDistance = Math.abs(metrics.zones[0] - targets.averageZones[0]) +
                            Math.abs(metrics.zones[1] - targets.averageZones[1]) +
                            Math.abs(metrics.zones[2] - targets.averageZones[2]);
                        const overlap = numbers.filter((number) => lastDrawSet.has(number)).length;
                        // 组合分：5 个号码的平均评分占主导，和值/跨度/奇偶/大小/三区/连号偏差做软约束
                        const score = baseScore * 1.6 -
                            sumDistance / 45 -
                            Math.abs(metrics.span - targets.averageSpan) / 18 -
                            Math.abs(metrics.odd - targets.averageOdd) * 0.1 -
                            Math.abs(metrics.big - targets.averageBig) * 0.1 -
                            zoneDistance * 0.1 -
                            countConsecutiveTriples(numbers) * 0.15 -
                            Math.max(0, overlap - 2) * 0.1;
                        if (!best ||
                            score > best.score + 1e-9 ||
                            (Math.abs(score - best.score) <= 1e-9 && sumDistance < bestSumDistance - 1e-9)) {
                            best = { numbers, metrics, score };
                            bestSumDistance = sumDistance;
                        }
                    }
                }
            }
        }
    }
    return best;
}
function pickBackCombination(pool, stats, targets, lastBack) {
    const statByNumber = new Map(stats.map((stat) => [stat.number, stat]));
    const lastDrawSet = new Set(lastBack);
    let best = null;
    let bestSumDistance = Number.POSITIVE_INFINITY;
    for (let first = 0; first < pool.length - 1; first += 1) {
        for (let second = first + 1; second < pool.length; second += 1) {
            const numbers = [pool[first].number, pool[second].number].sort((left, right) => left - right);
            const metrics = computeDltBackIndicators(numbers);
            if (!metrics) {
                continue;
            }
            const baseScore = numbers.reduce((total, number) => total + (statByNumber.get(number)?.score ?? 0), 0) /
                numbers.length;
            const sumDistance = Math.abs(metrics.sum - targets.averageBackSum);
            const overlap = numbers.filter((number) => lastDrawSet.has(number)).length;
            // 后区组合同样以评分为主，和值/跨度/奇偶偏差与重复上期做软约束
            const score = baseScore * 1.6 -
                sumDistance / 10 -
                Math.abs(metrics.span - targets.averageBackSpan) / 6 -
                Math.abs(metrics.odd - targets.averageBackOdd) * 0.12 -
                Math.max(0, overlap - 1) * 0.1;
            if (!best ||
                score > best.score + 1e-9 ||
                (Math.abs(score - best.score) <= 1e-9 && sumDistance < bestSumDistance - 1e-9)) {
                best = { numbers, metrics, score };
                bestSumDistance = sumDistance;
            }
        }
    }
    return best;
}
function buildReasons(params) {
    const { frontStats, backStats, frontMetrics, backMetrics, picks, targets, windows } = params;
    const frontStatByNumber = new Map(frontStats.map((stat) => [stat.number, stat]));
    const backStatByNumber = new Map(backStats.map((stat) => [stat.number, stat]));
    const reasons = [];
    const frontByHeat = [...picks.front].sort((left, right) => {
        const leftStat = frontStatByNumber.get(left);
        const rightStat = frontStatByNumber.get(right);
        return ((rightStat?.recentCount ?? 0) - (leftStat?.recentCount ?? 0) ||
            (rightStat?.shortCount ?? 0) - (leftStat?.shortCount ?? 0) ||
            left - right);
    });
    const frontByMiss = [...picks.front].sort((left, right) => {
        const leftStat = frontStatByNumber.get(left);
        const rightStat = frontStatByNumber.get(right);
        return (rightStat?.missSpan ?? 0) - (leftStat?.missSpan ?? 0) || left - right;
    });
    const hotFront = frontByHeat[0];
    const dueFront = frontByMiss[0];
    const hotFrontStat = frontStatByNumber.get(hotFront);
    const dueFrontStat = frontStatByNumber.get(dueFront);
    const expectedRecentFront = (windows.recent * FRONT_PICK_COUNT) / (DLT_FRONT_MAX - DLT_FRONT_MIN + 1);
    const averageGapFront = (DLT_FRONT_MAX - DLT_FRONT_MIN + 1) / FRONT_PICK_COUNT;
    const hotFrontText = `${pad(hotFront)} 近 ${windows.recent} 期出现 ${hotFrontStat?.recentCount ?? 0} 次（均值 ${expectedRecentFront.toFixed(1)} 次）`;
    const dueFrontText = dueFrontStat && dueFrontStat.missSpan >= windows.long
        ? `${pad(dueFront)} 近 ${windows.long} 期未出现`
        : `${pad(dueFront)} 已遗漏 ${dueFrontStat?.missSpan ?? 0} 期（平均 ${averageGapFront.toFixed(0)} 期一出）`;
    const hasDueFront = Boolean(dueFrontStat && dueFrontStat.missSpan >= averageGapFront);
    if (hotFront === dueFront) {
        const dueSpanText = dueFrontStat && dueFrontStat.missSpan >= windows.long
            ? `近 ${windows.long} 期未出现`
            : `当前遗漏 ${dueFrontStat?.missSpan ?? 0} 期`;
        reasons.push(`前区 ${pad(hotFront)} 近 ${windows.recent} 期出现 ${hotFrontStat?.recentCount ?? 0} 次，在入选号中热度最高；${dueSpanText}${hasDueFront ? '，也进入回补区间' : ''}。`);
    }
    else {
        const dueClause = hasDueFront
            ? `回补号 ${dueFrontText}`
            : `其余入选号最长遗漏 ${dueFrontStat?.missSpan ?? 0} 期`;
        reasons.push(`前区热号 ${hotFrontText}；${dueClause}。`);
    }
    const sumDistance = Math.abs(frontMetrics.sum - targets.averageSum);
    const spanDistance = Math.abs(frontMetrics.span - targets.averageSpan);
    const zoneDistance = Math.abs(frontMetrics.zones[0] - targets.averageZones[0]) +
        Math.abs(frontMetrics.zones[1] - targets.averageZones[1]) +
        Math.abs(frontMetrics.zones[2] - targets.averageZones[2]);
    const closenessText = sumDistance <= 12 && spanDistance <= 6 ? '接近' : '参考';
    const shapeText = zoneDistance <= 1.5 ? '形态保持均衡' : '形态相对集中';
    reasons.push(`组合和值 ${frontMetrics.sum}、跨度 ${frontMetrics.span}，${closenessText}近 ${windows.recent} 期均值 ${targets.averageSum.toFixed(1)} / ${targets.averageSpan.toFixed(1)}；奇偶 ${formatDltOddEven(frontMetrics)}、大小 ${formatDltBigSmall(frontMetrics)}、三区 ${formatDltZones(frontMetrics)}，${shapeText}（近 ${windows.recent} 期主流 ${targets.commonOddEven} / ${targets.commonBigSmall} / ${targets.commonZones}）。`);
    const backByHeat = [...picks.back].sort((left, right) => {
        const leftStat = backStatByNumber.get(left);
        const rightStat = backStatByNumber.get(right);
        return ((rightStat?.recentCount ?? 0) - (leftStat?.recentCount ?? 0) ||
            (rightStat?.shortCount ?? 0) - (leftStat?.shortCount ?? 0) ||
            left - right);
    });
    const backByMiss = [...picks.back].sort((left, right) => {
        const leftStat = backStatByNumber.get(left);
        const rightStat = backStatByNumber.get(right);
        return (rightStat?.missSpan ?? 0) - (leftStat?.missSpan ?? 0) || left - right;
    });
    const hotBack = backByHeat[0];
    const dueBack = backByMiss[0];
    const hotBackStat = backStatByNumber.get(hotBack);
    const dueBackStat = backStatByNumber.get(dueBack);
    const expectedRecentBack = (windows.recent * BACK_PICK_COUNT) / (DLT_BACK_MAX - DLT_BACK_MIN + 1);
    reasons.push(`后区 ${pad(hotBack)} 近 ${windows.recent} 期 ${hotBackStat?.recentCount ?? 0} 次（均值 ${expectedRecentBack.toFixed(1)} 次），${hotBack === dueBack
        ? '同时是入选后区中遗漏最久的号码'
        : `${pad(dueBack)} 已遗漏 ${dueBackStat?.missSpan ?? 0} 期`}；组合奇偶 ${formatDltOddEven(backMetrics)}、跨度 ${backMetrics.span}。`);
    return reasons;
}
function countConsecutiveTriples(numbers) {
    const sorted = [...numbers].sort((left, right) => left - right);
    let triples = 0;
    let runLength = 1;
    for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index] === sorted[index - 1] + 1) {
            runLength += 1;
            continue;
        }
        if (runLength >= 3) {
            triples += runLength - 2;
        }
        runLength = 1;
    }
    if (runLength >= 3) {
        triples += runLength - 2;
    }
    return triples;
}
function increment(counts, key) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}
function mostCommon(counts, fallback) {
    let bestKey = fallback;
    let bestCount = 0;
    for (const [key, count] of counts) {
        if (count > bestCount || (count === bestCount && key < bestKey)) {
            bestKey = key;
            bestCount = count;
        }
    }
    return bestKey;
}
function pad(value) {
    return String(value).padStart(2, '0');
}
