import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1794916800000 } from './migrations/InitialSchema.js';
import { IndexRevisions1794916800001 } from './migrations/IndexRevisions.js';
import { ApprovalAccess1794916800002 } from './migrations/ApprovalAccess.js';
import { LatestAssessment1794916800003 } from './migrations/LatestAssessment.js';
import { AssessmentJobs1794916800004 } from './migrations/AssessmentJobs.js';
export function createDataSource(url: string) {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    migrations: [
      InitialSchema1794916800000,
      IndexRevisions1794916800001,
      ApprovalAccess1794916800002,
      LatestAssessment1794916800003,
      AssessmentJobs1794916800004,
    ],
  });
}
