# tools

- `Int38Parser.java`：RTCM 1005 报文中 38 位有符号 ECEF 坐标解析的参考实现（非运行时依赖）。
  运行时使用的是 `public/app.js` 中的 `parseInt38`（JS 移植版），修改算法时两者需保持一致。
