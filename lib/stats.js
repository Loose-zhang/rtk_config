// 样本统计（纯函数）：均值、标准差、异常值剔除
const { log } = require('./logger');

// 计算样本均值（优化版：去除误差最大的2个样本）
function calculateAverage(samples) {
  if (samples.length === 0) return null;

  // 如果样本数量少于等于3个，不去除任何样本（至少保留1个样本）
  if (samples.length <= 3) {
    log('warn', `样本数量不足 (${samples.length}个)，不进行异常值过滤`);
    return calculateAverageInternal(samples);
  }

  // 步骤1：计算初步平均值（使用所有样本）
  const preliminaryMean = calculateAverageInternal(samples);

  // 步骤2：计算每个样本到平均值的距离
  const samplesWithDistance = samples.map((sample, index) => {
    // 计算ECEF坐标的欧氏距离
    const dx = sample.ecef.x - parseFloat(preliminaryMean.ecef.x);
    const dy = sample.ecef.y - parseFloat(preliminaryMean.ecef.y);
    const dz = sample.ecef.z - parseFloat(preliminaryMean.ecef.z);
    const ecefDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // 计算LLH坐标的距离（归一化后的距离）
    const dlat = (sample.llh.lat - parseFloat(preliminaryMean.llh.lat)) * 111320; // 1度纬度约111km
    const dlon = (sample.llh.lon - parseFloat(preliminaryMean.llh.lon)) * 111320 * Math.cos(sample.llh.lat * Math.PI / 180);
    const dheight = sample.llh.height - parseFloat(preliminaryMean.llh.height);
    const llhDistance = Math.sqrt(dlat * dlat + dlon * dlon + dheight * dheight);

    // 使用ECEF距离作为主要依据（更准确）
    return {
      sample: sample,
      distance: ecefDistance,
      llhDistance: llhDistance,
      index: index
    };
  });

  // 步骤3：按距离排序，找出最大的2个
  samplesWithDistance.sort((a, b) => b.distance - a.distance);

  const removed1 = samplesWithDistance[0];
  const removed2 = samplesWithDistance[1];

  log('info', `🔍 异常值检测: 移除误差最大的2个样本`);
  log('info', `  ❌ 样本#${removed1.index + 1}: ECEF距离=${removed1.distance.toFixed(4)}m, LLH距离=${removed1.llhDistance.toFixed(4)}m`);
  log('info', `  ❌ 样本#${removed2.index + 1}: ECEF距离=${removed2.distance.toFixed(4)}m, LLH距离=${removed2.llhDistance.toFixed(4)}m`);

  // 步骤4：去除最大的2个样本
  const filteredSamples = samplesWithDistance.slice(2).map(item => item.sample);

  log('info', `✅ 保留样本数: ${filteredSamples.length} / ${samples.length}`);

  // 步骤5：使用过滤后的样本计算最终平均值
  const finalAverage = calculateAverageInternal(filteredSamples);

  finalAverage.filtered = true;
  finalAverage.originalSampleCount = samples.length;
  finalAverage.removedSampleCount = 2;
  finalAverage.removedSamples = [
    {
      index: removed1.index + 1,
      ecefDistance: removed1.distance.toFixed(4),
      llhDistance: removed1.llhDistance.toFixed(4)
    },
    {
      index: removed2.index + 1,
      ecefDistance: removed2.distance.toFixed(4),
      llhDistance: removed2.llhDistance.toFixed(4)
    }
  ];

  return finalAverage;
}

// 内部函数：直接计算平均值（不过滤异常值）
function calculateAverageInternal(samples) {
  if (samples.length === 0) return null;

  const sum = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + sample.ecef.x,
        y: acc.ecef.y + sample.ecef.y,
        z: acc.ecef.z + sample.ecef.z
      },
      llh: {
        lat: acc.llh.lat + sample.llh.lat,
        lon: acc.llh.lon + sample.llh.lon,
        height: acc.llh.height + sample.llh.height
      },
      satellites: acc.satellites + sample.satellites
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 },
    satellites: 0
  });

  const count = samples.length;

  const mean = {
    ecef: {
      x: sum.ecef.x / count,
      y: sum.ecef.y / count,
      z: sum.ecef.z / count
    },
    llh: {
      lat: sum.llh.lat / count,
      lon: sum.llh.lon / count,
      height: sum.llh.height / count
    }
  };

  const stdDev = calculateStdDev(samples, mean);

  return {
    ecef: {
      x: mean.ecef.x.toFixed(4),
      y: mean.ecef.y.toFixed(4),
      z: mean.ecef.z.toFixed(4)
    },
    llh: {
      lat: mean.llh.lat.toFixed(9),
      lon: mean.llh.lon.toFixed(9),
      height: mean.llh.height.toFixed(4)
    },
    satellites: Math.round(sum.satellites / count),
    sampleCount: count,
    stdDev: stdDev
  };
}

// 计算标准差
function calculateStdDev(samples, mean) {
  if (samples.length < 2) return null;

  const variance = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + Math.pow(sample.ecef.x - mean.ecef.x, 2),
        y: acc.ecef.y + Math.pow(sample.ecef.y - mean.ecef.y, 2),
        z: acc.ecef.z + Math.pow(sample.ecef.z - mean.ecef.z, 2)
      },
      llh: {
        lat: acc.llh.lat + Math.pow(sample.llh.lat - mean.llh.lat, 2),
        lon: acc.llh.lon + Math.pow(sample.llh.lon - mean.llh.lon, 2),
        height: acc.llh.height + Math.pow(sample.llh.height - mean.llh.height, 2)
      }
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 }
  });

  const count = samples.length;

  return {
    ecef: {
      x: Math.sqrt(variance.ecef.x / count).toFixed(4),
      y: Math.sqrt(variance.ecef.y / count).toFixed(4),
      z: Math.sqrt(variance.ecef.z / count).toFixed(4)
    },
    llh: {
      lat: Math.sqrt(variance.llh.lat / count).toFixed(9),
      lon: Math.sqrt(variance.llh.lon / count).toFixed(9),
      height: Math.sqrt(variance.llh.height / count).toFixed(4)
    }
  };
}

module.exports = { calculateAverage, calculateAverageInternal, calculateStdDev };
