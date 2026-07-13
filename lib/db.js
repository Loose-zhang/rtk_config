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
        height DOUBLE NOT NULL
      )
    `);
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
  }
}

function dbInsertStableResult(record) {
  try {
    if (!dbPool || !record || !record.id) return;
    const sql = `
      INSERT INTO stable_results (id, station_id, timestamp, ecef_x, ecef_y, ecef_z, lat, lon, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        station_id = VALUES(station_id),
        timestamp = VALUES(timestamp),
        ecef_x = VALUES(ecef_x),
        ecef_y = VALUES(ecef_y),
        ecef_z = VALUES(ecef_z),
        lat = VALUES(lat),
        lon = VALUES(lon),
        height = VALUES(height)
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
      parseFloat(record.height)
    ];
    dbPool.execute(sql, params).catch(err => log('warn', `dbInsertStableResult error: ${err.message}`));
  } catch (e) {
    log('warn', `dbInsertStableResult failed: ${e.message}`);
  }
}

module.exports = { dbInitMySql, dbInsertStableResult };
