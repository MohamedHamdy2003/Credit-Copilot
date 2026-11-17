import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1794916800000 } from './migrations/InitialSchema.js';
import { IndexRevisions1794916800001 } from './migrations/IndexRevisions.js';
export function createDataSource(url: string) {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    migrations: [InitialSchema1794916800000, IndexRevisions1794916800001],
  });
}
