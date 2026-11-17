import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1794916800000 } from './migrations/InitialSchema.js';
export function createDataSource(url: string) {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    migrations: [InitialSchema1794916800000],
  });
}
