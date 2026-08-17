/**
 * DSH CA 库（ca-db.mjs）——薄壳 re-export（7.3 公开化，任务书 B §3.4）。
 * schema/openDb/helper 全部搬至 lib/ca-db.js（package.json exports["./ca-db"]），
 * 本文件保持既有 import 路径不变（summarize-history.mjs 等消费方零改动）；
 * 禁止双份 schema：建表 SQL 只应出现在 lib/ca-db.js。
 */
export * from '../lib/ca-db.js';
