// ⚠️ 自动生成，不要直接改这个文件。
// 源文件：src/domain/historyPrediction.ts（算法改动请改 TS，然后 npm run analysis:sync）
// 生成器：scripts/sync-analysis.mjs · 源指纹 133b593c984e

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const POSITION_COUNT = 5;
const RECENT_WINDOW = 12;
const LONG_WINDOW = 60;
const MIN_TRAINING_SIZE = 30;
const COMBINATION_POOL_SIZE = 3;
const COMBINATION_LIMIT = 6;
const DEFAULT_MARKOV_ORDER = 2;
const MATH_SAMPLE_WINDOW = 240;
const MATH_TREND_WINDOW = 36;
const MATH_VALIDATION_START = 120;
const MATH_CANDIDATE_COUNT = 3;
const MATH_RECENT_DIGIT_COUNT = 18;
export const DEFAULT_PREDICTION_SCORE_WEIGHTS = {
    recent: 0.34,
    long: 0.2,
    omission: 0.22,
    transition: 0.14,
    pairTransition: 0.1,
};
export function analyzeHistoryPrediction(entries, options = {}) {
    const config = resolvePredictionConfig(options);
    const sortedEntries = sortChronological(entries);
    const validDraws = getValidDraws(sortedEntries);
    const positionCount = Math.max(1, Math.floor(options.positionCount ?? POSITION_COUNT));
    const positions = Array.from({ length: positionCount }, (_, position) => analyzePosition(sortedEntries, position, config));
    const sampleSize = sortedEntries.length;
    return {
        sampleSize,
        averageTop1Rate: averageRate(positions.map((item) => item.backtest.top1Rate)),
        averageTop3Rate: averageRate(positions.map((item) => item.backtest.top3Rate)),
        positions,
        combinations: buildCombinationCandidates(positions, config),
        markov: {
            order: config.markovOrder,
            averageTop1Rate: averageRate(positions.map((item) => item.markov.backtest.top1Rate)),
            averageTop3Rate: averageRate(positions.map((item) => item.markov.backtest.top3Rate)),
            combinations: buildMarkovCombinationCandidates(positions, config),
        },
        config,
        statistics: buildPredictionStatistics(validDraws, config),
    };
}
export function analyzeMathTrendPrediction(entries, options = {}) {
    const config = resolveMathTrendConfig(options);
    const sortedEntries = sortChronological(entries);
    const positions = Array.from({ length: POSITION_COUNT }, (_, position) => analyzeMathTrendPosition(sortedEntries, position, config));
    const sampleSize = sortedEntries.length;
    return {
        sampleSize,
        effectiveSampleWindow: Math.min(config.sampleWindow, sampleSize),
        validationStart: config.validationStart,
        averageTop1Rate: averageRate(positions.map((item) => item.backtest.top1Rate)),
        averageTop3Rate: averageRate(positions.map((item) => item.backtest.top3Rate)),
        positions,
        config,
    };
}
function analyzePosition(entries, position, config) {
    const digits = entries.map((entry) => parseDigitValue(entry.numbers[position])).filter((value) => value !== null);
    const rankedDigits = rankNextDigits(digits, config);
    const markov = buildMarkovSnapshot(digits, config.markovOrder, config.combinationPoolSize);
    return {
        position,
        picks: rankedDigits.slice(0, config.combinationPoolSize).map((item) => item.digit),
        candidates: rankedDigits.slice(0, 5),
        latestDigit: digits[digits.length - 1] ?? null,
        historySample: digits.length,
        recentDigits: digits.slice(-config.recentWindow).reverse(),
        backtest: runBacktest(digits, config),
        markov: {
            order: config.markovOrder,
            effectiveOrder: markov.effectiveOrder,
            sourcePattern: markov.sourcePattern,
            supportCount: markov.supportCount,
            picks: markov.rankedDigits.slice(0, config.combinationPoolSize).map((item) => item.digit),
            candidates: markov.rankedDigits.slice(0, 5),
            backtest: runMarkovBacktest(digits, config),
        },
    };
}
function analyzeMathTrendPosition(entries, position, config) {
    const digits = entries.map((entry) => parseDigitValue(entry.numbers[position])).filter((value) => value !== null);
    const snapshot = buildMathTrendSnapshot(digits, config);
    return {
        position,
        picks: snapshot.rankedDigits.slice(0, config.candidateCount).map((item) => item.digit),
        candidates: snapshot.rankedDigits.slice(0, 5),
        latestDigit: digits[digits.length - 1] ?? null,
        historySample: digits.length,
        sampleWindow: snapshot.trainingDigits.length,
        recentDigits: snapshot.trainingDigits.slice(-MATH_RECENT_DIGIT_COUNT).reverse(),
        backtest: runMathTrendBacktest(digits, config),
        predictedCenter: snapshot.predictedCenter,
        trendSlope: snapshot.trendSlope,
        recentAverage: snapshot.recentAverage,
        volatility: snapshot.volatility,
    };
}
function rankNextDigits(historyDigits, config) {
    if (historyDigits.length === 0) {
        return DIGITS.map((digit) => ({
            digit,
            score: 0,
            totalCount: 0,
            recentCount: 0,
            missSpan: 0,
            transitionCount: 0,
            pairTransitionCount: 0,
            breakdown: {
                recent: 0,
                long: 0,
                omission: 0,
                transition: 0,
                pairTransition: 0,
            },
        }));
    }
    const recentWindow = Math.min(config.recentWindow, historyDigits.length);
    const longWindow = Math.min(config.longWindow, historyDigits.length);
    const recentDigits = historyDigits.slice(-recentWindow);
    const longDigits = historyDigits.slice(-longWindow);
    const recentCounts = countDigits(recentDigits);
    const longCounts = countDigits(longDigits);
    const lastDigit = historyDigits[historyDigits.length - 1];
    const prevDigit = historyDigits.length >= 2 ? historyDigits[historyDigits.length - 2] : null;
    const transitionCounts = countTransitionMatches(historyDigits, [lastDigit]);
    const pairTransitionCounts = prevDigit === null ? createZeroMap() : countTransitionMatches(historyDigits, [prevDigit, lastDigit]);
    const transitionTotal = sumCounts(transitionCounts);
    const pairTransitionTotal = sumCounts(pairTransitionCounts);
    const omissionCap = Math.max(6, Math.ceil(longWindow / 3));
    return DIGITS.map((digit) => {
        const recentScore = recentCounts[digit] / Math.max(recentWindow, 1);
        const longScore = longCounts[digit] / Math.max(longWindow, 1);
        const missSpan = getMissSpan(historyDigits, digit);
        const omissionScore = Math.min(missSpan / omissionCap, 1);
        const transitionScore = transitionTotal > 0 ? transitionCounts[digit] / transitionTotal : 0;
        const pairTransitionScore = pairTransitionTotal > 0 ? pairTransitionCounts[digit] / pairTransitionTotal : 0;
        const breakdown = {
            recent: roundScore(recentScore * config.scoreWeights.recent * 100),
            long: roundScore(longScore * config.scoreWeights.long * 100),
            omission: roundScore(omissionScore * config.scoreWeights.omission * 100),
            transition: roundScore(transitionScore * config.scoreWeights.transition * 100),
            pairTransition: roundScore(pairTransitionScore * config.scoreWeights.pairTransition * 100),
        };
        const score = breakdown.recent + breakdown.long + breakdown.omission + breakdown.transition + breakdown.pairTransition;
        return {
            digit,
            score: roundScore(score),
            totalCount: longCounts[digit],
            recentCount: recentCounts[digit],
            missSpan,
            transitionCount: transitionCounts[digit],
            pairTransitionCount: pairTransitionCounts[digit],
            breakdown,
        };
    }).sort((left, right) => right.score - left.score ||
        right.recentCount - left.recentCount ||
        right.totalCount - left.totalCount ||
        right.missSpan - left.missSpan ||
        left.digit - right.digit);
}
function buildMathTrendSnapshot(historyDigits, config) {
    const trainingDigits = getMathTrainingDigits(historyDigits, config);
    if (trainingDigits.length === 0) {
        return {
            trainingDigits,
            predictedCenter: null,
            trendSlope: 0,
            recentAverage: 0,
            volatility: 0,
            rankedDigits: DIGITS.map((digit) => ({
                digit,
                score: 0,
                occurrenceRate: 0,
                recentMomentum: 0,
                averageGap: 0,
                currentGap: 0,
                predictedDistance: 0,
                distributionGap: 0,
                breakdown: {
                    distribution: 0,
                    trend: 0,
                    cycle: 0,
                    momentum: 0,
                },
            })),
        };
    }
    const trendDigits = trainingDigits.slice(-Math.min(config.trendWindow, trainingDigits.length));
    const previousTrendDigits = trainingDigits.slice(Math.max(trainingDigits.length - trendDigits.length * 2, 0), Math.max(trainingDigits.length - trendDigits.length, 0));
    const predictedCenter = computeForecastCenter(trendDigits);
    const trendSlope = computeLinearSlope(trendDigits);
    const recentAverage = averageNumber(trendDigits);
    const volatility = computeStandardDeviation(trendDigits, recentAverage);
    const longCounts = countDigits(trainingDigits);
    const recentCounts = countDigits(trendDigits);
    const previousCounts = countDigits(previousTrendDigits);
    const expectedCount = trainingDigits.length / DIGITS.length;
    const sigma = Math.max(volatility, 1.4);
    const fallbackAverageGap = Math.max(trainingDigits.length / DIGITS.length, 1);
    const rankedDigits = DIGITS.map((digit) => {
        const occurrenceRate = safeRate(longCounts[digit], trainingDigits.length);
        const distributionGap = roundScore(expectedCount - longCounts[digit]);
        const distributionScore = clampZeroToOne(0.5 + (expectedCount - longCounts[digit]) / Math.max(expectedCount * 2, 1));
        const predictedDistance = predictedCenter === null ? 0 : Math.abs(digit - predictedCenter);
        const trendScore = predictedCenter === null ? 0 : Math.exp(-((predictedDistance * predictedDistance) / (2 * sigma * sigma)));
        const averageGap = getAverageGap(trainingDigits, digit, fallbackAverageGap);
        const currentGap = getMissSpan(trainingDigits, digit);
        const cycleRatio = currentGap / Math.max(averageGap, 1);
        const cycleScore = Math.max(0, 1 - Math.min(Math.abs(cycleRatio - 1), 1));
        const recentRate = safeRate(recentCounts[digit], trendDigits.length);
        const previousRate = previousTrendDigits.length > 0 ? safeRate(previousCounts[digit], previousTrendDigits.length) : occurrenceRate;
        const recentMomentum = recentRate - previousRate;
        const momentumScore = clampZeroToOne(0.5 + recentMomentum * 2.5);
        const breakdown = {
            distribution: roundScore(distributionScore * 26),
            trend: roundScore(trendScore * 38),
            cycle: roundScore(cycleScore * 20),
            momentum: roundScore(momentumScore * 16),
        };
        return {
            digit,
            score: roundScore(breakdown.distribution + breakdown.trend + breakdown.cycle + breakdown.momentum),
            occurrenceRate,
            recentMomentum: roundScore(recentMomentum * 100),
            averageGap: roundScore(averageGap),
            currentGap,
            predictedDistance: roundScore(predictedDistance),
            distributionGap,
            breakdown,
        };
    }).sort((left, right) => right.score - left.score ||
        left.predictedDistance - right.predictedDistance ||
        right.distributionGap - left.distributionGap ||
        right.currentGap - left.currentGap ||
        left.digit - right.digit);
    return {
        trainingDigits,
        predictedCenter,
        trendSlope: roundScore(trendSlope),
        recentAverage: roundScore(recentAverage),
        volatility: roundScore(volatility),
        rankedDigits,
    };
}
function runBacktest(historyDigits, config) {
    const minTrainingSize = Math.min(config.minTrainingSize, Math.max(10, historyDigits.length - 1));
    if (historyDigits.length <= minTrainingSize) {
        return {
            samples: 0,
            top1Hits: 0,
            top3Hits: 0,
            top1Rate: 0,
            top3Rate: 0,
        };
    }
    let samples = 0;
    let top1Hits = 0;
    let top3Hits = 0;
    for (let index = minTrainingSize; index < historyDigits.length; index += 1) {
        const rankedDigits = rankNextDigits(historyDigits.slice(0, index), config);
        const actualDigit = historyDigits[index];
        const top3Digits = rankedDigits.slice(0, 3).map((item) => item.digit);
        samples += 1;
        if (rankedDigits[0]?.digit === actualDigit) {
            top1Hits += 1;
        }
        if (top3Digits.some((digit) => digit === actualDigit)) {
            top3Hits += 1;
        }
    }
    return {
        samples,
        top1Hits,
        top3Hits,
        top1Rate: samples > 0 ? top1Hits / samples : 0,
        top3Rate: samples > 0 ? top3Hits / samples : 0,
    };
}
function runMarkovBacktest(historyDigits, config) {
    const minimumRequired = Math.max(config.markovOrder + 2, 10);
    const minTrainingSize = Math.min(config.minTrainingSize, Math.max(minimumRequired, historyDigits.length - 1));
    if (historyDigits.length <= minTrainingSize) {
        return {
            samples: 0,
            top1Hits: 0,
            top3Hits: 0,
            top1Rate: 0,
            top3Rate: 0,
        };
    }
    let samples = 0;
    let top1Hits = 0;
    let top3Hits = 0;
    for (let index = minTrainingSize; index < historyDigits.length; index += 1) {
        const snapshot = buildMarkovSnapshot(historyDigits.slice(0, index), config.markovOrder, config.combinationPoolSize);
        const actualDigit = historyDigits[index];
        const top3Digits = snapshot.rankedDigits.slice(0, 3).map((item) => item.digit);
        samples += 1;
        if (snapshot.rankedDigits[0]?.digit === actualDigit) {
            top1Hits += 1;
        }
        if (top3Digits.some((digit) => digit === actualDigit)) {
            top3Hits += 1;
        }
    }
    return {
        samples,
        top1Hits,
        top3Hits,
        top1Rate: samples > 0 ? top1Hits / samples : 0,
        top3Rate: samples > 0 ? top3Hits / samples : 0,
    };
}
function runMathTrendBacktest(historyDigits, config) {
    const minTrainingSize = Math.min(config.validationStart, Math.max(40, historyDigits.length - 1));
    if (historyDigits.length <= minTrainingSize) {
        return {
            samples: 0,
            top1Hits: 0,
            top3Hits: 0,
            top1Rate: 0,
            top3Rate: 0,
        };
    }
    let samples = 0;
    let top1Hits = 0;
    let top3Hits = 0;
    for (let index = minTrainingSize; index < historyDigits.length; index += 1) {
        const rankedDigits = buildMathTrendSnapshot(historyDigits.slice(0, index), config).rankedDigits;
        const actualDigit = historyDigits[index];
        const top3Digits = rankedDigits.slice(0, 3).map((item) => item.digit);
        samples += 1;
        if (rankedDigits[0]?.digit === actualDigit) {
            top1Hits += 1;
        }
        if (top3Digits.some((digit) => digit === actualDigit)) {
            top3Hits += 1;
        }
    }
    return {
        samples,
        top1Hits,
        top3Hits,
        top1Rate: samples > 0 ? top1Hits / samples : 0,
        top3Rate: samples > 0 ? top3Hits / samples : 0,
    };
}
function buildCombinationCandidates(positions, config) {
    const candidatePools = positions.map((item) => item.candidates.slice(0, config.combinationPoolSize));
    if (candidatePools.some((pool) => pool.length === 0)) {
        return [];
    }
    let beams = [{ value: '', score: 0 }];
    for (const pool of candidatePools) {
        const nextBeams = [];
        for (const beam of beams) {
            for (const candidate of pool) {
                nextBeams.push({
                    value: `${beam.value}${candidate.digit}`,
                    score: roundScore(beam.score + candidate.score),
                });
            }
        }
        beams = nextBeams
            .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value, 'zh-CN'))
            .slice(0, Math.max(config.combinationLimit * 2, config.combinationLimit));
    }
    return beams.slice(0, config.combinationLimit);
}
function buildMarkovCombinationCandidates(positions, config) {
    const candidatePools = positions.map((item) => item.markov.candidates.slice(0, config.combinationPoolSize));
    if (candidatePools.some((pool) => pool.length === 0)) {
        return [];
    }
    let beams = [{ value: '', score: 0 }];
    for (const pool of candidatePools) {
        const nextBeams = [];
        for (const beam of beams) {
            for (const candidate of pool) {
                nextBeams.push({
                    value: `${beam.value}${candidate.digit}`,
                    score: roundScore(beam.score + candidate.probability * 100),
                });
            }
        }
        beams = nextBeams
            .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value, 'zh-CN'))
            .slice(0, Math.max(config.combinationLimit * 2, config.combinationLimit));
    }
    return beams.slice(0, config.combinationLimit);
}
function buildPredictionStatistics(validDraws, config) {
    return {
        hotCold: buildHotColdStats(validDraws, config),
        sumSpan: buildSumSpanStats(validDraws, config),
        paritySize: buildParitySizeStats(validDraws, config),
    };
}
function buildHotColdStats(validDraws, config) {
    const recentDraws = validDraws.slice(-config.recentWindow);
    const longDraws = validDraws.slice(-config.longWindow);
    const recentCounts = countDigits(recentDraws.flat());
    const longCounts = countDigits(longDraws.flat());
    const digitStats = DIGITS.map((digit) => ({
        digit,
        recentCount: recentCounts[digit],
        longCount: longCounts[digit],
        missSpan: getDrawMissSpan(validDraws, digit),
    }));
    return {
        recentWindow: config.recentWindow,
        longWindow: config.longWindow,
        hotDigits: [...digitStats]
            .sort((left, right) => right.recentCount - left.recentCount ||
            right.longCount - left.longCount ||
            left.missSpan - right.missSpan ||
            left.digit - right.digit)
            .slice(0, 5),
        coldDigits: [...digitStats]
            .sort((left, right) => left.recentCount - right.recentCount ||
            left.longCount - right.longCount ||
            right.missSpan - left.missSpan ||
            left.digit - right.digit)
            .slice(0, 5),
    };
}
function buildSumSpanStats(validDraws, config) {
    const recentDraws = validDraws.slice(-config.recentWindow);
    const longDraws = validDraws.slice(-config.longWindow);
    const sumCounts = new Map();
    const spanCounts = new Map();
    for (const draw of longDraws) {
        incrementMapCount(sumCounts, String(getDrawSum(draw)));
        incrementMapCount(spanCounts, String(getDrawSpan(draw)));
    }
    return {
        recentAverageSum: averageNumber(recentDraws.map((draw) => getDrawSum(draw))),
        recentAverageSpan: averageNumber(recentDraws.map((draw) => getDrawSpan(draw))),
        topSums: buildTopBuckets(sumCounts, longDraws.length, 5),
        topSpans: buildTopBuckets(spanCounts, longDraws.length, 5),
    };
}
function buildParitySizeStats(validDraws, config) {
    const recentDraws = validDraws.slice(-config.recentWindow);
    const recentDigits = recentDraws.flat();
    const oddCount = recentDigits.filter((digit) => digit % 2 !== 0).length;
    const evenCount = recentDigits.length - oddCount;
    const bigCount = recentDigits.filter((digit) => digit >= 5).length;
    const smallCount = recentDigits.length - bigCount;
    const oddEvenPatterns = new Map();
    const bigSmallPatterns = new Map();
    for (const draw of recentDraws) {
        const oddInDraw = draw.filter((digit) => digit % 2 !== 0).length;
        const bigInDraw = draw.filter((digit) => digit >= 5).length;
        incrementMapCount(oddEvenPatterns, `${oddInDraw}:${draw.length - oddInDraw}`);
        incrementMapCount(bigSmallPatterns, `${bigInDraw}:${draw.length - bigInDraw}`);
    }
    return {
        oddRate: safeRate(oddCount, recentDigits.length),
        evenRate: safeRate(evenCount, recentDigits.length),
        bigRate: safeRate(bigCount, recentDigits.length),
        smallRate: safeRate(smallCount, recentDigits.length),
        oddEvenPatterns: buildTopBuckets(oddEvenPatterns, recentDraws.length, 3),
        bigSmallPatterns: buildTopBuckets(bigSmallPatterns, recentDraws.length, 3),
    };
}
function resolvePredictionConfig(options) {
    return {
        recentWindow: toBoundedInteger(options.recentWindow, RECENT_WINDOW, 5, 60),
        longWindow: toBoundedInteger(options.longWindow, LONG_WINDOW, 20, 180),
        minTrainingSize: toBoundedInteger(options.minTrainingSize, MIN_TRAINING_SIZE, 10, 120),
        combinationPoolSize: toBoundedInteger(options.combinationPoolSize, COMBINATION_POOL_SIZE, 1, 5),
        combinationLimit: toBoundedInteger(options.combinationLimit, COMBINATION_LIMIT, 1, 20),
        markovOrder: toBoundedInteger(options.markovOrder, DEFAULT_MARKOV_ORDER, 1, 5),
        scoreWeights: normalizeScoreWeights({
            ...DEFAULT_PREDICTION_SCORE_WEIGHTS,
            ...(options.scoreWeights ?? {}),
        }),
    };
}
function resolveMathTrendConfig(options) {
    return {
        sampleWindow: toBoundedInteger(options.sampleWindow, MATH_SAMPLE_WINDOW, 80, 400),
        trendWindow: toBoundedInteger(options.trendWindow, MATH_TREND_WINDOW, 12, 90),
        validationStart: toBoundedInteger(options.validationStart, MATH_VALIDATION_START, 40, 240),
        candidateCount: toBoundedInteger(options.candidateCount, MATH_CANDIDATE_COUNT, 1, 5),
    };
}
function sortChronological(entries) {
    const list = [...entries];
    const canSortByIssue = list.every((entry) => entry.issue && Number.isFinite(Number(entry.issue)));
    if (canSortByIssue) {
        return list.sort((left, right) => Number(left.issue) - Number(right.issue));
    }
    return list.reverse();
}
function parseDigitValue(value) {
    if (!value || !/^\d$/.test(value)) {
        return null;
    }
    return Number(value);
}
function getMathTrainingDigits(historyDigits, config) {
    return historyDigits.slice(-Math.min(config.sampleWindow, historyDigits.length));
}
function getValidDraws(entries) {
    return entries
        .map((entry) => entry.numbers.map((value) => parseDigitValue(value)).filter((value) => value !== null))
        .filter((draw) => draw.length === POSITION_COUNT);
}
function countDigits(values) {
    const counts = createZeroMap();
    for (const value of values) {
        counts[value] += 1;
    }
    return counts;
}
function computeForecastCenter(values) {
    if (values.length === 0) {
        return null;
    }
    const slope = computeLinearSlope(values);
    const average = averageNumber(values);
    const weightedAverage = values.reduce((sum, value, index) => sum + value * (index + 1), 0) / ((values.length * (values.length + 1)) / 2);
    const forecast = weightedAverage + slope + (weightedAverage - average) * 0.4;
    return roundScore(clampNumber(forecast, 0, 9));
}
function computeLinearSlope(values) {
    if (values.length <= 1) {
        return 0;
    }
    const meanX = (values.length - 1) / 2;
    const meanY = averageNumber(values);
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < values.length; index += 1) {
        const deltaX = index - meanX;
        numerator += deltaX * (values[index] - meanY);
        denominator += deltaX * deltaX;
    }
    if (denominator <= 0) {
        return 0;
    }
    return numerator / denominator;
}
function computeStandardDeviation(values, mean = averageNumber(values)) {
    if (values.length === 0) {
        return 0;
    }
    const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
    return Math.sqrt(Math.max(variance, 0));
}
function getAverageGap(values, digit, fallback) {
    const occurrenceIndexes = [];
    for (let index = 0; index < values.length; index += 1) {
        if (values[index] === digit) {
            occurrenceIndexes.push(index);
        }
    }
    if (occurrenceIndexes.length <= 1) {
        return fallback;
    }
    const gaps = [];
    for (let index = 1; index < occurrenceIndexes.length; index += 1) {
        gaps.push(occurrenceIndexes[index] - occurrenceIndexes[index - 1]);
    }
    return averageNumber(gaps);
}
function countTransitionMatches(values, pattern) {
    const counts = createZeroMap();
    const patternLength = pattern.length;
    if (values.length <= patternLength) {
        return counts;
    }
    for (let index = patternLength; index < values.length; index += 1) {
        let matched = true;
        for (let offset = 0; offset < patternLength; offset += 1) {
            if (values[index - patternLength + offset] !== pattern[offset]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            counts[values[index]] += 1;
        }
    }
    return counts;
}
function buildMarkovSnapshot(historyDigits, order, candidateCount) {
    if (historyDigits.length === 0) {
        return {
            effectiveOrder: 0,
            sourcePattern: [],
            supportCount: 0,
            rankedDigits: DIGITS.map((digit) => ({
                digit,
                probability: 0,
                count: 0,
            })).slice(0, Math.max(candidateCount, DIGITS.length)),
        };
    }
    const cappedOrder = Math.max(1, Math.min(order, historyDigits.length - 1));
    for (let currentOrder = cappedOrder; currentOrder >= 1; currentOrder -= 1) {
        const sourcePattern = historyDigits.slice(-currentOrder);
        const counts = countTransitionMatches(historyDigits, sourcePattern);
        const supportCount = sumCounts(counts);
        if (supportCount > 0) {
            return {
                effectiveOrder: currentOrder,
                sourcePattern,
                supportCount,
                rankedDigits: buildMarkovCandidates(counts, supportCount),
            };
        }
    }
    return {
        effectiveOrder: 0,
        sourcePattern: [],
        supportCount: historyDigits.length,
        rankedDigits: buildMarkovCandidates(countDigits(historyDigits), historyDigits.length),
    };
}
function buildMarkovCandidates(counts, supportCount) {
    return DIGITS.map((digit) => ({
        digit,
        probability: supportCount > 0 ? counts[digit] / supportCount : 0,
        count: counts[digit],
    })).sort((left, right) => right.probability - left.probability || right.count - left.count || left.digit - right.digit);
}
function getMissSpan(values, digit) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        if (values[index] === digit) {
            return values.length - 1 - index;
        }
    }
    return values.length;
}
function createZeroMap() {
    return Array(10).fill(0);
}
function getDrawMissSpan(draws, digit) {
    for (let index = draws.length - 1; index >= 0; index -= 1) {
        if (draws[index].includes(digit)) {
            return draws.length - 1 - index;
        }
    }
    return draws.length;
}
function getDrawSum(draw) {
    return draw.reduce((sum, value) => sum + value, 0);
}
function getDrawSpan(draw) {
    if (draw.length === 0) {
        return 0;
    }
    return Math.max(...draw) - Math.min(...draw);
}
function incrementMapCount(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}
function buildTopBuckets(map, total, limit) {
    return Array.from(map.entries())
        .map(([label, count]) => ({
        label,
        count,
        rate: safeRate(count, total),
    }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))
        .slice(0, limit);
}
function sumCounts(values) {
    return values.reduce((sum, value) => sum + value, 0);
}
function averageRate(values) {
    const validValues = values.filter((value) => Number.isFinite(value) && value > 0);
    if (validValues.length === 0) {
        return 0;
    }
    return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
}
function averageNumber(values) {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function safeRate(value, total) {
    if (total <= 0) {
        return 0;
    }
    return value / total;
}
function clampZeroToOne(value) {
    return clampNumber(value, 0, 1);
}
function normalizeScoreWeights(weights) {
    const sanitizedValues = Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Number.isFinite(value) && value > 0 ? value : 0]));
    const total = Object.values(sanitizedValues).reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        return DEFAULT_PREDICTION_SCORE_WEIGHTS;
    }
    return {
        recent: sanitizedValues.recent / total,
        long: sanitizedValues.long / total,
        omission: sanitizedValues.omission / total,
        transition: sanitizedValues.transition / total,
        pairTransition: sanitizedValues.pairTransition / total,
    };
}
function toBoundedInteger(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(Math.max(Math.floor(numeric), min), max);
}
function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function roundScore(value) {
    return Math.round(value * 10) / 10;
}
