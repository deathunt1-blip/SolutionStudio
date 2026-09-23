import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Registries } from '../../core/src/types.js';
import { acquireDatabaseLock } from './database-lock.js';

export interface Connection { query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<T[]> }
export interface Database extends Connection { kind: 'postgres'|'pglite'; transaction<T>(fn: (db: Connection) => Promise<T>): Promise<T>; close(): Promise<void> }

export async function openDatabase(dataDir: string, databaseUrl?: string): Promise<Database> {
  await mkdir(dataDir, { recursive: true });
  const releaseLock=databaseUrl?async()=>{}:await acquireDatabaseLock(dataDir);
  let pool:Pool|null=null,embedded:PGlite|null=null;
  try {
  pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  embedded = pool ? null : new PGlite(path.join(dataDir, 'postgres'));
  if (embedded) await embedded.waitReady;
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>) => { const task = tail.then(fn, fn); tail = task.catch(() => {}); return task; };
  const raw: Connection = { async query<T>(sql: string, values: unknown[] = []) {
    return (pool ? (await pool.query(sql, values)).rows : (await embedded!.query(sql, values)).rows) as T[];
  } };
  const db: Database = {
    kind: pool ? 'postgres' : 'pglite',
    query: <T>(sql: string, values: unknown[] = []) => exclusive(() => raw.query<T>(sql, values)),
    transaction: <T>(fn: (db: Connection) => Promise<T>) => exclusive(async () => {
      const client = pool ? await pool.connect() : null;
      const conn: Connection = client ? { async query<R>(sql: string, values: unknown[] = []) { return (await client.query(sql, values)).rows as R[]; } } : raw;
      await conn.query('BEGIN');
      try { const result = await fn(conn); await conn.query('COMMIT'); return result; }
      catch (error) { await conn.query('ROLLBACK'); throw error; }
      finally { client?.release(); }
    }),
    async close() { await tail; try { if (pool) await pool.end(); else await embedded!.close(); } finally { await releaseLock(); } },
  };
  const migration = await readFile(new URL('../../../migrations/001_initial.sql', import.meta.url), 'utf8');
  // Both engines execute the same PostgreSQL schema, including native tsvector / GIN.
  if (pool) await pool.query(migration); else await embedded!.exec(migration);
  for (const [version,filename] of [[2,'002_canonical_metadata.sql'],[3,'003_refinement.sql'],[4,'004_structured.sql'],[5,'005_external_sources.sql'],[6,'006_document_deduplication.sql'],[7,'007_projects.sql'],[8,'008_document_engine.sql']] as const) {
    const applied=await db.query('SELECT version FROM schema_migrations WHERE version=$1',[version]);
    if(applied.length)continue;
    const sql=await readFile(new URL(`../../../migrations/${filename}`,import.meta.url),'utf8');
    await db.transaction(async tx=>{if(embedded)await embedded.exec(sql);else await tx.query(sql);await tx.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[version]);});
  }
  await db.transaction(async tx => {
    await tx.query("INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO organizations VALUES ('default','Default organization') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO workspaces VALUES ('default','default','Default workspace') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO knowledge_sources(id,organization_id,workspace_id,type,name,mode,source_of_truth) VALUES ('manual','default','default','manual','手动上传','managed','studio') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO knowledge_sources(id,organization_id,workspace_id,type,name,mode,source_of_truth) VALUES ('local-import','default','default','local_folder','本地文件夹导入','managed','studio') ON CONFLICT DO NOTHING");
    for (const [kind, items] of Object.entries(initialRegistries)) {
      const table = registryTables[kind as keyof Registries];
      for (const item of items) await tx.query(`INSERT INTO ${table}(key,label,aliases) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [item.key, item.label, JSON.stringify(item.aliases)]);
    }
  });
  return db;
  } catch(error) {
    try { if(pool)await pool.end();else if(embedded?.ready&&!embedded.closed)await embedded.close(); }
    finally { await releaseLock(); }
    throw error;
  }
}

export const registryTables = { documentTypes: 'document_types', applications: 'applications', topics: 'topics' } as const;
const items = (pairs: [string,string,string[]?][]) => pairs.map(([key,label,aliases = []]) => ({key,label,aliases}));
export const initialRegistries: Registries = {
 documentTypes: items([['product_document','产品资料'],['technical_knowledge','技术知识'],['solution','技术方案'],['test_report','测试报告'],['acceptance_report','验收报告'],['implementation_document','实施文档'],['standard','标准 / 规范'],['manual','使用说明'],['case','项目案例'],['style_sample','写作样例'],['contract_or_requirement','合同 / 技术要求'],['other','其他'],['unknown','未知']]),
 applications: items([['robotics','机器人'],['drone','无人机'],['human_motion','人体运动'],['underwater','水下'],['vr','虚拟现实'],['industrial','工业'],['research','科研'],['sports','体育'],['film','影视'],['measurement','测量'],['education','教育']]),
 topics: items([['camera','相机'],['deployment','部署'],['coverage','覆盖'],['accuracy','精度'],['marker','标记点'],['rigid_body','刚体'],['calibration','标定'],['synchronization','同步',['PTP','IEEE1588','时钟同步','时间同步','网络同步']],['network','网络'],['software','软件'],['sdk','SDK'],['protocol','协议'],['installation','安装'],['latency','延迟'],['tracking','追踪'],['robotics','机器人'],['teleoperation','遥操作'],['data_collection','数据采集'],['testing','测试'],['acceptance','验收']]),
};
