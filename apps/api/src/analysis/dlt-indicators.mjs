// 冻结的实现：算法已迁到 Python 分析服务，这里只保留 Node 内联回退（ANALYSIS_API_BASE 未配置 / 不可达时使用）。
// 大乐透逐期指标（Node 回退实现，Python 版在 apps/analysis/app/analysis/dlt_indicators.py）
// 不要再从 src/domain 生成（生成器已删除）；改算法去改 Python 版。

/**
 * 大乐透前区 / 后区逐期指标。
 *
 * 业界走势图右侧通常跟着一组逐期统计：和值、跨度、奇偶比、大小比、三区比。
 * 这里集中定义口径，页面、右栏和号码推演只负责调用：
 * - 和值：前区 5 个号码之和，范围 15–165；后区 2 个号码之和，范围 3–23
 * - 跨度：最大号 − 最小号，前区 4–34；后区 1–11
 * - 奇偶比：奇数个数 : 偶数个数
 * - 大小比：大号（18–35） : 小号（1–17）
 * - 三区比：一区 1–12 : 二区 13–24 : 三区 25–35
 */
export const DLT_FRONT_BALL_COUNT = 5;
export const DLT_FRONT_MIN = 1;
export const DLT_FRONT_MAX = 35;
export const DLT_BACK_BALL_COUNT = 2;
export const DLT_BACK_MIN = 1;
export const DLT_BACK_MAX = 12;
/** 前区大小分界：18–35 为大号，1–17 为小号 */
export const DLT_BIG_NUMBER_MIN = 18;
/** 三区上界：1–12 / 13–24 / 25–35 */
const ZONE_UPPER_LIMITS = [12, 24, 35];
/** 号码属于前区第几区（0 = 一区 1–12，1 = 二区 13–24，2 = 三区 25–35） */
export function getDltFrontZoneIndex(value) {
    if (value <= ZONE_UPPER_LIMITS[0]) {
        return 0;
    }
    if (value <= ZONE_UPPER_LIMITS[1]) {
        return 1;
    }
    return 2;
}
/** 解析前区 5 个号码；号码缺失或越界时返回 null */
export function parseDltFrontNumbers(numbers) {
    if (numbers.length < DLT_FRONT_BALL_COUNT) {
        return null;
    }
    const frontNumbers = [];
    for (let index = 0; index < DLT_FRONT_BALL_COUNT; index += 1) {
        const value = Number(numbers[index]);
        if (!Number.isInteger(value) || value < DLT_FRONT_MIN || value > DLT_FRONT_MAX) {
            return null;
        }
        frontNumbers.push(value);
    }
    return frontNumbers;
}
/** 解析后区 2 个号码；号码缺失或越界时返回 null */
export function parseDltBackNumbers(numbers) {
    if (numbers.length < DLT_FRONT_BALL_COUNT + DLT_BACK_BALL_COUNT) {
        return null;
    }
    const backNumbers = [];
    for (let index = 0; index < DLT_BACK_BALL_COUNT; index += 1) {
        const value = Number(numbers[DLT_FRONT_BALL_COUNT + index]);
        if (!Number.isInteger(value) || value < DLT_BACK_MIN || value > DLT_BACK_MAX) {
            return null;
        }
        backNumbers.push(value);
    }
    return backNumbers;
}
/** 已解析的前区号码 → 逐期指标；非法号码返回 null */
export function computeDltFrontIndicators(frontNumbers) {
    if (frontNumbers.length < DLT_FRONT_BALL_COUNT) {
        return null;
    }
    const numbers = frontNumbers.slice(0, DLT_FRONT_BALL_COUNT);
    if (numbers.some((value) => !Number.isInteger(value) || value < DLT_FRONT_MIN || value > DLT_FRONT_MAX)) {
        return null;
    }
    let sum = 0;
    let odd = 0;
    let big = 0;
    const zones = [0, 0, 0];
    let min = numbers[0];
    let max = numbers[0];
    for (const value of numbers) {
        sum += value;
        if (value % 2 === 1) {
            odd += 1;
        }
        if (value >= DLT_BIG_NUMBER_MIN) {
            big += 1;
        }
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
        zones[getDltFrontZoneIndex(value)] += 1;
    }
    return {
        sum,
        span: max - min,
        odd,
        even: DLT_FRONT_BALL_COUNT - odd,
        big,
        small: DLT_FRONT_BALL_COUNT - big,
        zones,
    };
}
/** 已解析的后区号码 → 逐期指标；非法号码返回 null */
export function computeDltBackIndicators(backNumbers) {
    if (backNumbers.length < DLT_BACK_BALL_COUNT) {
        return null;
    }
    const numbers = backNumbers.slice(0, DLT_BACK_BALL_COUNT);
    if (numbers.some((value) => !Number.isInteger(value) || value < DLT_BACK_MIN || value > DLT_BACK_MAX)) {
        return null;
    }
    let sum = 0;
    let odd = 0;
    let min = numbers[0];
    let max = numbers[0];
    for (const value of numbers) {
        sum += value;
        if (value % 2 === 1) {
            odd += 1;
        }
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
    }
    return {
        sum,
        span: max - min,
        odd,
        even: DLT_BACK_BALL_COUNT - odd,
    };
}
/** 开奖记录中的号码字符串 → 前区指标 */
export function getDltFrontIndicators(numbers) {
    const frontNumbers = parseDltFrontNumbers(numbers);
    return frontNumbers ? computeDltFrontIndicators(frontNumbers) : null;
}
/** 开奖记录中的号码字符串 → 后区指标 */
export function getDltBackIndicators(numbers) {
    const backNumbers = parseDltBackNumbers(numbers);
    return backNumbers ? computeDltBackIndicators(backNumbers) : null;
}
/** 汇总一页数据，供右栏顶部显示「本页均值」 */
export function summarizeDltFrontIndicators(items) {
    const validItems = items.filter((item) => item !== null);
    if (validItems.length === 0) {
        return null;
    }
    let sum = 0;
    let span = 0;
    let odd = 0;
    let big = 0;
    let zone0 = 0;
    let zone1 = 0;
    let zone2 = 0;
    for (const item of validItems) {
        sum += item.sum;
        span += item.span;
        odd += item.odd;
        big += item.big;
        zone0 += item.zones[0];
        zone1 += item.zones[1];
        zone2 += item.zones[2];
    }
    const sampleSize = validItems.length;
    return {
        sampleSize,
        averageSum: sum / sampleSize,
        averageSpan: span / sampleSize,
        averageOdd: odd / sampleSize,
        averageBig: big / sampleSize,
        averageZones: [zone0 / sampleSize, zone1 / sampleSize, zone2 / sampleSize],
    };
}
/** 奇数 : 偶数 */
export function formatDltOddEven(indicators) {
    return `${indicators.odd}:${indicators.even}`;
}
/** 大号 : 小号 */
export function formatDltBigSmall(indicators) {
    return `${indicators.big}:${indicators.small}`;
}
/** 一区 : 二区 : 三区 */
export function formatDltZones(indicators) {
    return indicators.zones.join(':');
}
/** 均值保留 1 位小数，用于右栏顶部与号码推演的汇总 */
export function formatDltAverage(value) {
    return Number.isFinite(value) ? value.toFixed(1) : '--';
}
