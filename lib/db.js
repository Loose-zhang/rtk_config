// MySQL 初始化与访问封装（可选依赖，仅用于写入平均后的稳定结果）
const config = require('../config');
const { log } = require('./logger');

let mysql = null;
let dbPool = null;
try {
  // 可选依赖：MySQL（建议安装 mysql2）
  mysql = require('mysql2/promise');
} catch (e) {
  // 未安装 mysql2 时，仅记录日志
}

async function dbInitMySql() {
  try {
    if (!mysql || !config.mysql || !config.mysql.host) {
      log('warn', 'MySQL not configured. Database features are disabled. Configure config.mysql and install mysql2.');
      return;
    }
    const { host, user, password, database, port } = config.mysql;
    // 若目标数据库不存在，先以“无数据库”连接创建之
    try {
      const bootstrap = await mysql.createConnection({
        host,
        user,
        password,
        port: port || 3306
      });
      await bootstrap.execute(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
      await bootstrap.end();
      log('info', `Ensured database exists: ${database}`);
    } catch (e) {
      log('warn', `Ensure database failed (may already exist or no privilege): ${e.message}`);
    }
    dbPool = await mysql.createPool({
      host,
      user,
      password,
      database,
      port: port || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4'
    });
    // 创建仅用于平均后稳定结果的表
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS stable_results (
        id VARCHAR(128) PRIMARY KEY,
        station_id VARCHAR(128) NOT NULL,
        timestamp VARCHAR(32) NOT NULL,
        ecef_x DOUBLE NOT NULL,
        ecef_y DOUBLE NOT NULL,
        ecef_z DOUBLE NOT NULL,
        lat DOUBLE NOT NULL,
        lon DOUBLE NOT NULL,
        height DOUBLE NOT NULL,
        sample_count INT NOT NULL DEFAULT 0,
        filtered TINYINT NOT NULL DEFAULT 0,
        removed_count INT NOT NULL DEFAULT 0
      )
    `);
    // 旧表升级：补充展示用列（重复添加时忽略 ER_DUP_FIELDNAME）
    for (const colDef of [
      'sample_count INT NOT NULL DEFAULT 0',
      'filtered TINYINT NOT NULL DEFAULT 0',
      'removed_count INT NOT NULL DEFAULT 0'
    ]) {
      try {
        await dbPool.execute(`ALTER TABLE stable_results ADD COLUMN ${colDef}`);
      } catch (e) {
        if (!e || e.code !== 'ER_DUP_FIELDNAME') {
          log('warn', `Alter stable_results add column failed: ${e.message}`);
        }
      }
    }
    // 创建索引（老版本 MySQL 不支持 IF NOT EXISTS，这里忽略重复索引错误）
    try {
      await dbPool.execute(`CREATE INDEX idx_results_station ON stable_results(station_id)`);
    } catch (e) {
      if (e && e.code === 'ER_DUP_KEYNAME') {
        // 索引已存在，忽略
      } else {
        log('warn', `Create index on stable_results failed: ${e.message}`);
      }
    }
    log('info', `MySQL initialized: ${user}@${host}/${database}`);
  } catch (e) {
    log('error', `dbInitMySql failed: ${e.message}`);
    // createPool 不实际建立连接也会成功，初始化失败必须置空，
    // 否则 dbIsReady() 误报可用导致读取接口 500
    if (dbPool) {
      try { dbPool.end().catch(() => {}); } catch (e2) {}
      dbPool = null;
    }
  }
}

function dbIsReady() {
  return !!dbPool;
}

async function dbInsertStableResult(record) {
  try {
    if (!dbPool || !record || !record.id) return false;
    const sql = `
      INSERT INTO stable_results (id, station_id, timestamp, ecef_x, ecef_y, ecef_z, lat, lon, height, sample_count, filtered, removed_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        station_id = VALUES(station_id),
        timestamp = VALUES(timestamp),
        ecef_x = VALUES(ecef_x),
        ecef_y = VALUES(ecef_y),
        ecef_z = VALUES(ecef_z),
        lat = VALUES(lat),
        lon = VALUES(lon),
        height = VALUES(height),
        sample_count = VALUES(sample_count),
        filtered = VALUES(filtered),
        removed_count = VALUES(removed_count)
    `;
    const params = [
      record.id,
      record.stationId,
      record.timestamp,
      parseFloat(record.ecef_x),
      parseFloat(record.ecef_y),
      parseFloat(record.ecef_z),
      parseFloat(record.lat),
      parseFloat(record.lon),
      parseFloat(record.height),
      Number(record.sampleCount || 0),
      record.filtered ? 1 : 0,
      Number(record.removedSampleCount || 0)
    ];
    await dbPool.execute(sql, params);
    return true;
  } catch (e) {
    log('warn', `dbInsertStableResult failed: ${e.message}`);
    return false;
  }
}

// 将 JSON 兜底文件中的记录补写到数据库。使用 upsert，重复执行是安全的。
async function dbInsertStableResults(records) {
  const list = Array.isArray(records) ? records.filter(r => r && r.id) : [];
  const result = { attempted: list.length, saved: 0, failed: 0 };
  for (const record of list) {
    if (await dbInsertStableResult(record)) {
      result.saved += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}

// 读取全部稳定结果（数据库为主查询源；JSON 保留为持久兜底并用于缺失记录补写）
async function dbGetStableResults() {
  if (!dbPool) return null;
  const [rows] = await dbPool.execute(
    `SELECT id, station_id, timestamp, ecef_x, ecef_y, ecef_z, lat, lon, height, sample_count, filtered, removed_count
     FROM stable_results ORDER BY timestamp DESC`
  );
  return rows.map(r => ({
    id: r.id,
    stationId: r.station_id,
    timestamp: r.timestamp,
    ecef_x: Number(r.ecef_x).toFixed(4),
    ecef_y: Number(r.ecef_y).toFixed(4),
    ecef_z: Number(r.ecef_z).toFixed(4),
    lat: Number(r.lat).toFixed(9),
    lon: Number(r.lon).toFixed(9),
    height: Number(r.height).toFixed(4),
    sampleCount: Number(r.sample_count || 0),
    filtered: !!r.filtered,
    removedSampleCount: Number(r.removed_count || 0)
  }));
}

// 按 id 删除稳定结果，返回删除行数
async function dbDeleteStableResult(id) {
  if (!dbPool) return null;
  const [result] = await dbPool.execute(`DELETE FROM stable_results WHERE id = ?`, [id]);
  return result.affectedRows || 0;
}

module.exports = {
  dbInitMySql,
  dbIsReady,
  dbInsertStableResult,
  dbInsertStableResults,
  dbGetStableResults,
  dbDeleteStableResult
};
