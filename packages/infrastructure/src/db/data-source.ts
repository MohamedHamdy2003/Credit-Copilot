import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1794916800000 } from './migrations/InitialSchema.js';
import { IndexRevisions1794916800001 } from './migrations/IndexRevisions.js';
import { ApprovalAccess1794916800002 } from './migrations/ApprovalAccess.js';
import { LatestAssessment1794916800003 } from './migrations/LatestAssessment.js';
import { AssessmentJobs1794916800004 } from './migrations/AssessmentJobs.js';
import { CaseReviews1794916800005 } from './migrations/CaseReviews.js';
import { EmbeddingDimensions1794916800006 } from './migrations/EmbeddingDimensions.js';
import { AssessmentProgress1794916800007 } from './migrations/AssessmentProgress.js';
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
      CaseReviews1794916800005,
      EmbeddingDimensions1794916800006,
      AssessmentProgress1794916800007,
    ],
  });
}
