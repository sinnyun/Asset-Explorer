import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts'; 

declare global {
  var _postgresPool: Pool | undefined;
}

let _poolInstance: Pool | null = null;
let _dbInstance: any = null;

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST || 'localhost',
      user: process.env.SQL_USER || 'postgres',
      password: process.env.SQL_PASSWORD || '',
      database: process.env.SQL_DB_NAME || 'postgres',
      max: 10,
      connectionTimeoutMillis: 10000,
    });

    global._postgresPool.on('error', (err) => {
      console.warn('[SQL Pool] 数据库连接池告警 (若未配置云数据库可忽略):', err.message);
    });
  }
  return global._postgresPool;
};

export const getDb = () => {
  if (!_dbInstance) {
    try {
      const pool = createPool();
      _dbInstance = drizzle(pool, { schema });
    } catch (err: any) {
      console.warn('[Drizzle] 初始化数据库连接失败:', err.message);
      throw err;
    }
  }
  return _dbInstance;
};

// 代理模式保证已有导入 db 的路由不需要大量修改，但内部实现懒加载
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    const instance = getDb();
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

